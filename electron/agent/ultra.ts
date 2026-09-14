/**
 * Ultra 增强控制器（Agent 之上的可选增强层）。
 *
 * ── 为什么从 agentService 抽出来 ────────────────────────────────────────────
 * 这段逻辑原先以 6 个私有方法（+ 一整代 prompt 常量）长在 `agentService` 里，外部拿不到。
 * 后果是**无法评测**：`test/eval/realRunner.ts` 自行装配 Agent，根本走不到 Ultra，
 * 于是「单 Agent vs 单 Agent + Ultra」这个 A/B 是跑不出来的（跑两次是同一套代码）。
 * 抽成独立模块后，生产（`agentService.streamMessage`）与评测（`test/eval/realRunner.ts`）
 * 共用**同一份实现**，A/B 才反映真实差异。
 *
 * ── 语义（保持不变）────────────────────────────────────────────────────────
 * Ultra 不是多专家合议（SC）的别名，而是一套「增强总开关 + 顶层策略控制器」：
 * 1. 只做：长程规划约束、策略选择（自动/手动）、cost 预算与自动降级、约束下发；
 *    不做具体研判推理（研判交给下游 Agent 与工具）；
 * 2. 执行动作全部下沉 Agent：本层把所选策略的增强产出（规划/纪要/修订稿）
 *    作为一段「内部参考约束」拼进本轮请求，Agent 据此调用工具完成；
 * 3. multi_expert 只是策略库中的一项；未来新增增强手段只需加一条策略与一个子图。
 *
 * 本模块只依赖「两个模型实例 + 事件外发器」，不读 store、不碰 electron，
 * 因此可以被纯 TS 环境（评测 CLI / vitest）直接加载。
 */
import { z } from 'zod'
import type { ChatOpenAI } from '@langchain/openai'
import { countContextTokens } from './contextManager'
import { pickStructuredMethod } from './gatewayProbe'

/** 过程事件外发器（结构上是 `AgentWorkerEvent` 的子集，避免反向依赖 agentService）。 */
export interface UltraEvent {
  taskId: string
  title: string
  status: 'running' | 'done' | 'error'
  text?: string
}

export type UltraEmit = (event: UltraEvent) => void

/** 路由画像（由技能路由的 Meta-Cognition 产出，Ultra 自动选策略时复用，避免重复计费）。 */
export interface UltraRouterMeta {
  intents: string[]
  categories: string[]
  complexity: 'low' | 'medium' | 'high'
}

/** ── Self-Consistency 多专家合议（可选增强子图，默认关闭，用户按条消息开启）──
 *  控制流：Meta-Cognition 元认知判定 → 并行 K 路独立候选生成（无工具）→
 *  共识/分歧聚合（Aggregator）→ 反思校验（Reflection）。
 *  合议纪要不直接返回用户，而是作为「待验证上下文」交给 Agent（同一个模型循环），
 *  由它用工具核实分歧点后再给出最终回复。
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
输出一段面向执行者（带工具的 Agent）的工作纪要，聚焦「待验证」项，≤ 600 字。`

/** ── Ultra 增强策略库（可选增强控制器：Agent 之上的增强层）──────────────── */

/**
 * Ultra 增强策略（**不含「普通增强」**）。
 *
 * 历史上有过第 5 个策略 `plain`（仅往上下文注入一段「长程规划约束」）。2026-09 的 A/B 实测
 * 把它删掉了。证据（配对 18 条**两臂都干净执行**的用例，模型 deepseek-v4-flash）：
 *
 * | | 基线 | Ultra(plain) |
 * | --- | --- | --- |
 * | 成功率 | 77.8% | 72.2%（0 例修复 / 1 例回归） |
 * | 平均 token | 18810 | 26969（**+43.4%**） |
 * | 平均工具调用 | 1.94 | 3.61（**+85.7%**） |
 *
 * 机制：那段提示词写的是「先规划 / 分步核验 / 必要时调用工具核实 / 交付前逐项复查」，
 * 模型的反应是**多调工具去「核实」** —— 于是撞上「不该调的工具」的概率大增
 * （Ultra 臂 4 条用例因「调用了禁止的工具」失败，基线只有 2 条）。它加的不是判断力，是勤快；
 * 而在工具纪律本来就弱的模型上，勤快是负收益。
 *
 * 因此现在的语义是：**不需要增强就不增强**（{@link pickUltraStrategy} 返回 `null`），
 * 而不是塞一段无效提示词进上下文。
 */
