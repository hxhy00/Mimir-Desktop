import { createDeepAgent } from 'deepagents'
import { ChatOpenAI } from '@langchain/openai'
import { tool } from 'langchain/tools'
import { z } from 'zod'
import { arxivSearchTool, arxivFetchPaperTool } from './tools/arxivSearch'
import { webSearchTool } from './tools/webSearch'
import { wikiNoteTool } from './tools/wikiNote'
import { paperFetchTool, setPaperTool } from './tools/paperTools'
import { venueSearchTool } from './tools/venue'
import { experimentTool } from './tools/experiments'
import { serverStatusTool } from './tools/servers'
import { latexCompileTool } from './tools/latex'
import { meetingDeckTool } from './tools/meetings'
import { ledgerTool } from './tools/ledger'
import { figureTool } from './tools/figures'

/** 主 Agent 工具集：文献检索/落库 + 模块桥接（实验·服务器·LaTeX·组会·记录·图表）。 */
const AGENT_TOOLS = [
  arxivSearchTool,
  arxivFetchPaperTool,
  webSearchTool,
  wikiNoteTool,
  paperFetchTool,
  setPaperTool,
  venueSearchTool,
  experimentTool,
  serverStatusTool,
  latexCompileTool,
  meetingDeckTool,
  ledgerTool,
  figureTool,
]

export interface AgentConfig {
  apiKey: string
  model: string
  baseUrl?: string
}

export type AgentMode = 'normal' | 'swarm'

