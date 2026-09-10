/**
 * Harness 抽象层（Issue 1）。
 *
 * 目标：把 Mimir 当前使用的具体 agent 框架（deepagents + LangChain ChatOpenAI）
 * 从上层业务里抽离出来，让上层只需要面向 `HarnessAdapter`，将来可以挂上
 * Codex、Claude Code、Pi 等不同 harness 的实现。
 *
 * 边界契约（HarnessAdapter）：
 * - 唯一的执行入口：上层把用户消息交给 `sendMessage` / `streamMessage`；
 * - 唯一的事件出口：流式文本块（onChunk）和结构化过程事件（onWorkerEvent）。
 *
 * 不属于契约的内容（属于上层 / settings）：
 * - 模型 baseUrl / apiKey / modelId 的具体存储结构；
 * - 子代理 / 技能路由 / 工具注册的实现位置；
 * - Mimir 现有 Supervisor / Ultra / SC 增强子图，这些都属于「Mimir Harness」私有。
 *
 * ponytail: 第一版只迁接口 + 把现状迁移到 Mimir Harness；Codex / Claude Code / Pi
 * adapter 留 stub，提示「未实现」。待对应 harness 的本地协议确定后再实现。
 */

/** 流式文本块回调。 */
export type HarnessChunkCallback = (chunk: string) => void

/** Harness 过程事件（与现有 AgentWorkerEvent 对齐）。 */
export interface HarnessWorkerEvent {
  taskId: string
  title: string
  status: 'running' | 'done' | 'error'
  text?: string
  durationMs?: number
  kind?: 'phase' | 'task' | 'tool' | 'think' | 'think-token'
}

/** 过程事件回调。 */
export type HarnessEventCallback = (event: HarnessWorkerEvent) => void

/** 流式对话历史（与现有结构一致；不同 harness 可以忽略）。 */
export interface HarnessChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** Harness 配置：基址、API Key、模型 ID（不同 harness 可能用到不同字段）。 */
export interface HarnessConfig {
  apiKey: string
  model: string
  baseUrl?: string | undefined
}

/** 单条消息流式请求的可选项。 */
export interface HarnessSendOptions {
  ultra?: {
    enabled: boolean
    strategy?: 'auto' | 'plain' | 'multi_expert' | 'critique_reflect' | 'hybrid_mix' | 'self_consistency_vote'
  }
  history?: HarnessChatMessage[]
  /** 手动 /trigger 直通：跳过技能路由。 */
  manual?: boolean
}

/** 一个 harness 实例。不同 harness 对应不同的运行模型（本地进程 / MCP / HTTP / LangChain）。 */
export interface HarnessAdapter {
  /** 稳定 id（用于配置/UI 显示）。 */
  readonly id: string
  /** 人类可读名称。 */
  readonly name: string
  /** 是否依赖 ChatOpenAI / LangChain 等具体栈；上层可以据此决定是否暴露某些高级选项。 */
  readonly kind: 'langgraph' | 'process' | 'mcp' | 'http'

  /** 检查 harness 当前是否在主机上可用（进程存在、依赖安装、登录态等）。 */
  isAvailable(): Promise<boolean>

  /** 用指定配置初始化 harness。返回是否成功；上层应允许重新初始化。 */
  initialize(config: HarnessConfig): Promise<void>

  /** 单轮非流式消息，返回完整回复文本。 */
  sendMessage(message: string, conversationId: string): Promise<string>

  /** 流式消息：过程中通过 onChunk 推送文本、通过 onWorkerEvent 推送过程事件。
   *  返回拼接后的完整文本。中途可以调用 stopStreaming() 终止。 */
  streamMessage(
    message: string,
    conversationId: string,
    onChunk: HarnessChunkCallback,
    onWorkerEvent: HarnessEventCallback,
    options?: HarnessSendOptions
  ): Promise<string>

  /** 中止当前流式消息；无活动消息时为 no-op。 */
  stopStreaming(): Promise<void>

  /** 当前 harness 是否已初始化（可供 UI 显示状态）。 */
  isInitialized(): boolean

  /** 释放资源（卸载 harness）。 */
  shutdown(): Promise<void>
}

/** Harness 注册表的最小条目。 */
export interface HarnessRegistration {
  id: string
  name: string
  kind: HarnessAdapter['kind']
  /** 当前是否在 UI 中可选（false 表示仅占位/未来支持）。 */
  available: boolean
}
