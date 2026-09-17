/**
 * 真实 Agent 执行器（评测集与真实模型的**唯一**接线处）。
 *
 * ⚠️ 未验证声明（项目规则：未验证的 mock/接线必须写文档记录）：
 * 本文件在**没有网关凭据**的环境下无法运行，因此它的行为**尚未在 CI 中验证**。
 * 它默认被 `--real-agent` 显式开启；无凭据时 {@link hasGatewayCredentials} 返回 false，
 * CLI 会**跳过并打印提示（退出码 2）**，绝不静默退化成 mock——
 * mock 成功率恒 100%，退化成 mock 会把评测结论变成假的。
 * 复现命令见 `test/eval/README.md` 的「接入真实 Agent」一节。
 *
 * ── 装配范式 ────────────────────────────────────────────────────────────────
 * 照抄 `test/smoke/liveAgent.test.ts` 的既有范式：不依赖 electron 的 `app.getPath`，
 * 自己 `new ChatOpenAI` + `createDeepAgent` + `MimirFsBackend` 组装一个真实 Agent 实例。
 * **不修改任何 `electron/` / `src/` 下的文件，只 import。**
 *
 * ── 四项指标的采集点 ────────────────────────────────────────────────────────
 * 1. 工具调用序列 → {@link ToolCallTraceHandler} 挂在 model 的 callbacks 上，
 *    用 LangChain 的 tool start/end/error 事件捕获（能覆盖 deepagents 主循环内部发起的调用，
 *    以及内置文件工具 read_file/write_file/ls/glob/grep——它们不在 WORKER_TOOL_CATALOG 里，
 *    必须一并映射，否则 file-02/file-03 的约束会误判）；
 * 2. token 消耗   → 同一个 handler 的 `handleLLMEnd`，累加 `llmOutput.tokenUsage`
 *    （读法与 `electron/agent/trace.ts` 的 `summarizeOutput()` 一致，但不在那边增强）；
 * 3. 人工干预次数 → `installAutoApprover()`：`setApprovalSender` + 自动批准，
 *    计数即 `approvalCount`。**不自动批准会在无 GUI 下卡死到超时**；
 * 4. 延迟 / 最终输出 → `performance.now()` 包住 `agent.invoke(...)`；
 *    最终文本取最后一条非空 AI 消息；产物用 `extractArtifacts()` 从工具返回里观测。
 */
import { BaseCallbackHandler } from '@langchain/core/callbacks/base'
import type { LLMResult } from '@langchain/core/outputs'
import type { EvalCase } from './cases.ts'
import type { ApprovalRequest } from '../../electron/agent/approval'
import type { UltraStrategyPick } from '../../electron/agent/ultra'
import type { EvalRun, TokenUsage, ToolCallRecord } from './metrics.ts'

// ── 关于 import 方式（重要，别改回静态 import）───────────────────────────────
// `approval` / `artifactExtract` / `capabilityDomains` / `fsBackend` 是 electron 侧模块，
// 依赖链里有 `electron`、`electron-store` 这类只有 Electron 运行时或 vitest 别名才解析得了的东西。
//
// - 在 **vitest** 里：vitest.config.ts 的 alias 会兜住，用普通静态 import 也没问题。
// - 在 **CLI（node --experimental-strip-types）** 里：`electron/library/store` 这种
//   **无扩展名**导入 Node 原生解析不了（ERR_MODULE_NOT_FOUND），会直接崩在启动阶段。
//
// 因此这里全部改成**惰性 import**：只有 `--real-agent` 真的走到装配那一步才加载。
// 纯对话 / mock 跑评测不会碰这条依赖链，CLI 也不依赖 electron 侧的 tsx 打包器。
// 下面的具名 type-only import 不产生运行时代码，安全。
type ApprovalModule = typeof import('../../electron/agent/approval')
type ArtifactModule = typeof import('../../electron/agent/artifactExtract')
type CapabilityModule = typeof import('../../electron/agent/capabilityDomains')
type FsBackendModule = typeof import('../../electron/agent/fsBackend')

