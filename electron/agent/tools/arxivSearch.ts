import { tool } from 'langchain/tools'
import { z } from 'zod'

interface ArxivEntry {
  id: string
  title: string
  authors: string[]
  summary: string
  published: string
  link: string
}

/**
 * arXiv 访问节流层（进程内全局共享，Supervisor 与其模块子 Agent 共用同一实例）。
 *
 * 背景：export.arxiv.org 是无 key 的公共 API，限流很敏感；Supervisor 委派
 * 模块子 Agent 时会对相近关键词反复发起 arxiv_search / arxiv_fetch_paper，
 * 瞬间把接口打爆（HTTP 429）。这里的三个机制用来压低外部请求次数：
 *
 * 1. 结果缓存：同 key（关键词 + 数量 + 排序 / 论文 id）短时 TTL 内直接复用，
 *    重复查询不再发 HTTP；
 * 2. 在途合并：同一 key 的并发调用共享同一个 pending Promise，网络只发一次；
 * 3. 串行节流：所有 arXiv 请求经一条队列逐次发出、间隔 ≥150ms，
 *    避免不同查询在同一瞬间并发打到接口。
 *
 * 仅成功的正常结果（含“未找到”）写入缓存；HTTP 错误/限流/异常不缓存。
 */
const CACHE_TTL_MS = 15 * 60 * 1000
const MAX_CACHE_ENTRIES = 200
/** 相邻两个 arXiv 请求的最小间隔（加大并加抖动，降低对公共接口的瞬时压力）。 */
const MIN_REQUEST_INTERVAL_MS = 250
/** 间隔抖动上限（ms），错开并发调用方的同秒打点。 */
const INTERVAL_JITTER_MAX_MS = 80
/** 命中 429 后的冷却截止（ms）：冷却期内不再对外直发，避免连续空撞。 */
let arxivCoolUntil = 0
/** 429 冷却时长。 */
const ARXIV_COOL_DOWN_MS = 20_000
/** 单篇元数据读取的批量合并参数：窗口内多个 id 合并为一次 HTTP。 */
const FETCH_BATCH_WINDOW_MS = 150
const FETCH_BATCH_MAX_IDS = 20

const arxivCache = new Map<string, { at: number; value: string }>()
const inflight = new Map<string, Promise<string>>()
let requestTail: Promise<void> = Promise.resolve()
let lastRequestAt = 0

function arxivCacheKey(parts: Record<string, string | number>): string {
  return Object.keys(parts)
    .sort()
    .map((k) => `${k}=${parts[k]}`)
    .join('&')
}

function readCache(key: string): string | undefined {
  const hit = arxivCache.get(key)
  if (hit === undefined) return undefined
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    arxivCache.delete(key)
    return undefined
  }
  return hit.value
}

function writeCache(key: string, value: string): void {
  if (arxivCache.size >= MAX_CACHE_ENTRIES && !arxivCache.has(key)) {
    const oldest = arxivCache.keys().next()
    if (!oldest.done) arxivCache.delete(oldest.value)
  }
  arxivCache.set(key, { at: Date.now(), value })
}

/** 串行化 arXiv 网络请求：排队依次发出，保证前后间隔。 */
function runSerialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = requestTail.then(async () => {
    const waitMs = lastRequestAt + MIN_REQUEST_INTERVAL_MS + Math.random() * INTERVAL_JITTER_MAX_MS - Date.now()
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs))
    lastRequestAt = Date.now()
    return await fn()
  })
  requestTail = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/**
 * 带缓存 + 在途合并 + 串行节流的执行器。
 * http() 返回的字符串即为最终工具结果；HTTP 错误文本由 http() 自行返回
 * 但不应写入缓存，因此 http() 用 Error 表达「不应缓存」的失败更简单——
 * 本实现约定：正常结果与“未找到”直接返回字符串；限流/HTTP 错误抛出带
 * 前缀的 Error，由调用方转成中文文本（不缓存）。
 */
/** 冷却期/繁忙提示（抛错 → 不缓存，提示 Agent 稍候或减量）。 */
function busyError(): never {
  throw new Error('arXiv 服务繁忙（已进入短暂冷却，避免连续空撞公共接口）：请稍等约 30 秒后重试，或减少同一任务的检索/读取次数。')
}

async function execArxiv<THttp extends () => Promise<string>>(key: string, http: THttp): Promise<string> {
  // 429 冷却期内不再对外直发
  if (Date.now() < arxivCoolUntil) busyError()
  const cached = readCache(key)
  if (cached !== undefined) return cached
  const pending = inflight.get(key)
  if (pending !== undefined) return pending
  const promise = runSerialized(http).then((value) => {
    writeCache(key, value)
    return value
  })
  inflight.set(key, promise)
  try {
    return await promise
  } finally {
    inflight.delete(key)
  }
}

