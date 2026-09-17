/**
 * 模型层全链路可观测性（OpenTelemetry）。
 *
 * ## 为什么用 OTel 而不是自研 / 某个厂商 SDK
 *
 * OTel 是 LLM 观测的行业标准协议：埋点只认「OTLP 端点」这一个出参，后端可以是本地 Langfuse
 * （开发默认，数据不出本机）、Grafana Tempo、或将来换其它 SaaS / 阿里云 ARMS —— **埋点代码
 * 一行不用改**。自研 JSONL 方案（见 git 历史 `trace.ts`）只能事后 grep，没有可视化与关联视图。
 *
 * ## 埋的是什么
 *
 * 由 `@arizeai/openinference-instrumentation-langchain`（OpenInference 语义约定）负责，
 * 通过 `manuallyInstrument(CallbackManagerModule)` 钩住 LangChain 的 `CallbackManager.configure`，
 * 因此**不需要在每个模型调用点埋桩**，Agent 主循环 / 增强子图 / 历史压缩 / 技能路由等
 * 所有走同一 `ChatOpenAI` 实例的调用都会自动成 span：
 *
 * - `LLM` span：完整的输入 messages、输出内容与 tool_calls、token 用量、耗时、报错；
 * - `TOOL` span：工具名、入参、返回、耗时、报错；
 * - `CHAIN` / `AGENT` span：LangChain Runnable 与 Agent 的嵌套结构，呈树状。
 *
 * 会话级根 span（`agent.turn`）由 `agentService.ts` 创建，把一轮对话的全部子 span 收在
 * 一棵树下。
 *
 * ## 为什么默认后端是 Langfuse 而不是 Jaeger
 *
 * Jaeger 是「微服务调用链」工具，不懂 LLM：prompt 原文塞在 attribute 里不可读、没有「会话」
 * 概念、不做 token / 成本聚合、不支持运行对比与标注。Langfuse 是**专为 LLM 应用做观测**的
 * 平台，OpenInference 的语义约定本就是喂给这类平台看的。
 *
 * ## Langfuse 接入的两个硬性约束（写错会「看起来没数据」）
 *
 * 1. **必须带 `x-langfuse-ingestion-version: 4` 请求头**：不带的话 OTLP 直采数据可能延迟
 *    长达 10 分钟才可见（Langfuse v4 的实时摄入要求）。本模块在 exporter 层强制注入，
 *    用户无需手填。
 * 2. **仅支持 OTLP over HTTP，不支持 gRPC**：故用 `exporter-trace-otlp-proto`（HTTP/protobuf），
 *    端点形如 `http://localhost:3000/api/public/otel`（**不带** `/v1/traces` 后缀）。
 *
 * 认证为 HTTP Basic：`base64(public_key:secret_key)`，见 {@link buildLangfuseHeaders}。
 *
 * ## 会话元数据要打在哪
 *
 * Langfuse 只把 `langfuse.trace.metadata.*` / `langfuse.observation.metadata.*` 映射为**可过滤**
 * 字段；未映射的 OTel 属性会落进 `metadata.attributes`，**不可查询**。因此根 span 上的会话
 * 标识除了保留 OTel 约定属性，还会同步打一份 `langfuse.trace.metadata.session_id`。
 *
 * ## 高级能力（prompt 版本 / 评测 / 成本）走 SDK，不走 OTel
 *
 * Langfuse 官方明确：OTLP 直推是「已有 OTel 环境」的兼容入口，prompt 版本管理、数据集评测、
 * 分数标注应使用 **Langfuse SDK** 的显式 API。本模块只负责**自动链路观测**；需要这些能力的
 * 点位按需引入 SDK（`langfuse` 包），二者可共存、互不冲突。
 *
 * ## 开关与配置
 *
 * 三级配置，优先级从高到低（与项目其它配置一致，见 `agentService.initialize`）：
 * 1. 环境变量（开发用）：`MIMIR_OTEL_ENDPOINT` 等，见 {@link readOtelConfigFromEnv};
 * 2. 设置页「可观测性」：`settings.otel`，见 {@link readOtelConfigFromSettings};
 * 3. 都不给 → **完全不初始化 SDK**，零开销、零网络请求（默认态）。
 *
 * 配置示例：设置页「OTLP 端点」填 `http://localhost:3000/api/public/otel`，并填 Langfuse 的
 * public key / secret key；本地后端见 `docker/langfuse-compose.yml`，UI 在 `http://localhost:3000`。
 *
 * ## 数据出境口径
 *
 * 用户选择「完整上报」：span 里带**模型收到的完整原文**（含科研数据）。因此本模块
 * **默认端点指向 localhost**，且代码里不做任何截断/脱敏 —— 是否出境取决于用户填的端点，
 * 这是产品层面的责任边界，不是这里的技术边界（见 DEVELOPMENT.md「可观测性」）。
 *
 * ## 生命周期
 *
 * `NodeSDK` 的 batch span processor 是**异步批量上报**：必须在进程退出前 `shutdown()`
 * 把缓冲里的 span 刷出去，否则最后若干条 trace 会丢。由 `main.ts` 的 shutdown 链调用
 * {@link shutdownOtel}（见那里的超时约定）。
 */
