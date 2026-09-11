import { createDeepAgent } from 'deepagents'
import { ChatOpenAI } from '@langchain/openai'
import { tool } from 'langchain/tools'
import { z } from 'zod'
import { loadMemoryTool } from './tools/memory'
import { getStoreValue } from '../library/store'
import { loadSkillRegistry } from './skills'
import { candidatesToContext, routeSkills, SKILL_TOP_K } from './skillRouter'
import type { RouterCandidate } from './skillRouter'
import { loadSubAgentDefs, WORKER_TOOL_CATALOG, BUILTIN_SUBAGENTS } from './subagentRegistry'
import { MimirFsBackend } from './fsBackend'
import { createAgentTraceHandler, type AgentTraceLevel } from './trace'

/** Supervisor 模式：主管 Agent 负责规划并把任务委派给按科研模块划分的子 Agent（worker）。
 *  每个 worker 携带各自模块的工具，在独立上下文中执行并把结构化结果返回给主管；
 *  主管汇总后输出最终回复。工具的调用/返回/出错会以事件外发，渲染层在事件树中展示。
 *
 *  ── 上下文治理「不入链清单」（见 docs/agent-context-governance.md）─────────
 *  1. SC 多专家合议的 K 路候选/聚合/反思原文：只进事件树，绝不写入持久会话历史；
 *     反思纪要仅在单轮内拼接给主管使用（runScStage → finalMessage）。
 *  2. 工具返回（搜索/编译/实验等 ToolMessage）：当轮图内消费即弃，不沉淀为长期上下文。
 *  3. 文档/文献/Wiki 全文：只经 library_search / wiki_search 等检索工具取片段，不复制整库进 prompt。
 *  4. 会话历史由渲染层按滑动窗口+摘要压缩后作为 options.history 传入（见 M2），
 *     历史中的附件只保留引用，不把附件全文随历史重复注入。
 *  5. 永久层身份常量（见 M5）：主进程每轮从 settings.identity 合成一条前置 system 消息，
 *     恒定在场但不进入渲染层持久历史，不参与压缩/归档；默认未配置时零注入。 */

/** 模块 worker 执行事件（渲染层顶部状态条与过程日志用）。 */
export interface AgentWorkerEvent {
  /** 稳定标识：worker id（如 'literature'）、'main' 等。 */
  taskId: string
  /** 展示标题：worker 名 / 阶段名。 */
  title: string
  status: 'running' | 'done' | 'error'
  /** done 时为该任务产物文本；error 时为错误说明；tool/think 时为过程说明。 */
  text?: string
  /** 工具执行耗时（毫秒），由 withToolTrace 在调用返回/出错时填充。 */
  durationMs?: number
  /** 行类别：task=worker 节点，tool=工具调用，think=推理文本（缺省视为 task）。 */
  kind?: 'phase' | 'task' | 'tool' | 'think' | 'think-token'
}

/**
 * 技能与指令目录（追加进 systemPrompt）。
 * 渲染层输入框以 `/trigger 参数` 触发时会把完整执行说明随消息带入；
 * 这里只维护一份轻量目录，让模型在自然语言请求命中时也知道按对应框架走。
 * 触发词/说明需与 src/lib/slash/registry.ts 保持一致。
 */
const SLASH_CATALOG_TEXT = `## 技能与指令

Mimir 提供一组科研「技能」与「指令」，用户在输入框以 / 前缀调用（例：/research-lit-review 多智能体可靠性）。当消息以已知的 / 触发词开头时，完整执行说明会随该消息附带，你必须严格按其中的步骤、门禁与硬规则执行。这些触发词也可以自然语言的方式被提出——此时同样按对应技能的框架推进：

指令（/ + 触发词）：
- /research-idea <研究方向> — 从文献出发的科研开题：检索→paper_fetch 落库→产出想法报告
- /research-plan [课题|说明] — 把课题拆成可验证的实验方案与假设清单
- /paper-write [主题|说明] — 起草 LaTeX 论文：骨架→逐节内容→参考文献纪律（编译由用户在「论文」模块配合）
- /paper-compile [项目目录] — 把用户粘贴的 LaTeX 编译日志解析成修复清单
- /research-review <评审重点> — 对用户粘贴内容做 PASS/WARN/FAIL 评审

技能（/ + 触发词）：
- /research-pipeline [课题] — 全流程管线：开题→查新→综述→方案→实验→结论→写作→评审
- /research-lit-review <方向> — 文献综述：并行 arxiv_search/web_search，逐篇入文献库并写解读
- /research-novelty-check <想法> — 查新门：机制/应用/结果三路检索，判 已有/相邻/新颖
- /research-experiment-plan [课题] — 实验设计：假设→claim 映射的运行序列与预算
- /research-result-to-claim [结果] — 结果到结论门：证据支撑/否定/悬置的判定
- /research-paper-drafting [方向] — 论文逐节起草（编译循环由用户在「论文」模块配合）
- /research-paper-deai [文本] — 中英去 AI 味润色：公式/数字/引用逐字不动
- /research-citation-audit [文本] — 零信任引用审计：每条引用真实存在且被需要
- /research-rebuttal [审稿意见] — 回复审稿：拆解原子问题，证据优先
- /research-figure-plan [说明] — 论文配图规划：结论句图注 + 可复现产出
- /research-meeting-deck [主题] — 组会汇报材料组织（.pptx 由「组会」模块生成）

通用纪律：只断言有证据支撑的结论；本地文件的读取与写入已由「文件 Agent」(files) 提供（在其明确掌握用户给出的路径后），LaTeX 编译 / 图片落盘 / PPT 生成仍主要在对应模块由用户在 GUI 里执行；对尚不具备的能力不要假装已经执行。`

/** Supervisor（主管 Agent）系统提示：负责规划与委派，简单任务直接回复。 */
const SUPERVISOR_SYSTEM = `你是 Mimir，一个以 Agent 为核心的科研助手，运行在桌面科研工作台中。你采用「Supervisor 编排架构」工作：作为主管 Agent，你负责理解用户意图、制定执行计划，并把需要专业能力或模块操作的任务委派给下面按科研模块划分的子 Agent；每个子 Agent 会在自己的上下文里完成任务并把结构化结果返回给你，由你整合成最终回复。

可委派的模块子 Agent（由你按任务需要选择；除下列内置子代理外，委派清单中出现的其它已注册子代理同样可用）：
- literature「文献 Agent」— 检索 arXiv/网页文献、读取论文元数据、把论文保存进文献库、维护论文标签与 AI 相关性评分、查询会议截稿；
- paper「论文 Agent」— LaTeX 论文项目编译与诊断、图表库管理、Wiki 研究笔记读写；
- experiment「实验 Agent」— 实验记录管理、成长/里程碑时间线；
- meeting「组会 Agent」— 从文献库与实验记录生成组会汇报 .pptx；
- server「服务器 Agent」— 查询已注册 GPU 服务器的连通性与实时状态（nvidia-smi）；
- files「文件 Agent」— 按用户给定路径读写本机文件：read_dir 列目录、read_file 读文本（把草稿/项目文件纳入上下文）、write_file 把 Markdown 产物（调研/综述/评审）创建或覆盖写入指定文档（写与空间外读需批准）。其中 read_file/edit_file/write_file/ls 等由系统内置文件工具提供（已在 backend 层接入批准卡）。

工作原则：
- 使用中文回复，保持专业且友好的语气；
- 先规划再执行：需要工具/专业知识时优先把对应子任务委派给合适的模块子 Agent（可多次委派、让多个子 Agent 接力完成一个复杂任务），不要在未委派的情况下声称已经执行了模块能力；子 Agent 返回结果后整理去重、标注来源，输出一份完整且对用户可读的最终回答，不凭空添加事实；
- 简单的对话、概念解释、文本润色/改写、对用户粘贴内容的分析等不需要工具的任务，由你直接完成，不必委派；
- 涉及写盘/长耗时/生成产物等副作用时，相关工具会先向用户弹「批准卡片」，请等待用户确认后再继续；
- 各模块（文献库/论文/实验/组会/服务器/图表/成长记录/会议截稿等）的能力均由对应子 Agent 的工具提供，你本人不直接持有这些工具；
- 长期记忆（load_memory，你直属的只读工具）：当任务与用户的长期研究方向/常用约束/常用事实相关时才按需调用，不要默认请求每次加载；档案为空时不要臆造用户偏好；
- 每条消息可能附带一段「可选技能候选」：当其中某技能与该请求匹配时，按它的流程执行；不匹配就忽略，保持常规工作方式，不要编造候选之外的技能。`

/** ── Self-Consistency 多专家合议（可选增强子图，默认关闭，用户按条消息开启）──
 *  控制流：Meta-Cognition 元认知判定 → 并行 K 路独立候选生成（无工具）→
 *  共识/分歧聚合（Aggregator）→ 反思校验（Reflection）。
 *  合议纪要不直接返回用户，而是作为「待验证上下文」交给 Supervisor，
 *  由主管调用模块子 Agent 的工具核实分歧点后再给出最终回复。
 *  该子图为代码级静态编排：节点与分支在编译期写死，K/角色只是运行时参数。 */

/** 可启用的合议专家视角（预置 5 专家池）。 */
const SC_EXPERT_IDS = ['reviewer', 'empiricist', 'literature', 'engineer', 'minimalist'] as const
export type ScExpertId = (typeof SC_EXPERT_IDS)[number]

interface ScExpert {
  id: ScExpertId
  label: string
  prompt: string
}

