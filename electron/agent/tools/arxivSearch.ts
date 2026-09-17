import { tool } from 'langchain/tools'
import { z } from 'zod'
import type { ArxivEntry as LibraryEntry } from '../../library/types'

/** 本模块内部使用的 arXiv Atom 条目（字段名沿用 arXiv feed 的 link，勿与库类型混用）。 */
interface ArxivAtomEntry {
  id: string
  title: string
  authors: string[]
  summary: string
  published: string
  link: string
  source?: 'arxiv'
}

/**
 * arXiv 访问层（进程内全局共享）。
 *
 * ── 职责收窄（重要）────────────────────────────────────────────────────────
 * 本模块**不再是默认的元数据入口**：关键词检索与按 id 读取统一走
 * `agent/paperSearch.ts`（OpenAlex 主源 + Semantic Scholar 辅助），本模块降级为两件事：
 * 1. **最新提交排序**（`sortBy=submittedDate`）：OpenAlex 无该排序，只有 arXiv 支持；
 * 2. **新鲜预印本补充源**：统一访问层合并结果时用它补最近数日内提交的论文。
 *
 * 保留的原因：3 秒/次的官方限速是**这个接口的天花板**，不是访问层的实现问题。
 * 把它限制在「少数确需最新排序/补充」的调用上，主检索路径就不再排队。
 *
 * 以下节流机制仍然必要（补充源也受同一 ToS 约束）：
 *
 * 1. 结果缓存：同 key（关键词 + 数量 + 排序 / 论文 id）TTL 内直接复用，重复查询不发 HTTP；
 * 2. 在途合并：同一 key 的并发调用共享同一个 pending Promise，网络只发一次；
 * 3. 串行节流：所有请求经一条队列逐次发出，间隔 ≥ `MIN_REQUEST_INTERVAL_MS`（对齐 ToS 的 3s）；
 * 4. 单次尝试 + 冷却让路：撞 429/503 后读 Retry-After 设冷却并立即抛错降级，不在同一次
 *    调用里循环重试（见 `fetchArxiv`）；连续多个独立事件被限流则熔断停手。
 *
 * 仅成功的正常结果（含“未找到”）写入缓存；HTTP 错误/限流/异常不缓存。
 */
/**
 * 缓存 TTL（L4 差异化）：arXiv 元数据每日午夜才更新，24h 内重复请求同一 query/id
 * 结果不会变——因此按类型放宽 TTL，减少无谓的排队与限流风险。
 * - 单篇 id 读取：一旦收录基本不变，给最长（6h）。
 * - 关键词搜索：受"最新提交"影响，给 1h（远大于旧的 15min，又不至于太陈旧）。
 */
const FETCH_CACHE_TTL_MS = 6 * 60 * 60 * 1000
const SEARCH_CACHE_TTL_MS = 60 * 60 * 1000
const MAX_CACHE_ENTRIES = 200
/**
 * 相邻两个 arXiv 请求的最小间隔。
 *
 * ⚠️ 这个值曾长期是 250ms —— 相当于官方上限的 12 倍，429 是必然结果。
 * arXiv ToS：「no more than one request every three seconds」，不要为了"快"再往下调。
 */
const MIN_REQUEST_INTERVAL_MS = 3000
/** 间隔抖动上限（ms），错开并发调用方的同秒打点。 */
const INTERVAL_JITTER_MAX_MS = 400
/** 被限流后的"不早于"时刻（ms）。它不是错误状态：排队时跳过这段即可，不该抛错。 */
let arxivCoolUntil = 0
/** 无 Retry-After 头时的默认退避时长（ms）。 */
const DEFAULT_THROTTLE_WAIT_MS = 60_000
/**
 * 熔断阈值（L2）：连续 N 个**独立请求事件**被限流后进入 OPEN 态，暂停一段时间不再发请求。
 * 比"每次撞 429 再退避"更省时间——上游明确在限流时，硬撞只会拉长总耗时。
 */
