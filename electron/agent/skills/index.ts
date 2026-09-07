/**
 * Skill 注册聚合：内置注册表 + 运行时加载用户自定义技能（store mimir:user-skills）。
 * 自定义技能缺省字段自动推导；关键字段非法/缺失到无法推导时拒绝注册（P1 自进化校验）。
 */
import { BUILTIN_SKILLS } from './builtin'
import { getStoreValue } from '../../library/store'
import type { SkillCategory, SkillMetaRecord } from './types'

const USER_SKILL_STORAGE_KEY = 'mimir:user-skills'

/** 从描述/正文文本猜测 L3 目录（供自定义技能缺省推导；内置注册无需）。 */
function categoryFromText(text: string): SkillCategory {
  const low = text.toLowerCase()
  if (/(文献|综述|调研|查新|novelty|survey|literature|search)/.test(low)) return 'literature'
  if (/(组会|汇报|deck|meeting)/.test(low)) return 'meeting'
  if (/(图|figure|画图|可视化|plot)/.test(low)) return 'figures'
  if (/(结论|结果分析|claim|result)/.test(low)) return 'analysis'
  if (/(写作|paper|latex|润色|评审|rebuttal|citation|审稿)/.test(low)) return 'paper'
  return 'research_design'
}

function tagsFromText(text: string): string[] {
  const words = new Set<string>()
  for (const w of text.toLowerCase().split(/[\s,，、;；:：/\\()（）]+/)) {
    const t = w.trim()
    if (t.length >= 2 && t.length <= 24) words.add(t)
  }
  return [...words].slice(0, 12)
}

/** 把一条用户自定义技能（渲染层 userSkills 记录）归一化为路由注册项；缺字段自动推导。 */
function deriveCustom(rec: Record<string, unknown>): SkillMetaRecord {
  const trigger = typeof rec.trigger === 'string' ? rec.trigger.trim() : ''
  const title = typeof rec.title === 'string' ? rec.title.trim() : ''
  const description = typeof rec.description === 'string' ? rec.description.trim() : ''
  const whenToUse = typeof rec.whenToUse === 'string' ? rec.whenToUse.trim() : ''
  const usage = typeof rec.usage === 'string' ? rec.usage.trim() : ''
  const argsHint = typeof rec.argsHint === 'string' ? rec.argsHint.trim() : ''
  const hay = `${description} ${whenToUse} ${usage}`
  const costRaw = String(rec.costLevel ?? 'medium')
  const costLevel = costRaw === 'low' || costRaw === 'high' ? costRaw : 'medium'
  return {
    trigger,
    kind: 'skill',
    title: title !== '' ? title : trigger,
    description,
    whenToUse,
    usage,
    argsHint,
    requiresArg: rec.requiresArg === true,
    category: categoryFromText(hay),
    tags: Array.isArray(rec.tags)
      ? (rec.tags as string[]).map((t) => String(t)).filter((t) => t !== '')
      : tagsFromText(hay),
    applicableBoundary:
      typeof rec.applicableBoundary === 'string' && rec.applicableBoundary.trim() !== ''
        ? rec.applicableBoundary.trim()
        : whenToUse !== ''
          ? whenToUse
          : description,
    notSuitable: typeof rec.notSuitable === 'string' ? rec.notSuitable.trim() : '',
    positiveExamples: Array.isArray(rec.positiveExamples)
      ? (rec.positiveExamples as string[]).map((t) => String(t)).filter((t) => t !== '')
      : [usage].filter((t) => t !== ''),
    negativeExamples: Array.isArray(rec.negativeExamples)
      ? (rec.negativeExamples as string[]).map((t) => String(t)).filter((t) => t !== '')
      : [],
    costLevel,
    allowAgentTrigger: rec.allowAgentTrigger !== false,
    allowUserTrigger: rec.allowUserTrigger !== false,
    maxSessionTimes: typeof rec.maxSessionTimes === 'number' && rec.maxSessionTimes > 0 ? Math.trunc(rec.maxSessionTimes) : 0
  }
}

export interface SkillLoadResult {
  /** 已通过校验的可用注册项（内置 + 自定义）。 */
  skills: SkillMetaRecord[]
  /** 被拒绝注册的自定义项与原因（供日志 / 未来 UI 提示）。 */
  rejected: { trigger: string; reasons: string[] }[]
}

/** 读取并归一化全部技能注册项（内置恒在；自定义每次从 store 读取以支持运行时增删）。 */
export function loadSkillRegistry(): SkillLoadResult {
  const skills = [...BUILTIN_SKILLS]
  const rejected: { trigger: string; reasons: string[] }[] = []
  let raw: unknown
  try {
    raw = getStoreValue<unknown>(USER_SKILL_STORAGE_KEY)
  } catch {
    raw = undefined
  }
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue
      const rec = item as Record<string, unknown>
      const trigger = typeof rec.trigger === 'string' ? rec.trigger.trim() : ''
      if (trigger === '') continue
      const derived = deriveCustom(rec)
      // P1 自进化校验：缺失关键且无法推导则拒绝注册
      const reasons: string[] = []
      if (derived.trigger === '') reasons.push('trigger 缺失')
      if (derived.description === '') reasons.push('description 缺失且无法推导')
      if (derived.tags.length === 0) reasons.push('tags 缺失且无法从描述推导')
      if (reasons.length > 0) {
        rejected.push({ trigger, reasons })
        continue
      }
      if (!skills.some((s) => s.trigger === derived.trigger)) skills.push(derived)
    }
  }
  return { skills, rejected }
}
