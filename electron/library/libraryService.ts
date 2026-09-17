/**
 * 文献库核心服务：论文/项目/订阅 CRUD、BibTeX 导出、Zotero 集成、Web 搜索。
 * 数据持久化在 store.json（library:papers / library:projects / library:subscriptions）。
 */
import { randomUUID } from 'crypto'
import { mkdir, writeFile, readFile, access } from 'fs/promises'
import { join, dirname } from 'path'
import { app } from 'electron'
import { getStoreValue, setStoreValue, spaceRoot, currentSpaceEpoch, assertSpaceUnchanged } from './store'
import { fetchArxivSearch, fetchArxivPdf, fetchPdfBytes, paperPdfFileName } from './arxiv'
import { isDoiId, normalizeDoi, resolveOaPdfLocation } from './oaLocation'
import { httpFetch } from '../http'
import { parseBibtex, serializeBibtex, entryFromPaper } from './bibtex'
import { parseDuckDuckGoResults } from './webSearchParse'
import type {
  ArxivEntry,
  ArxivSubscriptionRecord,
  ArxivSubscriptionView,
  PaperRecord,
  ProjectRecord,
  SubscriptionCheckOutcome,
  WebSearchEntry,
} from './types'

const PAPERS_KEY = 'library:papers'
const PROJECTS_KEY = 'library:projects'
const SUBSCRIPTIONS_KEY = 'library:subscriptions'
const ARXIV_FETCH_TIMEOUT_MS = 15_000
const ARXIV_PDF_FETCH_TIMEOUT_MS = 60_000
const ARXIV_SEARCH_DEFAULT_MAX_RESULTS = 10
const ARXIV_SEARCH_MAX_RESULTS = 50
const ARXIV_SUBSCRIPTION_QUERY_MAX = 200

// ─── 内部工具 ────────────────────────────────────────────────────────

function papersTable(): Record<string, PaperRecord> {
  return getStoreValue<Record<string, PaperRecord>>(PAPERS_KEY) ?? {}
}

function savePapersTable(table: Record<string, PaperRecord>): void {
  setStoreValue(PAPERS_KEY, table)
}

function projectsList(): ProjectRecord[] {
  return getStoreValue<ProjectRecord[]>(PROJECTS_KEY) ?? []
}

function saveProjectsList(list: ProjectRecord[]): void {
  setStoreValue(PROJECTS_KEY, list)
}

function subscriptionsList(): ArxivSubscriptionRecord[] {
  return getStoreValue<ArxivSubscriptionRecord[]>(SUBSCRIPTIONS_KEY) ?? []
}

function saveSubscriptionsList(list: ArxivSubscriptionRecord[]): void {
  setStoreValue(SUBSCRIPTIONS_KEY, list)
}

function papersDir(): string {
  return join(spaceRoot(), 'papers')
}

/** 原子替换一个二进制文件（同目录唯一临时文件） */
async function writeBytesAtomic(filePath: string, bytes: Uint8Array): Promise<void> {
  const tempPath = `${filePath}.${randomUUID()}.tmp`
  try {
    await writeFile(tempPath, bytes, { mode: 0o666 })
    await import('fs/promises').then(({ rename }) => rename(tempPath, filePath))
  } catch (error) {
    await import('fs/promises').then(({ unlink }) => unlink(tempPath).catch(() => {}))
    throw error
  }
}

// ─── 论文 CRUD ──────────────────────────────────────────────────────

/** 列出所有论文，最近添加的在前 */
export function listPapers(): PaperRecord[] {
  return Object.values(papersTable()).sort((a, b) => b.addedAt.localeCompare(a.addedAt))
}

