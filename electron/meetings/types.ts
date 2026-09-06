/**
 * 组会演示文稿域类型（对齐 Mimir 的 DeckSlide 纯模型，去掉图片/逐图资产维度）。
 *
 * 数据来源：文献库 `library:papers` / `library:projects` 与实验模块
 * `experiments:list`（均存于 store.json）。产物为真实 .pptx，落在
 * `userData/meetings/`，文件系统为真相；元信息存 store key `meetings:index`。
 */

export type ExperimentStatus = 'running' | 'success' | 'failed'

/** 单篇论文的 AI 相关性评分（对齐 library/types.ts）。 */
export interface PaperRelevance {
  readonly score: number
  readonly reason: string
  readonly at: string
}

/** 一条实验记录（与 src/lib/experiments.ts 结构一致，供主进程独立使用）。 */
export interface ExperimentRecord {
  readonly id: string
  readonly name: string
  readonly status: ExperimentStatus
  readonly metrics: Record<string, number | string>
  readonly serverId?: string | undefined
  readonly updatedAt: string
}

/** 一篇供 deck 使用的论文（从 PaperRecord 派生）。 */
export interface DeckPaperSource {
  readonly arxivId: string
  readonly title: string
  readonly authors: readonly string[]
  readonly summary: string
  readonly notes: string
  readonly tags: readonly string[]
  /** 相对某项目的相关性评分（0-10），无项目时为 undefined。 */
  readonly relevanceScore?: number | undefined
  readonly relevanceReason?: string | undefined
}

/** 一次实验运行（deck 实验小节用）。 */
export interface DeckExperimentSource {
  readonly id: string
  readonly name: string
  readonly status: ExperimentStatus
  readonly metrics: Record<string, number | string>
}

/** 一份已生成的 deck 的展示视图。 */
export interface MeetingDeckView {
  /** 文件系统中的文件名（basename，含 .pptx）。 */
  readonly file: string
  /** 绝对路径。 */
  readonly path: string
  /** 展示标题（生成时的汇报主题）。 */
  readonly title: string
  readonly slides: number
  readonly sizeBytes: number
  /** ISO-8601。 */
  readonly updatedAt: string
  readonly createdAt: string
}

/** 生成一份 deck 的请求（渲染进程 → 主进程）。 */
export interface GenerateDeckRequest {
  readonly title: string
  readonly presenter?: string | undefined
  /** YYYY-MM-DD；缺省使用当天。 */
  readonly date?: string | undefined
  /** 关联项目 id（用于 relevance 评分展示与默认排序；可缺省）。 */
  readonly projectId?: string | undefined
  /** 已选论文 arXiv id 列表（空 = 不含文献小节）。 */
  readonly paperIds: readonly string[]
  /** 已选实验 id 列表（空 = 不含实验小节）。 */
  readonly experimentIds: readonly string[]
  /** 是否尝试用已配置大模型润色分享要点；无模型或失败时自动降级为确定性。 */
  readonly enhance: boolean
  /** 是否尝试 AI 配图（封面 + 至多 4 篇概念图）；需在设置中配置图像生成服务。 */
  readonly aiImages?: boolean | undefined
}

/** LLM 增强产物（页级内容微调，任何字段都可能缺省）。 */
export interface DeckEnhancement {
  /** 开场导语（约 60-120 字），插在论文小节之前。 */
  readonly overview?: string | undefined
  /** 实验小节的一句小结。 */
  readonly experimentsNote?: string | undefined
  /** 每篇论文的分享要点，keyed by arxivId。 */
  readonly paperPoints: Readonly<Record<string, readonly string[]>>
}

/** 当前可用的增强模型（settings.models 中选中项）。 */
export interface MeetingModelConfig {
  readonly baseUrl?: string | undefined
  readonly modelId?: string | undefined
  readonly apiKey?: string | undefined
}
