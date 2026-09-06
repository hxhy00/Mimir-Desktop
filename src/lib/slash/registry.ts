/**
 * 斜杠「技能与指令」注册表。
 *
 * 清单与语义照搬 Mimir（packages/mimir/src/skills.ts 的 BUNDLED_SKILLS，
 * 以及 commands/ 里的 research-idea / research-plan / paper-write /
 * paper-compile / research-review），在本应用以 L0 形态落地：输入
 * `/trigger 参数` 时展开为一段结构化任务提示注入 Agent，不产生本地文件副作用。
 */
import type { SlashEntry, SlashKind, SlashMatch } from './types'
import {
  researchPipelineContent,
  researchLitReviewContent,
  researchNoveltyCheckContent,
  researchExperimentPlanContent,
  researchResultToClaimContent,
  researchPaperDraftingContent,
  researchPaperDeaiContent,
  researchCitationAuditContent,
  researchRebuttalContent,
  researchFigurePlanContent,
  researchMeetingDeckContent,
} from './skillBodies'
import {
  IDEA_STEPS,
  PLAN_STEPS,
  PAPER_WRITE_STEPS,
  PAPER_COMPILE_STEPS,
  REVIEW_STEPS,
} from './commandBodies'

/** 由标题/触发词/步骤常量组装一条「指令」的 compose。 */
function commandCompose(steps: string, requiresArg: boolean) {
  return (args: string): string => {
    const trimmed = args.trim()
    const paramLine =
      trimmed === '' ? '（本次未附带参数。' + (requiresArg ? '如需要，先向用户索要用法后再开始。' : '按默认流程推进。') + '）' : `本次参数/说明：${trimmed}`
    return `${paramLine}\n\n${steps}\n\n（本指令改编自 Mimir 的 research-* 命令；涉及写文件/编译/读盘处均已改为对话产出或引导你在对应模块操作。）`
  }
}

function entry(
  kind: SlashKind,
  trigger: string,
  title: string,
  description: string,
  whenToUse: string,
  argsHint: string,
  usage: string,
  requiresArg: boolean,
  compose: (args: string) => string,
): SlashEntry {
  return { trigger, kind, title, description, whenToUse, argsHint, usage, requiresArg, compose }
}

// ─── 指令（commands，照搬 Mimir）────────────────────────────────────────

const COMMAND_METAS: ReadonlyArray<
  { trigger: string; title: string; description: string; whenToUse: string; argsHint: string; usage: string; requiresArg: boolean; steps: string }
> = [
  {
    trigger: 'research-idea',
    title: '科研开题（research-idea）',
    description: '从文献出发的开题梳理：检索→落库→产出想法报告',
    whenToUse: '拿到一个新的研究方向、想查清文献背景并正式立项时。',
    argsHint: '<研究方向>',
    usage: '/research-idea 让大模型阅读论文并自动复现',
    requiresArg: true,
    steps: IDEA_STEPS,
  },
  {
    trigger: 'research-plan',
    title: '实验方案（research-plan）',
    description: '把课题/想法拆成可验证的实验方案与假设清单',
    whenToUse: '已确立课题方向、需要设计实验序列与判定规则时。',
    argsHint: '[课题 | 补充说明]',
    usage: '/research-plan 我们的方法还没做消融实验',
    requiresArg: false,
    steps: PLAN_STEPS,
  },
  {
    trigger: 'paper-write',
    title: '论文写作（paper-write）',
    description: '起草 LaTeX 论文：骨架→逐节内容→参考文献纪律',
    whenToUse: '实验结果齐了、要在「论文」模块正式成稿时。',
    argsHint: '[主题 | 写作说明]',
    usage: '/paper-write 按 NeurIPS 风格组织我们的方法部分',
    requiresArg: false,
    steps: PAPER_WRITE_STEPS,
  },
  {
    trigger: 'paper-compile',
    title: '编译诊断（paper-compile）',
    description: '把 LaTeX 编译错误/警告日志解析成可执行修复清单',
    whenToUse: '「论文」模块编译报错、需要逐条定位与修复建议时。',
    argsHint: '[项目目录]',
    usage: '/paper-compile 把下面的编译日志粘进来',
    requiresArg: false,
    steps: PAPER_COMPILE_STEPS,
  },
  {
    trigger: 'research-review',
    title: '论文评审（research-review）',
    description: '对粘贴的文稿做一轮独立同行评审，输出 PASS/WARN/FAIL 与问题清单',
    whenToUse: '草稿完成或收到审稿意见、需要第三方视角的严肃评审时。',
    argsHint: '<评审重点>',
    usage: '/research-review 请重点检查实验与结论的匹配',
    requiresArg: false,
    steps: REVIEW_STEPS,
  },
]