/** 搜索 arXiv */
export async function searchArxiv(
  query: string,
  maxResults = ARXIV_SEARCH_DEFAULT_MAX_RESULTS,
  sortBy: 'relevance' | 'submittedDate' = 'relevance',
): Promise<ArxivEntry[]> {
  const q = query.trim()
  if (q === '') throw new Error('query must be non-empty')
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > ARXIV_SEARCH_MAX_RESULTS) {
    throw new Error(`maxResults must be an integer between 1 and ${ARXIV_SEARCH_MAX_RESULTS}`)
  }
  // 「按最新提交」只有 arXiv 支持（OpenAlex 无该排序），保持原路径；
  // 默认相关度检索走统一访问层：OpenAlex 主源 + arXiv 补充，免 3 秒/次的排队体感。
  if (sortBy === 'submittedDate') {
    return fetchArxivSearch(q, maxResults, AbortSignal.timeout(ARXIV_FETCH_TIMEOUT_MS), {
      sortBySubmittedDate: true,
    })
  }
  // arXiv 补充与 paper_search 共享统一访问层内的新鲜度门槛（见 paperSearch.shouldSupplementArxiv）：
  // 只有 OpenAlex 结果显示主题近期活跃时才发 arXiv 请求，省掉 3s 节流排队与 429 暴露面。
  const { searchPapers } = await import('../agent/paperSearch')
  return searchPapers(q, maxResults, (queryText, n) =>
    fetchArxivSearch(queryText, n, AbortSignal.timeout(ARXIV_FETCH_TIMEOUT_MS)),
  )
}

/** 导入一篇论文（幂等 upsert：重新导入刷新元数据但保留笔记/标签/项目/评分） */
export async function importPaper(entry: ArxivEntry, projectId?: string): Promise<{ imported: boolean }> {
  const arxivId = entry.id.trim()
  if (arxivId === '' || entry.title.trim() === '') {
    throw new Error('entry id and title must be non-empty')
  }
  if (projectId !== undefined && !projectsList().some((p) => p.id === projectId)) {
    throw new Error(`unknown project: ${projectId}`)
  }
  const table = papersTable()
  const existing = table[arxivId]
  const record: PaperRecord = {
    arxivId,
    title: entry.title,
    authors: [...entry.authors],
    summary: entry.summary,
    url: entry.url === '' ? `https://arxiv.org/abs/${arxivId}` : entry.url,
    ...(entry.source !== undefined ? { source: entry.source } : existing?.source !== undefined ? { source: existing.source } : {}),
    // OA 直链：新条目带回；旧条目保留原值（避免重新导入时被空值擦掉）
    ...(entry.pdfUrl !== undefined && entry.pdfUrl !== '' ? { pdfUrl: entry.pdfUrl, ...(entry.pdfSource !== undefined ? { pdfSource: entry.pdfSource } : {}) } : existing?.pdfUrl !== undefined ? { pdfUrl: existing.pdfUrl, ...(existing.pdfSource !== undefined ? { pdfSource: existing.pdfSource } : {}) } : {}),
    notes: existing?.notes ?? '',
    tags: [...(existing?.tags ?? [])],
    projectIds: [...new Set([
      ...(existing?.projectIds ?? []),
      ...(projectId === undefined ? [] : [projectId]),
    ])],
    ...(existing?.relevance === undefined ? {} : { relevance: existing.relevance }),
    ...(existing?.pdfPath === undefined ? {} : { pdfPath: existing.pdfPath }),
    addedAt: existing?.addedAt ?? new Date().toISOString(),
  }
  table[arxivId] = record
  savePapersTable(table)
  return { imported: existing === undefined }
}

/** 删除一篇论文 */
export async function removePaper(arxivId: string): Promise<void> {
  const table = papersTable()
  if (table[arxivId] === undefined) throw new Error(`paper-not-found: ${arxivId}`)
  delete table[arxivId]
  savePapersTable(table)
}