/** 预置专家池：每个视角给出一段独立立场提示，供 Meta-Cognition 选择启用哪几路。 */
const SC_EXPERT_POOL: ScExpert[] = [
  {
    id: 'reviewer',
    label: '严谨审稿人',
    prompt: `你是严谨的审稿人。独立评审这个问题，重点寻找：逻辑漏洞、未经证明的假设、反例与边界情况、过度承诺之处。给出你的结论与依据，明确标注哪些点只是怀疑、需要事实核查（标注【待验证】）。`
  },
  {
    id: 'empiricist',
    label: '实证派',
    prompt: `你是强调实证的科研人员。从数据/方法/可复现/实验验证的角度分析这个问题：已有或可获得的证据支持什么、结论应如何被验证、什么样的验证最省成本。不确定的证据一律标注【待验证】。`
  },
  {
    id: 'literature',
    label: '文献综述派',
    prompt: `你是文献综述专家。从领域定位与相关工作角度分析：该问题应参照哪些已有工作/方法、站在什么位置、引用要如何站得住（不要凭空捏造文献，凡提到文献一律标注【待验证·需检索】）。`
  },
  {
    id: 'engineer',
    label: '工程落地派',
    prompt: `你是工程落地专家。从实现约束角度分析：复杂度/依赖/成本/运行时长/可维护性/失败模式，给出务实可执行的落地方案。需要外部事实或数据支撑处标注【待验证】。`
  },
  {
    id: 'minimalist',
    label: '极简反方',
    prompt: `你是「极简反方」：刻意挑战其余视角，主张最小可行方案。指出方案是否过度设计、哪些步骤可省、最简单的路径是什么，并为任何省略给出风险说明。`
  }
]

/** 元认知判定的结构化输出 schema（enable 决定是否合议，roles 决定 K 路与启用专家）。 */
const SC_META_SCHEMA = z.object({
  enable: z.boolean(),
  roles: z.array(z.enum(SC_EXPERT_IDS)).min(1).max(5),
  reason: z.string()
})

const SC_META_SYSTEM = `你是 Mimir 的「元认知」判定器。判断该用户请求是否值得启用「多专家合议（Self-Consistency）」增强。
适合合议：问题开放、存在多种可行方案或答案、涉及权衡与不确定性、需要多视角评审（如科研选题、方案设计、方法/模型选型、论文回复审稿意见、去 AI 味、实验设计、写作结构）。
不适合：问候闲聊、单一事实查询、格式/语言转换、用户只要求立即执行某个操作。
请输出 JSON 决策：
- enable：是否启用合议；
- roles：从预置专家中选出要启用的 1~5 路（专家 id 与专长见下）；
- reason：≤ 60 字的中文说明。
可用专家：
- reviewer 严谨审稿：找漏洞/反例/过度承诺；
- empiricist 实证：证据/可复现/验证成本；
- literature 文献综述：相关工作/领域定位；
- engineer 工程落地：实现约束/复杂度/可行性；
- minimalist 极简反方：挑战过度设计、主张最小可行。
启用角色的数量即合议路数 K（1~5）；无把握时可多启用以增强合议。`

const SC_AGG_SYSTEM = `你是「多专家合议」的聚合者。你将收到多份独立候选意见，请做三件事并输出结构化中文：
## 共识点 —— 各方一致认可的结论与理由；
## 分歧点 —— 逐条列出分歧：各方主张 + 分歧的根源（假设不同 / 证据不足 / 视角不同）；
## 方案倾向 —— 基于合议给出 1~2 个较稳妥的倾向，并说明代价。
克制输出，不引入候选意见之外的新事实。`

const SC_REFLECT_SYSTEM = `你是「多专家合议」的反思校验员。审阅聚合纪要，完成反思：
1. 指出纪要中的逻辑漏洞、遗漏维度或被忽视的风险；
2. 逐条列出「最需要事实或工具验证的分歧/事实点」，每条标注【待验证】并说明应查证什么（文献/数据/编译/环境等）；
3. 给出一句话收束：本轮合议后最稳妥的下一步。
输出一段面向执行者（带工具的 Supervisor）的工作纪要，聚焦「待验证」项，≤ 600 字。`

/** ── Ultra 增强策略库（可选增强控制器：Supervisor 之上的增强层）────────────────
 *  Ultra 不是多专家合议（SC）的别名，而是一套「增强总开关 + 顶层策略控制器」：
 *  1. 只做：长程规划约束、策略选择（自动/手动）、cost 预算与自动降级、约束下发；
 *     不做具体研判推理（研判交给下游 Supervisor 与各模块子 Agent）；
 *  2. 执行动作全部下沉 Supervisor：本层把所选策略的增强产出（规划/纪要/修订稿）
 *     作为一段「内部参考约束」拼进本轮请求，Supervisor 据此调用模块子 Agent 完成；
 *  3. multi_expert 只是策略库中的一项；未来新增增强手段只需加一条策略与一个子图。 */
export type UltraStrategy =
  | 'plain'
  | 'multi_expert'
  | 'critique_reflect'
  | 'hybrid_mix'
  | 'self_consistency_vote'
/** Ultra 策略选择：auto = Ultra 按任务画像自动选；其余为用户手动指定。 */
export type UltraStrategyPick = 'auto' | UltraStrategy

export interface UltraStrategyMeta {
  label: string
  cost: 'low' | 'medium' | 'high'
  desc: string
}
export const ULTRA_STRATEGY_META: Record<UltraStrategy, UltraStrategyMeta> = {
  plain: { label: '普通增强', cost: 'low', desc: '仅长程规划约束；关闭高开销子图；Supervisor + 单轮反思' },
  multi_expert: { label: '多专家合议', cost: 'high', desc: '多视角对抗：K 路并行推演 + 共识/分歧输出' },
  critique_reflect: { label: '批判迭代', cost: 'medium', desc: '方案草稿 → 批判挑错 → 修订，循环 N 轮' },
  hybrid_mix: { label: '混合增强', cost: 'high', desc: '关键判断点触发合议，其余步骤走批判反思' },
  self_consistency_vote: { label: '一致性投票', cost: 'medium', desc: '轻量 SC：少路数只投票选最优，不出完整评审报告' }
}
export const ULTRA_STRATEGY_IDS: UltraStrategy[] = [
  'plain',
  'multi_expert',
  'critique_reflect',
  'hybrid_mix',
  'self_consistency_vote'
]

/** 一致性投票：只让 Meta 从预置专家里选 2~3 位最相关视角（保持轻量）。 */
const VOTE_META_SCHEMA = z.object({
  roles: z.array(z.enum(SC_EXPERT_IDS)).min(2).max(3),
  reason: z.string()
})
const VOTE_META_SYSTEM = `你是「一致性投票（轻量多专家）」的选择器。从预置专家中选 2~3 位与本任务最相关的视角参与投票（数量少，控制成本），并给出 ≤ 40 字理由。
可用专家：
- reviewer 严谨审稿（找漏洞/反例/过度承诺）；
- empiricist 实证（证据/可复现/验证成本）；
- literature 文献综述（相关工作/领域定位）；
- engineer 工程落地（实现约束/可行性）；
- minimalist 极简反方（挑战过度设计）。`
const VOTE_AGG_SYSTEM = `你是「一致性投票」的裁决者。多路独立候选基于同一问题作答。请做：
1. 找出观点最接近/互相印证的候选（一致性）；
2. 输出**推荐答案**（被多数或最可靠候选支持的那份，可融合表述，≤ 300 字）；
3. 结尾单列「需核验」≤ 2 条（真正需要工具/事实验证的点，标注【待验证】）。
不输出完整分歧报告，克制篇幅。`

/** 批判迭代：起草 → 批判 → 修订（N 轮）。 */
const ULTRA_DRAFT_SYSTEM = `你是执行层 Supervisor 的「方案起草者」。就用户任务产出一份**工作草案**（执行方案/核心判断结构/写作提纲），不是面向用户的最终答复。结构：
## 目标复述与约束 / ## 拆解出的子步骤（含先后依赖与可并行项）/ ## 各步骤应调用哪类能力或工具 / ## 草案自身风险与待验证点。
≤ 700 字，不寒暄。`
const ULTRA_CRITIQUE_SYSTEM = `你是「批判评审」。对给定的方案草案挑出真问题：
## 逻辑漏洞 / ## 未经验证的事实假设（逐条标注【待验证】并说明如何核验）/ ## 被忽略的维度/边界/反例 / ## 过度设计或不可行之处。
≤ 500 字，只列真问题，不要凑数。`
const ULTRA_REVISE_SYSTEM = `你是「方案修订者」。依据批判意见修订草案：逐条回应接受/反驳（一句话理由），给出修订后完整草案（结构与首版一致，≤ 700 字），结尾单列「仍需验证」清单（只保留真正需要 Supervisor 调用工具核实的点）。`

/** 混合增强：先拆全局方案 + 识别是否需要合议的关键决策点。 */
const ULTRA_HYBRID_META_SCHEMA = z.object({
  plan: z.string().describe('任务全局执行方案：子任务拆解、先后顺序/依赖、每步应产出，≤ 300 字'),
  hasCritical: z.boolean().describe('任务中是否存在必须多视角权衡/评审才能定夺的关键决策点'),
  criticalQuestion: z.string().describe('关键决策点的子问题表述（一句可被单独立论的话）；不存在则为空字符串')
})
const ULTRA_HYBRID_META_SYSTEM = `你是「混合增强」的全局规划器。对任务做两件事（不执行、不调用工具）：
1. 输出全局执行方案：拆子任务、标注先后依赖、每步应产出什么；
2. 判断任务中是否存在「必须多视角权衡的关键决策点」（如方法选型、方案权衡、结果解释分歧、审稿意见处置）。
只输出 JSON：plan、hasCritical、criticalQuestion（hasCritical 为 false 时留空）。`

/** ── Skill 分层路由（每轮 Meta-Cognition + 规则粗召回 + 可选 LLM 精排）──────── */
const ROUTE_META_SCHEMA = z.object({
  intents: z
    .array(z.string())
    .describe('任务意图标签（小写英文、下划线分隔），如 literature_review / scheme_evaluation / data_analysis / paper_writing / meeting / figure_plan / idea_evaluation / novelty_check / experiment_plan 等'),
  categories: z
    .array(z.enum(['research_design', 'literature', 'paper', 'analysis', 'figures', 'meeting']))
    .describe('命中的 L3 技能目录（0~3 个，越聚焦越好）'),
  complexity: z.enum(['low', 'medium', 'high']).describe('任务复杂度')
})
const ROUTE_RANK_SCHEMA = z.object({
  ranking: z
    .array(z.object({ trigger: z.string(), score: z.number().min(0).max(10), reason: z.string() }))
    .describe('按适合度从高到低排序的技能 trigger 列表')
})