const CIRCUIT_OPEN_THRESHOLD = 3
/** 熔断打开后的强制冷却时长（ms），到期转 HALF_OPEN 放行一次探测。 */
const CIRCUIT_OPEN_MS = 180_000
/** Retry-After 的合理上限：超过则截断，避免异常头把任务挂死。 */
const RETRY_AFTER_MAX_MS = 60_000

/**
 * 解析 HTTP `Retry-After` 头为毫秒。支持两种格式：
 * - 秒数（`Retry-After: 30`）；
 * - HTTP-date（`Retry-After: Wed, 21 Oct ...`）。
 * 无法解析返回 undefined（由调用方回落到预设退避）。结果封顶 `RETRY_AFTER_MAX_MS`。
 */
export function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined
  const secs = Number(header)
  if (Number.isFinite(secs)) {
    return Math.min(Math.max(secs, 0) * 1000, RETRY_AFTER_MAX_MS)
  }
  const dateMs = Date.parse(header)
  if (!Number.isNaN(dateMs)) {
    return Math.min(Math.max(dateMs - Date.now(), 0), RETRY_AFTER_MAX_MS)
  }
  return undefined
}
/** 带联系方式的 User-Agent（arXiv ToS 要求；缺失也是被限流的常见原因）。 */
const ARXIV_USER_AGENT =
  'Mimir-Desktop/0.0.1 (research assistant; +https://github.com/hxhy/Mimir-Desktop)'
/** 单篇元数据读取的批量合并参数：窗口内多个 id 合并为一次 HTTP。 */
const FETCH_BATCH_WINDOW_MS = 150
const FETCH_BATCH_MAX_IDS = 20

const arxivCache = new Map<string, { at: number; value: string }>()
const inflight = new Map<string, Promise<string>>()
let requestTail: Promise<void> = Promise.resolve()
let lastRequestAt = 0

// ─── L2 熔断器（CLOSED → OPEN → HALF_OPEN）───────────────────────────────
/**
 * arXiv 侧连续限流时进入 OPEN 态，暂停发请求一段时间，避免"撞 429→退避→再撞"的空转。
 * 与既有 `arxivCoolUntil`（单次退避让路）分工不同：coolUntil 管"这一批让路多久"，
 * 熔断管"上游是否已持续不可用、要不要整体停手"。
 */
type CircuitState = 'closed' | 'open' | 'half-open'
let circuitState: CircuitState = 'closed'
let circuitConsecutiveFails = 0
let circuitOpenUntil = 0

/** 熔断是否处于「现在不该发请求」的状态；OPEN 到期自动转 HALF_OPEN 放行探测。 */
function circuitBlocks(): boolean {
  if (circuitState === 'closed') return false
  if (circuitState === 'half-open') return false
  // open：到冷却时间就转半开，放一条探测流量过去
  if (Date.now() >= circuitOpenUntil) {
    circuitState = 'half-open'
    return false
  }
  return true
}

/** 记录一次成功：重置计数并回到 CLOSED。 */
function circuitRecordSuccess(): void {
  circuitConsecutiveFails = 0
  circuitState = 'closed'
}

/** 记录一次限流失败：累计到阈值即打开熔断。 */
function circuitRecordThrottle(): void {
  circuitConsecutiveFails += 1
  if (circuitState === 'half-open' || circuitConsecutiveFails >= CIRCUIT_OPEN_THRESHOLD) {
    circuitState = 'open'
    circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS
    console.warn(`[arxiv] 熔断打开 ${Math.round(CIRCUIT_OPEN_MS / 1000)}s（连续限流 ${circuitConsecutiveFails} 次）`)
  }
}

/**
 * 测试钩子：以受控时钟驱动并读取熔断器状态，验证 CLOSED→OPEN→HALF_OPEN 迁移。
 * 仅供单测使用，不参与生产调用路径。
 */
