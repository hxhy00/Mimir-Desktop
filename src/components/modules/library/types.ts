/** 前端文献库类型（与 electron/library/types.ts 对齐） */

export interface ArxivEntry {
  id: string
  title: string
  authors: string[]
  summary: string
  published: string
  url: string
}

export interface WebSearchEntry {
  title: string
  url: string
  content: string
  engine: string
  category: string
  publishedDate: string
}

export interface PaperRelevance {
  score: number
  reason: string
  at: string
}

export interface PaperRecord {
  arxivId: string
  title: string
  authors: string[]
  summary: string
  url: string
  notes: string
  tags: string[]
  projectIds: string[]
  pdfPath?: string
  relevance?: Record<string, PaperRelevance>
  addedAt: string
}

export interface ProjectRecord {
  id: string
  title: string
  paperDir?: string
  createdAt: string
  updatedAt: string
}

export interface ArxivSubscriptionView {
  id: string
  query: string
  createdAt: string
  lastCheckedAt: string | null
  newEntries: ArxivEntry[]
}

export interface SubscriptionCheckOutcome {
  subscription: ArxivSubscriptionView
  added: string[]
  error: string | null
}

export interface ZoteroCollection {
  key: string
  name: string
  numItems: number
}

export interface ZoteroItem {
  key: string
  title: string
  creators: string[]
  date: string
  url: string
}

/** 搜索结果统一视图（arXiv 或 Web） */
export type SearchResult = ArxivEntry | WebSearchEntry

export function isArxivEntry(entry: SearchResult): entry is ArxivEntry {
  return 'id' in entry && 'published' in entry
}

/** 生成 PDF 阅读 URL（mimir-pdf:// 自定义协议） */
export function pdfUrlOf(arxivId: string): string {
  return `mimir-pdf://paper/${encodeURIComponent(arxivId)}.pdf`
}

/** 解析 notes 中的带时间戳阅读笔记 */
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

/** 追加一条带时间戳的阅读笔记 */
export function appendReadingNote(notes: string, text: string, now: Date): string {
  const body = text.trim()
  if (body === '') return notes
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  const entry = `[${stamp}]\n${body}`
  return notes.trimEnd() === '' ? entry : `${notes.trimEnd()}\n\n${entry}`
}

export function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr)
    return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'short' })
  } catch {
    return dateStr
  }
}