import { NodeSDK } from '@opentelemetry/sdk-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME
} from '@opentelemetry/semantic-conventions/incubating'
import { SpanStatusCode, context, trace, type Span, type Tracer } from '@opentelemetry/api'
import { LangChainInstrumentation } from '@arizeai/openinference-instrumentation-langchain'
import * as CallbackManagerModule from '@langchain/core/callbacks/manager'
import { getStoreValue } from '../library/store'
import { agentLog } from '../logger'

/** OTel 配置（设置页 `settings.otel` 的规范化结果）。 */
export interface OtelConfig {
  /** OTLP/HTTP traces 端点，如 `http://localhost:3000/api/public/otel`。空串 = 不启用。 */
  endpoint: string
  /**
   * 附加到 OTLP 请求的头（多行 `key: value`），供需要鉴权的后端使用。
   *
   * Langfuse 场景无需用户手写：填了 {@link OtelConfig.publicKey} / {@link OtelConfig.secretKey}
   * 后由 {@link buildLangfuseHeaders} 自动生成 `Authorization`（用户手填的同名头优先级更低）。
   */
  headers: Record<string, string>
  /** Langfuse public key（`pk-lf-...`）。为空表示后端不需要 Basic 认证。 */
  publicKey: string
  /** Langfuse secret key（`sk-lf-...`）。 */
  secretKey: string
  /** 服务名（Langfuse「Service Name」维度里显示的值）。 */
  serviceName: string
  /** 环境标识（span 属性 `deployment.environment.name`）。 */
  environment: string
  /**
   * 是否记录完整原文。
   *
   * 用户口径是「完整上报」，故缺省 `true`。保留这个开关只为将来切到云后端时能一键降级，
   * 当前 UI 未暴露（见上方「数据出境口径」）。
   */
  captureContent: boolean
}

const DEFAULT_SERVICE_NAME = 'mimir-desktop'
/** Langfuse 自托管的默认 OTLP 端点（注意：不带 `/v1/traces` 后缀）。 */
const DEFAULT_ENDPOINT = 'http://localhost:3000/api/public/otel'
/** Langfuse v4 要求携带此头，否则 OTLP 直采数据延迟可达 10 分钟才可见。 */
const LANGFUSE_INGESTION_VERSION_HEADER = 'x-langfuse-ingestion-version'
const LANGFUSE_INGESTION_VERSION = '4'

/** SDK 单例：`null` = 未启用或已关闭。 */
let sdk: NodeSDK | null = null
/** 当前生效的配置；未初始化时为 `null`。 */
let activeConfig: OtelConfig | null = null
/** 幂等保护：`initializeOtel` 在同配置下重复调用直接返回。 */
let initializing = false

