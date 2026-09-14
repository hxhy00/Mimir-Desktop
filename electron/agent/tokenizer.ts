/**
 * Token 准确计数（主进程）。
 *
 * 背景：上下文治理原先用「字符数」阈值（如 `MAX_CONTEXT_CHARS = 60_000`）估算预算。
 * 但中文 / 英文 / 代码的 token 密度差异极大（实测「你好世界」4 字符 = 2 token，
 * 英文约 4.9 字符/token，TS 代码约 3.9 字符/token），字符估算会导致预算浪费、
 * 网关 400（超上下文）与压缩时机错误。这里改用真实 BPE tokenizer。
 *
 * 实现选型：`gpt-tokenizer`（纯 JS，无 WASM / 原生模块），因此在 Electron 主进程
 * 与 Node 下行为一致，无需 asar 解包或 rebuild；`tiktoken` 的 npm 包依赖 WASM 加载，
 * 在 Electron 打包后容易踩路径问题，故不采用。**不自研 tokenizer。**
 *
 * 契约（调用方依赖，改动需同步）：
 * - 所有导出函数**永不抛错**：tokenizer 不可用时降级为字符估算并打一次 warning。
 * - `countTokens` 供 `contextManager.setTokenCounter(countTokens)` 注入为全局计数器。
 *
 * 注意：Mimir 支持任意自定义 `baseUrl`，模型名可能是任意字符串（如 `deepseek-v3`、
 * `qwen-max`）。真实 tokenizer 只对 OpenAI 系词表精确，因此 {@link encodingForModel}
 * 对未知模型一律回落 `cl100k_base`，这是**近似而非精确**——但对「预算控制」这一用途
 * 足够：GPT-4o/Claude/Qwen 等主流模型的 token 密度与 cl100k/o200k 差异通常在 ±10% 内，
 * 远优于字符估算。阈值判定侧建议保留 10%~15% 安全余量。
 */
import {
  countTokens as countTokensO200k,
  encode as encodeO200k
} from 'gpt-tokenizer/encoding/o200k_base'
import {
  countTokens as countTokensCl100k,
  encode as encodeCl100k
} from 'gpt-tokenizer/encoding/cl100k_base'

/** 单条消息的角色 / 分隔符固定开销（OpenAI chatml 经验值，见下方 countMessageTokens 说明）。 */
const MESSAGE_OVERHEAD_TOKENS = 3
/** 整个 chat 请求的固定开销（回复引导 token 等）。 */
const REQUEST_OVERHEAD_TOKENS = 3

/** 相邻两次 warning 之间的最小间隔（ms），避免主进程日志被刷屏。 */
const WARN_THROTTLE_MS = 60_000

/** LRU 缓存容量：压缩热路径上同段历史会反复计数，1024 条足以覆盖一个长会话的片段数。 */
const CACHE_MAX_ENTRIES = 1024

/** cl100k_base 编码器（GPT-4 / 3.5 系；未知模型的回落目标）。 */
export const CL100K_BASE = 'cl100k_base'
/** o200k_base 编码器（GPT-4o 系 / o 系 / GPT-5 系）。 */
export const O200K_BASE = 'o200k_base'

/** 支持的编码名。未知编码一律回落 {@link CL100K_BASE}。 */
export type EncodingName = typeof CL100K_BASE | typeof O200K_BASE

/**
 * 模型名 → 编码名映射（前缀匹配，忽略大小写）。
 *
 * 近似说明：仅 OpenAI 系词表可精确还原；其它厂商模型（Claude / Qwen / GLM / DeepSeek…）
 * 走 {@link CL100K_BASE} 近似。未知模型不抛错。
 */
const MODEL_ENCODING_PREFIXES: ReadonlyArray<readonly [RegExp, EncodingName]> = [
  // GPT-4o 系 / o 系 / GPT-5 系 / GPT-4.1 系 → o200k_base
  [/^(gpt-4o|chatgpt-4o|gpt-4\.1|gpt-5|o1|o3|o4|codex-mini|computer-use-preview)/i, O200K_BASE],
  // gpt-oss 开源模型同样使用 o200k 词表
  [/^gpt-oss/i, O200K_BASE],
  // GPT-4 / GPT-3.5 系 → cl100k_base（显式列出便于阅读，也是默认回落项）
  [/^(gpt-4|gpt-3\.5|gpt-35|text-embedding-3|text-embedding-ada)/i, CL100K_BASE]
]

/** 带缓存的编码器句柄（懒加载：某些调用方只用 fallback 路径时不必付加载成本）。 */
interface EncoderHandle {
  /** 纯文本计数（对应 gpt-tokenizer 的 `countTokens`）。 */
  count: (text: string) => number
  /** 编码为 token id 数组（用于 chatml 消息序列拼接计数）。 */
  encode: (text: string) => number[]
}