const ROUTE_META_SYSTEM = `你是 Mimir 的「技能路由元认知」。根据用户请求输出结构化路由信号，供技能召回精排使用（不执行任务、不调用工具）：
- intents：把任务归到 1~4 个意图标签（小写英文，例如 literature_review、scheme_evaluation、data_analysis、paper_writing、idea_evaluation、novelty_check、experiment_plan、citation_audit、result_to_claim、rebuttal、figure_plan、meeting_prep、writing_polish）。
- categories：命中的技能目录（research_design 开题方案 / literature 文献 / paper 论文写作与评审 / analysis 结果分析 / figures 配图 / meeting 组会），最多 3 个。
- complexity：任务复杂度（low 单步/润色/查询；medium 需要多步或检索；high 长流程/多阶段/耗算力）。`

const ROUTE_RANK_SYSTEM = `你是技能精排器。给定候选技能与用户请求，从这些候选里选出最适合的并打分排序（0-10）：
重点考虑：与请求目标匹配度；适用边界（不适用场景命中则大幅减分）；成本收益（简单任务对高成本技能减分）；该会话上下文是否具备执行条件。
只允许选择出现在候选中的 trigger，不要杜撰。`

/** 会话历史摘要压缩系统提示（治理 Phase 1：只压 chat_history，不涉及文档库）。 */
const COMPRESS_HISTORY_SYSTEM = `你是对话历史的「结构化摘要器」。把下面一段较早的科研对话压缩成 ≤ 500 字的要点，供后续对话继续使用。必须保留：
- 用户的核心诉求与最终目标；
- 已经确认的结论 / 决策 / 关键实验参数与数值；
- 仍待办 / 仍在讨论的开放问题；
- 用户提到的硬约束（偏好、截止、不许改动等）。
丢弃寒暄与过程细节。只输出摘要正文，不要复述原文、不要加标题之外的寒暄。`

/** 单个 langchain 工具的调用面（只取包装所需的字段）。 */
interface ToolLike {
  name: string
  description?: string
  schema?: unknown
  invoke(input: unknown): Promise<unknown>
}

/** 截断一段输入/输出用于过程日志。 */
function truncateSummary(value: unknown, max = 160): string {
  let text = ''
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 把 langchain/网关的长错误压成一行可读中文（去掉 Troubleshooting URL、嵌套 JSON 等噪音）。 */
function humanizeAgentError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (raw.length > 240) return `${raw.slice(0, 240)}…`
  return raw
}

/** 包装工具：调用前 / 返回 / 出错三处打点（每个 worker/用途实例化一份，避免并发互串）；返回/出错附带耗时（ms）。 */
function withToolTrace(
  base: ToolLike,
  hooks: {
    onCall: (name: string, args: unknown) => void
    onDone: (name: string, out: unknown, durationMs: number) => void
    onError: (name: string, error: unknown, durationMs: number) => void
  }
): ToolLike {
  const proxied = Object.create(base) as ToolLike
  proxied.invoke = async (input: unknown) => {
    hooks.onCall(base.name, input)
    const t0 = Date.now()
    try {
      const out = await base.invoke.call(proxied, input)
      hooks.onDone(base.name, out, Date.now() - t0)
      return out
    } catch (error) {
      hooks.onError(base.name, error, Date.now() - t0)
      throw error
    }
  }
  return proxied
}

export interface AgentConfig {
  apiKey: string
  model: string
  baseUrl?: string
}

/** AgentService 实际用到的 Supervisor Agent 调用面（弱化 deepagents 的强泛型差异）。 */
interface SupervisorAgent {
  invoke(input: { messages: Array<{ role: string; content: string }> }): Promise<{ messages: unknown[] }>
  streamEvents(
    state: { messages: Array<{ role: string; content: string }> },
    config: { version: 'v3' }
  ): Promise<{ messages: AsyncIterable<{ text: AsyncIterable<string> }> }>
}

export class AgentService {
  private agent: SupervisorAgent | null = null
  private config: AgentConfig | null = null
  /** 多专家合议：元认知判定 / 聚合 / 反思用的模型（低温、输出稳定）。 */
  private scJudgeModel: ChatOpenAI | null = null
  /** 多专家合议：并行候选生成模型（高温、增强多样性）。 */
  private scCandidateModel: ChatOpenAI | null = null
  /** 当前流式对话的中止控制器（停止生成用）。 */
  private activeStreamAbort: AbortController | null = null
  /** Supervisor 流式调用期间的工具 trace 外发器：随每次调用临时注入，结束后清空。 */
  private workerTraceEmit: ((event: AgentWorkerEvent) => void) | null = null
  /** 会话级技能路由计数：convId -> trigger -> 已被纳入候选次数（对应 max_session_times）。 */
  private sessionSkillCounts = new Map<string, Map<string, number>>()

  constructor() {}

  /** 按「子代理注册表」（内置 + 自定义）生成「工具打点 + 委派声明」所需的 subagent 配置。 */
  private buildWorkerSubagents(): {
    name: string
    description: string
    systemPrompt: string
    tools: unknown[]
  }[] {
    const { agents, rejected } = loadSubAgentDefs()
    if (rejected.length > 0) {
      console.warn('[subagent-registry] 以下自定义子代理注册被拒绝：', rejected)
    }
    return agents.map((def) => ({
      name: def.id,
      description: def.description,
      systemPrompt: def.systemPrompt,
      tools: def.tools.map((base) =>
        withToolTrace(base as ToolLike, {
          onCall: (name, args): void => {
            this.workerTraceEmit?.({
              taskId: def.id,
              title: def.label,
              status: 'running',
              kind: 'tool',
              text: `调用 ${name}${args ? `：${truncateSummary(args, 120)}` : ''}`
            })
          },
          onDone: (name, out, durationMs): void => {
            this.workerTraceEmit?.({
              taskId: def.id,
              title: def.label,
              status: 'done',
              kind: 'tool',
              text: `${name} 返回：${truncateSummary(out, 4000)}`,
              durationMs
            })
          },
          onError: (name, error, durationMs): void => {
            this.workerTraceEmit?.({
              taskId: def.id,
              title: def.label,
              status: 'error',
              kind: 'tool',
              text: `${name} 出错：${humanizeAgentError(error)}`,
              durationMs
            })
          }
        })
      )
    }))
  }

  /**
   * Initialize the DeepAgents supervisor agent with the given config
   */
  async initialize(config: AgentConfig): Promise<void> {
    this.config = config

    // 模型层全链路 trace（settings.agentTraceLevel: off/compact/full，缺省 compact）：
    // handler 挂到 ChatOpenAI 构造 callbacks，LangChain 会把它作为每次模型运行的默认回调，
    // 从而覆盖 supervisor / 子代理 / SC / Ultra / 压缩等全部模型调用，无需在库内埋桩。
    let traceLevel: AgentTraceLevel = 'compact'
    try {
      const envRaw = process.env.MIMIR_AGENT_TRACE
      if (envRaw === 'off' || envRaw === 'compact' || envRaw === 'full') {
        traceLevel = envRaw
      } else {
        const settings = (getStoreValue<Record<string, unknown>>('settings') ?? {}) as Record<string, unknown>
        const raw = settings.agentTraceLevel
        if (raw === 'off' || raw === 'compact' || raw === 'full') traceLevel = raw
      }
    } catch {
      // 读取失败保持缺省 compact
    }
    const traceHandler = createAgentTraceHandler(traceLevel)
    if (traceHandler !== null) {
      console.log(`[agent] 模型层 trace 已开启（level=${traceLevel}，JSONL 落盘 ~/.mimir/logs/agent-trace-*.jsonl；设置 settings.agentTraceLevel=off 可关闭）`)
    }

    const buildModel = (temperature: number): ChatOpenAI =>
      new ChatOpenAI({
        apiKey: config.apiKey,
        model: config.model,
        temperature,
        ...(traceHandler !== null ? { callbacks: [traceHandler] } : {}),
        ...(config.baseUrl ? { configuration: { baseURL: config.baseUrl } } : {})
      })
    const model = buildModel(0.7)
    // 多专家合议（可选增强，默认关闭）：低温用于判定/聚合/反思，高温用于并行候选生成
    this.scJudgeModel = buildModel(0.3)
    this.scCandidateModel = buildModel(0.9)

    // Supervisor 编排：业务工具全部由各模块子 Agent 持有，主管通过 deepagents 内置委派机制
    // 把子任务派给对应模块；主管直属只保留极少的只读工具（长期记忆 load_memory）。
    const memoryToolTraced = withToolTrace(loadMemoryTool as unknown as ToolLike, {
      onCall: (name, args): void => {
        // 记忆链路诊断（M5 后新增）：主进程日志确认 supervisor 是否真正发起了 load_memory
        console.log(`[agent][memory-tool] 调用 ${name}${args ? ` args=${truncateSummary(args, 200)}` : ''}`)
        this.workerTraceEmit?.({
          taskId: 'main',
          title: '主管 Agent',
          status: 'running',
          kind: 'tool',
          text: `调用 ${name}${args ? `：${truncateSummary(args, 120)}` : ''}`
        })
      },
      onDone: (name, out, durationMs): void => {
        console.log(`[agent][memory-tool] ${name} 返回 ${durationMs}ms:${truncateSummary(out, 4000)}`)
        this.workerTraceEmit?.({
          taskId: 'main',
          title: '主管 Agent',
          status: 'done',
          kind: 'tool',
          text: `${name} 返回：${truncateSummary(out, 4000)}`,
          durationMs
        })
      },
      onError: (name, error, durationMs): void => {
        console.log(`[agent][memory-tool] ${name} 出错 ${durationMs}ms:${humanizeAgentError(error)}`)
        this.workerTraceEmit?.({
          taskId: 'main',
          title: '主管 Agent',
          status: 'error',
          kind: 'tool',
          text: `${name} 出错：${humanizeAgentError(error)}`,
          durationMs
        })
      }
    })
    this.agent = createDeepAgent({
      model,
      // 不再静态注入全量技能目录：由每轮 Skill 路由注入 top-K 候选（SLASH_CATALOG_TEXT
      // 仅在路由不可用时作为兜底目录注入），解决全量目录的 token 与召回噪声问题。
      systemPrompt: SUPERVISOR_SYSTEM,
      tools: [memoryToolTraced] as never,
      subagents: this.buildWorkerSubagents() as never,
      // 内置文件工具（read_file/write_file/edit_file/ls/glob/grep/delete）默认走内存 StateBackend，
      // 不会落到真实磁盘。注入 MimirFsBackend：真实磁盘读写 + 写/空间外读的批准卡。
      backend: new MimirFsBackend() as never
    }) as unknown as SupervisorAgent

    // 记忆链路诊断（M5 后新增）：打印 supervisor 直属工具注册清单。复现「让模型读取长期记忆」时，
    // 若主进程日志始终不出现 [agent][memory-tool] 调用记录，说明模型从未发出 load_memory 的
    // tool call（工具未绑定 / 该模型不支持 function calling / 判定不相关），按对应路径排查。
    console.log(
      `[agent] supervisor 直属工具注册:[${([memoryToolTraced] as ToolLike[]).map((t) => t.name).join(', ') || '(无)'}]`
    )
  }