/** 网关凭据（沿用 `liveAgent.test.ts` 的同一套环境变量约定，不自创）。 */
export interface GatewayConfig {
  baseUrl: string
  apiKey: string
  model: string
}

/**
 * 从环境变量解析网关配置。
 * 三个变量必须齐备才返回配置，否则返回 null（调用方据此走「跳过」分支）。
 */
export function resolveGateway(env: NodeJS.ProcessEnv = process.env): GatewayConfig | null {
  const url = env.MIMIR_GW_URL
  const key = env.MIMIR_GW_KEY
  const model = env.MIMIR_GW_MODEL
  if (url && key && model) return { baseUrl: url, apiKey: key, model }
  return null
}

/** 是否具备跑真实 Agent 的凭据（无凭据时必须跳过，不能退化成 mock）。 */
export function hasGatewayCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveGateway(env) !== null
}

/**
 * 单 Agent systemPrompt 的「评测版」。
 *
 * 与生产同款：能力域章节直接复用 `buildCapabilityDomainPrompt()`，保证评测跑的就是
 * 「单 Agent + 全量工具」这套口径。只额外追加一句「直接执行、不要反问」——
 * 这是评测场景的必需约束（评测无人值守，反问会直接超时）。
 */
async function buildEvalSystemPrompt(): Promise<string> {
  const cap: CapabilityModule = await import('../../electron/agent/capabilityDomains')
  const { domains } = cap.loadCapabilityDomains()
  return [
    '你是 Mimir（科研工作台 Agent）的评测实例。你直接持有全部工具，自己决定何时使用。',
    '用户给出明确路径时直接操作，不要反问、不要要求确认，尽快给出结果。',
    '完成后用中文简短说明你做了什么。',
    '',
    cap.buildCapabilityDomainPrompt(domains)
  ].join('\n')
}

/**
 * 从 LLMResult 提取模型发出的 tool_calls（真实工具名 + 参数）。
 *
 * 与 `electron/agent/trace.ts` 的 `summarizeOutput()` 用同一套提取方式（两处口径一致），
 * 同时兼容 OpenAI 原生形态（`message.tool_calls[].name/args`）与 chat-completions 形态
 * （`additional_kwargs.tool_calls[].function.name/arguments`）。
 */
function extractToolCalls(output: LLMResult): ToolCallRecord[] {
  const gen = output.generations?.[0]?.[0] as
    | {
        message?: {
          tool_calls?: unknown[]
          additional_kwargs?: { tool_calls?: unknown[] }
        }
      }
    | undefined
  const msg = gen?.message
  const raw: unknown[] = Array.isArray(msg?.tool_calls)
    ? msg.tool_calls
    : Array.isArray(msg?.additional_kwargs?.tool_calls)
      ? msg.additional_kwargs.tool_calls
      : []
  const out: ToolCallRecord[] = []
  for (const item of raw) {
    const rec = item as {
      name?: unknown
      args?: unknown
      function?: { name?: unknown; arguments?: unknown }
    }
    const name =
      typeof rec.name === 'string' && rec.name !== ''
        ? rec.name
        : typeof rec.function?.name === 'string'
          ? rec.function.name
          : ''
    if (name === '') continue
    let args = rec.args
    if (args === undefined && typeof rec.function?.arguments === 'string') {
      try {
        args = JSON.parse(rec.function.arguments)
      } catch {
        args = rec.function.arguments // 非 JSON 原样保留，仅供人工排查
      }
    }
    out.push({ name, args })
  }
  return out
}