/** 蜂群任务/阶段事件（渲染层顶部状态条与过程日志用）。 */
export interface SwarmWorkerEvent {
  /** 稳定标识：任务 id、'scheduler'（拆解）、'aggregate'（汇总）等。 */
  taskId: string
  /** 展示标题：任务名 / 阶段名。 */
  title: string
  status: 'running' | 'done' | 'error'
  /** done 时为该任务产物文本；error 时为错误说明；tool/think 时为过程说明。 */
  text?: string
  /** 工具执行耗时（毫秒），由 withToolTrace 在调用返回/出错时填充。 */
  durationMs?: number
  /** 行类别：phase=调度阶段，task=任务分发/执行，tool=工具调用，think=工蜂推理文本，think-token=推理逐字 token（缺省视为 task）。 */
  kind?: 'phase' | 'task' | 'tool' | 'think' | 'think-token'
  /** 调度拆解完成（phase/done）时附带任务计划，供渲染层展示「决策」细节。 */
  detail?: { id: string; title: string; role: SwarmRole; dependsOn: string[] }[]
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

通用纪律：只断言有证据支撑的结论；涉及本应用主进程能力（LaTeX 编译、图片落盘、PPT 生成、本地文件读写）时，引导用户在对应模块执行并请其把结果/日志粘贴回来，不要假装已经执行。`

/** 蜂群 Worker（并行子 Agent）的角色提示词。 */
const SWARM_WORKER_PROMPTS = {
  researcher:
    '你是 Mimir 蜂群中的「搜索 Agent」。你的任务是检索用户请求相关的文献与资料。主动使用 arxiv_search（学术论文）与 web_search（网页）检索，需要时用 arxiv_fetch_paper 读取单篇论文元数据。只做检索与资料收集，输出结构化的中文结果：分点列出标题、来源（arXiv id / URL）与摘要级要点，尽量给出可直接引用的出处。\n\n检索纪律（重要）：先把相关关键词合并成最少的几条查询（可用 OR/引号组合），每条 arxiv_search 尽量覆盖相近含义；一次检索返回的结果应直接复用于多个子问题，不要为同一主题反复调用同词查询；确需改换角度时才发起新查询。',
  analyst:
    '你是 Mimir 蜂群中的「分析 Agent」。你的任务是深入解析论文/方法/实验（优先用 arxiv_fetch_paper 获取论文元数据，必要时 web_search 补充），提炼关键信息：核心方法、实验设计与指标、创新点、局限与可复现要点。输出结构化中文分析结论，不做长篇综述，论点要给依据。',
  writer:
    '你是 Mimir 蜂群中的「写作 Agent」。你的任务是基于请求写出结构清晰、语言专业、符合学术规范的中文文本：若涉及笔记/落库可调用 wiki 笔记工具，否则直接产出文本。注意：不要编造没有依据的结论，引用一律标注来源（arXiv id / URL 优先）。'
} as const

/** 蜂群汇总 Agent 的系统提示（把各任务成果合成为面向用户的最终回答）。 */
const SWARM_AGGREGATOR_SYSTEM = `你是 Mimir 蜂群模式的汇总 Agent。你收到的是同一用户请求经调度器拆解、各任务子 Agent 独立产出的成果。
你的工作：
1. 合并去重：去掉各成果中的重复检索结果与冗余表述；
2. 组织成一份面向用户的最终中文回答：先给结论/直接答案，再展开要点；检索来源列出出处，相互矛盾的结论要指出并说明差异；
3. 保真：不凭空添加用户请求与子 Agent 成果之外的事实；任务注明失败/无输出的部分如实说明；
4. 若任务成果都是空或出错，如实告知用户，并给可执行的后续建议。
始终使用中文。`

/** 调度器可指派的工蜂角色。 */
export type SwarmRole = 'researcher' | 'analyst' | 'writer'

/** 单次蜂群的任务数与同批并发上限（成本/复杂度护栏）。
 *  注意：免费档 API 的「每分钟请求数」通常极低（可能仅 1~3 次/分钟），
 *  蜂群一次 run = 规划 + 多个工蜂 × 每工蜂多轮工具调用 + 汇总，极易瞬时打满，
 *  因此默认同批并发取 1（任务串行、同一时刻只发一个模型请求），并配合下方
 *  429「冷却对齐」退避：撞上窗口后先等窗口结束再重试，避免短退避反复空撞。 */
const SWARM_MAX_TASKS = 3
const SWARM_PARALLEL_CAP = 1

/** 429/限流后的全局冷却截止时间（ms 时间戳）。任一路径撞限流就把下次重试
 *  对齐到这个时刻再发，避免多个任务各自短退避后再次同秒并发打满窗口。 */
let llmRateCoolUntil = 0

/** 蜂王（调度器）：把请求拆成带依赖的子任务（DAG）。 */
const SWARM_PLANNER_SYSTEM = `你是 Mimir 蜂群模式的「蜂王 / 调度器」。你的工作是把用户请求拆解成由「工蜂」执行的子任务清单，你不执行任务本身。
要求：
1. 输出 2~${SWARM_MAX_TASKS} 个任务；能无依赖并行的任务尽量放在同一批（同一层并发执行）；
2. 确有先后依赖时用 dependsOn 表达（如「分析」依赖「检索」的产物），依赖链深度不超过 3 层；
3. 每个任务的 role 从三种工蜂中选一种：
   - researcher（搜索）：检索/收集信息，arXiv 或网页；
   - analyst（分析）：读取并分析已有材料、提炼结论与证据；
   - writer（写作）：撰写/整理/润色中文文本；
4. instruction 用中文写，具体可执行，让工蜂拿到即可独立开工；不要把一个任务塞成超长大步骤；
5. id 唯一、形如 task-1 / task-2…，title 简短；
6. 只输出任务清单，不要执行。`

const PLAN_TASK_SCHEMA = z.object({
  id: z.string(),
  role: z.enum(['researcher', 'analyst', 'writer']),
  title: z.string(),
  instruction: z.string(),
  dependsOn: z.array(z.string()).default([])
})
const PLAN_SCHEMA = z.object({ tasks: z.array(PLAN_TASK_SCHEMA).min(1).max(SWARM_MAX_TASKS) })

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 单次调用超时护栏（规划/工蜂/汇总都可能挂起，给个上限即可触发回退/失败事件，避免 UI 永远转圈）。 */
function withTimeout<T>(label: string, p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 在 ${Math.round(ms / 1000)}s 内未完成`)), ms)
  })
  return Promise.race([p, guard]).finally(() => {
    if (timer !== null) clearTimeout(timer)
  })
}

/** 限流/429 特征：匹配 HTTP 429、各网关的「rate limit / 请求数限制 / request limit」提示。 */
const RATE_LIMIT_RE = /\b429\b|rate\s?limit|请求数限制|request\s?limit/i

/** 429/限流时指数退避重试（避免蜂群把小配额瞬间打爆后整体失败）。 */
async function runWithRateRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const value = await fn()
      return value
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      if (!RATE_LIMIT_RE.test(raw)) throw error
      if (attempt === attempts - 1) throw error
      // 冷却对齐：把本次等待拉到「最近一次 429 之后 45s」的窗口结束时刻，
      // 而不是 12s/24s 递增——免费额度窗口常见 60s 级，短退避会反复空撞。
      const now = Date.now()
      llmRateCoolUntil = Math.max(llmRateCoolUntil, now + 45_000)
      const waitMs = Math.max(0, llmRateCoolUntil - now) + Math.random() * 4000
      console.warn(
        `[swarm] ${label} 触发模型限流(429)，${Math.round(waitMs / 1000)}s 后自动重试（第 ${attempt + 1}/${attempts - 1} 次）`
      )
      await sleep(waitMs)
    }
  }
  throw new Error(`[swarm] ${label} 重试次数耗尽`)
}