const encoderCache = new Map<EncodingName, EncoderHandle>()

let warnedFallback = false
let lastWarnAt = 0

/** 同一进程内只打一次（且带节流）的降级 warning，避免污染日志。 */
function warnFallbackOnce(reason: unknown): void {
  const now = Date.now()
  if (warnedFallback && now - lastWarnAt < WARN_THROTTLE_MS) return
  warnedFallback = true
  lastWarnAt = now
  const detail = reason instanceof Error ? reason.message : String(reason)
  console.warn(
    `[tokenizer] 真实 tokenizer 不可用，已降级为字符估算（CJK ≈ 1 token/字，其余 ≈ 1 token/4 字符）。原因：${detail}`
  )
}

/** 惰性获取编码器；加载失败返回 null，由调用方降级。 */
function getEncoder(encoding: EncodingName): EncoderHandle | null {
  const cached = encoderCache.get(encoding)
  if (cached !== undefined) return cached
  try {
    if (encoding === O200K_BASE) {
      const handle: EncoderHandle = {
        count: (text) => countTokensO200k(text),
        encode: (text) => encodeO200k(text)
      }
      encoderCache.set(encoding, handle)
      return handle
    }
    const handle: EncoderHandle = {
      count: (text) => countTokensCl100k(text),
      encode: (text) => encodeCl100k(text)
    }
    encoderCache.set(encoding, handle)
    return handle
  } catch (error) {
    // 例如依赖缺失、词表数据损坏——不允许影响主流程
    warnFallbackOnce(error)
    return null
  }
}

/**
 * 把模型名映射到编码名（近似）。
 *
 * - GPT-4o / o1 / o3 / o4 / GPT-4.1 / GPT-5 / gpt-oss → `o200k_base`
 * - GPT-4 / GPT-3.5 / text-embedding-3 → `cl100k_base`
 * - 空串、未知模型、自定义网关模型名 → `cl100k_base`（保守回落，不抛错）
 */
export function encodingForModel(model: string): EncodingName {
  if (typeof model !== 'string') return CL100K_BASE
  const name = model.trim()
  if (name === '') return CL100K_BASE
  for (const [pattern, encoding] of MODEL_ENCODING_PREFIXES) {
    if (pattern.test(name)) return encoding
  }
  return CL100K_BASE
}

/**
 * 按模型取编码名（`cl100k_base` / `o200k_base`），供需要固定编码的调用方使用。
 *
 * 与 {@link encodingForModel} 等价，此别名仅为满足调用方语义（`getEncoding(model)`）。
 * 注意：不要与 gpt-tokenizer 的 `getEncoding` 混淆——本函数只返回编码名字符串。
 */
export function getEncoding(model: string): EncodingName {
  return encodingForModel(model)
}

/**
 * 字符估算降级实现：tokenizer 不可用时的兜底，保证「永不抛错」。
 *
 * 经验公式（粗粒度、宁多勿少）：
 * - CJK 字符（含中日韩、全角标点）≈ 1 token / 字（真实值约 1~1.7，取 1 偏保守）；
 * - 其余字符 ≈ 1 token / 4 字符（英文与空白约 4~5 字符/token）；
 * - 至少返回 CJK 计数（纯英文串不会低于 1）。
 *
 * 与真实 tokenizer 相比，本函数在中文上会**低估**、在英文上接近准确；
 * 调用方使用降级路径时应额外留出安全余量。
 */
export function estimateTokensFallback(text: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0
  let cjk = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    // CJK 统一表意文字、扩展 A、兼容表意文字、CJK 标点、平假名/片假名、全角形式、谚文
    if (
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk += 1
    }
  }
  const rest = text.length - cjk
  return cjk + Math.ceil(rest / 4)
}

/**
 * 计算一段文本的 token 数（真实 tokenizer，失败时降级字符估算）。
 *
 * **永不抛错**：输入非字符串按空串处理；tokenizer 加载失败走
 * {@link estimateTokensFallback} 并打一次 warning。
 */
export function countTokens(text: string, model?: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0
  const encoding = model === undefined ? CL100K_BASE : encodingForModel(model)
  const encoder = getEncoder(encoding)
  if (encoder === null) return estimateTokensFallback(text)
  try {
    return encoder.count(text)
  } catch (error) {
    warnFallbackOnce(error)
    return estimateTokensFallback(text)
  }
}

/** 计算消息内容所需 token 数（不含消息级固定开销，内部使用）。 */
function contentTokens(text: unknown, encode: (s: string) => number[]): number {
  const content = typeof text === 'string' ? text : ''
  if (content === '') return 0
  try {
    return encode(content).length
  } catch (error) {
    warnFallbackOnce(error)
    return estimateTokensFallback(content)
  }
}

