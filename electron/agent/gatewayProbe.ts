/**
 * 网关能力探测（Gateway Capability Probe）。
 *
 * 背景（真实踩坑）：LangChain v1 的 `withStructuredOutput()` **默认优先选择 `json_schema`**，
 * 而绝大多数「OpenAI 兼容」第三方网关（aipy、DeepSeek 网关、各类聚合中转）并未实现该能力，
 * 会直接返回：
 *   400 "This response_format type is unavailable now ... type:invalid_request_error"
 * 结果是「代码没错、配置没错，一跑到结构化输出就炸」，且只在使用时才暴露。
 *
 * 解决思路：把「网关到底支持哪条结构化输出通道」变成**可探测、可缓存的事实**，
 * 而不是靠人肉踩坑。探测一次后按结果选择 `withStructuredOutput` 的 method，换网关/换模型自动适配。
 *
 * 探测三条通道（用最小请求，成本可忽略）：
 *   1. response_format = json_schema  → OpenAI 原生结构化输出
 *   2. response_format = json_object  → 老式 JSON mode
 *   3. tools（function calling）      → 兼容性最好，几乎所有网关都支持
 */

/** 单个通道的探测结论。 */
export interface ChannelProbe {
  /** 网关是否支持该通道。 */
  supported: boolean
  /** HTTP 状态码（网络层失败时为 0）。 */
  status: number
  /** 判定依据（人类可读，便于排障）。 */
  reason: string
}

/** 三通道探测总结果。 */
export interface GatewayCapabilities {
  jsonSchema: ChannelProbe
  jsonObject: ChannelProbe
  functionCalling: ChannelProbe
  /** 探测完成时间戳（ms）。 */
  probedAt: number
  /** 网关标识（baseUrl + model），用于缓存失效判断。 */
  fingerprint: string
}

/** `withStructuredOutput` 支持的 method（与 LangChain 对齐）。 */
export type StructuredOutputMethod = 'jsonSchema' | 'jsonMode' | 'functionCalling'

export interface ProbeOptions {
  baseUrl: string
  apiKey: string
  model: string
  /** 单次探测请求超时（ms），默认 15s。 */
  timeoutMs?: number
  /** 注入 fetch 便于测试。 */
  fetchImpl?: typeof fetch
}

const DEFAULT_TIMEOUT_MS = 15_000

