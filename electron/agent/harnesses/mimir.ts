/**
 * Mimir Harness：把现有 `AgentService`（deepagents + LangChain）包装成 `HarnessAdapter`。
 *
 * ponytail: 现阶段不重写 AgentService 内部逻辑——只做类型适配，让它实现统一接口。
 * 后续 Issue 1 的迭代可以进一步把 Ultra / SC / 技能路由从 AgentService 里拆出去。
 */

import type {
  HarnessAdapter,
  HarnessConfig,
  HarnessSendOptions,
  HarnessEventCallback,
  HarnessChunkCallback
} from '../harness.ts'
import { AgentService, type AgentWorkerEvent } from '../agentService.ts'

export class MimirHarness implements HarnessAdapter {
  readonly id = 'mimir'
  readonly name = 'Mimir'
  readonly kind = 'langgraph'

  private readonly service = new AgentService()
  private configured = false

  /** Mimir 依赖 Electron + LangChain 运行时：始终 available。 */
  async isAvailable(): Promise<boolean> {
    return true
  }

  async initialize(config: HarnessConfig): Promise<void> {
    await this.service.initialize(config)
    this.configured = true
  }

  isInitialized(): boolean {
    return this.configured && this.service.isInitialized()
  }

  async sendMessage(message: string, conversationId: string): Promise<string> {
    return this.service.sendMessage(message, conversationId)
  }

  async streamMessage(
    message: string,
    conversationId: string,
    onChunk: HarnessChunkCallback,
    onWorkerEvent: HarnessEventCallback,
    options?: HarnessSendOptions
  ): Promise<string> {
    const mappedEvent = (event: AgentWorkerEvent) => onWorkerEvent(event)
    return this.service.streamMessage(message, conversationId, onChunk, mappedEvent, options)
  }

  async stopStreaming(): Promise<void> {
    this.service.stopStreaming()
  }

  async shutdown(): Promise<void> {
    this.service.stopStreaming()
  }
}