/** 把 langchain/网关的长错误压成一行可读中文（去掉 Troubleshooting URL、嵌套 JSON 等噪音）。 */
function humanizeAgentError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (!RATE_LIMIT_RE.test(raw)) return raw.length > 240 ? `${raw.slice(0, 240)}…` : raw
  const quota = raw.match(/1分钟内最多请求\d+次/)
  const freeQuota = raw.includes('FreeUsageLimit') || /rate limit exceeded/i.test(raw)
  return `模型请求过限（HTTP 429${quota !== null ? `：${quota[0]}` : ''}${freeQuota ? '，免费额度/每分钟配额受限' : ''}）：蜂群已自动等待限流窗口结束后重试；若仍失败，请约 1 分钟后再试，或在「设置 → 模型管理」确认接口配额。`
}

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

/** 包装工具：调用前 / 返回 / 出错三处打点（每次任务实例化一份，避免并发互串）；返回/出错附带耗时（ms）。 */
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

export class AgentService {
  private agent: ReturnType<typeof createDeepAgent> | null = null
  /** 蜂群工蜂装配定义（角色 + 提示词 + 只读工具集）；执行时按任务实例化并打点日志。 */
  private swarmWorkers: { role: SwarmRole; label: string; systemPrompt: string; tools: unknown[] }[] = []
  /** 蜂群汇总阶段使用的模型（与 Worker 同一模型配置）。 */
  private chatModel: ChatOpenAI | null = null
  private config: AgentConfig | null = null
  /** 当前流式对话的中止控制器（停止生成用）。 */
  private activeStreamAbort: AbortController | null = null
  /** 普通模式（标准单 Agent）流式调用期间的工具 trace 外发器：随每次调用临时注入，结束后清空。 */
  private normalTraceEmit: ((event: SwarmWorkerEvent) => void) | null = null

  constructor() {}

  /**
   * Initialize the DeepAgents agent with the given config
   */
  async initialize(config: AgentConfig): Promise<void> {
    this.config = config

    const model = new ChatOpenAI({
      apiKey: config.apiKey,
      model: config.model,
      temperature: 0.7,
      ...(config.baseUrl ? { configuration: { baseURL: config.baseUrl } } : {})
    })

    const systemPrompt = `你是 Mimir，一个以 Agent 为核心的科研助手，运行在桌面科研工作台中。

你的核心能力：
1. 文献搜索与阅读 - 使用 arxiv_search 搜索 arXiv 论文，arxiv_fetch_paper 读取单篇论文的完整元数据（不落库），web_search 搜索网页，paper_fetch 把论文保存到文献库
2. 文献库管理 - 使用 set_paper 更新论文的标签、笔记和 AI 相关性评分
3. 论文写作 - 协助用户撰写和编辑 LaTeX 论文
4. 实验管理 - 记录和可视化实验数据
5. 组会准备 - 生成组会 PPT 和进展报告
6. 服务器管理 - 管理 GPU 服务器和远程作业

工作原则：
- 使用中文回复，保持专业且友好的语气
- 主动使用工具来完成任务，不要只给出建议
- 对于复杂任务，先规划再执行
- 涉及文件操作时，先确认再执行`

    // Standard single-agent mode：工具全部包上 trace，把「调用 / 返回 / 出错」也作为
    // 结构化事件外发（普通 Agent 的执行过程对渲染层可见，不再只有最终文本）。
    const normalHooks = {
      onCall: (name: string, args: unknown): void => {
        this.normalTraceEmit?.({
          taskId: 'main',
          title: '主 Agent',
          status: 'running',
          kind: 'tool',
          text: `调用 ${name}${args ? `：${truncateSummary(args, 120)}` : ''}`
        })
      },
      onDone: (name: string, out: unknown, durationMs: number): void => {
        this.normalTraceEmit?.({
          taskId: 'main',
          title: '主 Agent',
          status: 'done',
          kind: 'tool',
          text: `${name} 返回：${truncateSummary(out, 4000)}`,
          durationMs
        })
      },
      onError: (name: string, error: unknown, durationMs: number): void => {
        this.normalTraceEmit?.({
          taskId: 'main',
          title: '主 Agent',
          status: 'error',
          kind: 'tool',
          text: `${name} 出错：${humanizeAgentError(error)}`,
          durationMs
        })
      }
    }
    this.agent = createDeepAgent({
      model,
      systemPrompt: `${systemPrompt}\n\n${SLASH_CATALOG_TEXT}`,
      tools: AGENT_TOOLS.map((base) => withToolTrace(base as ToolLike, normalHooks)) as never
    })

    // Swarm mode: 工蜂装配定义（不在此实例化，执行时按任务实例化并逐步骤打点）。
    this.swarmWorkers = [
      {
        role: 'researcher',
        label: '搜索 Agent',
        systemPrompt: SWARM_WORKER_PROMPTS.researcher,
        tools: [arxivSearchTool, arxivFetchPaperTool, webSearchTool]
      },
      {
        role: 'analyst',
        label: '分析 Agent',
        systemPrompt: SWARM_WORKER_PROMPTS.analyst,
        tools: [arxivFetchPaperTool, webSearchTool]
      },
      {
        role: 'writer',
        label: '写作 Agent',
        systemPrompt: SWARM_WORKER_PROMPTS.writer,
        tools: [wikiNoteTool]
      }
    ]
    this.chatModel = model
  }