  /**
   * Check if the agent is initialized
   */
  isInitialized(): boolean {
    return this.agent !== null
  }

  /** 单次模型调用并抽取纯文本（SC 各子阶段通用）。 */
  private async invokeModelText(
    model: ChatOpenAI,
    messages: Array<{ role: string; content: string }>
  ): Promise<string> {
    const out = await model.invoke(messages)
    return this.textContentOf(out.content)
  }

  /**
   * Self-Consistency 多专家合议（代码级静态子图）：
   * ① Meta-Cognition 元认知判定（是否合议 + 选 K 路专家）→
   * ② 并行 K 路独立候选生成（无工具、互不可见）→
   * ③ Aggregator 共识/分歧聚合 → ④ Reflection 反思校验。
   * 返回合议纪要（brief），由 Supervisor 核验【待验证】分歧后再作答；无需合议或全部失败返回 brief=null。
   * @param opts.focus 只对某个子问题做合议（hybrid 的关键点局部触发）
   * @param opts.force 强制启用合议（用户指定 multi_expert / hybrid 局部场景），Meta 只负责选专家
   * @param opts.maxRoles 上限 K 路（轻量化）
   */
  private async runScStage(
    message: string,
    signal: AbortSignal,
    emit: (event: AgentWorkerEvent) => void,
    opts?: { force?: boolean; focus?: string; maxRoles?: number }
  ): Promise<{ brief: string | null }> {
    const judge = this.scJudgeModel
    const candidate = this.scCandidateModel
    if (judge === null || candidate === null) return { brief: null }
    const aborted = (): boolean => signal.aborted
    const findLabel = (id: ScExpertId): string => SC_EXPERT_POOL.find((e) => e.id === id)?.label ?? id
    // 合议对象：默认整条请求；hybrid 局部合议时聚焦到关键子问题
    const taskText = opts?.focus !== undefined && opts.focus.trim() !== '' ? opts.focus : message
    const focusTag = taskText !== message ? `（聚焦关键子问题：${truncateSummary(taskText, 60)}）` : ''

    // ① Meta-Cognition：判定是否合议 + 选择启用哪些专家（K = roles 长度）
    emit({ taskId: 'sc:meta', title: `元认知决策${focusTag}`, status: 'running' })
    let roles: ScExpertId[] = []
    let reason = ''
    try {
      const forceDirective =
        opts?.force === true
          ? '\n注意：本次由 Ultra 策略强制启用合议，enable 必须为 true，直接选择最合适的专家并说明理由。'
          : ''
      const parsed = await judge
        .withStructuredOutput(SC_META_SCHEMA, { name: 'sc_meta_decision', method: 'functionCalling' })
        .invoke([
          { role: 'system', content: SC_META_SYSTEM },
          { role: 'user', content: `用户请求：\n${taskText}${forceDirective}` }
        ])
      reason = parsed.reason ?? ''
      roles = [...new Set(parsed.roles)].slice(0, opts?.maxRoles ?? 5)
      if (roles.length === 0 && opts?.force === true) {
        roles = ['reviewer', 'empiricist', 'engineer']
      }
      if (aborted()) return { brief: null }
      if (!parsed.enable && opts?.force !== true) {
        emit({
          taskId: 'sc:meta',
          title: `元认知决策${focusTag}`,
          status: 'done',
          text: reason.trim() !== '' ? reason : '判定无需多专家合议，直接执行。'
        })
        return { brief: null }
      }
      emit({
        taskId: 'sc:meta',
        title: `元认知决策${focusTag}`,
        status: 'done',
        text: `启用多专家合议（${roles.length} 路）：${roles.map(findLabel).join('、')}。${reason}`
      })
    } catch (error) {
      emit({
        taskId: 'sc:meta',
        title: `元认知决策${focusTag}`,
        status: 'error',
        text: `判定失败：${humanizeAgentError(error)}，本次跳过合议直接执行。`
      })
      return { brief: null }
    }
    const experts = SC_EXPERT_POOL.filter((e) => roles.includes(e.id))
    if (experts.length === 0) return { brief: null }

    // ② 并行 K 路独立候选生成（无工具、各专家互不可见）
    const candidates: { label: string; text: string }[] = []
    await Promise.all(
      experts.map(async (ex) => {
        const taskId = `sc:c:${ex.id}`
        emit({ taskId, title: ex.label, status: 'running' })
        try {
          const text = (
            await this.invokeModelText(candidate, [
              {
                role: 'system',
                content:
                  `${ex.prompt}\n\n请用 Markdown 输出你的独立意见，控制在 400 字内，` +
                  `结构：## 结论 / ## 依据 / ## 我关注的风险与待验证点。你与其它评审相互不可见，独立作答。`
              },
              { role: 'user', content: `用户请求：\n${taskText}` }
            ])
          ).trim()
          if (text === '') throw new Error('专家返回为空')
          candidates.push({ label: ex.label, text })
          emit({ taskId, title: ex.label, status: 'done', text })
        } catch (error) {
          emit({
            taskId,
            title: ex.label,
            status: 'error',
            text: `（专家未能产出意见：${humanizeAgentError(error)}）`
          })
        }
      })
    )
    if (aborted()) return { brief: null }
    if (candidates.length === 0) {
      emit({
        taskId: 'sc:aggregate',
        title: '共识与分歧聚合',
        status: 'error',
        text: '所有专家均未能产出意见，本次跳过合议。'
      })
      return { brief: null }
    }

    // ③ Aggregator：共识 / 分歧 / 方案倾向
    const body = candidates.map((c) => `## ${c.label}\n\n${c.text}`).join('\n\n')
    emit({ taskId: 'sc:aggregate', title: '共识与分歧聚合', status: 'running' })
    let aggregated = ''
    try {
      aggregated = (
        await this.invokeModelText(judge, [
          { role: 'system', content: SC_AGG_SYSTEM },
          { role: 'user', content: `# 合议对象\n\n${taskText}\n\n# 各专家候选意见\n\n${body}` }
        ])
      ).trim()
      if (aborted()) return { brief: null }
      emit({ taskId: 'sc:aggregate', title: '共识与分歧聚合', status: 'done', text: aggregated })
    } catch (error) {
      emit({
        taskId: 'sc:aggregate',
        title: '共识与分歧聚合',
        status: 'error',
        text: `聚合失败：${humanizeAgentError(error)}，本次跳过合议。`
      })
      return { brief: null }
    }

    // ④ Reflection：反思校验 → 输出供 Supervisor 核验的待验证工作纪要
    emit({ taskId: 'sc:reflect', title: '反思校验', status: 'running' })
    let reflectText = ''
    try {
      reflectText = (
        await this.invokeModelText(judge, [
          { role: 'system', content: SC_REFLECT_SYSTEM },
          { role: 'user', content: `# 用户请求\n\n${taskText}\n\n# 聚合纪要\n\n${aggregated}` }
        ])
      ).trim()
      if (aborted()) return { brief: null }
      emit({ taskId: 'sc:reflect', title: '反思校验', status: 'done', text: reflectText })
    } catch (error) {
      emit({
        taskId: 'sc:reflect',
        title: '反思校验',
        status: 'error',
        text: `反思失败：${humanizeAgentError(error)}，改以聚合纪要作为合议输出。`
      })
      reflectText = aggregated
    }
    if (reflectText.trim() === '') reflectText = aggregated
    return { brief: reflectText }
  }

  /** Ultra 各策略子图通用的「增强产出」外包装（头部 + 面向 Supervisor 的执行注意）。 */
  private composeUltraContext(kind: UltraStrategy, body: string): string {
    const meta = ULTRA_STRATEGY_META[kind]
    let note = ''
    switch (kind) {
      case 'multi_expert':
        note =
          '请核验其中标注【待验证】的分歧与事实点（必要时调用模块子 Agent 工具核实），再面向用户给出完整中文回复；不要逐字复述纪要，也不要把内部合议过程写进最终回答。'
        break
      case 'self_consistency_vote':
        note =
          '以「推荐答案」为基准完善最终回复；其中【待验证】的点先调用模块子 Agent 工具核实后再输出。'
        break
      case 'critique_reflect':
        note =
          '采用经批判迭代修订后的方案执行：先规划后执行，能核实「仍需验证」清单事项的调用模块子 Agent 工具核实，最后面向用户输出完整中文回复。'
        break
      case 'hybrid_mix':
        note =
          '按全局方案分步执行，遵守子步骤先后依赖；「关键点合议 / 批判反思」结论作为内部参考，标注【待验证】的事项用模块子 Agent 工具核实后输出最终回复。'
        break
      case 'plain':
        note =
          '请遵守以上长程执行约束，面向用户输出完整中文回复；不要把约束原文逐字复述给用户。'
        break
    }
    return `# Ultra 增强产出（${meta.label} · 内部参考）\n\n${body}\n\n${note}`
  }

