/**
 * 文献检索统一访问层（主进程）。
 *
 * ── 背景（为什么换接口）────────────────────────────────────────────────────
 * 旧实现直连 `export.arxiv.org` 公共 API：无 key、官方 ToS 限速 **3 秒 1 次**，
 * 一趟多查询任务必然排队并偶发 429；且 `paper_fetch` 曾绕过该节流裸调 fetch，
 * 把「搜索被限流」放大成「保存也一直失败」。用户实测反馈「这个接口太拉了」。
 *
 * ── 方案（成熟公开 API，非自研）───────────────────────────────────────────
 * 三源分工 + 按 id 解析回退链，全部免 key：
 * - **OpenAlex**（主检索源）：完全免费，支持 DOI / arXiv id 直取；
 *   查询用官方推荐的 `filter=title_and_abstract.search:`（命中专用索引，相关度与
 *   性能都优于裸 `search=` 全文模式）；单篇直取走 singleton 端点 `/works/doi:{doi}`
 *   （官方计费为零，比 filter 列表查询省额度）。
 *   ⚠️ OpenAlex 已于 2025 年起转向 **API Key + 每日预算制**：旧 `mailto` 礼貌池不再
 *   提供配额增益（参数仍被接受但无收益）。推荐申请免费 key（额度 ×10，settings.
 *   openAlexApiKey 或环境变量 MIMIR_OPENALEX_API_KEY）；未配置时回退 mailto 标识。
 *   单篇解析链条里有一步 `filter=doi:10.48550/arxiv.{id}`：OpenAlex 对 arXiv 预印本的
 *   DOI 映射**覆盖率不完整**（实测 ResNet/VGG 命中、Attention 未命中），因此只能当
 *   arXiv id 的中间回退，不能当主路径；
 * - **Semantic Scholar Graph API**（语义检索 + 标题匹配 + 按 id 兜底）：
 *   · `search/vector`：把概念 query 嵌入向量空间做纯语义匹配，适合关键词宽泛的调研；
 *   · `search/match`：「已知标题 → 论文」的精确匹配；
 *   ⚠️ 传统 search 端点共享 IP 配额常 429，vector/match/by-id 较宽松——失败一律
 *   静默降级不阻塞；
 *   💡 S2 key 官方免费申请（settings.s2ApiKey 或环境变量 MIMIR_S2_API_KEY）：
 *   节流自动放宽到 200ms、429 只冷却 5s 而非 30s，本层最脆弱的一环基本消失；
 * - **arXiv API**（检索：新鲜度补充；解析：arXiv id 的**主源**）：OpenAlex/S2 对
 *   **刚提交数日内的预印本**收录有延迟。关键词检索时只有当 OpenAlex 结果的最新发表
 *   日期距今 ≤ FRESHNESS_WINDOW_DAYS（说明该主题近期活跃）时才补一次 arXiv——大多数
 *   主题检索根本不产生 arXiv 请求。而**按 arXiv id 解析单篇**时 arXiv 官方 API 是主源：
 *   `id_list` 直查 100% 命中（不依赖第三方 id 映射），且复用 arxivSearch 既有节流/
 *   批量合并/缓存，不新增限流暴露面。
 *
 * ── id 口径 ────────────────────────────────────────────────────────────────
 * 文献库以「裸 arXiv id」为主键（PaperRecord.arxivId）。本层把所有来源归一成同一
 * ArxivEntry 形状：非 arXiv 出版物用 `doi:xxx` 作 id（可入库、可导出 BibTeX），
 * url 指向其落地页。下游 importPaper / set_paper / bibtex 不需要感知来源差异。
 */
import type { ArxivEntry } from '../library/types'
import { httpFetch } from '../http'

const FETCH_TIMEOUT_MS = 15_000
const CACHE_TTL_MS = 15 * 60 * 1000
const MAX_CACHE_ENTRIES = 200
/**
 * OpenAlex 联系标识：历史上走「礼貌池」（mailto），现已转为 API Key 预算制——
 * mailto 仍被接受但不再提供配额增益，作为未配置 key 时的兜底标识保留。
 * 这是公开的项目联系邮箱，非隐私信息。
 */
const OPENALEX_MAILTO = 'hxhy@users.noreply.github.com'
/** S2 全局最小请求间隔（共享 IP 配额脆弱，主动降频比撞 429 后退避更省时间）。 */
const S2_MIN_INTERVAL_MS = 1200
/** S2 429 后的冷却时长。 */
const S2_COOL_DOWN_MS = 30_000
/**
 * arXiv 新鲜度补充窗口（天）：OpenAlex 结果最新发表日期距今 ≤ 该值时，说明主题近期
 * 活跃、OpenAlex 可能尚未收录新提交，才值得补一次 arXiv；否则跳过（省掉 3s 排队与 429 风险）。
 */
