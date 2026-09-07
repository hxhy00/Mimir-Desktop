/**
 * Skill 注册模块（L2 业务技能 / L3 目录）。
 *
 * 落地形态：技能仍以「结构化任务提示」由 Supervisor 执行（L0→现有运行时），
 * 注册模块只负责：元数据、目录分类、召回/精排所需字段与自进化校验。
 * 手动 `/trigger` 的正文展开仍在渲染层注册表（registry/userSkills）完成，
 * 主进程注册表不复制正文，仅维护路由元数据与输入输出说明。
 */

export type SkillKind = 'command' | 'skill'
export type SkillCost = 'low' | 'medium' | 'high'

/** L3 目录（粗召回分区）。 */
export const SKILL_CATEGORIES = [
  'research_design', // 开题 / 方案 / 实验设计 / 全流程
  'literature', // 文献综述 / 查新
  'paper', // 写作 / 编译 / 评审 / 回复审稿 / 引用审计 / 去AI味
  'analysis', // 结果→结论
  'figures', // 配图规划
  'meeting' // 组会汇报
] as const
export type SkillCategory = (typeof SKILL_CATEGORIES)[number]

export const SKILL_CATEGORY_LABEL: Record<SkillCategory, string> = {
  research_design: '科研开题与方案',
  literature: '文献处理',
  paper: '论文写作与评审',
  analysis: '结果分析',
  figures: '配图规划',
  meeting: '组会汇报'
}

/** 注册一条技能所需完整元数据（路由系统依赖；缺失关键字段会被校验拒绝）。 */
export interface SkillMetaRecord {
  trigger: string
  kind: SkillKind
  title: string
  /** 给路由/LLM 的简短说明。 */
  description: string
  /** 何时适合（≈适用边界补充）。 */
  whenToUse: string
  usage: string
  argsHint: string
  requiresArg: boolean
  /** L3 目录。 */
  category: SkillCategory
  /** 标签集（意图标签召回用）。 */
  tags: string[]
  /** 适用边界。 */
  applicableBoundary: string
  /** 不适用场景（强约束，精排重点扣分项）。 */
  notSuitable: string
  /** 正例（适合该技能的 query 描述）。 */
  positiveExamples: string[]
  /** 反例（看似相关其实不该用）。 */
  negativeExamples: string[]
  costLevel: SkillCost
  /** 允许 Agent 自动路由（false 则不出现在候选）。 */
  allowAgentTrigger: boolean
  /** 允许用户 / 手动触发。 */
  allowUserTrigger: boolean
  /** 单会话最多被自动路由进候选的次数；0 = 不限。 */
  maxSessionTimes: number
}

/** 校验一条注册元数据，返回错误列表（空 = 通过，P1 自进化校验）。 */
export function validateSkillMeta(m: SkillMetaRecord): string[] {
  const errors: string[] = []
  if (typeof m.trigger !== 'string' || m.trigger.trim() === '') errors.push('trigger 缺失')
  else if (!/^[a-z][a-z0-9-]*$/.test(m.trigger.trim())) errors.push(`trigger「${m.trigger}」不合法`)
  if (m.title.trim() === '') errors.push('title 缺失')
  if (m.description.trim() === '') errors.push('description 缺失')
  if (!(SKILL_CATEGORIES as readonly string[]).includes(m.category)) errors.push(`category「${m.category}」不在目录内`)
  if (!Array.isArray(m.tags) || m.tags.length === 0) errors.push('tags 缺失')
  if (m.applicableBoundary.trim() === '') errors.push('applicableBoundary 缺失')
  if (m.costLevel !== 'low' && m.costLevel !== 'medium' && m.costLevel !== 'high') errors.push('costLevel 不合法')
  if (typeof m.allowAgentTrigger !== 'boolean') errors.push('allowAgentTrigger 缺失')
  return errors
}
