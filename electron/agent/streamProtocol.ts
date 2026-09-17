/**
 * Agent 流式事件的**单一事实源**（主进程产出 / preload 桥接 / 渲染层消费共用一个类型）。
 *
 * ── 为什么替换掉「前缀字符串信封」────────────────────────────────────────────
 * 旧设计把「正文 token」「过程事件」「流结束信号」全部塞进同一条 `agent:chunk` 文本通道，
 * 用不可见控制字符前缀（`\u0002MIMIR_AGENT_EVENT\u0002` 等）区分类型。它带来了一整类
 * 结构性缺陷，每一个都是「内容显示不全」的独立成因：
 *
 *  1. **类型靠字符串前缀猜**：正文若恰好以该控制字符开头就会被误判为事件；四处
 *     （主进程计数、IPC 转发、preload 透传、渲染层分流）各写一遍 `startsWith`，改一处漏一处。
 *  2. **无序号，丢包不可检测**：丢了只能靠「最终长度对不上」反推，无法知道丢在第几个包，
 *     更无法重放。现象是「偶尔少一段」，且无法复现。
 *  3. **正文双份状态**：主进程 `fullContent` 与渲染层 `fullContent` 各拼一遍，用「结束信封
 *     里的全量 content」对账；对账不平（如主进程那份反而更短）时渲染层保留残缺值。
 *  4. **无流标识**：`winSend` 只判断窗口存活，不判断「这一轮的 chunk 该不该发给它」，
 *     窗口重建 / 多窗口时会串台。
 *
 * 现模型：**结构化事件 + 单调 seq + streamId**。
 *  - `type` 字段显式区分事件种类，不做任何字符串前缀判断；
 *  - `seq` 从 0 单调递增，接收端跳号即**确定**发生丢包（可日志、可告警），而非事后反推；
 *  - `streamId` 标记「一次回复流」，接收端据此丢弃陈旧流的迟到事件；
 *  - 正文只发**增量** `delta`，结束事件只带 `finalLength`，不重复传全文（消除双份状态）。
 *
 * ── 与 legacy 的兼容 ──────────────────────────────────────────────────────
 * 不保留前缀解析路径：旧路径的产物（`streamEnvelope.ts`）已删除。若将来需要读旧日志，
 * 走日志文本即可，不进代码。
 */

/** 事件类型（判别式联合的判别字段）。 */
export type AgentStreamEventType =
  /** 正文增量（模型逐字产出）。只带增量，接收端自行累加。 */
  | 'text-delta'
  /** 过程事件（工具调用/思考/阶段），负载为 AgentWorkerEvent 的 JSON 可序列化形态。 */
  | 'worker'
  /** 正文流结束（模型停止生成）。用于让渲染层立即定稿并关灯，不必等整轮 invoke 返回。 */
  | 'end'
  /** 出错。接收端据此提示并释放运行态。 */
  | 'error'

interface AgentStreamEventBase {
  /** 单调递增序号（同一 streamId 内从 0 起）：接收端跳号即丢包。 */
  seq: number
  /** 本次回复流标识（主进程生成）：接收端据此丢弃陈旧流的迟到事件。 */
  streamId: string
}

/** 正文增量。 */
export interface AgentTextDeltaEvent extends AgentStreamEventBase {
  type: 'text-delta'
  delta: string
}

/**
 * 过程事件（工具/思考/阶段）。
 *
 * `payload` 为结构化对象，**不做任何字段裁剪**：渲染层 applyRunEvent 需要什么就带什么。
 * 类型用 unknown 而非 AgentWorkerEvent，是为了让本文件（被 preload / 渲染层引用）不依赖
 * 主进程模块，保持「协议」与「实现」分离。
 */
export interface AgentWorkerEventMessage extends AgentStreamEventBase {
  type: 'worker'
  payload: unknown
}

/** 正文流结束。 */
export interface AgentStreamEndEvent extends AgentStreamEventBase {
  type: 'end'
  /**
   * 主进程累计的正文总长度（对账用，不发全文）。
   * 渲染层对比本地累加长度：不一致说明中途丢包（seq 跳号会先一步暴露）。
   */
  finalLength: number
}

/** 出错。 */
export interface AgentStreamErrorEvent extends AgentStreamEventBase {
  type: 'error'
  message: string
}

/** 流式事件联合类型。 */
export type AgentStreamEvent =
  | AgentTextDeltaEvent
  | AgentWorkerEventMessage
  | AgentStreamEndEvent
  | AgentStreamErrorEvent

/** 主进程内部：尚未编排 seq / streamId 的事件（由发送侧统一补齐）。 */
export type AgentStreamEventDraft =
  | { type: 'text-delta'; delta: string }
  | { type: 'worker'; payload: unknown }
  | { type: 'end'; finalLength: number }
  | { type: 'error'; message: string }

/** 生成一个回复流标识。 */
export function newStreamId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 事件编排器：给草稿事件补 `seq` / `streamId`，保证单调与归属。
 *
 * 一次回复对应一个实例（主进程在 `streamMessage` 入口创建）。
 */
export interface StreamSequencer {
  readonly streamId: string
  /** 下一个序号（已编排的事件数）。 */
  readonly count: number
  /** 编排一个事件：补 seq / streamId 后返回完整事件。 */
  next(draft: AgentStreamEventDraft): AgentStreamEvent
}

/** 创建编排器。 */
export function createSequencer(streamId: string = newStreamId()): StreamSequencer {
  let seq = 0
  return {
    streamId,
    get count(): number {
      return seq
    },
    next(draft: AgentStreamEventDraft): AgentStreamEvent {
      const base: AgentStreamEventBase = { seq, streamId }
      seq += 1
      return { ...base, ...draft } as AgentStreamEvent
    }
  }
}

/**
 * 接收端校验结果：把「丢没丢」从猜测变成确定事实。
 *
 * 为什么值得单独建模：旧设计里「内容少了」只能靠人眼比对长度，无法区分
 * 「上游没发」与「传输丢包」。有了 seq，跳号就是丢包的**直接证据**。
 */
export interface SeqCheckResult {
  /** 是否发生跳号（期望 seq 与实际不符）。 */
  skipped: boolean
  /** 跳号时，丢失的事件数量（实际 seq - 期望 seq）。 */
  missing: number
  /** 期望的 seq（上一事件 seq + 1）。 */
  expected: number
}

/** 校验并推进接收端 seq 计数（纯函数，返回新计数与校验结果）。 */
export function checkSeq(lastSeq: number, incoming: number): SeqCheckResult {
  const expected = lastSeq + 1
  if (incoming === expected) return { skipped: false, missing: 0, expected }
  // 重复 / 迟到事件（incoming <= lastSeq）不算丢包，按缺失 0 处理并保持进度不回退。
  if (incoming <= lastSeq) return { skipped: false, missing: 0, expected }
  return { skipped: true, missing: incoming - expected, expected }
}
