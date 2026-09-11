/**
 * 总览页「行动卡」派生规则。
 *
 * 纯函数集合：输入已读取的空间数据，输出按严重度排序的行动建议。
 * 不发起任何网络请求，只做本地状态推断，便于单测与避免总览页卡顿。
 */

import type { ModuleId } from '@/components/layout/Sidebar'

export type ActionSeverity = 'info' | 'warn' | 'urgent'

export interface ActionCard {
  readonly id: string
  readonly severity: ActionSeverity
  readonly title: string
  readonly detail: string
  readonly cta: { readonly label: string; readonly target: ModuleId }
}

/** 规则输入：各模块的最小状态快照。 */
export interface ActionCardInput {
  /** 各实验记录（含状态）。 */
  readonly experiments: readonly { readonly status: string; readonly updatedAt: string; readonly name: string }[]
  /** 关注的会议及其最近截稿（ISO 或 null）。 */
  readonly watchedVenues: readonly {
    readonly key: string
    readonly title: string
    readonly nextDeadlineAt: string | null
    readonly nextDeadlineKind: 'abstract' | 'paper' | null
  }[]
  /** 文献是否已有综述/笔记（粗略以 tags 是否含 reviewed 判断）。 */
  readonly papers: readonly { readonly arxivId: string; readonly title: string; readonly tags: readonly string[] }[]
  /** 论文项目列表（含最近修改时间）。 */
  readonly projects: readonly { readonly name: string; readonly updatedAt?: string }[]
  /** 当前时间（毫秒），便于测试注入。 */
  readonly now: number
}

const DAY_MS = 24 * 60 * 60 * 1000

function daysUntil(iso: string | null, now: number): number | null {
  if (iso === null) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return Math.ceil((t - now) / DAY_MS)
}

const SEVERITY_ORDER: Record<ActionSeverity, number> = { urgent: 0, warn: 1, info: 2 }

/**
 * 计算行动卡。
 * 规则（按优先级）：
 * - R2 截稿临近（≤14 天）→ urgent
 * - R5 实验运行超 24h 未更新 → warn
 * - R1 新文献未综述 → info
 * - R4 论文项目停滞 ≥7 天 → info
 */
export function computeActionCards(input: ActionCardInput): ActionCard[] {
  const cards: ActionCard[] = []

  // R2：截稿临近
  for (const venue of input.watchedVenues) {
    const d = daysUntil(venue.nextDeadlineAt, input.now)
    if (d === null || d < 0 || d > 14) continue
    const kindLabel = venue.nextDeadlineKind === 'abstract' ? '摘要' : '全文'
    cards.push({
      id: `venue-${venue.key}`,
      severity: d <= 3 ? 'urgent' : 'warn',
      title: `${venue.title} 截稿还有 ${String(d)} 天`,
      detail: `${kindLabel}截稿临近，检查论文进度与投稿材料`,
      cta: { label: '查看会议', target: 'venues' }
    })
  }

  // R5：实验长期运行未更新
  const staleExperiments = input.experiments.filter((e) => {
    if (e.status !== 'running') return false
    const t = Date.parse(e.updatedAt)
    return !Number.isNaN(t) && input.now - t > DAY_MS
  })
  if (staleExperiments.length > 0) {
    cards.push({
      id: 'experiments-stale',
      severity: 'warn',
      title: `${String(staleExperiments.length)} 个实验运行中且超过 24h 未更新`,
      detail: '确认训练状态，或更新指标/收敛状态',
      cta: { label: '查看实验', target: 'experiments' }
    })
  }

  // R1：新文献未综述（以缺少 reviewed 标签近似）
  const unreviewed = input.papers.filter((p) => !p.tags.includes('reviewed'))
  if (unreviewed.length > 0) {
    cards.push({
      id: 'papers-unreviewed',
      severity: 'info',
      title: `${String(unreviewed.length)} 篇文献待综述`,
      detail: '可交给 Agent 生成摘要与关联分析',
      cta: { label: '打开文献库', target: 'library' }
    })
  }

  // R4：论文项目停滞
  const staleProjects = input.projects.filter((p) => {
    if (p.updatedAt === undefined) return false
    const t = Date.parse(p.updatedAt)
    return !Number.isNaN(t) && input.now - t > 7 * DAY_MS
  })
  if (staleProjects.length > 0) {
    cards.push({
      id: 'projects-stale',
      severity: 'info',
      title: `${String(staleProjects.length)} 个论文项目超过 7 天未更新`,
      detail: staleProjects.map((p) => p.name).slice(0, 3).join('、'),
      cta: { label: '继续写作', target: 'paper' }
    })
  }

  return cards.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
}