/**
 * 计算一组 chat 消息的 token 数（含每条消息的角色 / 分隔符固定开销）。
 *
 * 公式依据：沿用 OpenAI 官方 cookbook 的 chatml 计数方法
 * （`https://github.com/openai/openai-cookbook` 的 "How to count tokens with tiktoken"），
 * 每条消息的 token 由三部分组成：
 *
 *   tokens_per_message
 *     = 3（`<|im_start|>` + role + `<|im_end|>` 的固定包裹开销）
 *     + tokenize(role 文本)      // OpenAI 直接把 role 当普通文本编码，如 "user" = 1 token
 *     + tokenize(content 文本)
 *
 * 整个请求额外加 3 个 token（回复引导 `<|im_start|>assistant`），故：
 *
 *   total = 3 + Σ (3 + tokenize(role) + tokenize(content))
 *
 * 说明：
 * - gpt-tokenizer 自带的 `encodeChat` 要求传入合法模型名且不支持任意 role 字符串，
 *   与我们「任意自定义 baseUrl / 任意模型名 / 任意 role」的场景不匹配，故这里用
 *   {@link encode} + 官方公式自行累加，等价且更可控。
 * - 真实网关的分隔符开销随模型略有差异（±4 token/条），此处为近似值。
 * - **永不抛错**：单条消息出错时该条降级为字符估算。
 */
export function countMessageTokens(
  messages: ReadonlyArray<{ role: string; content: string }>,
  model?: string
): number {
  if (!Array.isArray(messages) || messages.length === 0) return 0
  const encoding = model === undefined ? CL100K_BASE : encodingForModel(model)
  const encoder = getEncoder(encoding)
  // 降级路径：按各自字符估算，role 亦计入
  const encode = encoder !== null ? encoder.encode : (fallbackEncodingSafe(encoding))
  if (encoder === null) return REQUEST_OVERHEAD_TOKENS + messageTokensFallback(messages)

  let total = REQUEST_OVERHEAD_TOKENS
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    const role = typeof message.role === 'string' ? message.role : 'user'
    total += MESSAGE_OVERHEAD_TOKENS
    total += contentTokens(role, encode)
    total += contentTokens(message.content, encode)
  }
  return total
}

/** 降级路径下统一使用字符估算（编码器不可用时用它替代 encode）。 */
function fallbackEncodingSafe(_encoding: EncodingName): (text: string) => number[] {
  return (text: string) => {
    const n = estimateTokensFallback(text)
    return new Array<number>(n).fill(0)
  }
}

/** 与 {@link countMessageTokens} 同样的公式，但全程走字符估算。 */
function messageTokensFallback(
  messages: ReadonlyArray<{ role: string; content: string }>
): number {
  let total = 0
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    const role = typeof message.role === 'string' ? message.role : 'user'
    total += MESSAGE_OVERHEAD_TOKENS
    total += estimateTokensFallback(role)
    total += estimateTokensFallback(typeof message.content === 'string' ? message.content : '')
  }
  return total
}

/**
 * 带 LRU 缓存的 token 计数（压缩热路径专用）。
 *
 * 上下文压缩会对同一段历史反复计数（窗口滑动、分段压缩、预算试算），
 * 纯 JS BPE 在中长文本上单次耗时可达毫秒级，必须缓存。
 *
 * 缓存键为文本本身（Map 的插入顺序即 LRU 顺序，命中后重新插入实现「近期使用」）。
 * 缓存只覆盖真实 tokenizer 路径——降级估算本就很便宜，无需缓存。
 */
const lruCache = new Map<string, number>()

export function countTokensCached(text: string, model?: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0
  // 仅对「值得缓存」的文本生效：极短文本缓存收益低于 Map 开销
  if (text.length < 64) return countTokens(text, model)

  const key = model === undefined ? text : `${model}\u0000${text}`
  const hit = lruCache.get(key)
  if (hit !== undefined) {
    // 触达后移到队尾，标记为最近使用
    lruCache.delete(key)
    lruCache.set(key, hit)
    return hit
  }

  const value = countTokens(text, model)
  lruCache.set(key, value)
  if (lruCache.size > CACHE_MAX_ENTRIES) {
    const oldest = lruCache.keys().next()
    if (oldest.done !== true) lruCache.delete(oldest.value)
  }
  return value
}

/** 清空 LRU 缓存（仅供测试与内存回收使用）。 */
export function clearTokenCache(): void {
  lruCache.clear()
}

/** 当前缓存条目数（仅供测试与观测使用）。 */
export function tokenCacheSize(): number {
  return lruCache.size
}

/** 缓存容量常量（仅供测试断言使用）。 */
export const TOKEN_CACHE_MAX_ENTRIES = CACHE_MAX_ENTRIES
