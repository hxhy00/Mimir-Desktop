/**
 * 文献库领域类型定义（对齐 Mimir 的 PaperRecord / ProjectRecord 模型）
 */

/** 一篇 arXiv 论文条目（搜索结果 / 订阅新论文共用） */
export interface ArxivEntry {
  id: string
  title: string
  authors: string[]
  summary: string
  published: string
  url: string
}

/** 一条网页搜索结果 */
export interface WebSearchEntry {
  title: string
  url: string
  content: string
  engine: string
  category: string
  publishedDate: string
}

/** 单篇论文的 AI 相关性评分（按项目） */
export interface PaperRelevance {
  score: number
  reason: string
  at: string
}

/** 文献库中的论文记录 */
export interface PaperRecord {
  /** 裸 arXiv id（可带版本后缀，如 2103.00020v2） */
  arxivId: string
  title: string
  authors: string[]
  summary: string
  url: string
  /** 自由格式的工作笔记（阅读笔记以 [YYYY-MM-DD HH:mm] 块追加） */
  notes: string
  /** 组织标签 */
  tags: string[]
  /** 关联的项目 id 列表 */
  projectIds: string[]
  /** 已下载 PDF 的绝对路径；未下载时缺省 */
  pdfPath?: string
  /** AI 相关性评分，按项目 id 索引 */
  relevance?: Record<string, PaperRelevance>
  /** 首次写入时间（ISO-8601） */
  addedAt: string
}

/** 研究项目 */
export interface ProjectRecord {
  id: string
  title: string
  /** 项目对应的本地 LaTeX 目录（可选，用于 BibTeX 导出） */
  paperDir?: string
  /** 创建时间（ISO-8601） */
  createdAt: string
  /** 最后更新时间（ISO-8601） */
  updatedAt: string
}

/** arXiv 订阅记录 */
export interface ArxivSubscriptionRecord {
  id: string
  query: string
  createdAt: string
  lastCheckedAt: string | null
  /** 已见过的论文 id（用于判断新论文） */
  seenIds: string[]
  /** 新论文 id 列表 */
  newEntryIds: string[]
  /** 新论文详情 */
  newEntries: ArxivEntry[]
}

/** 订阅的对外视图（seenIds 是内部记账，不暴露） */
export interface ArxivSubscriptionView {
  id: string
  query: string
  createdAt: string
  lastCheckedAt: string | null
  newEntries: ArxivEntry[]
}

/** 一次订阅检查的结果 */
export interface SubscriptionCheckOutcome {
  subscription: ArxivSubscriptionView
  added: string[]
  error: string | null
}

/** BibTeX 条目 */
export interface BibEntry {
  key: string
  type: string
  fields: Record<string, string>
}