export type UltraStrategy = 'multi_expert' | 'critique_reflect' | 'hybrid_mix' | 'self_consistency_vote'

/** Ultra 策略选择：auto = Ultra 按任务画像自动选；其余为用户手动指定。 */
export type UltraStrategyPick = 'auto' | UltraStrategy

export interface UltraStrategyMeta {
  label: string
  cost: 'low' | 'medium' | 'high'
  desc: string
}

export const ULTRA_STRATEGY_META: Record<UltraStrategy, UltraStrategyMeta> = {
  multi_expert: { label: '多专家合议', cost: 'high', desc: '多视角对抗：K 路并行推演 + 共识/分歧输出' },
  critique_reflect: { label: '批判迭代', cost: 'medium', desc: '方案草稿 → 批判挑错 → 修订，循环 N 轮' },
  hybrid_mix: { label: '混合增强', cost: 'high', desc: '关键判断点触发合议，其余步骤走批判反思' },
  self_consistency_vote: { label: '一致性投票', cost: 'medium', desc: '轻量 SC：少路数只投票选最优，不出完整评审报告' }
}
export const ULTRA_STRATEGY_IDS: UltraStrategy[] = [
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
const ULTRA_DRAFT_SYSTEM = `你是执行层 Agent 的「方案起草者」。就用户任务产出一份**工作草案**（执行方案/核心判断结构/写作提纲），不是面向用户的最终答复。结构：
## 目标复述与约束 / ## 拆解出的子步骤（含先后依赖与可并行项）/ ## 各步骤应调用哪类能力或工具 / ## 草案自身风险与待验证点。
≤ 700 字，不寒暄。`
const ULTRA_CRITIQUE_SYSTEM = `你是「批判评审」。对给定的方案草案挑出真问题：
## 逻辑漏洞 / ## 未经验证的事实假设（逐条标注【待验证】并说明如何核验）/ ## 被忽略的维度/边界/反例 / ## 过度设计或不可行之处。
≤ 500 字，只列真问题，不要凑数。`
const ULTRA_REVISE_SYSTEM = `你是「方案修订者」。依据批判意见修订草案：逐条回应接受/反驳（一句话理由），给出修订后完整草案（结构与首版一致，≤ 700 字），结尾单列「仍需验证」清单（只保留真正需要调用工具核实的点）。`

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

// ─────────────────────────── 内部工具 ───────────────────────────

/** 把模型返回的 content（字符串 / 文本块数组）归一化为纯文本。 */
function textContentOf(content: unknown): string {
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

/** 单次模型调用并抽取纯文本（各子阶段通用）。 */
async function invokeModelText(
  model: ChatOpenAI,
  messages: Array<{ role: string; content: string }>
): Promise<string> {
  const out = await model.invoke(messages)
  return textContentOf(out.content)
}

/** 把长文本压成一行短摘要（子图事件文本用）。 */
function clip(value: unknown, max = 160): string {
  let text = ''
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 把网关/模型抛出的错误压成一行可读中文。 */
function clipError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.length > 240 ? `${raw.slice(0, 240)}…` : raw
}

/** 专家 id → 展示名。 */
function expertLabel(id: ScExpertId): string {
  return SC_EXPERT_POOL.find((e) => e.id === id)?.label ?? id
}

/**
 * 依据任务画像（技能路由 Meta 输出）自动选择增强策略；画像缺失时用轻量关键词兜底。
 *
 * **返回 `null` 表示「本次不增强」** —— 这不是失败，而是正确的默认：
 * 历史版本会在此处选 `plain`（注入一段规划约束提示词），实测它是负收益（见类型注释），
 * 所以现在直接不介入，把上下文留给任务本身。
 *
 * 导出为纯函数：便于单测直接覆盖选型规则，也便于评测报告解释「为什么这轮选了该策略」。
 */
export function pickUltraStrategy(
  message: string,
  routerMeta?: UltraRouterMeta | null
): { strategy: UltraStrategy | null; reason: string } {
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
    return { strategy: null, reason: '缺少路由画像且无增强关键词命中，本次不增强' }
  }
  const intents = routerMeta.intents ?? []
  const cats = routerMeta.categories ?? []
  const cx = routerMeta.complexity
  const hasIntent = (...ids: string[]): boolean => ids.some((i) => intents.includes(i))
  const hasCat = (...ids: string[]): boolean => ids.some((c) => cats.includes(c))
  if (cx === 'low') return { strategy: null, reason: '低复杂度任务不需要增强' }
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
  return { strategy: null, reason: '中等常规任务，无需增强' }
}

// ─────────────────────────── 控制器 ───────────────────────────

/** Ultra 一轮的运行入参。 */
export interface UltraRunArgs {
  message: string
  signal: AbortSignal
  /**
   * 治理后历史的 token 总量（口径为真实 token，见 contextManager）。
   * 用于全局预算降级判断；无历史时传 0。
   */
  historyTokens: number
  /** 用户手动指定的策略；缺省走自动选型。 */
  manual?: UltraStrategy
  /** 技能路由画像（自动选型用；评测/无路由时传 null）。 */
  routerMeta?: UltraRouterMeta | null
}

/** Ultra 一轮的产出。 */
export interface UltraRunResult {
  /** 要拼进本轮请求的「内部参考约束」段；空字符串表示本层未产出。 */
  output: string
  /** 实际采用的策略；未跑（模型缺失）时为 null。 */
  strategy: UltraStrategy | null
  /** 是否因 token 预算被自动降级。 */
  degraded: boolean
}

/**
 * Ultra 增强控制器：选策略（自动/手动 + token 预算降级）→ 跑对应子图 → 产出约束段。
 *
 * 无状态（除注入的模型与 emit），可被生产与评测各自实例化；一次 `run` 对应一轮对话。
 */
export class UltraController {
  private readonly judge: ChatOpenAI
  private readonly candidate: ChatOpenAI
  private readonly emit: UltraEmit
  /** 诊断日志出口（生产走 console；评测可传入静音函数）。 */
  private readonly log: (message: string) => void
  /**
   * 是否开启思考模式——决定结构化输出走哪条通道。
   * 思考模式（DeepSeek）拒绝 `tool_choice`，故不能走 `functionCalling`（详见
   * `pickStructuredMethod`）；缺省 false 保持既有行为。
   */
  private readonly reasoningOn: boolean

  constructor(opts: {
    /** 判定/聚合/反思用模型（低温）。 */
    judgeModel: ChatOpenAI
    /** 并行候选生成用模型（高温）。 */
    candidateModel: ChatOpenAI
    emit: UltraEmit
    log?: (message: string) => void
    /** 是否开启思考模式（决定结构化输出通道，缺省 false）。 */
    reasoningOn?: boolean
  }) {
    this.judge = opts.judgeModel
    this.candidate = opts.candidateModel
    this.emit = opts.emit
    this.log = opts.log ?? ((message: string) => console.log(message))
    this.reasoningOn = opts.reasoningOn ?? false
  }

  /** 跑一轮增强：返回「约束段 + 实际策略 + 是否降级」。 */
  async run(args: UltraRunArgs): Promise<UltraRunResult> {
    const { message, signal, historyTokens, manual, routerMeta } = args
    if (signal.aborted) return { output: '', strategy: null, degraded: false }

    const aborted = (): boolean => signal.aborted
    const ctxTokens = historyTokens + countContextTokens(message)

    this.emit({ taskId: 'ultra', title: 'Ultra 增强调度', status: 'running', text: '分析任务并选择增强策略…' })
    let strategy: UltraStrategy | null
    let reason: string
    let degraded = false
    if (manual !== undefined) {
      strategy = manual
      reason = '用户手动指定'
    } else {
      const picked = pickUltraStrategy(message, routerMeta)
      strategy = picked.strategy
      reason = picked.reason
      // 全局 token 预算治理：上下文已很长时**不再增强**（而不是降级到一个已被 A/B 证伪的
      // 「普通增强」提示词 —— 那等于在预算紧张时还要多付一笔确定性的负收益）。
      const cost = strategy === null ? 'low' : ULTRA_STRATEGY_META[strategy].cost
      if (strategy !== null && cost !== 'low' && ctxTokens > 16_000) {
        strategy = null
        degraded = true
        reason = `会话上下文已约 ${ctxTokens} token，超出增强预算，本次不增强`
      } else if (strategy !== null && cost === 'high' && ctxTokens > 9_000) {
        strategy = 'self_consistency_vote'
        degraded = true
        reason = `会话上下文已约 ${ctxTokens} token，高开销策略自动降级为一致性投票`
      }
    }
    if (aborted()) return { output: '', strategy: null, degraded: false }
    if (strategy === null) {
      // 「不增强」是**正常结果**，不是失败：不往上下文塞任何东西，把预算留给任务本身。
      this.emit({ taskId: 'ultra', title: 'Ultra 增强调度', status: 'done', text: `本次不增强。${reason}` })
      this.log(`[agent] Ultra 本次不增强，原因：${reason}，上下文约 ${ctxTokens} token`)
      return { output: '', strategy: null, degraded }
    }
    const label = ULTRA_STRATEGY_META[strategy].label
    this.emit({
      taskId: 'ultra',
      title: 'Ultra 增强调度',
      status: 'done',
      text: `策略：${label}。${reason}${degraded ? '（已自动降级以控制 token 预算）' : ''}`
    })
    this.log(
      `[agent] Ultra 本次策略=${strategy}（${label}），原因：${reason}${degraded ? '，已降级' : ''}，上下文约 ${ctxTokens} token`
    )
    if (aborted()) return { output: '', strategy, degraded }

    // 各策略：执行动作全部下沉 Agent —— 这里只产出一段「内部参考约束」拼进请求
    let brief: string | null = null
    if (strategy === 'multi_expert') {
      const sc = await this.runScStage(message, signal, { force: true })
      if (aborted()) return { output: '', strategy, degraded }
      brief = sc.brief
    } else if (strategy === 'self_consistency_vote') {
      const v = await this.runScVoteStage(message, signal)
      if (aborted()) return { output: '', strategy, degraded }
      brief = v.brief
    } else if (strategy === 'critique_reflect') {
      const c = await this.runCritiqueStage(message, signal, { rounds: 2 })
      if (aborted()) return { output: '', strategy, degraded }
      brief = c.brief
    } else if (strategy === 'hybrid_mix') {
      const h = await this.runHybridStage(message, signal)
      if (aborted()) return { output: '', strategy, degraded }
      brief = h.brief
    }
    if (brief === null || brief.trim() === '') {
      // 增强子图整体失败：**不注入任何东西**。
      // 历史版本会在此降级为「普通增强」提示词，而 A/B 已证明那段提示词是负收益 ——
      // 失败了就如实不介入，而不是用一段确定有害的文本去"兜底"。
      this.log(`[agent] Ultra 策略「${label}」子图执行失败，本次不注入增强产出`)
      this.emit({
        taskId: 'ultra:fallback',
        title: 'Ultra 子图降级',
        status: 'error',
        text: `「${label}」子图执行失败，本次不注入增强产出（该策略未产出可用结论）。`
      })
      return { output: '', strategy, degraded }
    }
    return { output: this.composeUltraContext(strategy, brief), strategy, degraded }
  }

  /** 各策略子图通用的「增强产出」外包装（头部 + 面向 Agent 的执行注意）。 */
  private composeUltraContext(kind: UltraStrategy, body: string): string {
    const meta = ULTRA_STRATEGY_META[kind]
    let note = ''
    switch (kind) {
      case 'multi_expert':
        note =
          '请核验其中标注【待验证】的分歧与事实点（必要时调用对应能力域工具核实），再面向用户给出完整中文回复；不要逐字复述纪要，也不要把内部合议过程写进最终回答。'
        break
      case 'self_consistency_vote':
        note =
          '以「推荐答案」为基准完善最终回复；其中【待验证】的点先调用对应能力域工具核实后再输出。'
        break
      case 'critique_reflect':
        note =
          '采用经批判迭代修订后的方案执行：先规划后执行，能核实「仍需验证」清单事项的调用对应能力域工具核实，最后面向用户输出完整中文回复。'
        break
      case 'hybrid_mix':
        note =
          '按全局方案分步执行，遵守子步骤先后依赖；「关键点合议 / 批判反思」结论作为内部参考，标注【待验证】的事项用对应能力域工具核实后输出最终回复。'
        break
    }
    return `# Ultra 增强产出（${meta.label} · 内部参考）\n\n${body}\n\n${note}`
  }

  /**
   * Self-Consistency 多专家合议（代码级静态子图）：
   * ① Meta-Cognition 元认知判定（是否合议 + 选 K 路专家）→
   * ② 并行 K 路独立候选生成（无工具、互不可见）→
   * ③ Aggregator 共识/分歧聚合 → ④ Reflection 反思校验。
   * 返回合议纪要（brief），由 Agent 核验【待验证】分歧后再作答；无需合议或全部失败返回 brief=null。
   * @param opts.focus 只对某个子问题做合议（hybrid 的关键点局部触发）
   * @param opts.force 强制启用合议（用户指定 multi_expert / hybrid 局部场景），Meta 只负责选专家
   * @param opts.maxRoles 上限 K 路（轻量化）
   */
  private async runScStage(
    message: string,
    signal: AbortSignal,
    opts?: { force?: boolean; focus?: string; maxRoles?: number }
  ): Promise<{ brief: string | null }> {
    const aborted = (): boolean => signal.aborted
    // 合议对象：默认整条请求；hybrid 局部合议时聚焦到关键子问题
    const taskText = opts?.focus !== undefined && opts.focus.trim() !== '' ? opts.focus : message
    const focusTag = taskText !== message ? `（聚焦关键子问题：${clip(taskText, 60)}）` : ''

    // ① Meta-Cognition：判定是否合议 + 选择启用哪些专家（K = roles 长度）
    this.emit({ taskId: 'sc:meta', title: `元认知决策${focusTag}`, status: 'running' })
    let roles: ScExpertId[] = []
    let reason = ''
    try {
      const forceDirective =
        opts?.force === true
          ? '\n注意：本次由 Ultra 策略强制启用合议，enable 必须为 true，直接选择最合适的专家并说明理由。'
          : ''
      const parsed = await this.judge
        .withStructuredOutput(SC_META_SCHEMA, { name: 'sc_meta_decision', method: pickStructuredMethod(this.reasoningOn) })
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
        this.emit({
          taskId: 'sc:meta',
          title: `元认知决策${focusTag}`,
          status: 'done',
          text: reason.trim() !== '' ? reason : '判定无需多专家合议，直接执行。'
        })
        return { brief: null }
      }
      this.emit({
        taskId: 'sc:meta',
        title: `元认知决策${focusTag}`,
        status: 'done',
        text: `启用多专家合议（${roles.length} 路）：${roles.map(expertLabel).join('、')}。${reason}`
      })
    } catch (error) {
      this.emit({
        taskId: 'sc:meta',
        title: `元认知决策${focusTag}`,
        status: 'error',
        text: `判定失败：${clipError(error)}，本次跳过合议直接执行。`
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
        this.emit({ taskId, title: ex.label, status: 'running' })
        try {
          const text = (
            await invokeModelText(this.candidate, [
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
          this.emit({ taskId, title: ex.label, status: 'done', text })
        } catch (error) {
          this.emit({
            taskId,
            title: ex.label,
            status: 'error',
            text: `（专家未能产出意见：${clipError(error)}）`
          })
        }
      })
    )
    if (aborted()) return { brief: null }
    if (candidates.length === 0) {
      this.emit({
        taskId: 'sc:aggregate',
        title: '共识与分歧聚合',
        status: 'error',
        text: '所有专家均未能产出意见，本次跳过合议。'
      })
      return { brief: null }
    }

    // ③ Aggregator：共识 / 分歧 / 方案倾向
    const body = candidates.map((c) => `## ${c.label}\n\n${c.text}`).join('\n\n')
    this.emit({ taskId: 'sc:aggregate', title: '共识与分歧聚合', status: 'running' })
    let aggregated = ''
    try {
      aggregated = (
        await invokeModelText(this.judge, [
          { role: 'system', content: SC_AGG_SYSTEM },
          { role: 'user', content: `# 合议对象\n\n${taskText}\n\n# 各专家候选意见\n\n${body}` }
        ])
      ).trim()
      if (aborted()) return { brief: null }
      this.emit({ taskId: 'sc:aggregate', title: '共识与分歧聚合', status: 'done', text: aggregated })
    } catch (error) {
      this.emit({
        taskId: 'sc:aggregate',
        title: '共识与分歧聚合',
        status: 'error',
        text: `聚合失败：${clipError(error)}，本次跳过合议。`
      })
      return { brief: null }
    }

    // ④ Reflection：反思校验 → 输出供 Agent 核验的待验证工作纪要
    this.emit({ taskId: 'sc:reflect', title: '反思校验', status: 'running' })
    let reflectText = ''
    try {
      reflectText = (
        await invokeModelText(this.judge, [
          { role: 'system', content: SC_REFLECT_SYSTEM },
          { role: 'user', content: `# 用户请求\n\n${taskText}\n\n# 聚合纪要\n\n${aggregated}` }
        ])
      ).trim()
      if (aborted()) return { brief: null }
      this.emit({ taskId: 'sc:reflect', title: '反思校验', status: 'done', text: reflectText })
    } catch (error) {
      this.emit({
        taskId: 'sc:reflect',
        title: '反思校验',
        status: 'error',
        text: `反思失败：${clipError(error)}，改以聚合纪要作为合议输出。`
      })
      reflectText = aggregated
    }
    if (reflectText.trim() === '') reflectText = aggregated
    return { brief: reflectText }
  }

  /** 一致性投票（轻量 SC）：Meta 选 2~3 位专家 → 并行候选 → 投票裁决推荐答案。 */
  private async runScVoteStage(message: string, signal: AbortSignal): Promise<{ brief: string | null }> {
    const aborted = (): boolean => signal.aborted
    this.emit({ taskId: 'vote:meta', title: '投票专家选择', status: 'running' })
    let roles: ScExpertId[] = []
    try {
      const parsed = await this.judge
        .withStructuredOutput(VOTE_META_SCHEMA, { name: 'svc_meta_decision', method: pickStructuredMethod(this.reasoningOn) })
        .invoke([
          { role: 'system', content: VOTE_META_SYSTEM },
          { role: 'user', content: `用户请求：\n${message}` }
        ])
      roles = [...new Set(parsed.roles)].slice(0, 3)
      if (roles.length < 2) roles = ['reviewer', 'empiricist']
      if (aborted()) return { brief: null }
      this.emit({
        taskId: 'vote:meta',
        title: '投票专家选择',
        status: 'done',
        text: `参与投票：${roles.map(expertLabel).join('、')}。${parsed.reason ?? ''}`
      })
    } catch (error) {
      this.emit({
        taskId: 'vote:meta',
        title: '投票专家选择',
        status: 'error',
        text: `专家选择失败：${clipError(error)}，本次跳过一致性投票。`
      })
      return { brief: null }
    }
    const experts = SC_EXPERT_POOL.filter((e) => roles.includes(e.id))
    const candidates: { label: string; text: string }[] = []
    await Promise.all(
      experts.map(async (ex) => {
        const taskId = `svc:c:${ex.id}`
        this.emit({ taskId, title: `${ex.label}（投票）`, status: 'running' })
        try {
          const text = (
            await invokeModelText(this.candidate, [
              {
                role: 'system',
                content: `${ex.prompt}\n\n请用 Markdown 输出你的独立意见，控制在 260 字内，结构：## 结论 / ## 依据。你与其它投票者相互不可见。`
              },
              { role: 'user', content: `用户请求：\n${message}` }
            ])
          ).trim()
          if (text === '') throw new Error('投票者返回为空')
          candidates.push({ label: ex.label, text })
          this.emit({ taskId, title: `${ex.label}（投票）`, status: 'done', text })
        } catch (error) {
          this.emit({ taskId, title: `${ex.label}（投票）`, status: 'error', text: `（未能产出意见：${clipError(error)}）` })
        }
      })
    )
    if (aborted()) return { brief: null }
    if (candidates.length === 0) {
      this.emit({ taskId: 'svc:vote', title: '一致性投票', status: 'error', text: '所有投票者均失败，跳过一致性投票。' })
      return { brief: null }
    }
    const body = candidates.map((c) => `## ${c.label}\n\n${c.text}`).join('\n\n')
    this.emit({ taskId: 'svc:vote', title: '一致性投票', status: 'running' })
    try {
      const voted = (
        await invokeModelText(this.judge, [
          { role: 'system', content: VOTE_AGG_SYSTEM },
          { role: 'user', content: `# 投票问题\n\n${message}\n\n# 各候选意见\n\n${body}` }
        ])
      ).trim()
      if (aborted()) return { brief: null }
      this.emit({ taskId: 'svc:vote', title: '一致性投票', status: 'done', text: voted })
      if (voted === '') return { brief: null }
      return { brief: `# 推荐答案（一致性投票）\n\n${voted}` }
    } catch (error) {
      this.emit({ taskId: 'svc:vote', title: '一致性投票', status: 'error', text: `投票失败：${clipError(error)}` })
      return { brief: null }
    }
  }

  /** 批判迭代（critique_reflect）：方案草稿 →（批判 → 修订）× rounds 轮，输出修订后方案。 */
  private async runCritiqueStage(
    message: string,
    signal: AbortSignal,
    opts?: { rounds?: number; seedDraft?: string }
  ): Promise<{ brief: string | null }> {
    const aborted = (): boolean => signal.aborted
    const rounds = Math.max(1, Math.min(3, opts?.rounds ?? 2))
    this.emit({ taskId: 'crit:plan', title: '方案起草', status: 'running' })
    let draft = opts?.seedDraft?.trim() ?? ''
    try {
      if (draft === '') {
        draft = (
          await invokeModelText(this.judge, [
            { role: 'system', content: ULTRA_DRAFT_SYSTEM },
            { role: 'user', content: `用户任务：\n${message}` }
          ])
        ).trim()
      }
      if (aborted()) return { brief: null }
      this.emit({ taskId: 'crit:plan', title: '方案起草', status: 'done', text: draft })
      if (draft === '') throw new Error('草案为空')
    } catch (error) {
      this.emit({ taskId: 'crit:plan', title: '方案起草', status: 'error', text: `起草失败：${clipError(error)}` })
      return { brief: null }
    }
    let lastCritique = ''
    for (let round = 1; round <= rounds; round++) {
      if (aborted()) return { brief: null }
      const critTask = `crit:c:${round}`
      this.emit({ taskId: critTask, title: `批判评审（${round}/${rounds}）`, status: 'running' })
      try {
        lastCritique = (
          await invokeModelText(this.judge, [
            { role: 'system', content: ULTRA_CRITIQUE_SYSTEM },
            { role: 'user', content: `用户任务：\n${message}\n\n# 方案草案\n\n${draft}` }
          ])
        ).trim()
        this.emit({ taskId: critTask, title: `批判评审（${round}/${rounds}）`, status: 'done', text: lastCritique })
      } catch (error) {
        this.emit({ taskId: critTask, title: `批判评审（${round}/${rounds}）`, status: 'error', text: `批判失败：${clipError(error)}` })
        lastCritique = ''
      }
      if (aborted()) return { brief: null }
      const revTask = `crit:r:${round}`
      this.emit({ taskId: revTask, title: `方案修订（${round}/${rounds}）`, status: 'running' })
      try {
        draft = (
          await invokeModelText(this.judge, [
            { role: 'system', content: ULTRA_REVISE_SYSTEM },
            {
              role: 'user',
              content: `用户任务：\n${message}\n\n# 方案草案\n\n${draft}\n\n# 批判意见\n\n${lastCritique !== '' ? lastCritique : '（本轮未产生批判，请自查补漏后给出修订稿）'}`
            }
          ])
        ).trim()
        this.emit({ taskId: revTask, title: `方案修订（${round}/${rounds}）`, status: 'done', text: draft })
      } catch (error) {
        this.emit({ taskId: revTask, title: `方案修订（${round}/${rounds}）`, status: 'error', text: `修订失败：${clipError(error)}，保留当前草案。` })
      }
    }
    if (aborted()) return { brief: null }
    if (draft.trim() === '') return { brief: null }
    return { brief: draft }
  }

  /** 混合增强（hybrid_mix）：全局方案 + 关键判断点局部多专家合议；无关键点时整体批判反思一轮。 */
  private async runHybridStage(message: string, signal: AbortSignal): Promise<{ brief: string | null }> {
    const aborted = (): boolean => signal.aborted
    this.emit({ taskId: 'hyb:meta', title: '全局方案与关键点识别', status: 'running' })
    let plan = ''
    let hasCritical = false
    let criticalQuestion = ''
    try {
      const meta = await this.judge
        .withStructuredOutput(ULTRA_HYBRID_META_SCHEMA, { name: 'ultra_hybrid_meta', method: pickStructuredMethod(this.reasoningOn) })
        .invoke([
          { role: 'system', content: ULTRA_HYBRID_META_SYSTEM },
          { role: 'user', content: `用户任务：\n${message}` }
        ])
      plan = (meta.plan ?? '').trim()
      hasCritical = meta.hasCritical === true
      criticalQuestion = (meta.criticalQuestion ?? '').trim()
      if (aborted()) return { brief: null }
      this.emit({
        taskId: 'hyb:meta',
        title: '全局方案与关键点识别',
        status: 'done',
        text: `全局方案：${clip(plan, 120)}；关键判断点：${hasCritical && criticalQuestion !== '' ? `有（${clip(criticalQuestion, 80)}）` : '无'}`
      })
      if (plan === '') throw new Error('方案为空')
    } catch (error) {
      this.emit({ taskId: 'hyb:meta', title: '全局方案与关键点识别', status: 'error', text: `规划失败：${clipError(error)}` })
      return { brief: null }
    }
    // 关键判断点 → 仅对该子问题做多专家合议（局部触发，K ≤ 3）；否则整体批判反思一轮
    if (hasCritical && criticalQuestion !== '') {
      const sc = await this.runScStage(criticalQuestion, signal, { force: true, maxRoles: 3 })
      if (aborted()) return { brief: null }
      if (sc.brief === null) return { brief: `# 全局执行方案\n\n${plan}\n\n（关键点合议执行失败，按上述方案常规执行。）` }
      return { brief: `# 全局执行方案\n\n${plan}\n\n# 关键点多专家合议\n\n${sc.brief}` }
    }
    const crit = await this.runCritiqueStage(message, signal, { rounds: 1, seedDraft: plan })
    if (aborted()) return { brief: null }
    if (crit.brief === null) return { brief: `# 全局执行方案\n\n${plan}\n\n（整体批判反思执行失败，按上述方案常规执行。）` }
    return { brief: `# 全局执行方案\n\n${plan}\n\n# 批判反思产出\n\n${crit.brief}` }
  }
}