  /**
   * 按任务实例化一个工蜂图：工具全部包上过程日志（调用/返回/出错）并绑定到该任务。
   * 每次调用新建实例，保证工具日志上下文不会在并发任务间串线。
   */
  private buildWorkerGraph(
    worker: { role: SwarmRole; label: string; systemPrompt: string; tools: unknown[] },
    task: { id: string; title: string },
    onEvent?: (event: SwarmWorkerEvent) => void
  ): ReturnType<typeof createDeepAgent> {
    const model = this.chatModel
    if (model === null) throw new Error('Agent 未初始化，请先在设置中配置 API Key')
    const emit = (
      kind: 'tool' | 'think',
      status: 'running' | 'done' | 'error',
      text: string,
      durationMs?: number
    ): void => onEvent?.({ taskId: task.id, title: task.title, kind, status, text, durationMs })
    const traced = worker.tools.map((base) =>
      withToolTrace(base as ToolLike, {
        onCall: (name, args) => emit('tool', 'running', `调用 ${name}${args ? `：${truncateSummary(args, 120)}` : ''}`),
        onDone: (name, out, durationMs) => emit('tool', 'done', `${name} 返回：${truncateSummary(out, 4000)}`, durationMs),
        onError: (name, error, durationMs) => emit('tool', 'error', `${name} 出错：${humanizeAgentError(error)}`, durationMs)
      })
    )
    return createDeepAgent({ model, systemPrompt: worker.systemPrompt, tools: traced as never })
  }

  /** 以 v3 逐字流执行工蜂图：模型 token 经 think-token 事件实时推给渲染层；返回最后一条完整 AI 文本。 */
  private async streamWorkerGraph(
    graph: ReturnType<typeof createDeepAgent>,
    input: { messages: Array<{ role: string; content: string }> },
    task: { id: string; title: string },
    onEvent?: (event: SwarmWorkerEvent) => void
  ): Promise<{ text: string }> {
    const run = await (graph.streamEvents as unknown as (
      state: { messages: Array<{ role: string; content: string }> },
      config: { version: 'v3' }
    ) => Promise<{ messages: AsyncIterable<{ text: AsyncIterable<string> }> }>)(input, { version: 'v3' })
    let artifact = ''
    for await (const msg of run.messages) {
      let buffer = ''
      for await (const token of msg.text) {
        if (this.isAgentStopped()) throw new Error('请求已停止')
        buffer += token
        onEvent?.({
          taskId: task.id,
          title: task.title,
          kind: 'think-token',
          status: 'running',
          text: token
        })
      }
      if (this.isAgentStopped()) throw new Error('请求已停止')
      if (buffer.trim() !== '') artifact = buffer
    }
    return { text: artifact }
  }

  /** 模型流式输出文本（供汇总 Agent 逐字推给聊天正文）。 */
  private async streamModelText(
    model: ChatOpenAI,
    messages: Array<{ role: string; content: string }>,
    onText?: (piece: string) => void
  ): Promise<string> {
    const stream = await model.stream(messages)
    let full = ''
    for await (const chunk of stream) {
      const piece = this.textContentOf(chunk.content)
      if (piece !== '') {
        full += piece
        onText?.(piece)
      }
    }
    return full
  }

