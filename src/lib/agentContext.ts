/**
 * 跨模块「交给 Agent」上下文总线。
 *
 * 各研究模块（文献库 / 论文 / 实验 / 图表 / 会议）通过 {@link handoffToAgent}
 * 把一个 {@link AgentContextPayload} 投递到 Chat 模块；ChatInput 消费后渲染为
 * 上下文芯片，并在发送时序列化为结构化 `<context>` 前缀注入用户消息。
 *
 * 设计约束：
 * - 单槽位（后投递覆盖先投递），避免多模块排队导致的语义歧义。
 * - 读后即清（consume），防止重挂载后重复注入。
 * - 空间切换时清空，避免跨空间引用污染（见 {@link clearAgentContext}）。
 */

export type AgentContextKind =
  | 'paper'
  | 'library-item'
  | 'experiment'
  | 'figure'
  | 'venue'
  | 'file'

export interface AgentContextPayload {
  /** 业务对象类型。 */
  readonly kind: AgentContextKind
  /** 业务主键：paperId / 图片路径 / 会议 key 等。 */
  readonly refId: string
  /** 展示标题（芯片文案 + 注入内容）。 */
  readonly title: string
  /** 已抽取好的纯文本摘要，避免 Agent 重复解析。 */
  readonly excerpt: string
  /** 对象所在绝对路径（Agent fs 工具可直接使用；缺省表示无确切文件）。 */
  readonly spacePath?: string
  /** 原始对象（可选，供后续扩展时透传结构化字段）。 */
  readonly meta?: Readonly<Record<string, unknown>>
}

/** 模块 → Chat 的导航事件名。App 负责监听并切换 activeModule。 */
export const AGENT_HANDOFF_EVENT = 'mimir:agent-handoff'
/** 空间切换事件：投递中的上下文须作废。 */
export const SPACE_CHANGED_EVENT = 'mimir:space-changed'

let pending: AgentContextPayload | null = null

/** 投递上下文（不触发导航，由 {@link handoffToAgent} 负责）。 */
export function setAgentContext(payload: AgentContextPayload): void {
  pending = payload
}

/** 读取但不消费（供输入框渲染芯片时用）。 */
export function peekAgentContext(): AgentContextPayload | null {
  return pending
}

/** 读取并清空。发送消息时调用，避免重复注入。 */
export function consumeAgentContext(): AgentContextPayload | null {
  const current = pending
  pending = null
  return current
}

/** 清空待投递上下文（空间切换 / 显式取消时调用）。 */
export function clearAgentContext(): void {
  pending = null
}

/**
 * 把上下文序列化为注入用户消息的结构化前缀。
 * 采用 XML 风格而非自然语言，便于模型稳定解析且不与用户正文混淆。
 */
export function serializeAgentContext(payload: AgentContextPayload): string {
  const attrs = [
    `kind="${payload.kind}"`,
    `ref="${escapeAttr(payload.refId)}"`,
    payload.spacePath !== undefined && payload.spacePath !== ''
      ? `path="${escapeAttr(payload.spacePath)}"`
      : ''
  ]
    .filter((s) => s !== '')
    .join(' ')
  const title = payload.title.trim() === '' ? payload.refId : payload.title.trim()
  const body = payload.excerpt.trim()
  return [
    `<context ${attrs}>`,
    `<title>${title}</title>`,
    body === '' ? '' : `<excerpt>${body}</excerpt>`,
    '</context>'
  ]
    .filter((line) => line !== '')
    .join('\n')
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 模块侧统一入口：投递上下文并请求跳转到 Chat。
 * 必须在渲染进程调用（依赖 window 事件）。
 */
export function handoffToAgent(payload: AgentContextPayload, prompt?: string): void {
  setAgentContext(payload)
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent(AGENT_HANDOFF_EVENT, { detail: { payload, prompt: prompt ?? '' } })
  )
}