  /** 依据任务画像（skill 路由 Meta 输出）自动选择增强策略；画像缺失时用轻量关键词兜底。 */
  private pickUltraStrategy(
    message: string,
    routerMeta?: { intents: string[]; categories: string[]; complexity: 'low' | 'medium' | 'high' } | null
  ): { strategy: UltraStrategy; reason: string } {
    const q = message.toLowerCase()
    const kwHit = (list: string[]): boolean => list.some((k) => q.includes(k))
    const decisionish = kwHit([
      '权衡', '选型', '取舍', '评估', '评审', '对比', '判断', '方案选择', '矛盾', '风险',
      '审稿意见', '回复审稿', '值不值得', '哪个更好', '分歧'
    ])
    const writingish = kwHit(['写作', '润色', '改写', '报告', '提纲', '起草', '初稿', '论文', '综述', '组织', '规划'])
    if (routerMeta === undefined || routerMeta === null) {
      if (decisionish) return { strategy: 'multi_expert', reason: '命中多视角权衡关键词，自动选择多专家合议' }
      if (writingish) return { strategy: 'critique_reflect', reason: '命中撰写/报告类关键词，自动选择批判迭代' }
      return { strategy: 'plain', reason: '缺少路由画像，默认普通增强（稳妥且低成本）' }
    }
    const intents = routerMeta.intents ?? []
    const cats = routerMeta.categories ?? []
    const cx = routerMeta.complexity
    const hasIntent = (...ids: string[]): boolean => ids.some((i) => intents.includes(i))
    const hasCat = (...ids: string[]): boolean => ids.some((c) => cats.includes(c))
    if (cx === 'low') return { strategy: 'plain', reason: '低复杂度任务不需要高开销增强' }
    if (cx === 'high') {
      if (hasIntent('scheme_evaluation', 'idea_evaluation', 'novelty_check', 'rebuttal', 'result_to_claim') || hasCat('analysis'))
        return { strategy: 'multi_expert', reason: '高复杂度且含方案评估/结论研判，选择多专家合议' }
      if (hasIntent('paper_writing', 'writing_polish', 'citation_audit', 'research_plan', 'literature_review') || hasCat('paper', 'literature'))
        return { strategy: 'critique_reflect', reason: '高复杂度长交付类任务，选择批判迭代做自我修正' }
      return { strategy: 'hybrid_mix', reason: '高复杂度综合任务，默认混合增强（关键点合议 + 全局批判反思）' }
    }
    if (decisionish || hasIntent('scheme_evaluation', 'idea_evaluation', 'novelty_check', 'rebuttal'))
      return { strategy: 'self_consistency_vote', reason: '中等权衡/判断型任务，选择轻量一致性投票' }
    if (writingish || hasIntent('paper_writing', 'writing_polish', 'research_plan') || hasCat('paper'))
      return { strategy: 'critique_reflect', reason: '中等撰写/计划类任务，选择批判迭代' }
    return { strategy: 'plain', reason: '中等常规任务，普通增强即可' }
  }

  /** 一致性投票（轻量 SC）：Meta 选 2~3 位专家 → 并行候选 → 投票裁决推荐答案。 */
  private async runScVoteStage(
    message: string,
    signal: AbortSignal,
    emit: (event: AgentWorkerEvent) => void
  ): Promise<{ brief: string | null }> {
    const judge = this.scJudgeModel
    const candidate = this.scCandidateModel
    if (judge === null || candidate === null) return { brief: null }
    const aborted = (): boolean => signal.aborted
    const findLabel = (id: ScExpertId): string => SC_EXPERT_POOL.find((e) => e.id === id)?.label ?? id
    emit({ taskId: 'vote:meta', title: '投票专家选择', status: 'running' })
    let roles: ScExpertId[] = []
    try {
      const parsed = await judge
        .withStructuredOutput(VOTE_META_SCHEMA, { name: 'svc_meta_decision', method: 'functionCalling' })
        .invoke([
          { role: 'system', content: VOTE_META_SYSTEM },
          { role: 'user', content: `用户请求：\n${message}` }
        ])
      roles = [...new Set(parsed.roles)].slice(0, 3)
      if (roles.length < 2) roles = ['reviewer', 'empiricist']
      if (aborted()) return { brief: null }
      emit({
        taskId: 'vote:meta',
        title: '投票专家选择',
        status: 'done',
        text: `参与投票：${roles.map(findLabel).join('、')}。${parsed.reason ?? ''}`
      })
    } catch (error) {
      emit({
        taskId: 'vote:meta',
        title: '投票专家选择',
        status: 'error',
        text: `专家选择失败：${humanizeAgentError(error)}，本次跳过一致性投票。`
      })
      return { brief: null }
    }
    const experts = SC_EXPERT_POOL.filter((e) => roles.includes(e.id))
    const candidates: { label: string; text: string }[] = []
    await Promise.all(
      experts.map(async (ex) => {
        const taskId = `svc:c:${ex.id}`
        emit({ taskId, title: `${ex.label}（投票）`, status: 'running' })
        try {
          const text = (
            await this.invokeModelText(candidate, [
              {
                role: 'system',
                content: `${ex.prompt}\n\n请用 Markdown 输出你的独立意见，控制在 260 字内，结构：## 结论 / ## 依据。你与其它投票者相互不可见。`
              },
              { role: 'user', content: `用户请求：\n${message}` }
            ])
          ).trim()
          if (text === '') throw new Error('投票者返回为空')
          candidates.push({ label: ex.label, text })
          emit({ taskId, title: `${ex.label}（投票）`, status: 'done', text })
        } catch (error) {
          emit({ taskId, title: `${ex.label}（投票）`, status: 'error', text: `（未能产出意见：${humanizeAgentError(error)}）` })
        }
      })
    )
    if (aborted()) return { brief: null }
    if (candidates.length === 0) {
      emit({ taskId: 'svc:vote', title: '一致性投票', status: 'error', text: '所有投票者均失败，跳过一致性投票。' })
      return { brief: null }
    }
    const body = candidates.map((c) => `## ${c.label}\n\n${c.text}`).join('\n\n')
    emit({ taskId: 'svc:vote', title: '一致性投票', status: 'running' })
    try {
      const voted = (
        await this.invokeModelText(judge, [
          { role: 'system', content: VOTE_AGG_SYSTEM },
          { role: 'user', content: `# 投票问题\n\n${message}\n\n# 各候选意见\n\n${body}` }
        ])
      ).trim()
      if (aborted()) return { brief: null }
      emit({ taskId: 'svc:vote', title: '一致性投票', status: 'done', text: voted })
      if (voted === '') return { brief: null }
      return { brief: `# 推荐答案（一致性投票）\n\n${voted}` }
    } catch (error) {
      emit({ taskId: 'svc:vote', title: '一致性投票', status: 'error', text: `投票失败：${humanizeAgentError(error)}` })
      return { brief: null }
    }
  }

  /** 批判迭代（critique_reflect）：方案草稿 →（批判 → 修订）× rounds 轮，输出修订后方案。 */
  private async runCritiqueStage(
    message: string,
    signal: AbortSignal,
    emit: (event: AgentWorkerEvent) => void,
    opts?: { rounds?: number; seedDraft?: string }
  ): Promise<{ brief: string | null }> {
    const judge = this.scJudgeModel
    if (judge === null) return { brief: null }
    const aborted = (): boolean => signal.aborted
    const rounds = Math.max(1, Math.min(3, opts?.rounds ?? 2))
    emit({ taskId: 'crit:plan', title: '方案起草', status: 'running' })
    let draft = opts?.seedDraft?.trim() ?? ''
    try {
      if (draft === '') {
        draft = (
          await this.invokeModelText(judge, [
            { role: 'system', content: ULTRA_DRAFT_SYSTEM },
            { role: 'user', content: `用户任务：\n${message}` }
          ])
        ).trim()
      }
      if (aborted()) return { brief: null }
      emit({ taskId: 'crit:plan', title: '方案起草', status: 'done', text: draft })
      if (draft === '') throw new Error('草案为空')
    } catch (error) {
      emit({ taskId: 'crit:plan', title: '方案起草', status: 'error', text: `起草失败：${humanizeAgentError(error)}` })
      return { brief: null }
    }
    let lastCritique = ''
    for (let round = 1; round <= rounds; round++) {
      if (aborted()) return { brief: null }
      const critTask = `crit:c:${round}`
      emit({ taskId: critTask, title: `批判评审（${round}/${rounds}）`, status: 'running' })
      try {
        lastCritique = (
          await this.invokeModelText(judge, [
            { role: 'system', content: ULTRA_CRITIQUE_SYSTEM },
            { role: 'user', content: `用户任务：\n${message}\n\n# 方案草案\n\n${draft}` }
          ])
        ).trim()
        emit({ taskId: critTask, title: `批判评审（${round}/${rounds}）`, status: 'done', text: lastCritique })
      } catch (error) {
        emit({ taskId: critTask, title: `批判评审（${round}/${rounds}）`, status: 'error', text: `批判失败：${humanizeAgentError(error)}` })
        lastCritique = ''
      }
      if (aborted()) return { brief: null }
      const revTask = `crit:r:${round}`
      emit({ taskId: revTask, title: `方案修订（${round}/${rounds}）`, status: 'running' })
      try {
        draft = (
          await this.invokeModelText(judge, [
            { role: 'system', content: ULTRA_REVISE_SYSTEM },
            {
              role: 'user',
              content: `用户任务：\n${message}\n\n# 方案草案\n\n${draft}\n\n# 批判意见\n\n${lastCritique !== '' ? lastCritique : '（本轮未产生批判，请自查补漏后给出修订稿）'}`
            }
          ])
        ).trim()
        emit({ taskId: revTask, title: `方案修订（${round}/${rounds}）`, status: 'done', text: draft })
      } catch (error) {
        emit({ taskId: revTask, title: `方案修订（${round}/${rounds}）`, status: 'error', text: `修订失败：${humanizeAgentError(error)}，保留当前草案。` })
      }
    }
    if (aborted()) return { brief: null }
    if (draft.trim() === '') return { brief: null }
    return { brief: draft }
  }

