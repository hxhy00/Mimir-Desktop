/**
 * 内置 Skill 注册表（指令 + 研究技能，与 src/lib/slash/registry.ts 语义一一对应）。
 * 仅维护路由元数据；正文展开仍在渲染层注册表。新增/迭代技能 = 在此注册并补全元数据。
 */
import type { SkillCategory, SkillCost, SkillMetaRecord } from './types'

interface MetaInput {
  trigger: string
  kind: 'command' | 'skill'
  title: string
  description: string
  whenToUse: string
  usage: string
  argsHint: string
  requiresArg?: boolean
  category: SkillCategory
  tags: string[]
  applicableBoundary: string
  notSuitable: string
  positiveExamples: string[]
  negativeExamples: string[]
  costLevel?: SkillCost
  allowAgentTrigger?: boolean
  allowUserTrigger?: boolean
  maxSessionTimes?: number
}

function m(input: MetaInput): SkillMetaRecord {
  return {
    trigger: input.trigger,
    kind: input.kind,
    title: input.title,
    description: input.description,
    whenToUse: input.whenToUse,
    usage: input.usage,
    argsHint: input.argsHint,
    requiresArg: input.requiresArg ?? false,
    category: input.category,
    tags: input.tags,
    applicableBoundary: input.applicableBoundary,
    notSuitable: input.notSuitable,
    positiveExamples: input.positiveExamples,
    negativeExamples: input.negativeExamples,
    costLevel: input.costLevel ?? 'medium',
    allowAgentTrigger: input.allowAgentTrigger ?? true,
    allowUserTrigger: input.allowUserTrigger ?? true,
    maxSessionTimes: input.maxSessionTimes ?? 0
  }
}