/**
 * 工具调用追踪 handler：同时采集「调用序列」与「token 用量」。
 *
 * ⚠️ **工具名与参数取自模型返回的 `tool_calls`，不取自 `handleToolStart` 的首参。**
 *
 * 踩过的坑（2026-09 实测）：LangChain JS 传给 `handleToolStart` 的第一个参数不是工具实例，
 * 而是不含 `name` 的 Serialized 包装 —— 于是 `tool?.name` 恒为 `undefined`，采集到的名字
 * 全是 `"(?)"`。后果是所有 `mustCallTools` 用例**假失败**，且现象极具误导性：报告显示
 * 「模型没调工具」，而消息序列里明明有 `[tool]` 返回（`electron/agent/trace.ts` 的
 * `handleToolStart` 也踩了同一处，见其 `tool?.name ?? '(?)'`）。
 *
 * 因此，本 handler 里 `handleToolStart` 只负责记「开始时刻」用于补耗时，名字来源唯一。
 */
export class ToolCallTraceHandler extends BaseCallbackHandler {
  name = 'mimir-eval-toolcall-trace'

  /** 按调用顺序记录的工具调用。 */
  readonly toolCalls: ToolCallRecord[] = []
  /** 累计 token（跨多次模型调用）。 */
  readonly usage: Required<TokenUsage> = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  /** 工具返回的原始文本，用于观测产物（extractArtifacts）。 */
  private readonly toolOutputs: unknown[] = []

  /** runId → 工具开始时刻（名字不在这里取，见类注释）。 */
  private readonly started = new Map<string, { t0: number }>()

  /** 模型返回：累加 token 用量 + 记录本轮模型发出的工具调用。 */
  async handleLLMEnd(output: LLMResult): Promise<void> {
    const usage = (output.llmOutput as { tokenUsage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } } | undefined)
      ?.tokenUsage
    if (usage !== undefined) {
      this.usage.inputTokens += num(usage.promptTokens)
      this.usage.outputTokens += num(usage.completionTokens)
      this.usage.totalTokens +=
        typeof usage.totalTokens === 'number'
          ? usage.totalTokens
          : num(usage.promptTokens) + num(usage.completionTokens)
    }
    for (const call of extractToolCalls(output)) this.toolCalls.push(call)
  }

  /** 工具开始：只记时刻（名字已在 handleLLMEnd 里记录）。 */
  async handleToolStart(_tool: unknown, _input: string, runId: string): Promise<void> {
    this.started.set(runId, { t0: performance.now() })
  }

  async handleToolEnd(output: unknown, runId: string): Promise<void> {
    this.finish(runId)
    this.toolOutputs.push(output)
  }

  async handleToolError(err: Error, runId: string): Promise<void> {
    const call = this.finish(runId)
    if (call !== undefined) call.error = true
    this.toolOutputs.push(`[tool error] ${err.message}`)
  }

  /**
   * 给「最早一条还没记过耗时的调用」补耗时（工具按序执行，用 FIFO 配对），返回该记录。
   * 配不上的情况（例如工具被中间件拦下、事件顺序异常）静默忽略：耗时只是展示项，不影响判定。
   */
  private finish(runId: string): ToolCallRecord | undefined {
    const rec = this.started.get(runId)
    this.started.delete(runId)
    if (rec === undefined) return undefined
    const call = this.oldestWithoutDuration()
    if (call !== undefined) call.durationMs = Math.round(performance.now() - rec.t0)
    return call
  }

  private oldestWithoutDuration(): ToolCallRecord | undefined {
    for (const c of this.toolCalls) {
      if (c.durationMs === undefined && c.error === undefined) return c
    }
    return undefined
  }

  /**
   * 从各工具返回文本里观测落盘产物（**observed-only**，见 `EvalRun.artifacts` 注释）。
   * 解析器是 electron 侧的纯函数 `extractArtifacts`，此处惰性加载走既有实现，不自研。
   */
  async observedArtifacts(): Promise<string[]> {
    const { extractArtifacts }: ArtifactModule = await import('../../electron/agent/artifactExtract')
    const paths = new Set<string>()
    for (const out of this.toolOutputs) {
      for (const ref of extractArtifacts(out)) paths.add(ref.path)
    }
    return [...paths]
  }
}