  /**
   * Check if the agent is initialized
   */
  isInitialized(): boolean {
    return this.agent !== null
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

  /** 蜂王：把用户请求拆解成带依赖的子任务（结构化输出）。拆解失败/超时返回 null。 */
  private async planSwarmTasks(
    message: string
  ): Promise<{ id: string; role: SwarmRole; title: string; instruction: string; dependsOn: string[] }[] | null> {
    const model = this.chatModel
    if (model === null) return null
    try {
      const planner = model.withStructuredOutput(PLAN_SCHEMA, { name: 'plan_swarm_tasks' })
      // 1 分钟硬性上限：超时就回退到三角色并行，避免 UI 永远卡在“蜂王规划中”。
      const output = await withTimeout(
        '蜂王拆解',
        runWithRateRetry(
          '蜂王拆解',
          () =>
            planner.invoke([
              { role: 'system', content: SWARM_PLANNER_SYSTEM },
              { role: 'user', content: `用户请求：\n${message}` }
            ]),
          2
        ),
        60_000
      )
      const parsed = PLAN_SCHEMA.parse(output)
      const seen = new Set<string>()
      const tasks = parsed.tasks.filter((task) => {
        if (typeof task.id !== 'string' || task.id === '' || seen.has(task.id)) return false
        seen.add(task.id)
        return true
      })
      const ids = new Set(tasks.map((t) => t.id))
      return tasks.map((task) => ({
        id: task.id,
        role: task.role,
        title: task.title,
        instruction: task.instruction,
        dependsOn: task.dependsOn.filter((dep) => dep !== task.id && ids.has(dep))
      }))
    } catch (error) {
      console.warn('蜂王拆解失败（回退三角色并行）：', humanizeAgentError(error))
      return null
    }
  }

  /** 汇总各任务成果：模型输出经 onText 逐字外发（供聊天正文流式显示）。sections 为空返回 null。 */
  private async aggregateSections(
    message: string,
    sections: { title: string; text: string }[],
    onText?: (piece: string) => void
  ): Promise<string | null> {
    const model = this.chatModel
    if (model === null || sections.length === 0) return null
    if (this.isAgentStopped()) return null
    const body = sections.map((s) => `## ${s.title}\n\n${s.text.trim() || '（无输出）'}`).join('\n\n')
    let emitted = false
    try {
      const text = await runWithRateRetry(
        '蜂群汇总',
        () =>
          this.streamModelText(
            model,
            [
              { role: 'system', content: SWARM_AGGREGATOR_SYSTEM },
              {
                role: 'user',
                content: `# 用户请求\n\n${message}\n\n# 各子任务成果\n\n${body}\n\n请把上述成果汇总成一份面向用户的最终中文回答。`
              }
            ],
            (piece) => {
              emitted = true
              onText?.(piece)
            }
          ),
        3
      )
      const trimmed = text.trim()
      if (trimmed === '') {
        if (!emitted) onText?.(body)
        return body
      }
      return trimmed
    } catch (error) {
      console.error('蜂群汇总失败：', humanizeAgentError(error))
      if (!emitted) onText?.(body)
      return body
    }
  }

  /** 就绪任务并发执行；依赖就绪才放行下一批，工蜂产物进入共享状态供后续依赖与汇总消费。 */
  private async runSwarmDag(
    message: string,
    plan: { id: string; role: SwarmRole; title: string; instruction: string; dependsOn: string[] }[],
    onEvent?: (event: SwarmWorkerEvent) => void,
    onText?: (piece: string) => void
  ): Promise<string | null> {
    const byRole = new Map<SwarmRole, (typeof this.swarmWorkers)[number]>(this.swarmWorkers.map((w) => [w.role, w]))
    const byId = new Map(plan.map((t) => [t.id, t]))
    // 共享状态：任务 id → 产物文本（已完成/失败均有，供依赖方参考）
    const doneText = new Map<string, string>()
    const sections: { title: string; text: string }[] = []
    const pending = new Set(plan.map((t) => t.id))

    // 调度循环：每一轮选出“依赖全部就绪”的任务并发执行（不轮询，由调度器推进）
    let guard = 0
    while (pending.size > 0 && guard++ < SWARM_MAX_TASKS * 4 && !this.isAgentStopped()) {
      const ready = plan.filter((t) => pending.has(t.id) && t.dependsOn.every((dep) => doneText.has(dep)))
      if (ready.length === 0) {
        onEvent?.({
          taskId: 'scheduler',
          title: '蜂群调度',
          kind: 'phase',
          status: 'error',
          text: '任务依赖成环或存在不可达依赖，调度中止。'
        })
        break
      }
      const batch = ready.slice(0, SWARM_PARALLEL_CAP)
      await Promise.all(
        batch.map(async (task) => {
          pending.delete(task.id)
          const worker = byRole.get(task.role)
          // 分发：把该任务派给对应角色的工蜂
          onEvent?.({
            taskId: task.id,
            title: task.title,
            kind: 'task',
            status: 'running',
            text: worker === undefined ? '（未找到角色工蜂）' : `分发至 ${worker.label}`
          })
          try {
            if (!worker) throw new Error(`没有「${task.role}」角色的工蜂`)
            // 为该任务实例化工蜂图（工具带过程日志），随后执行
            const graph = this.buildWorkerGraph(worker, { id: task.id, title: task.title }, onEvent)
            const depBlock =
              task.dependsOn.length > 0
                ? `\n\n# 依赖任务的成果（供你参考，不可重复执行）\n\n${task.dependsOn
                    .map((depId) => {
                      const dep = byId.get(depId)
                      return `【${dep?.title ?? depId}】\n${doneText.get(depId) ?? '（空）'}`
                    })
                    .join('\n\n')}`
                : ''
            const taskInput = {
              messages: [
                {
                  role: 'user',
                  content: `# 用户请求\n\n${message}\n\n# 你的子任务\n标题：${task.title}\n角色：${worker.label}\n任务内容：\n${task.instruction}${depBlock}\n\n请只完成该子任务并输出结构化中文成果，不要执行其它任务。`
                }
              ]
            }
            // 工蜂以 v3 逐字流执行：模型 token 实时进入任务卡的思考区
            const streamed = await runWithRateRetry(
              `任务「${task.title}」`,
              () =>
                this.streamWorkerGraph(graph, taskInput, { id: task.id, title: task.title }, onEvent)
            )
            const text = streamed.text.trim()
            if (text === '') throw new Error('工蜂未返回内容')
            doneText.set(task.id, text)
            sections.push({ title: task.title, text })
            onEvent?.({ taskId: task.id, title: task.title, status: 'done', text })
          } catch (error) {
            const brief = humanizeAgentError(error)
            const text = `（任务执行失败：${brief}）`
            doneText.set(task.id, text)
            sections.push({ title: task.title, text })
            onEvent?.({ taskId: task.id, title: task.title, status: 'error', text })
          }
        })
      )
    }
    // 用户停止：立即结束，不再进入汇总
    if (this.isAgentStopped()) return null
    // 所有子任务都失败（例如接口限流连续击穿）时不做无意义的模型汇总，直接给出原因
    if (sections.length > 0 && sections.every((s) => this.isFailureText(s.text))) {
      const detail = sections.map((s) => `${s.title}：${s.text}`).join('\n')
      throw new Error(`蜂群各子任务均未成功：\n${detail}`)
    }
    onEvent?.({ taskId: 'aggregate', title: '结果汇总', kind: 'phase', status: 'running' })
    const aggregated = await this.aggregateSections(message, sections, onText)
    onEvent?.({
      taskId: 'aggregate',
      title: '结果汇总',
      kind: 'phase',
      status: aggregated === null ? 'error' : 'done',
      text: aggregated === null ? '没有可汇总的成果' : '汇总完成'
    })
    return aggregated
  }

  /** 旧版三角色并行：调度器拆解不可用时的降级（保证功能可用）。 */
  private async runSwarmClassic(
    message: string,
    onEvent?: (event: SwarmWorkerEvent) => void,
    onText?: (piece: string) => void
  ): Promise<string | null> {
    const results = await Promise.all(
      this.swarmWorkers.map(async (worker) => {
        onEvent?.({
          taskId: worker.role,
          title: worker.label,
          kind: 'task',
          status: 'running',
          text: '分发至该角色工蜂'
        })
        try {
          const graph = this.buildWorkerGraph(worker, { id: worker.role, title: worker.label }, onEvent)
          const classicInput = {
            messages: [
              {
                role: 'user',
                content: `# 用户请求\n\n${message}\n\n# 本 Agent 任务\n以「${worker.label}」的专业视角处理上面的请求：只完成职责范围内的部分，主动调用可用工具（检索/读取/写作），输出结构清晰、带来源的中文成果。`
              }
            ]
          }
          const streamed = await runWithRateRetry(
            `「${worker.label}」`,
            () =>
              this.streamWorkerGraph(
                graph,
                classicInput,
                { id: worker.role, title: worker.label },
                onEvent
              )
          )
          const text = streamed.text.trim()
          onEvent?.({ taskId: worker.role, title: worker.label, status: text === '' ? 'error' : 'done', text: text === '' ? '（无输出）' : text })
          return { title: worker.label, text }
        } catch (error) {
          const text = `（执行出错：${humanizeAgentError(error)}）`
          onEvent?.({ taskId: worker.role, title: worker.label, status: 'error', text })
          return { title: worker.label, text }
        }
      })
    )
    if (this.isAgentStopped()) return null
    onEvent?.({ taskId: 'aggregate', title: '结果汇总', kind: 'phase', status: 'running' })
    const aggregated = await this.aggregateSections(message, results.filter((r) => r.text.trim() !== ''), onText)
    onEvent?.({
      taskId: 'aggregate',
      title: '结果汇总',
      kind: 'phase',
      status: aggregated === null ? 'error' : 'done',
      text: aggregated === null ? '没有可汇总的成果' : '汇总完成'
    })
    return aggregated
  }

  /** 蜂群入口：蜂王拆解 → DAG 调度；拆解失败降级三角色并行；最终汇总或 null。 */
  private async runSwarm(
    message: string,
    onEvent?: (event: SwarmWorkerEvent) => void,
    onText?: (piece: string) => void
  ): Promise<string | null> {
    if (this.chatModel === null || this.swarmWorkers.length === 0) return null
    onEvent?.({ taskId: 'scheduler', title: '蜂王拆解', kind: 'phase', status: 'running' })
    const plan = await this.planSwarmTasks(message)
    if (this.isAgentStopped()) return null
    if (plan === null || plan.length === 0) {
      onEvent?.({
        taskId: 'scheduler',
        title: '蜂王拆解',
        kind: 'phase',
        status: 'error',
        text: '未能自动拆解任务，改用三角色并行执行。'
      })
      return this.runSwarmClassic(message, onEvent, onText)
    }
    onEvent?.({
      taskId: 'scheduler',
      title: '蜂王拆解',
      kind: 'phase',
      status: 'done',
      text: `已拆解 ${plan.length} 个子任务`,
      detail: plan.map((t) => ({ id: t.id, title: t.title, role: t.role, dependsOn: t.dependsOn }))
    })
    return this.runSwarmDag(message, plan, onEvent, onText)
  }

  /** 是否为失败占位文本（任务级失败/出错）。 */
  private isFailureText = (text: string): boolean =>
    text.startsWith('（任务执行失败') || text.startsWith('（执行出错')

  /** 蜂群入口：优先 DAG 调度蜂群，异常/未配置时回退到标准单 Agent。 */
  private async runSwarmTask(
    message: string,
    onEvent?: (event: SwarmWorkerEvent) => void,
    onText?: (piece: string) => void
  ): Promise<string> {
    try {
      const out = await this.runSwarm(message, onEvent, onText)
      if (out !== null) return out
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      if (RATE_LIMIT_RE.test(raw)) {
        // 限流是配额问题：再回退标准 Agent 只会再撞一次窗口，直接把可读原因抛给用户
        console.error('蜂群受模型限流影响而中止（不回退，避免再次打满配额）：', humanizeAgentError(error))
        throw new Error(`蜂群未能完成：${humanizeAgentError(error)}`)
      }
      if (this.isAgentStopped()) {
        console.log('蜂群已被用户停止，放弃回退')
        return ''
      }
      console.error('蜂群执行失败，回退标准 Agent：', error)
    }
    if (this.isAgentStopped() || this.agent === null) {
      if (this.agent === null) throw new Error('Agent 未初始化，请先在设置中配置 API Key')
      return ''
    }
    const result = await this.agent.invoke({
      messages: [{ role: 'user', content: message }]
    })
    return this.lastTextOf(result)
  }

  /**
   * Send a message to the agent and get a response
   */
  async sendMessage(message: string, conversationId: string, mode: AgentMode = 'normal'): Promise<string> {
    if (mode === 'swarm') return this.runSwarmTask(message)

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
   * Stream a message to the agent, calling onChunk for each chunk.
   * 可通过 {@link stopStreaming} 中止：abort 后返回已收到的部分内容。
   */
  async streamMessage(
    message: string,
    conversationId: string,
    onChunk: (chunk: string) => void,
    mode: AgentMode = 'normal',
    onSwarmEvent?: (event: SwarmWorkerEvent) => void
  ): Promise<string> {
    // 蜂群：Worker 并行 + 汇总一次性输出（并行子 Agent 的网络调用不可逐 token 转发）。
    if (mode === 'swarm') {
      const controller = new AbortController()
      this.activeStreamAbort = controller
      try {
        // 汇总文本已通过 onText → onChunk 逐字外发；这里只等 run 结束返回最终全文
        const full = await this.runSwarmTask(message, onSwarmEvent, (piece) => {
          if (!controller.signal.aborted) onChunk(piece)
        })
        return controller.signal.aborted ? '' : full
      } finally {
        if (this.activeStreamAbort === controller) {
          this.activeStreamAbort = null
        }
      }
    }

    const agent = this.agent
    if (!agent) {
      throw new Error('Agent 未初始化，请先在设置中配置 API Key')
    }

    const controller = new AbortController()
    this.activeStreamAbort = controller
    // 本次流式调用期间，工具执行事件经 onSwarmEvent 外发（渲染层按需入树）
    this.normalTraceEmit = (event) => onSwarmEvent?.(event)
    let fullContent = ''

    try {
      console.log(`[agent] 回复开始（v3 逐字流）mode=normal 会话=${conversationId}`)

      // 官方推荐：streamEvents(state, { version: 'v3' }) → run.messages 内每条
      // AI 消息的 .text 是逐字 AsyncIterable。deepagents legacy `.stream()` 的
      // chunk 结构与文本抽取不匹配（会“正常结束但零输出”），已弃用。
      try {
        const run = await (agent.streamEvents as unknown as (
          state: { messages: Array<{ role: string; content: string }> },
          config: { version: 'v3' },
        ) => Promise<{ messages: AsyncIterable<{ text: AsyncIterable<string> }> }>)(
          { messages: [{ role: 'user', content: message }] },
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
      } catch (streamError) {
        if (controller.signal.aborted) {
          console.log('[agent] v3 流被用户中止')
        } else {
          console.warn('[agent] v3 逐字流执行异常，回退 invoke：', streamError)
        }
      }

      if (controller.signal.aborted) {
        console.log(`[agent] 回复被中止，已收到 ${fullContent.length} 字符`)
        return ''
      }

      // v3 未产出文本（流异常/模型空回/兼容问题）→ 回退整段 invoke，保证回复可靠
      if (fullContent === '') {
        console.log('[agent] v3 未产出文本，回退 invoke')
        const result = await agent.invoke({
          messages: [{ role: 'user', content: message }]
        })
        fullContent = this.lastTextOf(result)
        if (fullContent === '') {
          throw new Error('模型返回了空回复。请检查模型配置/接口是否兼容，或换个模型重试。')
        }
        onChunk(fullContent)
      }

      console.log(`[agent] 回复完成，共 ${fullContent.length} 字符`)
      return fullContent
    } catch (error) {
      console.error('[agent] 回复失败：', error)
      throw error
    } finally {
      this.normalTraceEmit = null
      if (this.activeStreamAbort === controller) {
        this.activeStreamAbort = null
      }
    }
  }

  /** 用户是否已点击「停止」（当前流式中止即视为停止）。 */
  private isAgentStopped(): boolean {
    return this.activeStreamAbort?.signal.aborted === true
  }

  /** 中止当前正在进行的流式回复（若存在）。 */
  stopStreaming(): void {
    this.activeStreamAbort?.abort()
  }

  /**
   * Extract text content from a stream chunk
   */
  private extractTextFromChunk(chunk: unknown): string {
    try {
      const c = chunk as Record<string, unknown>
      const messages = c.messages as Array<Record<string, unknown>> | undefined
      if (messages && messages.length > 0) {
        const last = messages[messages.length - 1]
        const content = last.content
        if (typeof content === 'string') {
          return content
        }
        if (Array.isArray(content)) {
          return content
            .map((item) => {
              if (typeof item === 'string') return item
              if (item && typeof item === 'object' && 'text' in item) {
                return (item as { text: string }).text
              }
              return ''
            })
            .join('')
        }
      }
      return ''
    } catch {
      return ''
    }
  }
}

// Singleton instance
export const agentService = new AgentService()