/** 把「多行 key: value」解析成 OTLP headers 对象（用于自建后端鉴权）。 */
function parseHeaders(raw: unknown): Record<string, string> {
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (key !== '' && value !== '') out[key] = value
  }
  return out
}

/** 从环境变量读配置（开发调试用；未设 `MIMIR_OTEL_ENDPOINT` 时返回 null 表示「不启用」）。 */
export function readOtelConfigFromEnv(): OtelConfig | null {
  const endpoint = (process.env.MIMIR_OTEL_ENDPOINT ?? '').trim()
  if (endpoint === '') return null
  return {
    endpoint,
    headers: parseHeaders(process.env.MIMIR_OTEL_HEADERS),
    publicKey: (process.env.MIMIR_OTEL_PUBLIC_KEY ?? '').trim(),
    secretKey: (process.env.MIMIR_OTEL_SECRET_KEY ?? '').trim(),
    serviceName: (process.env.MIMIR_OTEL_SERVICE_NAME ?? '').trim() || DEFAULT_SERVICE_NAME,
    environment: (process.env.MIMIR_OTEL_ENVIRONMENT ?? '').trim() || (process.env.NODE_ENV ?? 'development'),
    captureContent: process.env.MIMIR_OTEL_CAPTURE_CONTENT !== 'false'
  }
}

/**
 * 组装最终发给后端的请求头。
 *
 * Langfuse 的认证是 HTTP Basic：`Authorization: Basic base64(public_key:secret_key)`。
 * 由本函数用配置里的 key **自动生成**，不让用户在设置页手写 base64（易错且难排查）。
 * 同时强制注入 {@link LANGFUSE_INGESTION_VERSION_HEADER} —— 缺它会让 OTLP 直采数据延迟
 * 最多 10 分钟才可见。
 *
 * 用户手填的 `headers` 优先级更低：同名 key 以自动生成的为准。
 */
export function buildLangfuseHeaders(config: OtelConfig): Record<string, string> {
  const headers: Record<string, string> = { ...config.headers }
  if (config.publicKey !== '' && config.secretKey !== '') {
    const auth = Buffer.from(`${config.publicKey}:${config.secretKey}`, 'utf8').toString('base64')
    headers['Authorization'] = `Basic ${auth}`
    // 只在确实带鉴权时注入版本头：无鉴权时填了也没用，还会误导自建后端。
    headers[LANGFUSE_INGESTION_VERSION_HEADER] = LANGFUSE_INGESTION_VERSION
  }
  return headers
}

/**
 * 从设置读配置（设置页「可观测性」）。
 *
 * 只有用户**显式填了端点**才启用：`settings.otel.enabled` 为 true 但端点为空的中间态
 * 一律视为未配置 —— 避免在没告诉用户的情况下把 span 发去默认地址。
 */