/** 把 baseUrl 规整为 chat/completions 端点。 */
function completionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`
}

/** 区分「网关不支持该能力」与「网络/鉴权问题」——后者不应被判定为「不支持」。 */
function classify(status: number, body: string): { supported: boolean; reason: string } {
  if (status >= 200 && status < 300) {
    return { supported: true, reason: `HTTP ${status}：网关接受该参数` }
  }
  if (status === 401 || status === 403) {
    return { supported: false, reason: `HTTP ${status}：鉴权失败（API Key 无效或无权限），结论不可用` }
  }
  if (status === 404) {
    return { supported: false, reason: 'HTTP 404：接口路径不存在（baseUrl 可能需带 /v1）' }
  }
  if (status === 400 || status === 422) {
    const lower = body.toLowerCase()
    const looksLikeParamRejection =
      lower.includes('unavailable') ||
      lower.includes('not supported') ||
      lower.includes('unsupported') ||
      lower.includes('invalid_request_error') ||
      lower.includes('response_format') ||
      lower.includes('unknown parameter')
    return {
      supported: false,
      reason: looksLikeParamRejection
        ? `HTTP ${status}：网关拒绝该参数（该通道不可用）`
        : `HTTP ${status}：请求被拒（${body.slice(0, 120)}）`
    }
  }
  return { supported: false, reason: `HTTP ${status}：意外状态（${body.slice(0, 120)}）` }
}

/** 发一个最小请求并归类结果。网络异常一律视为「不支持」但注明是网络问题。 */
async function probeOnce(
  url: string,
  apiKey: string,
  model: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  channelName: string
): Promise<ChannelProbe> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8, ...payload }),
      signal: controller.signal
    })
    const body = await res.text().catch(() => '')
    const { supported, reason } = classify(res.status, body)
    return { supported, status: res.status, reason: `[${channelName}] ${reason}` }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { supported: false, status: 0, reason: `[${channelName}] 网络/超时失败：${msg}` }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 探测网关对三条结构化输出通道的支持情况。
 * 三条探测并行发出，整体耗时 ≈ 单次请求。
 */
export async function probeGatewayCapabilities(opts: ProbeOptions): Promise<GatewayCapabilities> {
  const { baseUrl, apiKey, model } = opts
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl = opts.fetchImpl ?? fetch
  const url = completionsUrl(baseUrl)

  const [jsonSchema, jsonObject, functionCalling] = await Promise.all([
    probeOnce(
      url,
      apiKey,
      model,
      {
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'probe',
            strict: true,
            schema: {
              type: 'object',
              properties: { ok: { type: 'boolean' } },
              required: ['ok'],
              additionalProperties: false
            }
          }
        }
      },
      timeoutMs,
      fetchImpl,
      'json_schema'
    ),
    probeOnce(url, apiKey, model, { response_format: { type: 'json_object' } }, timeoutMs, fetchImpl, 'json_object'),
    probeOnce(
      url,
      apiKey,
      model,
      {
        tools: [
          {
            type: 'function',
            function: {
              name: 'probe_tool',
              description: '探测 function calling 是否可用',
              parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
            }
          }
        ],
        tool_choice: 'auto'
      },
      timeoutMs,
      fetchImpl,
      'function_calling'
    )
  ])

  return {
    jsonSchema,
    jsonObject,
    functionCalling,
    probedAt: Date.now(),
    fingerprint: `${baseUrl}::${model}`
  }
}

/**
 * 依据探测结果给出应使用的 `withStructuredOutput` method。
 *
 * 优先级：functionCalling（兼容性最好）> jsonMode > jsonSchema。
 * 注意：json_schema 即使「可用」也排在最后——因为在兼容网关上它最脆弱，
 * 而 functionCalling 已被证明可用时没必要冒险。
 */
export function pickStructuredOutputMethod(caps: GatewayCapabilities): {
  method: StructuredOutputMethod
  fallback: StructuredOutputMethod[]
  reason: string
} {
  if (caps.functionCalling.supported) {
    return {
      method: 'functionCalling',
      fallback: caps.jsonObject.supported ? ['jsonMode'] : [],
      reason: '网关支持 function calling（兼容性最好，优先使用）'
    }
  }
  if (caps.jsonObject.supported) {
    return {
      method: 'jsonMode',
      fallback: [],
      reason: '网关支持 json_object，不支持 function calling，改用 JSON mode'
    }
  }
  if (caps.jsonSchema.supported) {
    return { method: 'jsonSchema', fallback: [], reason: '仅支持 json_schema（OpenAI 原生通道）' }
  }
  return {
    method: 'jsonMode',
    fallback: [],
    reason: '三通道探测均未通过：默认按 JSON mode 尝试，请检查网关/Key/baseUrl 是否正确'
  }
}

/** 人类可读的探测报告（日志/排障用）。 */
export function formatCapabilityReport(caps: GatewayCapabilities): string {
  const line = (name: string, p: ChannelProbe): string =>
    `  ${p.supported ? '✓' : '✗'} ${name.padEnd(16)} ${p.reason}`
  const picked = pickStructuredOutputMethod(caps)
  return [
    `网关能力探测（${caps.fingerprint}）：`,
    line('json_schema', caps.jsonSchema),
    line('json_object', caps.jsonObject),
    line('function_calling', caps.functionCalling),
    `  → 选用 method: ${picked.method}（${picked.reason}）`
  ].join('\n')
}