export const FRESHNESS_WINDOW_DAYS = 7

const cache = new Map<string, { at: number; value: ArxivEntry[] }>()
let s2LastRequestAt = 0
let s2CoolUntil = 0

/** 测试钩子：清空模块级检索缓存（跨用例串扰防护，不参与生产调用路径）。 */
export function __resetCacheForTest(): void {
  cache.clear()
}

/**
 * S2 API key 读取接缝：设置页 `settings.s2ApiKey` 优先，环境变量兜底。
 *
 * 不直读 process.env：打包后 main 是 ESM bundle，Rollup 会把 `process.env.X`
 * 静态替换成构建期常量（运行时改值失效）。经此接缝注入后，store 里的设置能即时生效，
 * 单测也可直接 setS2KeyProvider 打桩。
 */
let s2KeyProvider: () => string = () => process.env['MIMIR_S2_API_KEY'] ?? ''
export function setS2KeyProvider(provider: () => string): void {
  s2KeyProvider = provider
}
/** 测试钩子：恢复默认 provider（环境变量），避免用例间串扰。 */
export function __resetS2KeyProvider(): void {
  s2KeyProvider = () => process.env['MIMIR_S2_API_KEY'] ?? ''
}
function hasS2Key(): boolean {
  return s2KeyProvider().trim() !== ''
}

/**
 * OpenAlex API key 读取接缝：设置页 `settings.openAlexApiKey` 优先，环境变量兜底。
 * 与 S2 key 同一套理由：打包后 ESM bundle 里 `process.env.X` 被构建期静态替换，
 * 经接缝注入后 store 设置即时生效，单测可打桩。
 */
let openAlexKeyProvider: () => string = () => process.env['MIMIR_OPENALEX_API_KEY'] ?? ''
export function setOpenAlexKeyProvider(provider: () => string): void {
  openAlexKeyProvider = provider
}
/** 测试钩子：恢复默认 provider（环境变量）。 */
export function __resetOpenAlexKeyProvider(): void {
  openAlexKeyProvider = () => process.env['MIMIR_OPENALEX_API_KEY'] ?? ''
}