export const __circuitTestHooks = {
  reset(): void {
    circuitState = 'closed'
    circuitConsecutiveFails = 0
    circuitOpenUntil = 0
  },
  recordSuccess: circuitRecordSuccess,
  recordThrottle: circuitRecordThrottle,
  blocks: circuitBlocks,
  state(): CircuitState {
    return circuitState
  },
  /** 强制把 OPEN 的解除时刻设到给定时间戳，配合 fake timers 测半开迁移。 */
  setOpenUntil(ms: number): void {
    circuitState = 'open'
    circuitOpenUntil = ms
  }
}

function arxivCacheKey(parts: Record<string, string | number>): string {
  return Object.keys(parts)
    .sort()
    .map((k) => `${k}=${parts[k]}`)
    .join('&')
}

/** 按缓存 key 的 kind 选择 TTL：单篇 id 读取比关键词搜索更耐久。 */
export function ttlForKey(key: string): number {
  return key.includes('kind=fetch') ? FETCH_CACHE_TTL_MS : SEARCH_CACHE_TTL_MS
}

function readCache(key: string): string | undefined {
  const hit = arxivCache.get(key)
  if (hit === undefined) return undefined
  if (Date.now() - hit.at > ttlForKey(key)) {
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

/**
 * 串行化 arXiv 网络请求：排队依次发出，同时满足两个约束 ——
 * ① 与上一个请求间隔 ≥3s（ToS）；② 不早于冷却截止（刚被限流过就让路）。
 * 取两者较晚的时刻，因此**冷却不会变成一次失败**，只是"排队稍微久一点"。
 *
 * ⚠️ **不可重入**：队列只能有一个所有者。若在 `runSerialized` 的回调里再调
 * `runSerialized`（或调 `fetchArxiv`，它内部会入队），内层会等外层结束、外层等内层返回
 * → **死锁**（表现为该工具永不返回，Node 以退出码 13 "unfinished top-level await" 收场）。
 * 现实例证：本函数曾既被 `execArxiv` 包一层、又被 `fetchArxiv` 包一层，导致每次
 * `paper_search` 都永久挂住 —— 现已收敛为「**只有 `fetchArxiv` 入队**」。
 */
function runSerialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = requestTail.then(async () => {
    // L2：熔断 OPEN 时，把"不早于"时刻抬到熔断解除点——排队让路而非硬撞，
    // 与单次退避让路（arxivCoolUntil）取较晚者，冷却同样不表现为失败。
    const circuitReadyAt = circuitBlocks() ? circuitOpenUntil : 0
    const earliest = Math.max(
      lastRequestAt + MIN_REQUEST_INTERVAL_MS + Math.random() * INTERVAL_JITTER_MAX_MS,
      arxivCoolUntil,
      circuitReadyAt
    )
    const waitMs = earliest - Date.now()
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
 * 发一个 arXiv 请求：带 UA、走节流队列。
 *
 * **单次尝试**（成熟做法）：一次 HTTP 只算一个限流事件——撞 429/503 后读 `Retry-After`
 * （无头则默认 60s）设置冷却、记一次熔断计数，然后**立即抛错降级**，不在本次调用里循环重试。
 *
 * 为什么取消旧的「同调用内退避重试」：旧实现里重试循环与全局冷却互相打架——排队中的下一个
 * 请求撞上同一冷却窗口再吃一发 429，同一次限流事件被计成多次、熔断误开；且熔断打开后
 * tool call 挂死 180s，Agent 层超时会重发整个任务，反而放大流量。恢复交给下一次自然探测。
 *
 * @returns 响应体文本
 */
async function fetchArxiv(url: string): Promise<string> {
  const response = await runSerialized(() =>
    fetch(url, {
      headers: { 'User-Agent': ARXIV_USER_AGENT, Accept: 'application/atom+xml' }
    })
  )
  if (response.ok) {
    circuitRecordSuccess()
    return response.text()
  }
  if (response.status === 429 || response.status === 503) {
    const wait = parseRetryAfterMs(response.headers.get('retry-after')) ?? DEFAULT_THROTTLE_WAIT_MS
    circuitRecordThrottle()
    // 记冷却截止：让队列里其它请求也一起让路，避免退避后并发再撞限流
    arxivCoolUntil = Date.now() + wait
    console.warn(`[arxiv] HTTP ${response.status}，${Math.round(wait / 1000)}s 内不再请求（熔断态：${circuitState}）`)
    throw new Error(
      `arXiv 限流（HTTP ${String(response.status)}）：已按官方要求 3 秒/次节流，本次仍被限流，` +
        `约 ${String(Math.round(wait / 1000))} 秒后可用。请直接使用 OpenAlex 已有结果，不要重试本工具。`
    )
  }
  throw new Error(`arXiv API 请求失败: HTTP ${String(response.status)}`)
}

/**
 * 带缓存 + 在途合并的执行器。**节流/UA/重试全部由 `fetchArxiv` 负责**，
 * 这里直接调用 `http()`，不再包 `runSerialized` —— 否则会与 `fetchArxiv` 内部的入队形成死锁
 * （见 `runSerialized` 的警告）。
 *
 * 约定：正常结果与“未找到”直接返回字符串；限流/HTTP 错误抛 Error（不缓存）。
 */
async function execArxiv<THttp extends () => Promise<string>>(key: string, http: THttp): Promise<string> {
  const cached = readCache(key)
  if (cached !== undefined) return cached
  const pending = inflight.get(key)
  if (pending !== undefined) return pending
  const promise = http().then((value) => {
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

// ─── 单篇元数据批量读取（arxiv_fetch_paper）───────────────────────────
interface FetchPending {
  resolve: (value: string) => void
  reject: (error: Error) => void
  /** 需要 ArxivEntry 形状的调用方（paperSearch.resolvePaperById 主源）；与 resolve 二选一。 */
  resolveEntry?: (value: ArxivAtomEntry | null) => void
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
function formatFetchText(cleanId: string, e: ArxivAtomEntry): string {
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

  const url = `https://export.arxiv.org/api/query?id_list=${ids.map(encodeURIComponent).join(',')}&max_results=${ids.length}`
  try {
    // fetchArxiv 内部已走节流队列 + 退避重试，这里不再单独包 runSerialized
    const xml = await fetchArxiv(url)
    const byId = new Map<string, ArxivAtomEntry>()
    for (const entry of parseArxivXml(xml)) byId.set(normalizeArxivId(entry.id), entry)
    for (const [id, pendings] of batch) {
      const entry = byId.get(id)
      const text = entry !== undefined ? formatFetchText(id, entry) : `arXiv 中未找到 id 为 '${id}' 的记录。`
      if (entry !== undefined) writeCache(arxivCacheKey({ kind: 'fetch', id }), text)
      for (const p of pendings) {
        if (p.resolveEntry !== undefined) p.resolveEntry(entry ?? null)
        else p.resolve(text)
      }
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
  // 冷却不再表现为"拒绝"：排队时会自动让路（见 runSerialized）
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
 * 按 id 读取多篇的 **LibraryEntry（ArxivEntry）形状**（统一访问层 resolvePaperById
 * 的 arXiv 主源）。与 queueArxivFetch 共享同一批量合并队列/节流，只是分发时返回
 * 条目而非文本。找不到的 id 不出现在结果里（不是错误——arXiv 官方也查不到才算
 * 真的不存在）。注意：不读 text 缓存（那是格式化文本，无法还原条目）。
 */
export async function fetchArxivEntriesByIds(ids: string[]): Promise<LibraryEntry[]> {
  const cleanIds = ids.map(normalizeArxivId).filter((id) => id !== '')
  if (cleanIds.length === 0) return []
  const slots: Array<LibraryEntry | null> = cleanIds.map(() => null)
  await Promise.all(
    cleanIds.map((id, index) =>
      new Promise<void>((resolve) => {
        const pendings = fetchRequests.get(id) ?? []
        pendings.push({
          resolve: () => resolve(),
          reject: () => resolve(),
          resolveEntry: (entry) => {
            if (entry !== null) slots[index] = toLibraryEntry(entry)
            resolve()
          }
        })
        fetchRequests.set(id, pendings)
      })
    )
  )
  if (fetchTimer === null) {
    fetchTimer = setTimeout(() => {
      void flushFetchBatch()
    }, FETCH_BATCH_WINDOW_MS)
  }
  return slots.filter((e): e is LibraryEntry => e !== null)
}

/** 把统一访问层 / arXiv 原生接口的条目渲染成工具返回文本（两种形状都支持）。 */
function formatSearchResults(entries: Array<LibraryEntry & { source?: string }>): string {
  if (entries.length === 0) return '未找到相关论文。'
  return entries
    .map((entry, i) => {
      const src = entry.source !== undefined && entry.source !== 'arxiv' ? `（来源: ${entry.source}）` : ''
      return (
        `### ${i + 1}. ${entry.title}${src}\n` +
        `- id: ${entry.id}\n` +
        `- 作者: ${entry.authors.join(', ')}\n` +
        `- 发布时间: ${entry.published}\n` +
        `- 摘要: ${entry.summary.slice(0, 300)}...\n` +
        `- 链接: ${entry.url}`
      )
    })
    .join('\n\n')
}

/** Atom 条目 → 统一返回形状（link → url）。 */
function toLibraryEntry(e: ArxivAtomEntry): LibraryEntry {
  return { id: e.id, title: e.title, authors: e.authors, summary: e.summary, published: e.published, url: e.link, source: 'arxiv' }
}

/**
 * 学术文献检索（默认走 OpenAlex 主源 + arXiv 新鲜预印本补充，3 秒排队只发生在补充那一次）。
 *
 * 工具对外名为 `paper_search`（中性命名）：它检索的是**学术文献**而非仅 arXiv，
 * 只是「最新提交」排序只有 arXiv 支持，那一条走本模块原生路径（受 3 秒节流约束）。
 */
export const paperSearchTool = tool(
  async ({ query, maxResults = 5, sortBy = 'relevance' }) => {
    const normQuery = query.trim().replace(/\s+/g, ' ')
    const count = Math.min(Math.max(Math.trunc(maxResults ?? 5), 1), 30)
    const sort = sortBy === 'submittedDate' ? 'submittedDate' : 'relevance'
    if (normQuery === '') return '搜索关键词为空。'

    // 默认（相关度）路径：统一访问层，不受 arXiv 3 秒/次排队体感影响。
    if (sort === 'relevance') {
      try {
        const { searchPapers } = await import('../paperSearch')
        const entries = await searchPapers(normQuery, count, async (q, n) => {
          const key = arxivCacheKey({ kind: 'search', q, n, s: 'relevance' })
          const xml = await execArxiv(key, async () => {
            const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(q)}&start=0&max_results=${n}&sortBy=relevance`
            return fetchArxiv(url)
          })
          return parseArxivXml(xml).map(toLibraryEntry)
        })
        return formatSearchResults(entries)
      } catch (error) {
        return `搜索失败: ${error instanceof Error ? error.message : '未知错误'}`
      }
    }

    // 最新提交：仅 arXiv 支持该排序，保留原生路径（3 秒节流在此不可避免）。
    const key = arxivCacheKey({ kind: 'search', q: normQuery, n: count, s: sort })
    try {
      const xml = await execArxiv(key, async () => {
        const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(normQuery)}&start=0&max_results=${count}&sortBy=submittedDate&sortOrder=descending`
        return fetchArxiv(url)
      })
      return formatSearchResults(parseArxivXml(xml).map(toLibraryEntry))
    } catch (error) {
      return `搜索失败: ${error instanceof Error ? error.message : '未知错误'}`
    }
  },
  {
    name: 'paper_search',
    description:
      '检索学术论文（默认源 OpenAlex，覆盖 arXiv 预印本与期刊正式版；主题近期活跃时自动补充 arXiv 最新预印本，' +
      'OpenAlex 无结果时用 Semantic Scholar 语义检索兜底），返回标题、id、作者、摘要与链接。' +
      '检索纪律：一次调用尽量覆盖——把同义/相近表述合并进同一个 query，不要为同一主题换措辞逐次搜索；' +
      '同一关键词短时间重复调用会直接复用缓存，不重复请求外部接口。' +
      '降级纪律：返回内容提示 arXiv 限流/不可用时，说明 OpenAlex 等主源结果已照常返回，' +
      '**直接使用现有结果，禁止重试本工具**。' +
      '只有确需「按最新提交时间」时才用 sortBy=submittedDate，该排序依赖 arXiv 原生接口，会有每 3 秒 1 次的排队等待。',
    schema: z.object({
      query: z.string().describe('搜索关键词，如 "vision language model"'),
      maxResults: z.number().optional().default(5).describe('返回结果数量，默认 5，最多 30'),
      sortBy: z
        .enum(['relevance', 'submittedDate'])
        .optional()
        .default('relevance')
        .describe('排序方式：relevance 按相关度（走 OpenAlex，快），submittedDate 按最新提交时间（走 arXiv，需排队）')
    })
  }
)

/**
 * 仅读取单篇论文的完整元数据（不写入文献库）。
 * 需要把论文保存到文献库时使用 paper_fetch（见 paperTools.ts）。
 *
 * 主路径走统一访问层（OpenAlex / Semantic Scholar，免排队）；OpenAlex 收录有延迟时，
 * 回退到本模块的 arXiv 批量合并读取（同篇并发只发一次 HTTP）。
 */
export const arxivFetchPaperTool = tool(
  async ({ id }) => {
    const cleanId = normalizeArxivId(id)
    if (cleanId === '') return '无效的 arXiv id。'
    try {
      const { resolvePaperById } = await import('../paperSearch')
      const entry = await resolvePaperById(cleanId)
      return (
        `### ${entry.title}\n` +
        `- id: ${entry.id}（来源: ${entry.source ?? 'openalex'}）\n` +
        `- 作者: ${entry.authors.join(', ')}\n` +
        `- 发布时间: ${entry.published}\n` +
        `- 链接: ${entry.url}\n` +
        `- 摘要: ${entry.summary}`
      )
    } catch {
      // 统一访问层未收录（常见于刚提交的预印本）→ 回退 arXiv 原生读取
      try {
        return await queueArxivFetch(cleanId)
      } catch (error) {
        return `获取论文失败: ${error instanceof Error ? error.message : '未知错误'}`
      }
    }
  },
  {
    name: 'arxiv_fetch_paper',
    description:
      '根据 arXiv id 读取单篇论文的完整元数据（标题、作者、发布时间、完整摘要），不写入文献库。若要保存到文献库请改用 paper_fetch。' +
      '同一时刻需要读取多篇时放心逐篇调用：内部会合并/缓存，不会重复请求外部接口。',
    schema: z.object({
      id: z.string().describe('arXiv 论文 id，如 "2301.12345"、含版本号 "2301.12345v2" 或完整链接')
    })
  }
)

/**
 * Parse arXiv Atom XML response
 */
function parseArxivXml(xml: string): ArxivAtomEntry[] {
  const entries: ArxivAtomEntry[] = []
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g
  let match: RegExpExecArray | null

  while ((match = entryRegex.exec(xml)) !== null) {
    const entryXml = match[1]

    const getTag = (tag: string) => {
      const m = entryXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))
      return m ? m[1].trim() : ''
    }

    const id = getTag('id').replace(/^https?:\/\/arxiv\.org\/abs\//, '').replace(/v\d+$/, '')
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

    entries.push({ id, title, authors, summary, published, link: id, source: 'arxiv' })
  }

  return entries
}