/** 部分更新一篇论文的组织字段（tags / projectIds / notes / relevance） */
export async function updatePaper(request: {
  arxivId: string
  tags?: string[]
  projectIds?: string[]
  notes?: string
  relevance?: { projectId: string; score: number; reason: string }
}): Promise<PaperRecord> {
  const table = papersTable()
  const existing = table[request.arxivId]
  if (existing === undefined) throw new Error(`paper-not-found: ${request.arxivId}`)
  if (request.projectIds !== undefined) {
    const known = new Set(projectsList().map((p) => p.id))
    for (const projectId of request.projectIds) {
      if (!known.has(projectId)) throw new Error(`unknown project: ${projectId}`)
    }
  }
  if (request.relevance !== undefined) {
    const { projectId, score } = request.relevance
    if (!projectsList().some((p) => p.id === projectId)) {
      throw new Error(`unknown project: ${projectId}`)
    }
    if (!Number.isFinite(score) || score < 0 || score > 10) {
      throw new Error('relevance score must be a finite number between 0 and 10')
    }
  }
  const next: PaperRecord = {
    ...existing,
    tags: request.tags === undefined
      ? existing.tags
      : [...new Set(request.tags.map((tag) => tag.trim()).filter((tag) => tag !== ''))],
    projectIds: request.projectIds ?? existing.projectIds,
    notes: request.notes ?? existing.notes,
    ...(request.relevance === undefined ? {} : {
      relevance: {
        ...existing.relevance,
        [request.relevance.projectId]: {
          score: request.relevance.score,
          reason: request.relevance.reason,
          at: new Date().toISOString(),
        },
      },
    }),
  }
  table[request.arxivId] = next
  savePapersTable(table)
  return next
}

/**
 * 解析并下载一篇论文的 PDF 字节（fetchPaperPdf 的取字节阶段）。
 *
 * 顺序（命中即停，失败原因累计后如实汇总）：
 * 1. 条目可解析出 arXiv id → arXiv 通道（export 主站 + 主站回退，内部已处理）；
 * 2. 否则视为 DOI 条目 → OA 直链（OpenAlex → Unpaywall）→ 通用 https PDF 下载。
 *
 * 注意：DOI 条目**不再直接拒绝**——OA 版本存在时就能直接读全文，
 * 不存在时给出的是「未发现开放获取版本」这一准确结论，而非笼统的「不支持」。
 */