// ─── 技能（skills，照搬 Mimir 的 research-* 清单）────────────────────────

interface SkillMeta {
  trigger: string
  title: string
  description: string
  whenToUse: string
  argsHint: string
  usage: string
  compose: (args: string) => string
}

const SKILL_METAS: SkillMeta[] = [
  {
    trigger: 'research-pipeline',
    title: '全流程管线（research-pipeline）',
    description: '从想法到论文的端到端编排：开题→查新→综述→方案→实验→结论→写作→评审',
    whenToUse: '想一次推进完整研究流程，或用户说"做科研 / 从想法到论文"。',
    argsHint: '[研究课题]',
    usage: '/research-pipeline 端到端推进这个方向',
    compose: researchPipelineContent,
  },
  {
    trigger: 'research-lit-review',
    title: '文献综述（research-lit-review）',
    description: '把方向梳理成有笔记、可引用的文献集并收进文献库',
    whenToUse: '用户说"文献综述 / lit review / 调研一下"，或一个方向需要建文献底。',
    argsHint: '<研究方向>',
    usage: '/research-lit-review 多智能体系统可靠性',
    compose: researchLitReviewContent,
  },
  {
    trigger: 'research-novelty-check',
    title: '查新（research-novelty-check）',
    description: '对想法做已发表判定：机制/应用/结果三路检索，判已有/相邻/新颖',
    whenToUse: '用户说"查新 / novelty / 有没有人做过"，或在投入算力前验证想法。',
    argsHint: '<研究想法>',
    usage: '/research-novelty-check 让 LLM 同时读摘要与正文的方法可能吗',
    compose: researchNoveltyCheckContent,
  },
  {
    trigger: 'research-experiment-plan',
    title: '实验设计（research-experiment-plan）',
    description: '把假设变成排序/预算过的实验序列，对得上每条待验证假设',
    whenToUse: '方案已存在、需要具体的 claim 映射与运行顺序，或用户说"实验方案"。',
    argsHint: '[课题/假设]',
    usage: '/research-experiment-plan 给我们主实验排个消融顺序',
    compose: researchExperimentPlanContent,
  },
  {
    trigger: 'research-result-to-claim',
    title: '结果到结论（research-result-to-claim）',
    description: '判定实验到底支撑/否定/悬置哪些结论，写作前把关',
    whenToUse: '实验完成、写正文前，或用户说"结果分析 / result to claim"。',
    argsHint: '[实验结果说明]',
    usage: '/research-result-to-claim 判断我们现有实验支撑哪几条结论',
    compose: researchResultToClaimContent,
  },
  {
    trigger: 'research-paper-drafting',
    title: '论文逐节起草（research-paper-drafting）',
    description: '在「论文」模块逐节起草 LaTeX，边写边编译的精细路径',
    whenToUse: '用户说"写论文 / 逐节写"，或要更可控的成稿方式。',
    argsHint: '[方向/章节]',
    usage: '/research-paper-drafting 先起草方法与实验两节',
    compose: researchPaperDraftingContent,
  },
  {
    trigger: 'research-paper-deai',
    title: '去 AI 味（research-paper-deai）',
    description: '中英双语去 AI 痕迹润色：只改措辞，公式/数字/引用逐字不动',
    whenToUse: '用户说"去AI味 / de-AI / humanize / 润色"，或提交前的定稿阶段。',
    argsHint: '[粘贴待润色文本]',
    usage: '/research-paper-deai 帮我润色下面这段摘要',
    compose: researchPaperDeaiContent,
  },
  {
    trigger: 'research-citation-audit',
    title: '引用审计（research-citation-audit）',
    description: '零信任核对参考文献：每条真实存在且确实被需要',
    whenToUse: '投稿前，或用户说"审查引用 / 核对参考文献"。',
    argsHint: '[粘贴 .bib 与引用句]',
    usage: '/research-citation-audit 核对下面的参考文献',
    compose: researchCitationAuditContent,
  },
  {
    trigger: 'research-rebuttal',
    title: '回复审稿（research-rebuttal）',
    description: '把评审拆成原子问题，起草有依据、守篇幅的 rebuttal',
    whenToUse: '收到审稿意见/OpenReview，或用户说"回复审稿 / rebuttal"。',
    argsHint: '[粘贴审稿意见]',
    usage: '/research-rebuttal 帮我起草对这两位审稿人的回复',
    compose: researchRebuttalContent,
  },
  {
    trigger: 'research-figure-plan',
    title: '论文配图规划（research-figure-plan）',
    description: '设计承载结论的图：逐图规格→可复现产出→图表模块登记',
    whenToUse: '用户说"画图 / 论文配图"，或论文需要规划配图。',
    argsHint: '[图表说明]',
    usage: '/research-figure-plan 主结果图该画什么',
    compose: researchFigurePlanContent,
  },
  {
    trigger: 'research-meeting-deck',
    title: '组会汇报（research-meeting-deck）',
    description: '组会材料组织：单篇逐图精读 或 全项目汇报，图注写成结论句',
    whenToUse: '组会临近，或用户说"组会 / meeting deck"。',
    argsHint: '[汇报主题]',
    usage: '/research-meeting-deck 准备本周的组会汇报',
    compose: researchMeetingDeckContent,
  },
]