/**
 * 把可能是脏数据（缺失 / 非数字 / NaN / Infinity / 负数）的 token 数归一为非负有限值。
 * 负数归零与 `metrics.ts` 里 `sumTokens`/`latencyMs` 的兜底口径保持一致。
 */
function num(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * 自动批准器：记录收到的批准请求（即人工干预次数），并立即放行。
 *
 * ⚠️ 不自动批准会在无 GUI 环境下**卡死到超时**——这是 `liveAgent.test.ts` 的既有做法，
 * 必须保留。评测是无人值守的，卡死的成本是整轮评测作废。
 */
export async function installAutoApprover(): Promise<{ seen: ApprovalRequest[] }> {
  const { setApprovalSender, settleApproval }: ApprovalModule = await import('../../electron/agent/approval')
  const seen: ApprovalRequest[] = []
  setApprovalSender((req: ApprovalRequest) => {
    seen.push(req)
    queueMicrotask(() => settleApproval(req.id, true))
  })
  return { seen }
}

/** Agent 的最小可调用面（避免 import deepagents 的内部类型）。 */
export interface InvokableAgent {
  /**
   * @param config LangGraph 运行配置。
   *
   * ⚠️ **工具事件的 callback 必须在这一层传**，不能挂在模型构造参数上：
   * 模型构造期传入的 callback 只能收到 LLM 事件（token 能统计到），**收不到工具事件** ——
   * 工具事件由工具节点在「运行配置」的回调树上发出，构造期回调不在那棵树上。
   *
   * 这个坑的实际后果（2026-09 实测）：`server_status` 明明被调用、消息序列里也有
   * `[tool]` 返回，但 `toolCalls` 为空 → 所有 `mustCallTools` 用例被**误判为失败**，
   * 评测结论整体失真（且看起来像「模型不会调工具」）。
   */
  invoke(
    input: { messages: { role: string; content: string }[] },
    config?: { callbacks?: unknown[]; signal?: AbortSignal }
  ): Promise<{ messages: unknown[] }>
}

/** 真实 Agent 的装配物：agent 实例 + 本轮 trace handler（每轮必须新建一个）。 */
export interface RealAgentBundle {
  agent: InvokableAgent
  trace: ToolCallTraceHandler
  approver: { seen: ApprovalRequest[] }
  /** Ultra 增强控制器（未启用时为 null）。 */
  ultra: UltraControllerInstance | null
}

/** 真实执行器的可选开关。 */
export interface RealRunnerOptions {
  /**
   * Ultra 增强层（可选）：开启后每轮先用 `electron/agent/ultra.ts` 产出「内部参考约束」，
   * 再拼进用户消息交给同一个 Agent —— 与生产 `agentService.streamMessage` 完全同一条路径，
   * 因此跑出来的差异就是 Ultra 的真实贡献。
   */
  ultra?: { enabled: boolean; strategy?: UltraStrategyPick }
}

type UltraModule = typeof import('../../electron/agent/ultra')
type UltraControllerInstance = InstanceType<UltraModule['UltraController']>

/**
 * 装配一个真实 Agent 实例（每轮新建：trace handler 与批准器都是「有状态」的）。
 *
 * 用 `resolveAllWorkerTools()` 取单 Agent 的全量工具；内置文件工具由
 * `MimirFsBackend` 提供，其调用由 trace handler 捕获后一并计入 toolCalls。
 *
 * 注：`ChatOpenAI` / `createDeepAgent` / `MimirFsBackend` 都在这里惰性加载，
 * 使本模块在不跑真实 Agent 时可被安全 import（CLI 启动阶段不会碰 electron 依赖链）。
 */
export async function buildRealAgent(
  cfg: GatewayConfig,
  opts: RealRunnerOptions = {}
): Promise<RealAgentBundle> {
  const [{ ChatOpenAI }, { createDeepAgent }, cap, fs, approval] = await Promise.all([
    import('@langchain/openai'),
    import('deepagents'),
    import('../../electron/agent/capabilityDomains') as Promise<CapabilityModule>,
    import('../../electron/agent/fsBackend') as Promise<FsBackendModule>,
    import('../../electron/agent/approval') as Promise<ApprovalModule>
  ])

  const trace = new ToolCallTraceHandler()
  // 注意：这里**不**把 trace 挂在模型构造参数上。
  // - 主 Agent 的 callback 在 `agent.invoke(..., { callbacks: [trace] })` 处统一挂载，
  //   这样 LLM 事件与工具事件走同一棵回调树（构造期回调收不到工具事件，见 InvokableAgent）；
  // - 若两处都挂同一个 handler，LLM 事件会被统计两次，token 直接翻倍。
  const model = new ChatOpenAI({
    apiKey: cfg.apiKey,
    model: cfg.model,
    temperature: 0,
    configuration: { baseURL: cfg.baseUrl }
  })
  // 与生产装配（agentService.ts）对齐：注册能力域子代理，deepagents 会据此注入
  // `task` 委派工具并校验 subagent_type。若不传 subagents，deepagents 仍会注入一个
  // 只含默认 `general-purpose` 的 task 工具——模型一旦选择委派（如跨域用例委派给
  // `literature`），库会直接抛 "invoked agent of type ... only allowed types are
  // `general-purpose`" 导致整条运行失败（cross-01 实测踩中此坑）。
  const { domains } = cap.loadCapabilityDomains()
  const agent = createDeepAgent({
    model,
    systemPrompt: await buildEvalSystemPrompt(),
    // 主 Agent 持有全部能力域工具（16 个），同时可把整块工作委派给能力域子代理。
    tools: cap.resolveAllWorkerTools() as never,
    subagents: cap.buildDomainSubagents(domains) as never,
    backend: new fs.MimirFsBackend() as never
  })

  // 批准器内联装配（installAutoApprover 已在上面 import 了 approval 模块，
  // 这里直接复用同一份模块实例，避免重复 import）。
  const seen: ApprovalRequest[] = []
  approval.setApprovalSender((req: ApprovalRequest) => {
    seen.push(req)
    queueMicrotask(() => approval.settleApproval(req.id, true))
  })

  // ── Ultra 增强层（可选）─────────────────────────────────────────────────
  // 复用生产同一份实现（electron/agent/ultra.ts），不在评测侧另写一遍。
  //
  // ⚠️ 公平性关键点：Ultra 的判定/候选模型**也要挂同一个 trace handler**。
  // 否则 Ultra 那几次额外模型调用产生的 token 不会被计入，candidate 版的成本
  // 会被系统性低估 —— 而「token 涨了几倍」正是决定 Ultra 生死的那一个数。
  let ultra: UltraControllerInstance | null = null
  if (opts.ultra?.enabled === true) {
    const ultraMod: UltraModule = await import('../../electron/agent/ultra')
    const mkModel = (temperature: number): InstanceType<typeof ChatOpenAI> =>
      new ChatOpenAI({
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature,
        configuration: { baseURL: cfg.baseUrl },
        callbacks: [trace]
      })
    ultra = new ultraMod.UltraController({
      judgeModel: mkModel(0.3),
      candidateModel: mkModel(0.9),
      // 评测无人值守：子图过程事件不外发、不打日志；策略结论由 run() 返回值带出。
      emit: () => {},
      log: () => {}
    })
  }

  return { agent: agent as never as InvokableAgent, trace, approver: { seen }, ultra }
}

/** 从消息数组里取最后一条有文本的 assistant 消息。 */
export function lastAssistantText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as { content?: unknown; _getType?: () => string; type?: string } | undefined
    if (m === undefined) continue
    const type = typeof m._getType === 'function' ? m._getType() : m.type
    if (type !== undefined && type !== 'ai' && type !== 'assistant') continue
    const text = typeof m.content === 'string' ? m.content : m.content === undefined ? '' : JSON.stringify(m.content)
    if (text.trim() !== '') return text
  }
  return ''
}