async function downloadPaperBytes(
  paper: PaperRecord,
): Promise<{ bytes: Uint8Array; source?: string }> {
  const arxivId = arxivIdOf(paper)
  const errors: string[] = []
  const timeout = ARXIV_PDF_FETCH_TIMEOUT_MS
  if (arxivId !== null) {
    try {
      return { bytes: await fetchArxivPdf(arxivId, AbortSignal.timeout(timeout)), source: 'arxiv' }
    } catch (error) {
      errors.push(`arXiv: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const doi = normalizeDoi(paper.arxivId) ?? paper.arxivId
  const location = await resolveOaPdfLocation(doi, { url: paper.pdfUrl, source: paper.pdfSource })
  if (location === null) {
    errors.push('未在 OpenAlex / Unpaywall 找到开放获取（OA）版本')
    throw new Error(
      `${errors.join('；')}。该论文可能需要机构订阅访问，可复制链接到浏览器或图书馆代理下载：${paper.url}`,
    )
  }
  try {
    return { bytes: await fetchPdfBytes(location.url, AbortSignal.timeout(timeout)), source: location.source }
  } catch (error) {
    errors.push(`${location.source}: ${error instanceof Error ? error.message : String(error)}`)
    throw new Error(`${errors.join('；')}。该论文可能需要机构订阅访问，可复制链接到浏览器或图书馆代理下载：${paper.url}`)
  }
}

/** 从一条记录里解析可用的 arXiv id：主键是裸 id 时直接可用；DOI 条目则看 URL 与 pdfUrl。 */
function arxivIdOf(paper: PaperRecord): string | null {
  const bare = paper.arxivId.trim()
  if (bare !== '' && !isDoiId(bare)) return bare
  // DOI 条目：若来源页是 arXiv 落地页（如 10.48550/arXiv.xxxx 或 url 指向 /abs/），仍可走 arXiv 通道
  const candidates = [paper.url, paper.pdfUrl ?? '', bare]
  for (const candidate of candidates) {
    const match = /arxiv\.org\/(?:abs|pdf)\/([\w.\-/]+?)(?:v\d+)?(?:\.pdf)?(?:[?#].*)?$/i.exec(candidate)
    if (match?.[1] !== undefined && match[1] !== '') return match[1]
    const doiMatch = /10\.48550\/arxiv\.([\w.\-/]+)/i.exec(candidate)
    if (doiMatch?.[1] !== undefined && doiMatch[1] !== '') return doiMatch[1]
  }
  return null
}

/**
 * 下载一篇论文的 PDF 到空间 papers 目录并更新记录。
 *
 * 两条通道合一的瀑布：
 * - **arXiv 条目**（裸 id / 可解析出 arXiv id）→ export.arxiv.org（含主站回退）；
 * - **非 arXiv 条目**（DOI）→ 解析 OA 直链（OpenAlex → Unpaywall）后下载。
 *
 * 失败信息如实列出各源状态，不再一言以蔽之「暂不支持」。
 */
export async function fetchPaperPdf(arxivId: string): Promise<PaperRecord> {
  const epoch = currentSpaceEpoch()
  const table = papersTable()
  const existing = table[arxivId]
  if (existing === undefined) throw new Error(`paper-not-found: ${arxivId}`)

  const { bytes, source } = await downloadPaperBytes(existing)
  // 下载期间用户可能切换了科研空间：写盘与写回前校验，避免把旧空间数据写进新空间
  assertSpaceUnchanged(epoch)
  const dir = papersDir()
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, paperPdfFileName(arxivId))
  await writeBytesAtomic(filePath, bytes)
  assertSpaceUnchanged(epoch)
  const currentTable = papersTable()
  const current = currentTable[arxivId]
  if (current === undefined) throw new Error(`paper-not-found: ${arxivId}（科研空间已切换）`)
  const next: PaperRecord = {
    ...current,
    pdfPath: filePath,
    // 记录本次实际命中的通道，便于排障「这篇到底从哪下的」
    ...(source !== undefined ? { pdfSource: source } : {}),
  }
  currentTable[arxivId] = next
  savePapersTable(currentTable)
  return next
}

// ─── 项目 CRUD ─────────────────────────────────────────────────────

/** 列出所有项目 */
export function listProjects(): ProjectRecord[] {
  return projectsList().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** 创建项目 */
export function createProject(title: string, paperDir?: string): ProjectRecord {
  const t = title.trim()
  if (t === '') throw new Error('project title must be non-empty')
  const now = new Date().toISOString()
  const record: ProjectRecord = {
    id: randomUUID(),
    title: t,
    ...(paperDir && paperDir.trim() !== '' ? { paperDir: paperDir.trim() } : {}),
    createdAt: now,
    updatedAt: now,
  }
  saveProjectsList([...projectsList(), record])
  return record
}

/** 更新项目（标题 / 论文目录） */
export function updateProject(id: string, patch: { title?: string; paperDir?: string }): ProjectRecord {
  const list = projectsList()
  const index = list.findIndex((p) => p.id === id)
  if (index === -1) throw new Error(`project-not-found: ${id}`)
  const current = list[index]!
  const next: ProjectRecord = {
    ...current,
    ...(patch.title !== undefined ? { title: patch.title.trim() || current.title } : {}),
    ...(patch.paperDir !== undefined
      ? (patch.paperDir.trim() === '' ? { paperDir: undefined } : { paperDir: patch.paperDir.trim() })
      : {}),
    updatedAt: new Date().toISOString(),
  }
  list[index] = next
  saveProjectsList(list)
  return next
}

/** 删除项目（同时从论文的 projectIds 中移除） */
export function deleteProject(id: string): void {
  saveProjectsList(projectsList().filter((p) => p.id !== id))
  const table = papersTable()
  let changed = false
  for (const [arxivId, paper] of Object.entries(table)) {
    if (paper.projectIds.includes(id)) {
      table[arxivId] = { ...paper, projectIds: paper.projectIds.filter((pid) => pid !== id) }
      changed = true
    }
  }
  if (changed) savePapersTable(table)
}

// ─── BibTeX 导出 ───────────────────────────────────────────────────

/**
 * 把论文追加到项目的 references.bib（跳过已存在的引用键）。
 * 项目有 paperDir 时写入该目录；否则写入空间根 projects/<id>/references.bib。
 */
export async function importPapersToBib(
  projectId: string,
  arxivIds: string[],
): Promise<{ added: string[]; skipped: string[]; bibPath: string }> {
  const project = projectsList().find((p) => p.id === projectId)
  if (project === undefined) throw new Error(`project-not-found: ${projectId}`)
  const table = papersTable()
  const entries = arxivIds.map((id) => {
    const paper = table[id]
    if (paper === undefined) throw new Error(`paper-not-found: ${id}`)
    return entryFromPaper(paper)
  })
  const dir = project.paperDir
    ? project.paperDir
    : join(spaceRoot(), 'projects', project.id)
  await mkdir(dir, { recursive: true })
  const bibPath = join(dir, 'references.bib')

  let existingText = ''
  try {
    existingText = await readFile(bibPath, 'utf-8')
  } catch {
    // 文件不存在 → 从空开始
  }
  const { entries: parsed, rawByKey, errors } = parseBibtex(existingText)
  if (errors.length > 0) {
    throw new Error(`现有 references.bib 解析失败，已中止写入以保护原文件：${errors[0]}`)
  }
  const originalByKey = new Map(parsed.map((e) => [e.key, e]))
  const present = new Set(parsed.map((e) => e.key))
  const added: string[] = []
  const skipped: string[] = []
  for (const incoming of entries) {
    if (present.has(incoming.key)) { skipped.push(incoming.key); continue }
    parsed.push(incoming)
    present.add(incoming.key)
    added.push(incoming.key)
  }
  if (added.length > 0) {
    await writeFile(bibPath, serializeBibtex(parsed, rawByKey, originalByKey), 'utf-8')
  }
  return { added, skipped, bibPath }
}

// ─── arXiv 订阅 ────────────────────────────────────────────────────

function toView(record: ArxivSubscriptionRecord): ArxivSubscriptionView {
  return {
    id: record.id,
    query: record.query,
    createdAt: record.createdAt,
    lastCheckedAt: record.lastCheckedAt,
    newEntries: [...record.newEntries],
  }
}

/** 列出所有订阅 */
export async function listArxivSubscriptions(): Promise<ArxivSubscriptionView[]> {
  return subscriptionsList().map(toView)
}

/** 新增订阅 */
export async function saveArxivSubscription(query: string): Promise<ArxivSubscriptionView> {
  const q = query.trim()
  if (q === '') throw new Error('query must be non-empty')
  if (q.length > ARXIV_SUBSCRIPTION_QUERY_MAX) {
    throw new Error(`query must be at most ${ARXIV_SUBSCRIPTION_QUERY_MAX} characters`)
  }
  const list = subscriptionsList()
  if (list.some((r) => r.query.toLowerCase() === q.toLowerCase())) {
    throw new Error(`already subscribed: ${q}`)
  }
  const record: ArxivSubscriptionRecord = {
    id: randomUUID(),
    query: q,
    createdAt: new Date().toISOString(),
    lastCheckedAt: null,
    seenIds: [],
    newEntryIds: [],
    newEntries: [],
  }
  saveSubscriptionsList([...list, record])
  return toView(record)
}

/** 删除订阅 */
export async function deleteArxivSubscription(id: string): Promise<void> {
  const list = subscriptionsList()
  if (!list.some((r) => r.id === id)) throw new Error(`subscription-not-found: ${id}`)
  saveSubscriptionsList(list.filter((r) => r.id !== id))
}

/** 检查订阅的新论文（id 缺省时检查全部） */
export async function checkArxivSubscriptions(id?: string): Promise<SubscriptionCheckOutcome[]> {
  // 订阅是空间数据：逐轮网络往返期间若切换了空间，中止回写以防跨空间污染
  const epoch = currentSpaceEpoch()
  const list = subscriptionsList()
  const targets = id === undefined ? list : list.filter((r) => r.id === id)
  if (id !== undefined && targets.length === 0) throw new Error(`subscription-not-found: ${id}`)

  const outcomes: SubscriptionCheckOutcome[] = []
  for (const record of targets) {
    assertSpaceUnchanged(epoch)
    let added: string[] = []
    let error: string | null = null
    try {
      const entries = await fetchArxivSearch(record.query, 20, AbortSignal.timeout(ARXIV_FETCH_TIMEOUT_MS), {
        sortBySubmittedDate: true,
      })
      const seen = new Set(record.seenIds)
      const fresh = entries.filter((e) => !seen.has(e.id))
      added = fresh.map((e) => e.id)
      record.seenIds = [...new Set([...record.seenIds, ...entries.map((e) => e.id)])]
      record.newEntryIds = fresh.map((e) => e.id)
      record.newEntries = fresh
      record.lastCheckedAt = new Date().toISOString()
    } catch (e) {
      error = e instanceof Error ? e.message : 'arXiv check failed'
    }
    outcomes.push({ subscription: toView(record), added, error })
  }
  assertSpaceUnchanged(epoch)
  saveSubscriptionsList(list)
  return outcomes
}

// ─── Web 搜索 ──────────────────────────────────────────────────────

/** DuckDuckGo HTML 搜索（无需 API key），解析为结构化结果 */
export async function searchWeb(query: string, maxResults = 10): Promise<WebSearchEntry[]> {
  const q = query.trim()
  if (q === '') throw new Error('query must be non-empty')
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`
  const response = await httpFetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(ARXIV_FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`web search failed: HTTP ${response.status}`)
  const html = await response.text()
  return parseDuckDuckGoResults(html, maxResults)
}

// ─── Zotero 集成 ───────────────────────────────────────────────────

interface ZoteroConfig {
  apiKey?: string
  userId?: string
}

function zoteroConfig(): ZoteroConfig {
  const settings = getStoreValue<Record<string, unknown>>('settings') ?? {}
  const z = (settings.zotero as ZoteroConfig | undefined) ?? {}
  return z
}

function zoteroClient(): { apiKey: string; userId: string } | null {
  const { apiKey, userId } = zoteroConfig()
  if (!apiKey || !userId) return null
  return { apiKey, userId }
}

/** 探测 Zotero 配置状态 */
export function checkZotero(): { configured: boolean; message: string } {
  const client = zoteroClient()
  if (client === null) {
    return { configured: false, message: '未配置 Zotero API Key / User ID，请在设置中配置' }
  }
  return { configured: true, message: '已配置' }
}

/** 列出 Zotero 集合 */
export async function listZoteroCollections(): Promise<{ key: string; name: string; numItems: number }[]> {
  const client = zoteroClient()
  if (client === null) throw new Error('Zotero 未配置：请在设置中填写 API Key 和 User ID')
  const url = `https://api.zotero.org/users/${client.userId}/collections?limit=100`
  const response = await httpFetch(url, {
    headers: { 'Zotero-API-Key': client.apiKey },
    signal: AbortSignal.timeout(ARXIV_FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Zotero API failed: HTTP ${response.status}`)
  const data = (await response.json()) as Array<{ key: string; data: { name: string; meta?: { numItems?: number } } }>
  return data.map((c) => ({ key: c.key, name: c.data.name, numItems: c.data.meta?.numItems ?? 0 }))
}

/** 搜索 Zotero 条目 */
export async function searchZotero(query: string): Promise<{ key: string; title: string; creators: string[]; date: string; url: string }[]> {
  const client = zoteroClient()
  if (client === null) throw new Error('Zotero 未配置：请在设置中填写 API Key 和 User ID')
  const url = `https://api.zotero.org/users/${client.userId}/items?q=${encodeURIComponent(query)}&limit=25&format=json&itemType=-attachment%20-note`
  const response = await httpFetch(url, {
    headers: { 'Zotero-API-Key': client.apiKey },
    signal: AbortSignal.timeout(ARXIV_FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Zotero API failed: HTTP ${response.status}`)
  const data = (await response.json()) as Array<{ key: string; data: { title?: string; creators?: Array<{ name?: string; firstName?: string; lastName?: string }>; date?: string; url?: string } }>
  return data.map((item) => ({
    key: item.key,
    title: item.data.title ?? '',
    creators: (item.data.creators ?? []).map((c) => c.name ?? [c.firstName, c.lastName].filter(Boolean).join(' ')).filter(Boolean),
    date: item.data.date ?? '',
    url: item.data.url ?? '',
  }))
}

/** 把一个 Zotero 集合导出为 BibTeX 并合并进项目 references.bib */
export async function exportZoteroCollectionToBib(
  projectId: string,
  collectionKey: string,
): Promise<{ added: string[]; skipped: string[]; bibPath: string }> {
  const client = zoteroClient()
  if (client === null) throw new Error('Zotero 未配置：请在设置中填写 API Key 和 User ID')
  const project = projectsList().find((p) => p.id === projectId)
  if (project === undefined) throw new Error(`project-not-found: ${projectId}`)

  const url = `https://api.zotero.org/users/${client.userId}/collections/${collectionKey}/items?format=bibtex&limit=100`
  const response = await httpFetch(url, {
    headers: { 'Zotero-API-Key': client.apiKey },
    signal: AbortSignal.timeout(ARXIV_FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Zotero API failed: HTTP ${response.status}`)
  const bibtex = await response.text()
  const zoteroParsed = parseBibtex(bibtex)
  if (zoteroParsed.errors.length > 0) {
    throw new Error(`Zotero 返回的 BibTeX 解析失败：${zoteroParsed.errors[0]}`)
  }
  const entries = zoteroParsed.entries

  const dir = project.paperDir
    ? project.paperDir
    : join(spaceRoot(), 'projects', project.id)
  await mkdir(dir, { recursive: true })
  const bibPath = join(dir, 'references.bib')

  let existingText = ''
  try {
    existingText = await readFile(bibPath, 'utf-8')
  } catch {
    // 文件不存在 → 从空开始
  }
  const { entries: parsed, rawByKey, errors } = parseBibtex(existingText)
  if (errors.length > 0) {
    throw new Error(`现有 references.bib 解析失败，已中止写入以保护原文件：${errors[0]}`)
  }
  const originalByKey = new Map(parsed.map((e) => [e.key, e]))
  const present = new Set(parsed.map((e) => e.key))
  const added: string[] = []
  const skipped: string[] = []
  for (const incoming of entries) {
    if (present.has(incoming.key)) { skipped.push(incoming.key); continue }
    parsed.push(incoming)
    present.add(incoming.key)
    added.push(incoming.key)
  }
  if (added.length > 0) {
    await writeFile(bibPath, serializeBibtex(parsed, rawByKey, originalByKey), 'utf-8')
  }
  return { added, skipped, bibPath }
}

// ─── 阅读笔记工具 ──────────────────────────────────────────────────

/** 追加一条带时间戳的阅读笔记到论文 notes */
export function appendReadingNote(notes: string, text: string, now: Date): string {
  const body = text.trim()
  if (body === '') return notes
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  const entry = `[${stamp}]\n${body}`
  return notes.trimEnd() === '' ? entry : `${notes.trimEnd()}\n\n${entry}`
}

/** 解析 notes 中的带时间戳阅读笔记条目 */
export function parseReadingNotes(notes: string): { at: string; text: string }[] {
  const entries: { at: string; text: string }[] = []
  const header = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\n/
  for (const block of notes.split(/\n{2,}/)) {
    const match = header.exec(block)
    if (match === null || match[1] === undefined) continue
    entries.push({ at: match[1], text: block.slice(match[0].length) })
  }
  return entries
}