export const BUILTIN_SKILLS: SkillMetaRecord[] = [
  m({
    trigger: 'research-pipeline',
    kind: 'skill',
    title: '全流程管线',
    description: '从想法到论文的端到端编排：开题→查新→综述→方案→实验→结论→写作→评审',
    whenToUse: '用户想一次推进完整研究流程，或说“做科研 / 从想法到论文”。',
    usage: '/research-pipeline 端到端推进这个方向',
    argsHint: '[研究课题]',
    category: 'research_design',
    tags: ['pipeline', 'research', 'all'],
    applicableBoundary: '需要覆盖“想法→论文”整链、或一次编排多个子流程时。',
    notSuitable: '单一明确子任务（如只要检索、只要润色一段文字）。',
    positiveExamples: ['帮我把这个方向从开题到论文完整跑一遍', '全流程推进，先综述后设计实验再写'],
    negativeExamples: ['把这段摘要润色一下', '查一下有没有人做过 X'],
    costLevel: 'high',
    maxSessionTimes: 6
  }),
  m({
    trigger: 'research-idea',
    kind: 'command',
    title: '科研开题',
    description: '从文献出发的开题梳理：检索→落库→产出想法报告',
    whenToUse: '拿到新方向、想查清背景并正式立项时。',
    usage: '/research-idea 让大模型阅读论文并自动复现',
    argsHint: '<研究方向>',
    requiresArg: true,
    category: 'research_design',
    tags: ['idea', 'topic', 'proposal'],
    applicableBoundary: '开新题、需要文献支撑的立项梳理与想法报告。',
    notSuitable: '已有完整方案只需补实验细节。',
    positiveExamples: ['帮我评估“扩散模型压缩”这个开题方向', '想确认一个新方向值不值得投入'],
    negativeExamples: ['现有方案补个消融实验怎么排', '把这段话翻译一下'],
    costLevel: 'medium'
  }),
  m({
    trigger: 'research-plan',
    kind: 'command',
    title: '实验方案',
    description: '把课题/想法拆成可验证的实验方案与假设清单',
    whenToUse: '已确立方向、需要设计实验序列与判定规则时。',
    usage: '/research-plan 我们的方法还没做消融实验',
    argsHint: '[课题 | 补充说明]',
    category: 'research_design',
    tags: ['plan', 'experiment', 'ablation', 'hypothesis'],
    applicableBoundary: '从课题/想法拆可验证实验序列、假设-claim 映射与消融顺序。',
    notSuitable: '只要对已有结果写结论（用 result-to-claim），或只需检索资料。',
    positiveExamples: ['给我们的方法排一组消融实验', '拆解成可验证的假设清单'],
    negativeExamples: ['判定现有实验支撑哪几条结论', '综述一下这个方向'],
    costLevel: 'medium'
  }),
  m({
    trigger: 'research-experiment-plan',
    kind: 'skill',
    title: '实验设计',
    description: '把假设变成排序/预算过的实验序列，对得上每条待验证假设',
    whenToUse: '方案已存在、需要具体 claim 映射与运行顺序，或用户说“实验方案”。',
    usage: '/research-experiment-plan 给我们主实验排个消融顺序',
    argsHint: '[课题/假设]',
    category: 'research_design',
    tags: ['experiment', 'plan', 'claim'],
    applicableBoundary: '已有方法/假设，需产出带排序与运行预算的实验序列。',
    notSuitable: '还在选题阶段（用 research-idea），或结果已有（用 result-to-claim）。',
    positiveExamples: ['把主实验的消融排个序并预估开销'],
    negativeExamples: ['开题判断这个方向有没有前景'],
    costLevel: 'medium'
  }),
  m({
    trigger: 'research-lit-review',
    kind: 'skill',
    title: '文献综述',
    description: '把方向梳理成有笔记、可引用的文献集并收进文献库',
    whenToUse: '用户说“文献综述 / lit review / 调研一下”，或需建文献底。',
    usage: '/research-lit-review 多智能体系统可靠性',
    argsHint: '<研究方向>',
    category: 'literature',
    tags: ['literature', 'review', 'survey', 'search'],
    applicableBoundary: '系统性梳理某方向文献并入库、逐篇写解读。',
    notSuitable: '只查一两篇是否存在（用 arxiv_search），或查新判定新颖性（novelty-check）。',
    positiveExamples: ['帮我系统综述一下“视频生成模型一致性”这个方向', '调研近三年 RLHF 的数据偏好建模工作'],
    negativeExamples: ['查一下 2301.12345 是什么', '判断我这个 idea 有没有人做过'],
    costLevel: 'high',
    maxSessionTimes: 8
  }),
  m({
    trigger: 'research-novelty-check',
    kind: 'skill',
    title: '查新',
    description: '对想法做已发表判定：机制/应用/结果三路检索，判已有/相邻/新颖',
    whenToUse: '用户说“查新 / novelty / 有没有人做过”，或在投入算力前验证想法。',
    usage: '/research-novelty-check 让 LLM 同时读摘要与正文的方法可能吗',
    argsHint: '<研究想法>',
    category: 'literature',
    tags: ['novelty', 'search', 'prior'],
    applicableBoundary: '验证想法新颖性、是否已有/相邻/新颖的三路判定。',
    notSuitable: '需要系统建文献底（用 lit-review），或只搜单篇。',
    positiveExamples: ['验证“用扩散模型做分子对接”有没有人发过'],
    negativeExamples: ['把方向全面调研一遍并整理成笔记'],
    costLevel: 'medium'
  }),
  m({
    trigger: 'paper-write',
    kind: 'command',
    title: '论文写作',
    description: '起草 LaTeX 论文：骨架→逐节内容→参考文献纪律',
    whenToUse: '实验结果齐了、要在「论文」模块正式成稿时。',
    usage: '/paper-write 按 NeurIPS 风格组织我们的方法部分',
    argsHint: '[主题 | 写作说明]',
    category: 'paper',
    tags: ['paper', 'write', 'latex'],
    applicableBoundary: '起草论文骨架与各节内容、组织结构与篇幅。',
    notSuitable: '仅润色措辞（用 deai），或已有稿子要评审（research-review）。',
    positiveExamples: ['按双栏会议风格起草我们的方法部分'],
    negativeExamples: ['把这段话去一下 AI 味', '审一下这份手稿有没有逻辑漏洞'],
    costLevel: 'high',
    maxSessionTimes: 8
  }),
  m({
    trigger: 'research-paper-drafting',
    kind: 'skill',
    title: '论文逐节起草',
    description: '在「论文」模块逐节起草 LaTeX，边写边编译的精细路径',
    whenToUse: '用户说“写论文 / 逐节写”，或要更可控的成稿方式。',
    usage: '/research-paper-drafting 先起草方法与实验两节',
    argsHint: '[方向/章节]',
    category: 'paper',
    tags: ['paper', 'write', 'draft'],
    applicableBoundary: '需要按章节渐进起草并配合编译循环的精细写作。',
    notSuitable: '一次性整体成稿即可（paper-write 足够）。',
    positiveExamples: ['从引言开始逐节写论文'],
    negativeExamples: ['帮我整理论文整体大纲和章节顺序'],
    costLevel: 'high',
    maxSessionTimes: 8
  }),
  m({
    trigger: 'paper-compile',
    kind: 'command',
    title: '编译诊断',
    description: '把 LaTeX 编译错误/警告日志解析成可执行修复清单',
    whenToUse: '「论文」模块编译报错、需要逐条定位与修复建议时。',
    usage: '/paper-compile 把下面的编译日志粘进来',
    argsHint: '[项目目录]',
    category: 'paper',
    tags: ['latex', 'compile', 'fix'],
    applicableBoundary: '解析编译日志、定位错误行并给修复建议。',
    notSuitable: '没有编译日志的写作类请求。',
    positiveExamples: ['下面这段 latexmk 报错帮我逐条修复'],
    negativeExamples: ['帮我把方法节扩写 300 字'],
    costLevel: 'low'
  }),
  m({
    trigger: 'research-review',
    kind: 'command',
    title: '论文评审',
    description: '对粘贴文稿做独立同行评审，输出 PASS/WARN/FAIL 与问题清单',
    whenToUse: '草稿完成或收到审稿意见、需要第三方严肃评审时。',
    usage: '/research-review 请重点检查实验与结论的匹配',
    argsHint: '<评审重点>',
    category: 'paper',
    tags: ['review', 'paper', 'critique'],
    applicableBoundary: '对完整/半成品文稿做结构、方法、结论匹配的评审。',
    notSuitable: '回复已有审稿意见（用 rebuttal），或只是润色。',
    positiveExamples: ['以审稿人视角评一下这份手稿'],
    negativeExamples: ['帮我把摘要改通顺'],
    costLevel: 'medium'
  }),
  m({
    trigger: 'research-rebuttal',
    kind: 'skill',
    title: '回复审稿',
    description: '把评审拆成原子问题，起草有依据、守篇幅的 rebuttal',
    whenToUse: '收到审稿意见/OpenReview，或用户说“回复审稿”。',
    usage: '/research-rebuttal 帮我起草对这两位审稿人的回复',
    argsHint: '[粘贴审稿意见]',
    category: 'paper',
    tags: ['rebuttal', 'review', 'response'],
    applicableBoundary: '把审稿意见拆为原子问题并逐条起草回复。',
    notSuitable: '尚未收到审稿意见、只是自查（research-review）。',
    positiveExamples: ['审稿人 2 的三条意见怎么逐条回'],
    negativeExamples: ['评估这篇投稿本身质量如何'],
    costLevel: 'medium'
  }),
  m({
    trigger: 'research-citation-audit',
    kind: 'skill',
    title: '引用审计',
    description: '零信任核对参考文献：每条真实存在且确实被需要',
    whenToUse: '投稿前，或用户说“审查引用 / 核对参考文献”。',
    usage: '/research-citation-audit 核对下面的参考文献',
    argsHint: '[粘贴 .bib 与引用句]',
    category: 'paper',
    tags: ['citation', 'reference', 'audit'],
    applicableBoundary: '逐条核对引文真实性与必要性。',
    notSuitable: '写作中新建引用列表（与引用管理流程无关）。',
    positiveExamples: ['核对下面参考文献是否真实且都被引用'],
    negativeExamples: ['帮我生成引言并配上引用'],
    costLevel: 'medium'
  }),
  m({
    trigger: 'research-paper-deai',
    kind: 'skill',
    title: '去 AI 味',
    description: '中英双语去 AI 痕迹润色：只改措辞，公式/数字/引用逐字不动',
    whenToUse: '用户说“去AI味 / de-AI / humanize / 润色”，或提交前定稿。',
    usage: '/research-paper-deai 帮我润色下面这段摘要',
    argsHint: '[粘贴待润色文本]',
    category: 'paper',
    tags: ['deai', 'polish', 'humanize'],
    applicableBoundary: '对已写好文本做措辞级去模板化润色，不改语义。',
    notSuitable: '需要扩写/补内容，或翻译。',
    positiveExamples: ['这段引言一读就很 AI，帮我 humanize'],
    negativeExamples: ['把这段扩写成 300 字'],
    costLevel: 'low'
  }),
  m({
    trigger: 'research-result-to-claim',
    kind: 'skill',
    title: '结果到结论',
    description: '判定实验到底支撑/否定/悬置哪些结论，写作前把关',
    whenToUse: '实验完成、写正文前，或用户说“结果分析 / result to claim”。',
    usage: '/research-result-to-claim 判断我们现有实验支撑哪几条结论',
    argsHint: '[实验结果说明]',
    category: 'analysis',
    tags: ['result', 'claim', 'analysis'],
    applicableBoundary: '用证据判定支撑/否定/悬置，写作前把关结论强度。',
    notSuitable: '还没做实验要排方案（用 plan/experiment-plan）。',
    positiveExamples: ['现有消融能支撑主结论吗，逐条判定'],
    negativeExamples: ['排一下还要补哪些实验'],
    costLevel: 'low'
  }),
  m({
    trigger: 'research-figure-plan',
    kind: 'skill',
    title: '论文配图规划',
    description: '设计承载结论的图：逐图规格→可复现产出→图表模块登记',
    whenToUse: '用户说“画图 / 论文配图”，或论文需要规划配图。',
    usage: '/research-figure-plan 主结果图该画什么',
    argsHint: '[图表说明]',
    category: 'figures',
    tags: ['figure', 'plot', 'visual'],
    applicableBoundary: '结论句→图注→可复现产出规格的配图规划。',
    notSuitable: '生成具体图表文件（图表模块/工具职责）。',
    positiveExamples: ['主结果图怎么画才能撑住结论'],
    negativeExamples: ['把这组数据画成折线图'],
    costLevel: 'low'
  }),
  m({
    trigger: 'research-meeting-deck',
    kind: 'skill',
    title: '组会汇报',
    description: '组会材料组织：单篇逐图精读 或 全项目汇报，图注写成结论句',
    whenToUse: '组会临近，或用户说“组会 / meeting deck”。',
    usage: '/research-meeting-deck 准备本周的组会汇报',
    argsHint: '[汇报主题]',
    category: 'meeting',
    tags: ['meeting', 'deck', 'report'],
    applicableBoundary: '组织面向组会的汇报结构、单篇/全项目选材。',
    notSuitable: '生成 .pptx 文件本身（组会 Agent 的 meeting_deck 工具）。',
    positiveExamples: ['这周组会汇报怎么组织'],
    negativeExamples: ['直接生成一份 PPT'],
    costLevel: 'low'
  })
]