// ─── 导出注册表与解析 ───────────────────────────────────────────────────

/** 全部指令条目（带 compose）。 */
export const COMMAND_ENTRIES: SlashEntry[] = COMMAND_METAS.map((meta) =>
  entry(
    'command',
    meta.trigger,
    meta.title,
    meta.description,
    meta.whenToUse,
    meta.argsHint,
    meta.usage,
    meta.requiresArg,
    commandCompose(meta.steps, meta.requiresArg),
  ),
)

/** 全部技能条目。 */
export const SKILL_ENTRIES: SlashEntry[] = SKILL_METAS.map((meta) =>
  entry('skill', meta.trigger, meta.title, meta.description, meta.whenToUse, meta.argsHint, meta.usage, false, meta.compose),
)

/** 菜单/目录展示用：指令在前、技能在后，按触发词排序。 */
export const SLASH_ENTRIES: SlashEntry[] = [...COMMAND_ENTRIES, ...SKILL_ENTRIES]

/** 构造触发词 -> 条目的查找表（后出现的覆盖先出现的）。 */
function entryMapOf(entries: readonly SlashEntry[]): Map<string, SlashEntry> {
  const map = new Map<string, SlashEntry>()
  for (const item of entries) map.set(item.trigger, item)
  return map
}

/** 按前缀过滤（用于斜杠菜单实时过滤）。entries 缺省为内置注册表，可传入「内置 + 自定义」合并列表。 */
export function filterSlashEntries(query: string, entries: readonly SlashEntry[] = SLASH_ENTRIES): SlashEntry[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...entries]
  return entries.filter(
    (item) =>
      item.trigger.toLowerCase().includes(q) ||
      item.title.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q),
  )
}

/** 解析一条用户消息：当它形如 `/trigger 参数` 且命中注册表时返回展开结果。entries 缺省为内置注册表。 */
export function resolveSlashInput(input: string, entries: readonly SlashEntry[] = SLASH_ENTRIES): SlashMatch | null {
  const text = input.trim()
  const match = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(text)
  if (match === null) return null
  const entryFor = entryMapOf(entries).get(match[1] ?? '')
  if (entryFor === undefined) return null
  const args = (match[2] ?? '').trim()
  return { entry: entryFor, args, expanded: entryFor.compose(args) }
}
