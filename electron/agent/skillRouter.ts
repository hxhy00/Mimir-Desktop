/**
 * Skill 分层路由：阶段1 粗召回（零 LLM 规则）+ 阶段2 精排（规则分数，可选 LLM 精排）。
 * 只负责候选收缩与排序，不替 Supervisor 做“是否调用”的最终判断。
 */
import type { SkillMetaRecord } from './skills/types'

/** 精排后送入 Supervisor 的候选数。 */
export const SKILL_TOP_K = 4

export interface RouterContext {
  message: string
  /** Meta-Cognition 输出：意图标签 / 建议目录 / 复杂度。 */
  intents: string[]
  categories: string[]
  complexity: 'low' | 'medium' | 'high'
  /** 会话内每个 trigger 已被路由进候选的次数（用于 max_session_times 硬规则）。 */
  sessionCounts: Map<string, number>
}

export interface RouterCandidate {
  trigger: string
  title: string
  description: string
  costLevel: string
  applicableBoundary: string
  notSuitable: string
  positiveExamples: string[]
  negativeExamples: string[]
}

interface Scored extends RouterCandidate {
  score: number
  rec: SkillMetaRecord
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,，、;；:：.。()（）/\\"'\-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
}

function overlap(a: string[], b: string[]): number {
  const set = new Set(b)
  return a.filter((t) => set.has(t)).length
}

/** 阶段1 粗召回：目录分区 + 标签命中 + 硬规则过滤 + 正例弱匹配（低过滤强度，宁大勿漏）。 */
function coarseRecall(skills: SkillMetaRecord[], ctx: RouterContext): SkillMetaRecord[] {
  const qTokens = tokenize(ctx.message)
  const intentSet = new Set(ctx.intents.map((i) => i.toLowerCase()))
  return skills.filter((s) => {
    if (!s.allowAgentTrigger) return false // 硬规则：不允许自动调用
    const max = s.maxSessionTimes
    if (max > 0 && (ctx.sessionCounts.get(s.trigger) ?? 0) >= max) return false // 会话次数上限
    if (ctx.complexity === 'low' && s.costLevel === 'high') return false // 低成本任务筛掉高开销技能

    const inCategory = ctx.categories.length === 0 || ctx.categories.includes(s.category)
    const tagHit = s.tags.some((t) => intentSet.has(t.toLowerCase())) || s.tags.some((t) => qTokens.includes(t.toLowerCase()))
    // 反例弱命中直接剔除（notSuitable 关键词命中 query）
    const hitNegative = s.notSuitable !== '' && qTokens.some((t) => s.notSuitable.toLowerCase().includes(t))
    if (hitNegative) return false
    return inCategory || tagHit
  })
}

/** 规则打分（精排基础分，LLM 精排在候选 > TOP_K 时可选覆盖排序）。 */
function ruleScore(s: SkillMetaRecord, ctx: RouterContext): number {
  const qTokens = tokenize(ctx.message)
  let score = 0
  score += overlap(qTokens, s.tags) * 3
  score += overlap(qTokens, tokenize(s.title + ' ' + s.description)) * 2
  score += overlap(qTokens, s.positiveExamples.map(tokenize).flat()) * 2
  score += ctx.categories.includes(s.category) ? 2 : 0
  // 命中不适用场景的强负样本扣分
  if (s.notSuitable !== '' && qTokens.some((t) => s.notSuitable.toLowerCase().includes(t))) score -= 6
  // 成本收益：低复杂度任务对 high cost 额外扣分（粗召回已滤 high/low 场景，这里兜底）
  if (ctx.complexity === 'low' && s.costLevel !== 'low') score -= 2
  return score
}

/** 序列化候选给 LLM 精排/注入使用的一行紧凑文本。 */
export function candidateLine(c: SkillMetaRecord): string {
  const cost = c.costLevel === 'low' ? '低成本' : c.costLevel === 'high' ? '高成本' : '中成本'
  return `- /${c.trigger} · ${c.title} — ${c.description}（${cost}）${c.applicableBoundary !== '' ? ` 适用：${c.applicableBoundary}` : ''}`
}

/** 把 top 候选压成一段“可选技能候选”上下文（注入 Supervisor）。 */
export function candidatesToContext(cands: RouterCandidate[]): string {
  if (cands.length === 0) return ''
  const lines = cands.map(
    (c) =>
      `- /${c.trigger} · ${c.title} — ${c.description}` +
      (c.applicableBoundary !== '' ? `（适用：${c.applicableBoundary}）` : '') +
      (c.costLevel === 'high' ? '（高成本，仅在必要时）' : '')
  )
  return `\n\n# 可选技能候选（如需可套用其流程，不需要请忽略）\n${lines.join('\n')}`
}

/**
 * 运行路由：粗召回 → 规则精排 →（可选 LLM 精排覆盖排序）→ top-K。
 * @param llmRerank 提供 LLM 精排的函数；返回 null 表示不启用/失败，回退规则排序。
 */
export async function routeSkills(
  skills: SkillMetaRecord[],
  ctx: RouterContext,
  k = SKILL_TOP_K,
  llmRerank?: (cands: RouterCandidate[], message: string) => Promise<RouterCandidate[] | null>
): Promise<RouterCandidate[]> {
  const coarse = coarseRecall(skills, ctx)
  const scored: Scored[] = coarse
    .map((rec) => ({ rec, score: ruleScore(rec, ctx), ...pick(rec) }))
    .sort((a, b) => b.score - a.score)

  let picked: RouterCandidate[] = scored.slice(0, k)
  if (scored.length > 1 && llmRerank !== undefined) {
    try {
      const ranked = await llmRerank(
        scored.slice(0, 10).map((s) => ({ ...pick(s.rec), costLevel: s.rec.costLevel, applicableBoundary: s.rec.applicableBoundary, notSuitable: s.rec.notSuitable, positiveExamples: s.rec.positiveExamples, negativeExamples: s.rec.negativeExamples })),
        ctx.message
      )
      if (ranked !== null && ranked.length > 0) picked = ranked.slice(0, k)
    } catch {
      // LLM 精排失败回退规则排序
    }
  }
  // 保底：分数为 0 的“碰运气”候选不注入，避免噪声（LLM 精排产物不带 score，直接保留）
  const meaningful = picked.filter((p) => {
    const s = (p as Scored).score
    return s === undefined || s > 0
  })
  return meaningful.slice(0, k)
}

function pick(rec: SkillMetaRecord): RouterCandidate {
  return {
    trigger: rec.trigger,
    title: rec.title,
    description: rec.description,
    costLevel: rec.costLevel,
    applicableBoundary: rec.applicableBoundary,
    notSuitable: rec.notSuitable,
    positiveExamples: rec.positiveExamples,
    negativeExamples: rec.negativeExamples
  }
}
