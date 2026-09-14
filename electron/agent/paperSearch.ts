/**
 * 文献检索统一访问层（主进程）。
 *
 * ── 背景（为什么换接口）────────────────────────────────────────────────────
 * 旧实现直连 `export.arxiv.org` 公共 API：无 key、官方 ToS 限速 **3 秒 1 次**，
 * 一趟多查询任务必然排队并偶发 429；且 `paper_fetch` 曾绕过该节流裸调 fetch，
 * 把「搜索被限流」放大成「保存也一直失败」。用户实测反馈「这个接口太拉了」。
 *
 * ── 方案（成熟公开 API，非自研）───────────────────────────────────────────
 * 三源并行 + 按 id 解析回退链，全部免 key：
 * - **OpenAlex**（主检索源）：完全免费、无严格限流感（礼貌池 10 万次/天），
 *   覆盖 arXiv 预印本与期刊正式版，支持 DOI / arXiv id 直取；
 * - **Semantic Scholar Graph API**（辅助匹配）：标题精确匹配（search/match）质量好；
 *   ⚠️ 实测其 search 端点共享 IP 配额常 429，match/by-id 端点较宽松——因此它只做
 *   「已知标题 → 论文」的匹配，不做关键词浏览，且失败静默降级不阻塞；
 * - **arXiv API**（新鲜度补充）：OpenAlex/S2 对**刚提交数日内的预印本**收录有延迟，
 *   合并结果时用 arXiv 补最近新论文（走既有 3s 节流队列，只发一次）。
 *
 * ── id 口径 ────────────────────────────────────────────────────────────────
 * 文献库以「裸 arXiv id」为主键（PaperRecord.arxivId）。本层把所有来源归一成同一
 * ArxivEntry 形状：非 arXiv 出版物用 `doi:xxx` 作 id（可入库、可导出 BibTeX），
 * url 指向其落地页。下游 importPaper / set_paper / bibtex 不需要感知来源差异。
 */
import type { ArxivEntry } from '../library/types'

const FETCH_TIMEOUT_MS = 15_000
const CACHE_TTL_MS = 15 * 60 * 1000
const MAX_CACHE_ENTRIES = 200
/**
 * OpenAlex「礼貌池」标识：在请求里带上可联系的邮箱（mailto），OpenAlex 会把它路由到
 * 响应更好的礼貌队列，比匿名裸调更稳定（成熟实践）。这是公开的项目联系邮箱，非隐私信息。
 */
const OPENALEX_MAILTO = 'hxhy@users.noreply.github.com'
/** S2 全局最小请求间隔（共享 IP 配额脆弱，主动降频比撞 429 后退避更省时间）。 */
const S2_MIN_INTERVAL_MS = 1200
/** S2 429 后的冷却时长。 */
const S2_COOL_DOWN_MS = 30_000

const cache = new Map<string, { at: number; value: ArxivEntry[] }>()
let s2LastRequestAt = 0
let s2CoolUntil = 0

function readCache(key: string): ArxivEntry[] | undefined {
  const hit = cache.get(key)
  if (hit === undefined) return undefined
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key)
    return undefined
  }
  return hit.value
}

function writeCache(key: string, value: ArxivEntry[]): void {
  if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(key)) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  cache.set(key, { at: Date.now(), value })
}