export function readOtelConfigFromSettings(): OtelConfig | null {
  let raw: unknown = null
  try {
    const settings = getStoreValue<Record<string, unknown>>('settings') ?? {}
    raw = settings.otel
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const cfg = raw as Record<string, unknown>
  if (cfg.enabled !== true) return null
  const endpoint = (typeof cfg.endpoint === 'string' ? cfg.endpoint : '').trim()
  if (endpoint === '') return null
  return {
    endpoint,
    headers: parseHeaders(cfg.headers),
    publicKey: (typeof cfg.publicKey === 'string' ? cfg.publicKey : '').trim(),
    secretKey: (typeof cfg.secretKey === 'string' ? cfg.secretKey : '').trim(),
    serviceName: (typeof cfg.serviceName === 'string' ? cfg.serviceName : '').trim() || DEFAULT_SERVICE_NAME,
    environment: (typeof cfg.environment === 'string' ? cfg.environment : '').trim() || 'development',
    // 设置页未暴露该开关时按「完整上报」处理（用户已确认的口径）。
    captureContent: cfg.captureContent !== false
  }
}

/** 环境变量优先于设置页（与 `agentTraceLevel` 的既有优先级一致）。 */
export function resolveOtelConfig(): OtelConfig | null {
  return readOtelConfigFromEnv() ?? readOtelConfigFromSettings()
}

/** 当前生效的配置（未启用为 null）；供设置页/诊断展示。 */
export function getActiveOtelConfig(): OtelConfig | null {
  return activeConfig
}

/** OTel 是否已启用（决定是否创建会话级 span）。 */
export function isOtelEnabled(): boolean {
  return sdk !== null
}

/**
 * 初始化 OTel SDK 并挂载 LangChain 插桩。
 *
 * 幂等：同配置重复调用直接返回；配置从「有」变「无」会先 {@link shutdownOtel}。
 * 任何失败都被吞掉并记日志 —— 观测是增益，绝不能因后端不可达而阻断 Agent 主流程。
 *
 * @returns 是否处于启用状态
 */
export async function initializeOtel(config: OtelConfig | null): Promise<boolean> {
  if (config === null) {
    await shutdownOtel()
    activeConfig = null
    return false
  }
  if (sdk !== null && activeConfig !== null && activeConfig.endpoint === config.endpoint) {
    return true
  }
  if (initializing) return sdk !== null
  initializing = true
  try {
    // 换端点/改配置：先关旧的，避免两套上报并行。
    await shutdownOtel()

    const exporterHeaders = buildLangfuseHeaders(config)
    const exporter = new OTLPTraceExporter({
      url: config.endpoint,
      ...(Object.keys(exporterHeaders).length > 0 ? { headers: exporterHeaders } : {})
    })

    const instance = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: config.serviceName,
        [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '0.0.0',
        [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.environment
      }),
      traceExporter: exporter,
      // 不开自动插桩（默认会去 require http/fs 等模块）：我们只显式挂 LangChain。
      // 少一层 `require-in-the-middle` 的模块钩子，Electron 打包后行为更可预期。
      instrumentations: []
    })

    instance.start()

    // OpenInference 的 LangChain 插桩必须**手动**挂：`@langchain/core` 的包结构不走
    // 标准模块导出，`registerInstrumentations` 的自动探测找不到它（官方 README 明确说明）。
    const instrumentation = new LangChainInstrumentation({
      tracerProvider: trace.getTracerProvider()
    })
    instrumentation.manuallyInstrument(CallbackManagerModule)

    sdk = instance
    activeConfig = config
    const authed = config.publicKey !== '' && config.secretKey !== ''
    agentLog.info(
      `[otel] 可观测性已启用：endpoint=${config.endpoint} service=${config.serviceName} env=${config.environment} ` +
        `fullContent=${String(config.captureContent)} auth=${authed ? 'basic' : 'none'}` +
        `（Langfuse UI 见 ${new URL(config.endpoint).origin}）`
    )
    return true
  } catch (error) {
    agentLog.error('[otel] 初始化失败，已降级为不观测（不影响 Agent 主流程）：', error)
    sdk = null
    activeConfig = null
    return false
  } finally {
    initializing = false
  }
}

/**
 * 按当前环境变量 / 设置页配置初始化（启动时与「重新初始化 Agent」时调用）。
 *
 * @returns 是否处于启用状态
 */
export async function initializeOtelFromCurrentConfig(): Promise<boolean> {
  let config: OtelConfig | null = null
  try {
    config = resolveOtelConfig()
  } catch (error) {
    agentLog.warn('[otel] 读取配置失败，按未启用处理：', error)
  }
  return initializeOtel(config)
}

/**
 * 刷新 SDK 并返回一个 Tracer（未启用时返回 null）。
 *
 * 供 `agentService` 每轮对话取 tracer 创建根 span。
 */
export function getTracer(name = 'mimir-agent'): Tracer | null {
  if (sdk === null) return null
  return trace.getTracer(name)
}

/**
 * 退出前把缓冲的 span 刷出去。
 *
 * batch processor 是异步的，不调用这里会丢最后若干条 trace。`main.ts` 的 shutdown 链
 * 已带整体超时（3s），这里不再自带超时，避免与上层超时打架。
 */