  /** 混合增强（hybrid_mix）：全局方案 + 关键判断点局部多专家合议；无关键点时整体批判反思一轮。 */
  private async runHybridStage(
    message: string,
    signal: AbortSignal,
    emit: (event: AgentWorkerEvent) => void
  ): Promise<{ brief: string | null }> {
    const judge = this.scJudgeModel
    if (judge === null) return { brief: null }
    const aborted = (): boolean => signal.aborted
    emit({ taskId: 'hyb:meta', title: '全局方案与关键点识别', status: 'running' })
    let plan = ''
    let hasCritical = false
    let criticalQuestion = ''
    try {
      const meta = await judge
        .withStructuredOutput(ULTRA_HYBRID_META_SCHEMA, { name: 'ultra_hybrid_meta', method: 'functionCalling' })
        .invoke([
          { role: 'system', content: ULTRA_HYBRID_META_SYSTEM },
          { role: 'user', content: `用户任务：\n${message}` }
        ])
      plan = (meta.plan ?? '').trim()
      hasCritical = meta.hasCritical === true
      criticalQuestion = (meta.criticalQuestion ?? '').trim()
      if (aborted()) return { brief: null }
      emit({
        taskId: 'hyb:meta',
        title: '全局方案与关键点识别',
        status: 'done',
        text: `全局方案：${truncateSummary(plan, 120)}；关键判断点：${hasCritical && criticalQuestion !== '' ? `有（${truncateSummary(criticalQuestion, 80)}）` : '无'}`
      })
      if (plan === '') throw new Error('方案为空')
    } catch (error) {
      emit({ taskId: 'hyb:meta', title: '全局方案与关键点识别', status: 'error', text: `规划失败：${humanizeAgentError(error)}` })
      return { brief: null }
    }
    // 关键判断点 → 仅对该子问题做多专家合议（局部触发，K ≤ 3）；否则整体批判反思一轮
    if (hasCritical && criticalQuestion !== '') {
      const sc = await this.runScStage(criticalQuestion, signal, emit, { force: true, maxRoles: 3 })
      if (aborted()) return { brief: null }
      if (sc.brief === null) return { brief: `# 全局执行方案\n\n${plan}\n\n（关键点合议执行失败，按上述方案常规执行。）` }
      return { brief: `# 全局执行方案\n\n${plan}\n\n# 关键点多专家合议\n\n${sc.brief}` }
    }
    const crit = await this.runCritiqueStage(message, signal, emit, { rounds: 1, seedDraft: plan })
    if (aborted()) return { brief: null }
    if (crit.brief === null) return { brief: `# 全局执行方案\n\n${plan}\n\n（整体批判反思执行失败，按上述方案常规执行。）` }
    return { brief: `# 全局执行方案\n\n${plan}\n\n# 批判反思产出\n\n${crit.brief}` }
  }

  /** Ultra 增强控制器：选策略（自动/手动 + token 预算降级）→ 跑对应子图 → 产出约束段。 */
  private async runUltraController(args: {
    message: string
    signal: AbortSignal
    emit: (event: AgentWorkerEvent) => void
    historyChars: number
    manual?: UltraStrategy
    routerMeta?: { intents: string[]; categories: string[]; complexity: 'low' | 'medium' | 'high' } | null
  }): Promise<{ output: string }> {
    const { message, signal, emit, historyChars, manual, routerMeta } = args
    if (this.scJudgeModel === null) return { output: '' }
    const aborted = (): boolean => signal.aborted
    const ctxChars = historyChars + message.length

    emit({ taskId: 'ultra', title: 'Ultra 增强调度', status: 'running', text: '分析任务并选择增强策略…' })
    let strategy: UltraStrategy
    let reason: string
    let degraded = false
    if (manual !== undefined) {
      strategy = manual
      reason = '用户手动指定'
    } else {
      const picked = this.pickUltraStrategy(message, routerMeta)
      strategy = picked.strategy
      reason = picked.reason
      // 全局 token 预算治理：会话上下文已很长时，把高开销策略自动降级并如实记录选型
      const cost = ULTRA_STRATEGY_META[strategy].cost
      if (cost !== 'low' && ctxChars > 32_000) {
        strategy = 'plain'
        degraded = true
        reason = `会话上下文已约 ${ctxChars} 字，超出增强预算，自动降级为普通增强`
      } else if (cost === 'high' && ctxChars > 18_000) {
        strategy = 'self_consistency_vote'
        degraded = true
        reason = `会话上下文已约 ${ctxChars} 字，高开销策略自动降级为一致性投票`
      }
    }
    if (aborted()) return { output: '' }
    const label = ULTRA_STRATEGY_META[strategy].label
    emit({ taskId: 'ultra', title: 'Ultra 增强调度', status: 'done', text: `策略：${label}。${reason}${degraded ? '（已自动降级以控制 token 预算）' : ''}` })
    console.log(`[agent] Ultra 本次策略=${strategy}（${label}），原因：${reason}${degraded ? '，已降级' : ''}，上下文约 ${ctxChars} 字`)
    if (aborted()) return { output: '' }

    // 各策略：执行动作全部下沉 Supervisor —— 这里只产出一段「内部参考约束」拼进请求
    if (strategy === 'plain') {
      const body = [
        '## 长程执行约束',
        '- 先规划后执行：把任务拆成明确子步骤，标注哪些可并行、哪些存在先后依赖；存在依赖的步骤等前置产出后再继续；',
        '- 每个子步骤完成后做一次内部一致性核验（结论是否被前序产物支持、是否偏离用户原始请求）再进入下一步；',
        '- 涉及未经验证的事实/数字/文献时标注【待验证】，需要外部信息的调用模块子 Agent 工具核实，不要直接断言；',
        '- 最终交付前整体复查：对照用户原始请求逐项检查是否有遗漏。'
      ].join('\n')
      return { output: this.composeUltraContext('plain', body) }
    }
    let brief: string | null = null
    if (strategy === 'multi_expert') {
      const sc = await this.runScStage(message, signal, emit, { force: true })
      if (aborted()) return { output: '' }
      brief = sc.brief
    } else if (strategy === 'self_consistency_vote') {
      const v = await this.runScVoteStage(message, signal, emit)
      if (aborted()) return { output: '' }
      brief = v.brief
    } else if (strategy === 'critique_reflect') {
      const c = await this.runCritiqueStage(message, signal, emit, { rounds: 2 })
      if (aborted()) return { output: '' }
      brief = c.brief
    } else if (strategy === 'hybrid_mix') {
      const h = await this.runHybridStage(message, signal, emit)
      if (aborted()) return { output: '' }
      brief = h.brief
    }
    if (brief === null || brief.trim() === '') {
      // 增强子图整体失败：降级为普通长程约束，保证本次请求仍能推进
      console.log(`[agent] Ultra 策略「${label}」子图执行失败，降级为普通增强约束`)
      emit({ taskId: 'ultra:fallback', title: 'Ultra 子图降级', status: 'error', text: `「${label}」子图执行失败，已自动降级为普通增强。` })
      const body = '- 先规划后执行，拆分子步骤并标注依赖；\n- 分步内部核验后再继续；\n- 未经核实的事实标注【待验证】并用模块子 Agent 工具核实；\n- 交付前对照用户原始请求整体复查。'
      return { output: `# Ultra 增强产出（普通增强降级 · 内部参考）\n\n${body}` }
    }
    return { output: this.composeUltraContext(strategy, brief) }
  }

  /** 从任意 agent 返回结果中抽取末条消息的文本内容。 */
  private lastTextOf(result: { messages: unknown[] }): string {
    const last = result.messages[result.messages.length - 1] as { content?: unknown } | undefined
    return last ? this.textContentOf(last.content) : ''
  }

