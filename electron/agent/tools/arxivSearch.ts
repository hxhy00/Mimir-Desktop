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
 * arXiv 访问节流层（进程内全局共享，普通 Agent 与蜂群工蜂共用同一实例）。
 *
 * 背景：export.arxiv.org 是无 key 的公共 API，限流很敏感；蜂群并行时多个
 * 子 Agent 会对相近关键词反复发起 arxiv_search / arxiv_fetch_paper，瞬间
 * 把接口打爆（HTTP 429）。这里的三个机制用来压低外部请求次数：
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
/** 相邻两个 arXiv 请求的最小间隔。 */
const MIN_REQUEST_INTERVAL_MS = 150

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
    const waitMs = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now()
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
async function execArxiv<THttp extends () => Promise<string>>(key: string, http: THttp): Promise<string> {
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

/** 校验非 2xx 的 arXiv 响应，并给出可读的中文失败信息（抛错 → 不缓存）。 */
function raiseHttpError(status: number): never {
  if (status === 429) {
    throw new Error('arXiv API 限流（HTTP 429）：请求过于频繁，已自动合并重复查询，请稍等约 1 分钟再试')
  }
  throw new Error(`arXiv API 请求失败: HTTP ${status}`)
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
      '搜索 arXiv 学术论文。输入关键词，返回相关论文的标题、作者、摘要和链接。同一关键词短时间内重复搜索会直接复用已检索结果，不再重复请求外部接口。',
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
    const cleanId = id.trim().replace(/^https?:\/\/arxiv\.org\/abs\//, '').replace(/^https?:\/\/arxiv\.org\/pdf\//, '')
    if (!cleanId) return '无效的 arXiv id。'
    const key = arxivCacheKey({ kind: 'fetch', id: cleanId })
    try {
      return await execArxiv(key, async () => {
        const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(cleanId)}&max_results=1`
        const response = await fetch(url)
        if (!response.ok) raiseHttpError(response.status)
        const xml = await response.text()
        const entries = parseArxivXml(xml)
        if (entries.length === 0) return `arXiv 中未找到 id 为 '${cleanId}' 的记录。`
        const e = entries[0]
        return (
          `### ${e.title}\n` +
          `- arXiv id: ${cleanId}\n` +
          `- 作者: ${e.authors.join(', ')}\n` +
          `- 发布时间: ${e.published}\n` +
          `- 链接: ${e.link}\n` +
          `- 摘要: ${e.summary}`
        )
      })
    } catch (error) {
      return `获取论文失败: ${error instanceof Error ? error.message : '未知错误'}`
    }
  },
  {
    name: 'arxiv_fetch_paper',
    description:
      '根据 arXiv id 读取单篇论文的完整元数据（标题、作者、发布时间、完整摘要），不写入文献库。若要保存到文献库请改用 paper_fetch。',
    schema: z.object({
      id: z.string().describe('arXiv 论文 id，如 "2301.12345" 或完整链接')
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