async function getJson(url: string, headers?: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    ...(headers !== undefined ? { headers } : {})
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

// ─── OpenAlex（主源）──────────────────────────────────────────────────────

interface OpenAlexWork {
  id?: string
  doi?: string | null
  title?: string | null
  display_name?: string | null
  publication_year?: number | null
  publication_date?: string | null
  authorships?: Array<{ authors?: Array<{ display_name?: string | null }> }>
  primary_location?: { source?: { display_name?: string | null } | null } | null
  best_oa_location?: { landing_page_url?: string | null; pdf_url?: string | null } | null
  abstract_inverted_index?: Record<string, number[][]> | null
}

/** OpenAlex 用倒排索引存摘要；重建成普通文本（截断即可，检索展示够用）。 */
function rebuildAbstract(inv: OpenAlexWork['abstract_inverted_index']): string {
  if (inv === null || inv === undefined) return ''
  const positions: Array<[number, string]> = []
  for (const [word, idxs] of Object.entries(inv)) {
    for (const i of (idxs as number[][]).flat()) positions.push([i, word])
  }
  positions.sort((a, b) => a[0] - b[0])
  return positions.map(([, w]) => w).join(' ').slice(0, 1200)
}

function openAlexArxivId(work: OpenAlexWork): string | null {
  const urls = [work.best_oa_location?.landing_page_url ?? '', work.primary_location?.source?.display_name ?? '']
  for (const u of urls) {
    const m = /arxiv\.org\/abs\/([\w.\-/]+?)(?:v\d+)?(?:[?#].*)?$/.exec(u)
    if (m?.[1] !== undefined) return m[1]
  }
  // DOI 前缀 10.48550/arXiv.xxxx 也是 arXiv 的注册 DOI
  const doi = work.doi ?? ''
  const dm = /10\.48550\/arxiv\.([\w.\-/]+)/i.exec(doi)
  return dm?.[1] ?? null
}

function toEntryFromOpenAlex(work: OpenAlexWork): ArxivEntry {
  const arxivId = openAlexArxivId(work)
  const authors = (work.authorships ?? [])
    .flatMap((a) => (a.authors ?? []).map((x) => x.display_name ?? ''))
    .filter((n) => n !== '')
  const title = (work.title ?? work.display_name ?? '').replace(/\s+/g, ' ').trim()
  return {
    id: arxivId ?? (work.doi ?? work.id ?? title).replace(/^https?:\/\/doi\.org\//, ''),
    title,
    authors,
    summary: rebuildAbstract(work.abstract_inverted_index),
    published: work.publication_date ?? (work.publication_year !== undefined ? `${work.publication_year}-01-01` : ''),
    url: arxivId !== null ? `https://arxiv.org/abs/${arxivId}` : work.doi ?? work.id ?? '',
    source: 'openalex'
  }
}

async function openAlexSearch(query: string, limit: number): Promise<ArxivEntry[]> {
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${Math.min(limit, 50)}&mailto=${OPENALEX_MAILTO}&select=id,doi,title,display_name,publication_year,publication_date,authorships,primary_location,best_oa_location,abstract_inverted_index`
  const data = (await getJson(url)) as { results?: OpenAlexWork[] }
  return (data.results ?? []).map(toEntryFromOpenAlex).filter((e) => e.title !== '')
}

/** 按 arXiv id / DOI 直取一篇（OpenAlex filter）。 */
async function openAlexById(idOrDoi: string): Promise<ArxivEntry | null> {
  const clean = idOrDoi.trim().replace(/v\d+$/, '')
  const target = /^10\./.test(clean) || clean.startsWith('doi:')
    ? `doi:${clean.replace(/^doi:/, '')}`
    : `arxiv:${clean}`
  const url = `https://api.openalex.org/works?filter=${encodeURIComponent(target)}&per-page=1&mailto=${OPENALEX_MAILTO}&select=id,doi,title,display_name,publication_year,publication_date,authorships,primary_location,best_oa_location,abstract_inverted_index`
  try {
    const data = (await getJson(url)) as { results?: OpenAlexWork[] }
    const first = data.results?.[0]
    return first !== undefined ? toEntryFromOpenAlex(first) : null
  } catch {
    return null
  }
}

// ─── Semantic Scholar（辅助：标题精确匹配）───────────────────────────────

interface S2Paper {
  title?: string
  abstract?: string | null
  year?: number | null
  publicationDate?: string | null
  url?: string
  externalIds?: { ArXiv?: string | null; DOI?: string | null }
  authors?: Array<{ name?: string }>
}

/** S2 串行节流 + 冷却；返回 false 表示「现在不该发」（让调用方静默降级）。 */
async function s2Gate(): Promise<boolean> {
  const now = Date.now()
  if (now < s2CoolUntil) return false
  const wait = s2LastRequestAt + S2_MIN_INTERVAL_MS - now
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  s2LastRequestAt = Date.now()
  return true
}

async function s2Fetch(url: string): Promise<S2Paper | null> {
  if (!(await s2Gate())) return null
  try {
    const data = (await getJson(url)) as S2Paper & { data?: S2Paper[] }
    return (data.data?.[0] ?? (data.title !== undefined ? data : null)) ?? null
  } catch (error) {
    const msg = error instanceof Error ? error.message : ''
    if (msg.includes('429')) s2CoolUntil = Date.now() + S2_COOL_DOWN_MS
    return null
  }
}

function toEntryFromS2(p: S2Paper): ArxivEntry | null {
  const title = (p.title ?? '').replace(/\s+/g, ' ').trim()
  if (title === '') return null
  const arxivId = p.externalIds?.ArXiv ?? null
  const doi = p.externalIds?.DOI ?? null
  return {
    id: arxivId ?? doi ?? title,
    title,
    authors: (p.authors ?? []).map((a) => a.name ?? '').filter((n) => n !== ''),
    summary: (p.abstract ?? '').replace(/\s+/g, ' '),
    published: p.publicationDate ?? (p.year !== undefined ? `${p.year}-01-01` : ''),
    url: arxivId !== null ? `https://arxiv.org/abs/${arxivId}` : p.url ?? doi ?? '',
    source: 'semantic-scholar'
  }
}

/** 标题 → 论文的精确匹配（match 端点配额较 search 宽松；失败返回 null 由上层降级）。 */
async function s2MatchTitle(title: string): Promise<ArxivEntry | null> {
  const fields = 'title,abstract,year,publicationDate,url,externalIds,authors'
  const p = await s2Fetch(`https://api.semanticscholar.org/graph/v1/paper/search/match?query=${encodeURIComponent(title)}&fields=${fields}`)
  return p !== null ? toEntryFromS2(p) : null
}

/** 按 arXiv id 读单篇（S2 by-id；OpenAlex 失败时的第二回退）。 */
async function s2ByArxivId(arxivId: string): Promise<ArxivEntry | null> {
  const fields = 'title,abstract,year,publicationDate,url,externalIds,authors'
  const p = await s2Fetch(`https://api.semanticscholar.org/graph/v1/paper/arXiv:${encodeURIComponent(arxivId)}?fields=${fields}`)
  return p !== null ? toEntryFromS2(p) : null
}

// ─── 对外 API ─────────────────────────────────────────────────────────────

/**
 * 关键词检索：OpenAlex 为主，arXiv 补充最新预印本（去重合并）。
 * arXiv 侧失败（限流等）不影响整体——OpenAlex 结果照常返回。
 * @param arxivSupplement 可选注入 arXiv 检索函数（生产传 arxivSearch 的 exec 封装；
 *                        单测传 fake，避免真实网络）。
 */
export async function searchPapers(
  query: string,
  limit: number,
  arxivSupplement?: (q: string, n: number) => Promise<ArxivEntry[]>
): Promise<ArxivEntry[]> {
  const q = query.trim()
  if (q === '') return []
  const key = `search:${q}:${limit}`
  const cached = readCache(key)
  if (cached !== undefined) return cached

  let entries: ArxivEntry[] = []
  const errors: string[] = []
  try {
    entries = await openAlexSearch(q, limit)
  } catch (error) {
    errors.push(`OpenAlex: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (arxivSupplement !== undefined) {
    try {
      const fresh = await arxivSupplement(q, Math.min(limit, 10))
      const seen = new Set(entries.map((e) => normId(e.id)))
      for (const f of fresh) {
        if (!seen.has(normId(f.id))) entries.push({ ...f, source: f.source ?? 'arxiv' })
      }
    } catch {
      // arXiv 补充失败是预期内降级路径，不算错
    }
  }
  if (entries.length === 0 && errors.length > 0) {
    throw new Error(`文献检索失败（${errors.join('；')}）。可稍后重试或改用 web_search 找线索。`)
  }
  const merged = entries.slice(0, limit)
  if (merged.length > 0) writeCache(key, merged)
  return merged
}

/**
 * 按 id 解析一篇论文元数据（paper_fetch 用）。
 * 回退链：OpenAlex（arxiv/doi 直取）→ Semantic Scholar by-id → S2 标题匹配不适用。
 * 全部失败时抛错，错误信息如实列出各源状态（供 Agent 向用户解释，不再谎称"限流相关"）。
 */
export async function resolvePaperById(idOrDoi: string): Promise<ArxivEntry> {
  const clean = idOrDoi.trim().replace(/^https?:\/\/arxiv\.org\/(abs|pdf)\//, '').replace(/v\d+$/, '')
  if (clean === '') throw new Error('无效的论文 id。')
  const key = `id:${clean.toLowerCase()}`
  const cached = readCache(key)?.[0]
  if (cached !== undefined) return cached

  const viaOpenAlex = await openAlexById(clean)
  if (viaOpenAlex !== null) {
    writeCache(key, [viaOpenAlex])
    return viaOpenAlex
  }
  if (!/^10\.|^doi:/i.test(clean)) {
    const viaS2 = await s2ByArxivId(clean)
    if (viaS2 !== null) {
      writeCache(key, [viaS2])
      return viaS2
    }
  }
  throw new Error(
    `未能在 OpenAlex / Semantic Scholar 解析 id「${clean}」。` +
      '若这是刚提交的 arXiv 预印本，数据库可能尚未收录——可稍后用 arxiv_fetch_paper 直读 arXiv，或告诉我论文标题让我按标题检索。'
  )
}

/** 标题 → 论文（用于「只有标题没有 id」的入库场景；GUI 网页结果导入也复用）。 */
export async function matchPaperByTitle(title: string): Promise<ArxivEntry | null> {
  const t = title.trim()
  if (t === '') return null
  const key = `title:${t.toLowerCase()}`
  const cached = readCache(key)?.[0]
  if (cached !== undefined) return cached
  const hit = await s2MatchTitle(t)
  if (hit !== null) writeCache(key, [hit])
  return hit
}

/** id 归一（比较用）：去 URL 前缀与版本后缀、小写。 */
function normId(id: string): string {
  return id
    .replace(/^https?:\/\/arxiv\.org\/(abs|pdf)\//, '')
    .replace(/^doi:/i, '')
    .replace(/v\d+$/, '')
    .toLowerCase()
}