/** 把 agent 的消息序列拍平成 EvalRun.messages（只保留 role + 文本）。 */
export function flattenMessages(messages: readonly unknown[]): EvalRun['messages'] {
  const out: EvalRun['messages'] = []
  for (const raw of messages) {
    const m = raw as {
      _getType?: () => string
      type?: string
      content?: unknown
      name?: string
    }
    const type = typeof m._getType === 'function' ? m._getType() : (m.type ?? 'assistant')
    const role: EvalRun['messages'][number]['role'] =
      type === 'human' || type === 'user'
        ? 'user'
        : type === 'system'
          ? 'system'
          : type === 'tool'
            ? 'tool'
            : 'assistant'
    const content = typeof m.content === 'string' ? m.content : m.content === undefined ? '' : JSON.stringify(m.content)
    out.push({ role, content })
  }
  return out
}

/**
 * 构造真实 Agent 的 {@link CaseRunner}。
 *
 * 每跑一条用例都重新装配 Agent（隔离上下文，避免用例间互相污染）。
 *
 * 耗时口径：`durationMs` 覆盖「Ultra 增强 + Agent 主循环」，即用户真实感知的一轮时长。
 * 若只包住 `agent.invoke` 而把 Ultra 排除在外，开启增强的版本会被系统性低估延迟，
 * A/B 的延迟对比就失去意义。
 *
 * @param opts.ultra 开启后每轮先跑 Ultra 增强，产出「内部参考约束」拼进用户消息
 *   （与生产 `agentService.streamMessage` 同一条路径）。
 */