/** OpenAlex 鉴权参数：配了免费 API key 走账号配额（额度 ×10），否则回退 mailto 标识。 */
function openAlexAuth(): string {
  const key = openAlexKeyProvider().trim()
  return key !== '' ? `api_key=${encodeURIComponent(key)}` : `mailto=${OPENALEX_MAILTO}`
}

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
  const response = await httpFetch(url, {
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
  // OpenAlex 已给出 OA 版本时顺手带回来（免一次 Unpaywall 请求）；注意 pdf_url 常为
  // null 而只有 landing_page_url（机构库/出版商页），那种情况留给下载时的瀑布链处理。
  const oaPdf = (work.best_oa_location?.pdf_url ?? '').trim()
  return {
    id: arxivId ?? (work.doi ?? work.id ?? title).replace(/^https?:\/\/doi\.org\//, ''),
    title,
    authors,
    summary: rebuildAbstract(work.abstract_inverted_index),
    published: work.publication_date ?? (work.publication_year !== undefined ? `${work.publication_year}-01-01` : ''),
    url: arxivId !== null ? `https://arxiv.org/abs/${arxivId}` : work.doi ?? work.id ?? '',
    source: 'openalex',
    ...(oaPdf !== '' && arxivId === null ? { pdfUrl: oaPdf, pdfSource: 'openalex-oa' } : {})
  }
}

const OPENALEX_SELECT = 'id,doi,title,display_name,publication_year,publication_date,authorships,primary_location,best_oa_location,abstract_inverted_index'

async function openAlexSearch(query: string, limit: number): Promise<ArxivEntry[]> {
  // 官方推荐查询用 title_and_abstract.search 过滤（命中专用索引，比裸 search= 全文模式
  // 相关度更好、返回更省）；引号包裹使多词 query 按短语邻近匹配。
  const url = `https://api.openalex.org/works?filter=${encodeURIComponent(`title_and_abstract.search:"${query}"`)}&per-page=${Math.min(limit, 50)}&${openAlexAuth()}&select=${OPENALEX_SELECT}`
  const data = (await getJson(url)) as { results?: OpenAlexWork[] }
  return (data.results ?? []).map(toEntryFromOpenAlex).filter((e) => e.title !== '')
}

/** 结果里最新的发表日期（ISO 字符串），全部缺失时返回 null。 */
function latestPublishedAt(entries: ArxivEntry[]): string | null {
  let latest: string | null = null
  for (const e of entries) {
    if (e.published === '' || Number.isNaN(Date.parse(e.published))) continue
    if (latest === null || Date.parse(e.published) > Date.parse(latest)) latest = e.published
  }
  return latest
}

/**
 * arXiv 新鲜度补充是否值得做：OpenAlex 最新结果距今 ≤ FRESHNESS_WINDOW_DAYS 说明主题
 * 近期活跃（新预印本可能未收录）→ 补；否则跳过，不产生 arXiv 请求。
 * 导出供调用方（paper_search 工具 / libraryService）共享同一门槛。
 */
export function shouldSupplementArxiv(openAlexEntries: ArxivEntry[]): boolean {
  const latest = latestPublishedAt(openAlexEntries)
  if (latest === null) return false
  const ageDays = (Date.now() - Date.parse(latest)) / 86_400_000
  return ageDays <= FRESHNESS_WINDOW_DAYS
}

/** S2 向量语义检索：概念 query → 论文列表（配额较传统 search 宽松；失败返回 []）。 */
async function s2VectorSearch(query: string, limit: number): Promise<ArxivEntry[]> {
  const fields = 'title,abstract,year,publicationDate,url,externalIds,authors'
  if (!(await s2Gate())) return []
  try {
    const data = (await getJson(
      `https://api.semanticscholar.org/graph/v1/paper/search/vector?query=${encodeURIComponent(query)}&limit=${Math.min(limit, 50)}&fields=${fields}`,
      s2KeyHeader()
    )) as { data?: S2Paper[] }
    return (data.data ?? []).map(toEntryFromS2).filter((e): e is ArxivEntry => e !== null)
  } catch (error) {
    const msg = error instanceof Error ? error.message : ''
    if (msg.includes('429')) s2CoolUntil = Date.now() + (hasS2Key() ? 5_000 : S2_COOL_DOWN_MS)
    return []
  }
}

/**
 * 按 DOI 直取一篇（OpenAlex **singleton** 端点 `/works/doi:{doi}`）。
 *
 * 为什么不用 filter 列表查询：官方按端点计费——singleton 免费，`?filter=` 每次扣额度；
 * 且语义上「按 id 取一篇」就是单实体读取。404（未收录）与 429/5xx 在这里语义不同：
 * 404 返回 null 让调用方走回退链；429/5xx 已由 http 层退避重试过，仍失败则视为源暂不可用，
 * 同样返回 null（错误语义由调用方 resolvePaperById 统一呈现）。
 */
async function openAlexByDoi(doi: string): Promise<ArxivEntry | null> {
  const url = `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?${openAlexAuth()}&select=${OPENALEX_SELECT}`
  try {
    const data = (await getJson(url)) as OpenAlexWork
    return data.id !== undefined ? toEntryFromOpenAlex(data) : null
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
  // 配了 API key 就走账号配额（官方 1 req/s 起），共享 IP 的熔断困境不复存在，
  // 因此不再需要 1.2s 的保守间隔——用 200ms 让有 key 的用户明显更快。
  const interval = hasS2Key() ? 200 : S2_MIN_INTERVAL_MS
  const wait = s2LastRequestAt + interval - now
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  s2LastRequestAt = Date.now()
  return true
}

/** S2 请求头：带 key 时走账号配额（官方免费申请）。 */
function s2KeyHeader(): Record<string, string> | undefined {
  const key = s2KeyProvider().trim()
  return key !== '' ? { 'x-api-key': key } : undefined
}

async function s2Fetch(url: string): Promise<S2Paper | null> {
  if (!(await s2Gate())) return null
  try {
    const data = (await getJson(url, s2KeyHeader())) as S2Paper & { data?: S2Paper[] }
    return (data.data?.[0] ?? (data.title !== undefined ? data : null)) ?? null
  } catch (error) {
    const msg = error instanceof Error ? error.message : ''
    // 带 key 时 429 通常是瞬时抖动，仍按冷却处理但缩短；无 key 时共享 IP 配额脆弱，冷却更久
    if (msg.includes('429')) {
      s2CoolUntil = Date.now() + (hasS2Key() ? 5_000 : S2_COOL_DOWN_MS)
    }
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

/** 合并去重：把 supplement 中未出现过的条目追加进 entries（按归一 id）。 */
function mergeDedup(entries: ArxivEntry[], supplement: ArxivEntry[]): void {
  const seen = new Set(entries.map((e) => normId(e.id)))
  for (const f of supplement) {
    if (!seen.has(normId(f.id))) entries.push({ ...f, source: f.source ?? 'arxiv' })
  }
}

/**
 * 关键词检索：OpenAlex 为主源；结果近期活跃时补 arXiv 最新预印本；
 * OpenAlex 空/失败时用 S2 向量语义检索兜底。
 * 任一补充源失败都不影响整体——有多少结果返回多少。
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
  // arXiv 新鲜度补充是**条件触发**：只有 OpenAlex 结果显示该主题近 FRESHNESS_WINDOW_DAYS
  // 天内仍有新论文（收录可能滞后）时才补一次。跳过它等于同时省掉 3s 节流排队与 429 暴露面。
  if (arxivSupplement !== undefined && shouldSupplementArxiv(entries)) {
    try {
      mergeDedup(entries, await arxivSupplement(q, Math.min(limit, 10)))
    } catch {
      // arXiv 补充失败是预期内降级路径，不算错
    }
  }
  // OpenAlex 空手而归（查询过宽/措辞罕见）→ S2 向量语义检索兜底（概念匹配，静默降级）。
  if (entries.length === 0) {
    mergeDedup(entries, await s2VectorSearch(q, limit))
  }
  if (entries.length === 0 && errors.length > 0) {
    throw new Error(`文献检索失败（${errors.join('；')}）。可稍后重试或改用 web_search 找线索。`)
  }
  const merged = entries.slice(0, limit)
  if (merged.length > 0) writeCache(key, merged)
  return merged
}

/**
 * 按 id 解析一篇论文元数据（paper_fetch / arxiv_fetch_paper 用）。
 *
 * 回退链（按「该 id 类型最权威的源优先」排列）：
 * - **arXiv id** → ① arXiv 官方 `id_list`（100% 命中，不依赖第三方 id 映射；
 *   复用 arxivSearch 的节流/批量合并/缓存）→ ② OpenAlex singleton（DOI 通道
 *   `doi:10.48550/arxiv.{id}`，⚠️ 映射覆盖不完整，实测部分老预印本缺失）→
 *   ③ Semantic Scholar by-id（共享 IP 配额脆弱，最后兜底）；
 * - **DOI** → ① OpenAlex singleton（免费且权威）→ ②（S2 by-DOI 未实现：S2 的
 *   引用图价值不在元数据，DOI 主源失败时极少需要它）。
 *
 * 全部失败时抛错，错误信息如实列出各源状态（供 Agent 向用户解释，不再谎称"限流相关"）。
 */
export async function resolvePaperById(idOrDoi: string): Promise<ArxivEntry> {
  const clean = idOrDoi.trim().replace(/^https?:\/\/arxiv\.org\/(abs|pdf)\//, '').replace(/v\d+$/, '')
  if (clean === '') throw new Error('无效的论文 id。')
  const key = `id:${clean.toLowerCase()}`
  const cached = readCache(key)?.[0]
  if (cached !== undefined) return cached

  const isDoi = /^10\.|^doi:/i.test(clean)

  // ① arXiv id 主源：arXiv 官方 id_list（网络异常/限流时静默落到下一级）
  if (!isDoi) {
    const viaArxiv = await arxivByOfficialApi(clean)
    if (viaArxiv !== null) {
      writeCache(key, [viaArxiv])
      return viaArxiv
    }
  }

  // ② OpenAlex singleton：arXiv id 走其注册 DOI（10.48550/arxiv.{id}），DOI 直接查
  const viaOpenAlex = await openAlexByDoi(
    isDoi ? clean.replace(/^doi:/i, '') : `10.48550/arxiv.${clean}`
  )
  if (viaOpenAlex !== null) {
    writeCache(key, [viaOpenAlex])
    return viaOpenAlex
  }

  // ③ S2 by-id：仅 arXiv id（DOI 无对应路径）
  if (!isDoi) {
    const viaS2 = await s2ByArxivId(clean)
    if (viaS2 !== null) {
      writeCache(key, [viaS2])
      return viaS2
    }
  }

  throw new Error(
    `未能在 arXiv / OpenAlex / Semantic Scholar 解析 id「${clean}」。` +
      '若这是刚提交的 arXiv 预印本，官方 API 也查不到时请核对 id 是否正确；' +
      'DOI 形式请确认前缀与后缀无误。也可以告诉我论文标题，我按标题检索。'
  )
}

/**
 * arXiv 官方 API 按 id 直取（依赖注入避免循环依赖：实现转发到 arxivSearch 模块的
 * 批量合并读取，与生产共用同一份节流/缓存；单测注入 fake 不打真实网络）。
 */
let arxivOfficialFetcher: (arxivId: string) => Promise<ArxivEntry | null> = async (arxivId) => {
  const { fetchArxivEntriesByIds } = await import('./tools/arxivSearch')
  const entries = await fetchArxivEntriesByIds([arxivId])
  return entries[0] ?? null
}
export function setArxivOfficialFetcher(fn: (arxivId: string) => Promise<ArxivEntry | null>): void {
  arxivOfficialFetcher = fn
}
async function arxivByOfficialApi(arxivId: string): Promise<ArxivEntry | null> {
  try {
    return await arxivOfficialFetcher(arxivId)
  } catch {
    // arXiv 侧限流/网络错误是预期内降级：转 OpenAlex DOI 通道
    return null
  }
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
