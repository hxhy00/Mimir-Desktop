/** 前端组会模块类型（与 electron/meetings 主进程域对齐）。 */

export type ExperimentStatus = 'running' | 'success' | 'failed'

/** 实验记录（experiments:list 中的条目，与 src/lib/experiments.ts 一致）。 */
export interface ExperimentRecord {
  readonly id: string
  readonly name: string
  readonly status: ExperimentStatus
  readonly metrics: Record<string, number | string>
  readonly serverId?: string | undefined
  readonly updatedAt: string
}

/** 文献库论文（library:listPapers 返回项的前端镜像）。 */
export interface PaperRecord {
  readonly arxivId: string
  readonly title: string
  readonly authors: readonly string[]
  readonly summary: string
  readonly notes: string
  readonly tags: readonly string[]
  readonly projectIds: readonly string[]
  readonly pdfPath?: string | undefined
  readonly relevance?: Record<string, { score: number; reason: string; at: string }> | undefined
  readonly addedAt: string
}

/** 文献库项目。 */
export interface ProjectRecord {
  readonly id: string
  readonly title: string
  readonly paperDir?: string | undefined
  readonly createdAt: string
  readonly updatedAt: string
}

/** 一份已生成的演示文稿。 */
export interface MeetingDeckView {
  readonly file: string
  readonly path: string
  readonly title: string
  readonly slides: number
  readonly sizeBytes: number
  readonly updatedAt: string
  readonly createdAt: string
}

/** 生成请求（前端 → IPC）。 */
export interface MeetingGenerateRequest {
  readonly title: string
  readonly presenter?: string | undefined
  readonly date?: string | undefined
  readonly projectId?: string | undefined
  readonly paperIds: readonly string[]
  readonly experimentIds: readonly string[]
  readonly enhance: boolean
}

/** 生成请求上的该项目的相关性评分（0-10），无则 undefined。 */
export function relevanceScoreOf(paper: PaperRecord, projectId: string | undefined): number | undefined {
  if (projectId === undefined) return undefined
  return paper.relevance?.[projectId]?.score
}

export function formatDeckSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