/** 校验非 2xx 的 arXiv 响应，并给出可读的中文失败信息（抛错 → 不缓存）。429 会启动全局冷却。 */
function raiseHttpError(status: number): never {
  if (status === 429) {
    arxivCoolUntil = Date.now() + ARXIV_COOL_DOWN_MS
    throw new Error('arXiv API 限流（HTTP 429）：请求过于频繁，已自动合并重复查询并进入短暂冷却，请稍等约 30 秒再试。')
  }
  throw new Error(`arXiv API 请求失败: HTTP ${status}`)
}

// ─── 单篇元数据批量读取（arxiv_fetch_paper）───────────────────────────
interface FetchPending {
  resolve: (value: string) => void
  reject: (error: Error) => void
}
/** cleanId -> 等待该篇的调用方（同篇并发只等一份）。 */
const fetchRequests = new Map<string, FetchPending[]>()
let fetchTimer: NodeJS.Timeout | null = null

/** 归一化 arXiv id：去 URL 前缀与版本后缀（2301.12345v2 → 2301.12345）。 */
function normalizeArxivId(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\/arxiv\.org\/(abs|pdf)\//, '')
    .replace(/v\d+$/, '')
}

/** 与单篇原有展示一致的结果文本。 */
function formatFetchText(cleanId: string, e: ArxivEntry): string {
  return (
    `### ${e.title}\n` +
    `- arXiv id: ${cleanId}\n` +
    `- 作者: ${e.authors.join(', ')}\n` +
    `- 发布时间: ${e.published}\n` +
    `- 链接: ${e.link}\n` +
    `- 摘要: ${e.summary}`
  )
}

/** 到点把积攒的多篇读取合并成一次 HTTP（id_list=a,b,c），按 id 分发给各调用方。 */
async function flushFetchBatch(): Promise<void> {
  fetchTimer = null
  const entries = [...fetchRequests.entries()]
  const batch = entries.slice(0, FETCH_BATCH_MAX_IDS)
  // 超过单批上限的剩余 id 进入下一窗口处理
  if (entries.length > FETCH_BATCH_MAX_IDS) {
    fetchTimer = setTimeout(() => {
      void flushFetchBatch()
    }, FETCH_BATCH_WINDOW_MS)
  }
  const ids = batch.map(([id]) => id)
  for (const [id] of batch) fetchRequests.delete(id)
  if (ids.length === 0) return

  const http = async (): Promise<string> => {
    const url = `https://export.arxiv.org/api/query?id_list=${ids.map(encodeURIComponent).join(',')}&max_results=${ids.length}`
    const response = await fetch(url)
    if (!response.ok) raiseHttpError(response.status)
    return response.text()
  }
  try {
    const xml = await runSerialized(http)
    const byId = new Map<string, ArxivEntry>()
    for (const entry of parseArxivXml(xml)) byId.set(normalizeArxivId(entry.id), entry)
    for (const [id, pendings] of batch) {
      const entry = byId.get(id)
      const text = entry !== undefined ? formatFetchText(id, entry) : `arXiv 中未找到 id 为 '${id}' 的记录。`
      if (entry !== undefined) writeCache(arxivCacheKey({ kind: 'fetch', id }), text)
      for (const p of pendings) p.resolve(text)
    }
  } catch (error) {
    const reason = error instanceof Error ? error : new Error(String(error))
    for (const [, pendings] of batch) for (const p of pendings) p.reject(reason)
  }
}

/** 入队一篇读取请求：同篇命中缓存立即返回；不同篇在窗口内合并为一次 HTTP。 */
function queueArxivFetch(cleanId: string): Promise<string> {
  const key = arxivCacheKey({ kind: 'fetch', id: cleanId })
  const cached = readCache(key)
  if (cached !== undefined) return Promise.resolve(cached)
  if (Date.now() < arxivCoolUntil) return Promise.reject(new Error('arXiv 服务繁忙（短暂冷却中）：请稍等约 30 秒后重试。'))
  return new Promise((resolve, reject) => {
    const pendings = fetchRequests.get(cleanId) ?? []
    pendings.push({ resolve, reject })
    fetchRequests.set(cleanId, pendings)
    if (fetchTimer === null) {
      fetchTimer = setTimeout(() => {
        void flushFetchBatch()
      }, FETCH_BATCH_WINDOW_MS)
    }
  })
}

/**
 * Search arXiv for academic papers
 */