  /** 把模型返回的 content（字符串 / 文本块数组）归一化为纯文本。 */
  private textContentOf(content: unknown): string {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content
        .map((item) => {
          if (typeof item === 'string') return item
          if (item && typeof item === 'object' && 'text' in item) {
            return String((item as { text: unknown }).text ?? '')
          }
          return ''
        })
        .join('')
    }
    return ''
  }

  /**
   * Send a message to the agent and get a response
   */
  async sendMessage(message: string, conversationId: string): Promise<string> {
    const agent = this.agent
    if (!agent) {
      throw new Error('Agent 未初始化，请先在设置中配置 API Key')
    }

    const result = await agent.invoke({
      messages: [{ role: 'user', content: message }]
    })

    return this.lastTextOf(result)
  }

  /**
   * 永久层（全局身份常量，治理 Phase 4 / M5）：读取设置 settings.identity，
   * 若用户显式配置了身份信息则生成「每轮恒定在场」的文本块，否则返回 ''（默认零注入）。
   *
   * 与 load_memory 的分界：长期记忆默认不在场、判定相关才按需读取；身份常量一旦配置，
   * 就作为 system 消息恒定前置到每次 Supervisor 输入（不参与窗口/压缩/归档/时效管理），
   * 量极小（≤ 数十 token）。自动学习/对话写回永不落入永久层——仅由用户在设置页手动维护。
   */
  private buildIdentityBlock(): string {
    try {
      const settings = (getStoreValue<Record<string, unknown>>('settings') ?? {}) as Record<string, unknown>
      const id = (settings.identity ?? {}) as Record<string, unknown>
      const role = typeof id.role === 'string' ? id.role.trim() : ''
      // 仅语言与系统默认（中文交流）不同时才需要声明覆盖；写作语言需用户显式指定
      const interact =
        id.interactLanguage === 'en' ? 'English' : id.interactLanguage === 'zh' ? '' : ''
      const writing =
        id.writingLanguage === 'en' ? 'English' : id.writingLanguage === 'zh' ? '中文' : ''
      if (role === '' && interact === '' && writing === '') return ''
      const lines: string[] = [
        '【用户身份（永久层设定，每次对话恒定在场，非本轮任务指令；若与系统提示中的语言默认冲突，以此为准）】'
      ]
      if (role !== '') lines.push(`- 科研身份：${role}`)
      if (interact !== '') lines.push(`- 与用户交流语言：${interact}`)
      if (writing !== '') lines.push(`- 论文与正式写作语言：${writing}`)
      return lines.join('\n')
    } catch {
      return ''
    }
  }

  /**
   * Stream a message to the agent, calling onChunk for each chunk.
   * 可通过 {@link stopStreaming} 中止：abort 后返回已收到的部分内容。
   * @param onWorkerEvent 各模块子 Agent / 工具的执行过程事件（渲染层事件树用）
   * @param options.ultra 开启「Ultra 增强控制器」（可选的增强层）：enabled 总开关，strategy 为
   *   增强策略（'auto' 由 Ultra 自动选，或 plain / multi_expert / critique_reflect / hybrid_mix /
   *   self_consistency_vote）；options.history 最近对话历史（滑动窗口，仅 user/assistant 纯文本）。
   */
  async streamMessage(
    message: string,
    conversationId: string,
    onChunk: (chunk: string) => void,
    onWorkerEvent?: (event: AgentWorkerEvent) => void,
    options?: {
      ultra?: { enabled: boolean; strategy?: UltraStrategyPick }
      history?: { role: 'user' | 'assistant'; content: string }[]
      /** 手动 /trigger 直通：跳过技能路由（用户显式触发，正文已注入）。 */
      manual?: boolean
    }
  ): Promise<string> {
    const agent = this.agent
    if (!agent) {
      throw new Error('Agent 未初始化，请先在设置中配置 API Key')
    }

    const controller = new AbortController()
    this.activeStreamAbort = controller
    // 本次流式调用期间，模块 worker 的执行事件经 onWorkerEvent 外发（渲染层按需入树）
    this.workerTraceEmit = (event) => onWorkerEvent?.(event)
    /** 本次回复的轨迹外发器；主流程各阶段用它补齐 supervisor 自身的节点。 */
    const emit = (event: AgentWorkerEvent): void => onWorkerEvent?.(event)
    let fullContent = ''
    const isManual = options?.manual === true || message.trim().startsWith('/')
    // 进入 Supervisor 主流程前的上下文片段（当前消息 → 技能路由候选 → Ultra 增强产出）
    const contextParts: string[] = [message]
    // Skill 路由 Meta 画像：Ultra 自动选策略时复用（同一判定，避免重复计费）
    let routeMeta: { intents: string[]; categories: string[]; complexity: 'low' | 'medium' | 'high' } | null = null

    try {
      const ultraCfg = options?.ultra
      const ultraOn = ultraCfg?.enabled === true
      console.log(
        `[agent] 回复开始（v3 逐字流）会话=${conversationId}${ultraOn ? `（Ultra 增强：策略 ${ultraCfg?.strategy ?? 'auto'}）` : ''}` +
          `${options?.history !== undefined && options.history.length > 0 ? `（携带 ${options.history.length} 条历史）` : ''}` +
          `${isManual ? '（手动技能直通）' : ''}`
      )

      // Skill 分层路由（每轮自动；手动 / 触发绕过）：粗召回 + 精排 → 仅注入 top-K 候选。
      if (!isManual && this.readSettingsFlag('skillRouting', true)) {
        emit({ taskId: 'phase:routing', title: '技能路由', status: 'running' })
        const routed = await this.runSkillRouting(message, conversationId, controller.signal, emit)
        if (controller.signal.aborted) {
          console.log('[agent] 技能路由阶段被用户中止')
          emit({ taskId: 'phase:routing', title: '技能路由', status: 'error', text: '已被用户中止。' })
          return ''
        }
        emit({
          taskId: 'phase:routing',
          title: '技能路由',
          status: 'done',
          text:
            routed === null
              ? '路由不可用，回退静态技能目录。'
              : `已召回 ${routed.meta?.categories.length ?? 0} 类技能候选。`
        })
        if (routed === null) {
          // 路由不可用（无判定模型/判定失败）→ 回退静态目录，保留原有的自然语言命中能力
          contextParts.push(SLASH_CATALOG_TEXT)
        } else {
          routeMeta = routed.meta
          if (routed.context !== '') contextParts.push(routed.context)
        }
      }

      // Ultra 增强控制器（可选增强层，默认关闭；Supervisor 之上的策略调度）：
      // 选策略（自动/手动 + token 预算降级）→ 跑对应子图 → 产出「约束段」拼入本轮请求，
      // 执行动作全部下沉 Supervisor（含模块子 Agent 工具核验）。
      if (ultraOn) {
        const historyChars = (options?.history ?? []).reduce((n, m) => n + m.content.length, 0)
        const manualStrategy =
          ultraCfg?.strategy !== undefined && ultraCfg.strategy !== 'auto' ? ultraCfg.strategy : undefined
        const uc = await this.runUltraController({
          message,
          signal: controller.signal,
          emit,
          historyChars,
          manual: manualStrategy,
          routerMeta: routeMeta
        })
        if (controller.signal.aborted) {
          console.log('[agent] Ultra 增强阶段被用户中止')
          return ''
        }
        if (uc.output !== '') contextParts.push(uc.output)
      }
      const finalMessage = contextParts.join('\n\n')

      // 上下文治理（M2）：历史滑动窗口经 options.history 以「引用」方式前置注入，
      // Ultra 增强子图不读历史（隔离）；历史只含 user/assistant 纯文本，不含工具产物/附件全文。
      // 永久层身份常量（M5）：用户配置过则作为前置 system 消息恒定在场——由主进程服务端
      // 合成，不进渲染层持久历史，不参与滑动窗口/压缩/归档；默认未配置时零注入。
      const identityBlock = this.buildIdentityBlock()
      const inputMessages: Array<{ role: string; content: string }> = [
        ...(identityBlock !== '' ? [{ role: 'system' as const, content: identityBlock }] : []),
        ...(options?.history ?? []),
        { role: 'user', content: finalMessage }
      ]

      // Supervisor 主流程节点：模块 worker 的工具事件（taskId=worker id）会长在这个容器下，
      // 使渲染层的事件树能显示「主管 → 模块 → 工具」的层级，而不是散落的顶层行。
      emit({ taskId: 'main', title: '主管 Agent', status: 'running', kind: 'task' })

      // 官方推荐：streamEvents(state, { version: 'v3' }) → run.messages 内每条
      // AI 消息的 .text 是逐字 AsyncIterable。deepagents legacy `.stream()` 的
      // chunk 结构与文本抽取不匹配（会“正常结束但零输出”），已弃用。
      try {
        const run = await (agent.streamEvents as unknown as (
          state: { messages: Array<{ role: string; content: string }> },
          config: { version: 'v3' },
        ) => Promise<{ messages: AsyncIterable<{ text: AsyncIterable<string> }> }>)(
          { messages: inputMessages },
          { version: 'v3' },
        )
        for await (const msg of run.messages) {
          for await (const token of msg.text) {
            if (controller.signal.aborted) break
            fullContent += token
            onChunk(token)
          }
          if (controller.signal.aborted) break
        }
        emit({ taskId: 'main', title: '主管 Agent', status: 'done' })
      } catch (streamError) {
        if (controller.signal.aborted) {
          console.log('[agent] v3 流被用户中止')
          emit({ taskId: 'main', title: '主管 Agent', status: 'error', text: '已被用户中止。' })
        } else {
          console.warn('[agent] v3 逐字流执行异常，回退 invoke：', streamError)
          emit({
            taskId: 'main',
            title: '主管 Agent',
            status: 'error',
            text: `执行异常：${humanizeAgentError(streamError)}`
          })
        }
      }

      if (controller.signal.aborted) {
        console.log(`[agent] 回复被中止，已收到 ${fullContent.length} 字符`)
        return ''
      }

      // v3 未产出文本（流异常/模型空回/兼容问题）→ 不再回退 invoke，因为流式执行期间工具
      // 可能已被调用，invoke 会重复执行导致副作用重复（如重复写库/审批）。
      if (fullContent === '') {
        console.warn('[agent] v3 流完成但未产出文本，流式过程中工具可能已执行。')
        throw new Error('模型返回了空回复（流式执行期间工具已运行但未生成文本）。请检查模型配置/接口是否兼容，或换个模型重试。')
      }

      console.log(`[agent] 回复完成，共 ${fullContent.length} 字符`)
      return fullContent
    } catch (error) {
      console.error('[agent] 回复失败：', error)
      throw error
    } finally {
      this.workerTraceEmit = null
      if (this.activeStreamAbort === controller) {
        this.activeStreamAbort = null
      }
    }
  }

  /**
   * 会话历史摘要压缩（治理 Phase 1，供渲染层发送前调用）。
   * 只压缩 chat_history 文本；压缩只改「送入模型的上下文」，原始消息由渲染层归档供回看。
   * @returns 结构化摘要文本；history 为空返回 ''
   */
  async compressHistory(
    history: { role: 'user' | 'assistant'; content: string }[]
  ): Promise<string> {
    const judge = this.scJudgeModel
    if (judge === null) throw new Error('Agent 未初始化，请先在设置中配置 API Key')
    if (history.length === 0) return ''
    const body = history
      .map((m) => `${m.role === 'user' ? '【用户】' : '【助手】'}\n${m.content}`)
      .join('\n\n')
    const text = (
      await this.invokeModelText(judge, [
        { role: 'system', content: COMPRESS_HISTORY_SYSTEM },
        { role: 'user', content: body }
      ])
    ).trim()
    return text
  }

  /** 读取全局设置布尔开关（settings.<key>；缺省 def）。 */
  private readSettingsFlag(key: string, def: boolean): boolean {
    try {
      const settings = (getStoreValue<Record<string, unknown>>('settings') ?? {}) as Record<string, unknown>
      const v = settings[key]
      return typeof v === 'boolean' ? v : def
    } catch {
      return def
    }
  }

  /**
   * Skill 分层路由（每轮自动执行；手动 / 触发在调用方已跳过）。
   * Meta-Cognition（意图/目录/复杂度）→ 规则粗召回 →（可选）LLM 精排 → 仅注入 top-K 候选上下文。
   * @returns { context, meta } 候选注入文本与路由 Meta 画像；null 表示路由不可用（调用方可用目录兜底）。
   */
  private async runSkillRouting(
    message: string,
    conversationId: string,
    signal: AbortSignal,
    emit: (event: AgentWorkerEvent) => void
  ): Promise<
    | {
        context: string
        meta: { intents: string[]; categories: string[]; complexity: 'low' | 'medium' | 'high' } | null
      }
    | null
  > {
    const judge = this.scJudgeModel
    if (judge === null) return null
    const { skills, rejected } = loadSkillRegistry()
    if (skills.length === 0) return null
    if (rejected.length > 0) {
      console.warn('[skill-router] 以下自定义技能注册被拒绝：', rejected)
    }

    emit({ taskId: 'router', title: '技能路由', status: 'running' })
    // ① Meta-Cognition：意图 / 目录 / 复杂度
    let intents: string[] = []
    let categories: string[] = []
    let complexity: 'low' | 'medium' | 'high' = 'medium'
    try {
      const meta = await judge
        .withStructuredOutput(ROUTE_META_SCHEMA, { name: 'skill_route_meta', method: 'functionCalling' })
        .invoke([
          { role: 'system', content: ROUTE_META_SYSTEM },
          { role: 'user', content: `用户请求：\n${message}` }
        ])
      intents = meta.intents ?? []
      categories = (meta.categories ?? []).slice(0, 3)
      complexity = meta.complexity
    } catch (error) {
      emit({
        taskId: 'router',
        title: '技能路由',
        status: 'error',
        text: `路由判定失败：${humanizeAgentError(error)}（本次不注入技能候选）`
      })
      return null
    }
    if (signal.aborted) return { context: '', meta: { intents, categories, complexity } }

    const counts = this.sessionSkillCounts.get(conversationId) ?? new Map<string, number>()
    this.sessionSkillCounts.set(conversationId, counts)
    const rerankEnabled = this.readSettingsFlag('skillRerank', true)

    // ② 粗召回 + ③ 精排（规则；候选 > 1 且开启时叠加 LLM 精排）
    const llmRerank =
      rerankEnabled === false
        ? undefined
        : async (cands: RouterCandidate[], q: string): Promise<RouterCandidate[] | null> => {
            try {
              const lines = cands.map((c) => `- ${c.trigger} · ${c.title} — ${c.description}`)
              const ranked = await judge
                .withStructuredOutput(ROUTE_RANK_SCHEMA, { name: 'skill_route_rerank', method: 'functionCalling' })
                .invoke([
                  { role: 'system', content: ROUTE_RANK_SYSTEM },
                  { role: 'user', content: `用户请求：${q}\n\n候选技能：\n${lines.join('\n')}` }
                ])
              const order = ranked.ranking ?? []
              const byTrigger = new Map(cands.map((c) => [c.trigger, c]))
              return order.map((r) => byTrigger.get(r.trigger)).filter((c): c is RouterCandidate => c !== undefined)
            } catch {
              return null
            }
          }

    const picked = await routeSkills(skills, { message, intents, categories, complexity, sessionCounts: counts }, SKILL_TOP_K, llmRerank)
    if (signal.aborted) return { context: '', meta: { intents, categories, complexity } }

    // ④ 更新会话级候选计数（max_session_times 治理）
    for (const c of picked) counts.set(c.trigger, (counts.get(c.trigger) ?? 0) + 1)

    if (picked.length === 0) {
      emit({ taskId: 'router', title: '技能路由', status: 'done', text: '无合适技能候选，按常规流程处理。' })
      return { context: '', meta: { intents, categories, complexity } }
    }
    const context = candidatesToContext(picked)
    emit({
      taskId: 'router',
      title: '技能路由',
      status: 'done',
      text: `候选：${picked.map((c) => `/${c.trigger}`).join('、')}`
    })
    return { context, meta: { intents, categories, complexity } }
  }

  /** 中止当前正在进行的流式回复（若存在）。 */
  stopStreaming(): void {
    this.activeStreamAbort?.abort()
  }

  /** 用最近一次配置重新初始化 Supervisor（「插件 → 子代理」增删改查后调用，免重启生效）。 */
  async reload(): Promise<{ ok: boolean; message: string }> {
    if (this.config === null) {
      return { ok: false, message: 'Agent 尚未初始化，请先在设置中配置 API Key 并重新初始化。' }
    }
    try {
      await this.initialize(this.config)
      return { ok: true, message: 'Supervisor 已按最新子代理注册重新初始化，变更即时生效。' }
    } catch (error) {
      return { ok: false, message: `重新初始化失败：${humanizeAgentError(error)}` }
    }
  }

  /** 「插件 → 子代理」面板所需的只读目录：工具白名单 + 内置子代理（供展示/克隆）。 */
  getSubagentCatalog(): {
    tools: { id: string; label: string; description: string }[]
    builtin: { id: string; label: string; description: string; systemPrompt: string; toolIds: string[] }[]
  } {
    return {
      tools: WORKER_TOOL_CATALOG,
      builtin: BUILTIN_SUBAGENTS.map((b) => ({
        id: b.id,
        label: b.label,
        description: b.description,
        systemPrompt: b.systemPrompt,
        toolIds: [...b.toolIds]
      }))
    }
  }

  /** 一句话职责描述 → AI 生成自定义子代理草稿（name/label/说明/提示词/工具白名单）。 */
  async generateSubagentFromPrompt(
    prompt: string,
    takenNames: string[]
  ): Promise<{
    ok: boolean
    draft?: { name: string; label: string; description: string; systemPrompt: string; toolIds: string[] }
    message?: string
  }> {
    const judge = this.scJudgeModel
    if (judge === null) {
      return { ok: false, message: 'Agent 尚未初始化，请先在设置中配置 API Key 并重新初始化。' }
    }
    const p = prompt.trim()
    if (p === '') return { ok: false, message: '请先描述你想创建的子代理职责。' }
    const toolIds = WORKER_TOOL_CATALOG.map((t) => t.id)
    const toolEnum = z.enum(toolIds as [string, ...string[]])
    const GEN_SCHEMA = z.object({
      name: z.string().describe('小写字母开头，仅含小写字母/数字/中划线，2~4 段词'),
      label: z.string().describe('中文展示名，8 字内'),
      description: z.string().describe('一句话说明何时由 Supervisor 委派 + 能力边界，60 字内'),
      systemPrompt: z.string().describe('完整中文角色提示词（定位/职责步骤/纪律/输出），300~600 字'),
      toolIds: z.array(toolEnum).describe('从工具白名单中按职责勾选；无关则留空'),
      note: z.string().describe('给用户的生成说明，≤ 40 字').optional()
    })
    const toolLines = WORKER_TOOL_CATALOG.map((t) => `- ${t.id}：${t.label} — ${t.description}`).join('\n')
    const system = `你是 Mimir 的「子代理设计师」。用户会给你一句对某个科研/办公子代理的职责描述，请为其生成一份可直接注册的自定义子代理配置（只输出 JSON）：
- name：小写字母开头，仅含小写字母/数字/中划线（2~4 段词，如 my-critic）；以下 name 已被占用，绝不能重复：${takenNames.join('、') || '（无）'}
- label：中文展示名（8 字内）；
- description：一句话说明「何时由 Supervisor 委派」+ 能力边界（≤ 60 字）；
- systemPrompt：完整中文角色提示词：角色定位 → 职责与执行步骤 → 纪律与边界 → 输出要求（300~600 字，参考严谨科研 Agent 风格；不得声称拥有白名单之外的能力）；
- toolIds：只从下面白名单选择与本职责真正相关的工具，不相关就不选（可为空数组）。

工具白名单：
${toolLines}

用户职责描述：${p}`
    try {
      const parsed = await judge
        .withStructuredOutput(GEN_SCHEMA, { name: 'subagent_design', method: 'functionCalling' })
        .invoke([
          { role: 'system', content: system },
          { role: 'user', content: `一句话职责描述：\n${p}` }
        ])
      const name = (parsed.name ?? '').trim().toLowerCase()
      if (name === '') return { ok: false, message: '模型未产出有效 name，请重试。' }
      const allowed = new Set(toolIds)
      const picked = (Array.isArray(parsed.toolIds) ? parsed.toolIds : [])
        .map((t) => String(t))
        .filter((t) => allowed.has(t))
      return {
        ok: true,
        draft: {
          name,
          label: (parsed.label ?? '').trim(),
          description: (parsed.description ?? '').trim(),
          systemPrompt: (parsed.systemPrompt ?? '').trim(),
          toolIds: [...new Set(picked)]
        }
      }
    } catch (error) {
      return { ok: false, message: `子代理生成失败：${humanizeAgentError(error)}` }
    }
  }
}

// Singleton instance
export const agentService = new AgentService()