export async function shutdownOtel(): Promise<void> {
  const instance = sdk
  if (instance === null) return
  sdk = null
  activeConfig = null
  try {
    await instance.shutdown()
    agentLog.info('[otel] 已停止上报并 flush 缓冲 span。')
  } catch (error) {
    agentLog.warn('[otel] 关闭失败（缓冲 span 可能丢失）：', error)
  }
}

// ─── 会话级根 span ───────────────────────────────────────────────────────────
//
// 一轮对话 = 一棵 span 树。`agentService.runConversation` 在最外层开根 span，
// 其后所有 LangChain span（模型/工具/子图）自动成为它的子节点 —— 因为插桩拿到的是
// **当前 OTel 上下文**里的 active span，而 context 随 async 调用链传播。

/** 一轮对话的根 span 句柄；由 {@link startAgentTurnSpan} 返回、{@link endAgentTurnSpan} 收尾。 */
export interface AgentTurnSpan {
  span: Span
}

/**
 * 开启一轮对话的根 span。
 *
 * 未启用 OTel 时返回 null（调用方据此跳过，零开销）。
 *
 * @param input 用户本轮输入原文（完整上报口径下直接入 span 属性）
 * @param conversationId 会话标识，同时作为 `session.id` 与 `langfuse.trace.metadata.session_id`，
 *   便于在 Langfuse 里按会话过滤全部轮次
 * @param attributes 额外属性（模型名、是否 Ultra、是否手动触发等）
 */
export function startAgentTurnSpan(
  input: string,
  conversationId: string,
  attributes: Record<string, string | number | boolean> = {}
): AgentTurnSpan | null {
  const tracer = getTracer('mimir-agent.turn')
  if (tracer === null) return null
  try {
    const span = tracer.startSpan('agent.turn', {
      attributes: {
        // OTel 通用约定：任何后端都能识别。
        'session.id': conversationId,
        'user.input': input,
        // Langfuse 专属：只有 `langfuse.trace.metadata.*` 会被映射为**可过滤/可聚合**的顶层
        // metadata；不映射的属性会落进不可查询的 `metadata.attributes`。
        'langfuse.trace.metadata.session_id': conversationId,
        'langfuse.trace.name': 'agent.turn',
        ...attributes
      }
    })
    // 设为 active span：此后 async 链里的 LangChain 插桩会把子 span 挂到它下面。
    return { span }
  } catch (error) {
    agentLog.warn('[otel] 创建会话根 span 失败（本轮不上报）：', error)
    return null
  }
}

/** 正常结束一轮对话的根 span。 */
export function endAgentTurnSpan(turn: AgentTurnSpan | null, output: string): void {
  if (turn === null) return
  try {
    turn.span.setAttribute('agent.output', output)
    turn.span.setStatus({ code: SpanStatusCode.OK })
    turn.span.end()
  } catch {
    // span 收尾失败不影响主流程
  }
}

/** 异常结束一轮对话的根 span（记录错误信息，便于在后端里筛失败轮次）。 */
export function failAgentTurnSpan(turn: AgentTurnSpan | null, error: unknown): void {
  if (turn === null) return
  try {
    const message = error instanceof Error ? error.message : String(error)
    turn.span.setStatus({ code: SpanStatusCode.ERROR, message })
    turn.span.recordException(error instanceof Error ? error : new Error(message))
    turn.span.end()
  } catch {
    // 同上
  }
}

/**
 * 在根 span 的上下文里执行一段异步逻辑。
 *
 * 必须用它包住整轮对话：LangChain 插桩创建子 span 时读的是**当前上下文里的 active span**，
 * 只有 `context.with(trace.setSpan(...))` 才能让 async 链上的下游正确识别父子关系
 * （直接 `span.end()` 只能结束自身，不会建立父子结构）。
 */
export function withAgentTurnContext<T>(turn: AgentTurnSpan | null, fn: () => Promise<T>): Promise<T> {
  if (turn === null) return fn()
  return context.with(trace.setSpan(context.active(), turn.span), fn)
}