export const arxivSearchTool = tool(
  async ({ query, maxResults = 5, sortBy = 'relevance' }) => {
    const normQuery = query.trim().replace(/\s+/g, ' ')
    const count = Math.min(Math.max(Math.trunc(maxResults ?? 5), 1), 30)
    const sort = sortBy === 'submittedDate' ? 'submittedDate' : 'relevance'
    if (normQuery === '') return '搜索关键词为空。'
    const key = arxivCacheKey({ kind: 'search', q: normQuery, n: count, s: sort })
    try {
      return await execArxiv(key, async () => {
        const sortParam = sort === 'submittedDate' ? '&sortBy=submittedDate&sortOrder=descending' : '&sortBy=relevance'
        const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(normQuery)}&start=0&max_results=${count}${sortParam}`
        const response = await fetch(url)
        if (!response.ok) raiseHttpError(response.status)
        const xml = await response.text()
        const entries = parseArxivXml(xml)
        if (entries.length === 0) return '未找到相关论文。'
        return entries
          .map((entry, i) => {
            return (
              `### ${i + 1}. ${entry.title}\n` +
              `- 作者: ${entry.authors.join(', ')}\n` +
              `- 发布时间: ${entry.published}\n` +
              `- 摘要: ${entry.summary.slice(0, 300)}...\n` +
              `- 链接: ${entry.link}`
            )
          })
          .join('\n\n')
      })
    } catch (error) {
      return `搜索失败: ${error instanceof Error ? error.message : '未知错误'}`
    }
  },
  {
    name: 'arxiv_search',
    description:
      '搜索 arXiv 学术论文，返回命中论文的标题、作者、摘要与链接。' +
      '检索纪律：一次调用尽量覆盖——把同义/相近表述用 OR 或引号合并进同一个 query（例：all:"llm agent" OR all:"large language model agent"），不要为同一主题换措辞逐次搜索；' +
      '同一关键词短时间重复调用会直接复用缓存，不重复请求外部接口。服务繁忙（限流）时会返回冷却提示，请稍后再试。',
    schema: z.object({
      query: z.string().describe('搜索关键词，如 "vision language model"'),
      maxResults: z.number().optional().default(5).describe('返回结果数量，默认 5，最多 30'),
      sortBy: z
        .enum(['relevance', 'submittedDate'])
        .optional()
        .default('relevance')
        .describe('排序方式：relevance 按相关度，submittedDate 按最新提交时间')
    })
  }
)

/**
 * 仅读取单篇 arXiv 论文的完整元数据（不写入文献库）。
 * 需要把论文保存到文献库时使用 paper_fetch（见 paperTools.ts）。
 * 同一 id 短时间内的重复读取直接命中缓存，不再请求外部接口。
 */
export const arxivFetchPaperTool = tool(
  async ({ id }) => {
    const cleanId = normalizeArxivId(id)
    if (cleanId === '') return '无效的 arXiv id。'
    try {
      return await queueArxivFetch(cleanId)
    } catch (error) {
      return `获取论文失败: ${error instanceof Error ? error.message : '未知错误'}`
    }
  },
  {
    name: 'arxiv_fetch_paper',
    description:
      '根据 arXiv id 读取单篇论文的完整元数据（标题、作者、发布时间、完整摘要），不写入文献库。若要保存到文献库请改用 paper_fetch。' +
      '同一时刻需要读取多篇时放心逐篇调用：系统会自动把短时间内的多篇读取合并成一次请求，减少外部访问次数。',
    schema: z.object({
      id: z.string().describe('arXiv 论文 id，如 "2301.12345"、含版本号 "2301.12345v2" 或完整链接')
    })
  }
)

/**
 * Parse arXiv Atom XML response
 */
function parseArxivXml(xml: string): ArxivEntry[] {
  const entries: ArxivEntry[] = []
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g
  let match: RegExpExecArray | null

  while ((match = entryRegex.exec(xml)) !== null) {
    const entryXml = match[1]

    const getTag = (tag: string) => {
      const m = entryXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))
      return m ? m[1].trim() : ''
    }

    const id = getTag('id')
    const title = getTag('title').replace(/\s+/g, ' ').trim()
    const summary = getTag('summary').replace(/\s+/g, ' ').trim()
    const published = getTag('published')

    // Extract authors
    const authors: string[] = []
    const authorRegex = /<name>([\s\S]*?)<\/name>/g
    let authorMatch: RegExpExecArray | null
    while ((authorMatch = authorRegex.exec(entryXml)) !== null) {
      authors.push(authorMatch[1].trim())
    }

    entries.push({ id, title, authors, summary, published, link: id })
  }

  return entries
}
