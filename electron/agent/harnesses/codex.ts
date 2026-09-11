/**
 * Codex Harness stub（Issue 1 占位）。
 *
 * ponytail: 目前未实现。`isAvailable()` 始终返回 false；所有执行方法均拒绝并提示安装。
 * 真正的实现取决于 Codex 的本地运行模型（CLI / 本地进程 / HTTP）。
 */

import type { HarnessAdapter, HarnessConfig, HarnessSendOptions, HarnessEventCallback, HarnessChunkCallback } from '../harness.ts'

export class CodexHarness implements HarnessAdapter {
  readonly id = 'codex'
  readonly name = 'Codex'
  readonly kind = 'process'

  private initialized = false

  async isAvailable(): Promise<boolean> {
    return false
  }

  async initialize(_config: HarnessConfig): Promise<void> {
    this.initialized = true
  }

  isInitialized(): boolean {
    return this.initialized
  }

  async sendMessage(_message: string, _conversationId: string): Promise<string> {
    throw new Error('Codex Harness 尚未实现，请等待后续版本支持。')
  }

  async streamMessage(
    _message: string,
    _conversationId: string,
    _onChunk: HarnessChunkCallback,
    _onWorkerEvent: HarnessEventCallback,
    _options?: HarnessSendOptions
  ): Promise<string> {
    throw new Error('Codex Harness 尚未实现，请等待后续版本支持。')
  }

  async stopStreaming(): Promise<void> {}

  async shutdown(): Promise<void> {
    this.initialized = false
  }
}