export function createRealRunner(
  cfg: GatewayConfig,
  opts: RealRunnerOptions = {}
): (c: EvalCase, observe?: (patch: Partial<EvalRun>) => void, signal?: AbortSignal) => Promise<EvalRun> {
  const manual =
    opts.ultra?.strategy !== undefined && opts.ultra.strategy !== 'auto' ? opts.ultra.strategy : undefined
  return async (
    c: EvalCase,
    observe?: (patch: Partial<EvalRun>) => void,
    signal?: AbortSignal
  ): Promise<EvalRun> => {
    const { agent, trace, approver, ultra } = await buildRealAgent(cfg, opts)
    const started = performance.now()
    // 用例取消信号（由 runEval 在超时时 abort）。必须一路透传，否则超时后底层仍在跑。
    const caseSignal = signal ?? new AbortController().signal

    // Ultra 增强（可选）：评测是单轮无历史场景，historyTokens 恒为 0。
    let input = c.input
    let ultraStrategy: string | undefined
    if (ultra !== null) {
      const r = await ultra.run({
        message: c.input,
        signal: caseSignal,
        historyTokens: 0,
        manual,
        routerMeta: null
      })
      if (r.output !== '') input = `${c.input}\n\n${r.output}`
      if (r.strategy !== null) {
        ultraStrategy = r.strategy
        // 先登记：agent 主循环若超时，报告仍能显示「这一轮用的是哪个增强策略」。
        observe?.({ ultraStrategy: r.strategy })
      }
    }

    // callbacks 挂在这里（运行配置），才能同时收到 LLM 事件与工具事件；
    // signal 也在这里传，超时才能真正中断图执行（而不是只 reject 外层 promise）。
    const res = await agent.invoke(
      { messages: [{ role: 'user', content: input }] },
      { callbacks: [trace], signal: caseSignal }
    )
    const durationMs = Math.round(performance.now() - started)

    return {
      caseId: c.id,
      messages: flattenMessages(res.messages),
      toolCalls: trace.toolCalls,
      usage: { ...trace.usage },
      durationMs,
      // 批准卡被触发几次即人工干预几次（自动批准只是为了不卡死，不代表没人干预）。
      approvalCount: approver.seen.length,
      finalOutput: lastAssistantText(res.messages),
      artifacts: await trace.observedArtifacts(),
      // 记录实际策略：报告里若两版都是空/`-`，说明增强没接上，A/B 结论无效。
      ...(ultraStrategy !== undefined ? { ultraStrategy } : {})
    }
  }
}
