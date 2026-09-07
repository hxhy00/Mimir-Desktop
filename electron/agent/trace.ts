/**
 * 模型层全链路 trace（debug 通用设施，方案 B）。
 *
 * 背景：此前只能手动在各工具/阶段打 console.log，且「模型层」是黑盒——看不到每个
 * ChatModel 请求实际收到的上下文、模型是否真的发出 tool_call、各次调用的耗时与 token。
 *
 * 本模块实现一个 LangChain BaseCallbackHandler，挂在 ChatOpenAI 构造时的 callbacks 上：
 * LangChain v1 的 BaseChatModel 在运行时会用 `CallbackManager.configure(config.callbacks,
 * this.callbacks, …)` 把「构造时传入的 callbacks」作为回退，因此 deepagents 内部无论
 * supervisor / 子代理 / 各增强子图共用该 model 实例的多少次调用，都会触发这里的事件——
 * 一个 handler 即可看到整张执行图，无需在库内部逐点埋桩。
 *
 * 级别（settings.agentTraceLevel，缺省 'compact'）：
 * - off：不创建 handler，零开销；
 * - compact：每次模型调用一行「llm→ 输入摘要」、返回一行「llm← tool_calls/文本/token」，
 *   工具 start/end 各一行（覆盖「模型有没有真调 load_memory」这个盲区）；
 * - full：在 compact 基础上展开更长片段。
 *
 * 输出：
 * 1) 以 [agent-trace] 前缀打到主进程终端；
 * 2) 追加写入 ~/.mimir/logs/agent-trace-<yyyyMMdd>.jsonl 便于事后离线检索。
 * 所有文本均截断，不落盘 apiKey。
 */
import { appendFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { BaseCallbackHandler } from '@langchain/core/callbacks/base'
import type { LLMResult } from '@langchain/core/outputs'

export type AgentTraceLevel = 'off' | 'compact' | 'full'

export interface AgentTraceOptions {
  level: Exclude<AgentTraceLevel, 'off'>
  /** 是否同时写 JSONL 到 ~/.mimir/logs（缺省 true）。 */
  toFile?: boolean
}

/** 规整并截断一段内容（压空白、防长文/密钥刷屏）。 */
function clip(value: unknown, max = 200): string {
  let text = ''
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 从 messages（首个批量）取「系统首条 + 用户末条」，展示本轮模型真正收到的上下文。 */
function messagesSnippet(messages: { role?: string; content?: unknown }[][]): string {
  const batch = messages[0]
  if (!Array.isArray(batch) || batch.length === 0) return '(空)'
  const head = batch[0]
  const tail = batch[batch.length - 1]
  const parts: string[] = []
  if (head?.role === 'system' && typeof head.content === 'string' && head.content !== '') {
    parts.push(`sys=${clip(head.content, 100)}`)
  }
  const role = typeof tail?.role === 'string' && tail.role !== '' ? tail.role : 'msg'
  parts.push(`${role}=${clip(tail?.content ?? '', 120)}`)
  return parts.join(' | ')
}

/** 从 LLMResult 提取回复文本 / tool_calls / token 用量。 */
function summarizeOutput(output: LLMResult): { text: string; calls: string[]; tokens: string } {
  const gen = output.generations?.[0]?.[0] as
    | {
        message?: {
          content?: unknown
          tool_calls?: { name?: string; args?: unknown }[]
          additional_kwargs?: { tool_calls?: unknown[] }
        }
        text?: string
      }
    | undefined
  const msg = gen?.message
  const text = clip(msg?.content ?? gen?.text ?? '', 200)
  const rawCalls: { name?: string; args?: unknown }[] = Array.isArray(msg?.tool_calls)
    ? (msg.tool_calls as { name?: string; args?: unknown }[])
    : Array.isArray(msg?.additional_kwargs?.tool_calls)
      ? (msg.additional_kwargs.tool_calls as { name?: string; args?: unknown }[])
      : []
  const calls = rawCalls.map((c) => `${c.name ?? '(?)'}(${clip(c.args, 80)})`)
  const usage = output.llmOutput as
    | { tokenUsage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } }
    | undefined
  const t = usage?.tokenUsage
  const tokens =
    t === undefined
      ? ''
      : ` pt=${t.promptTokens ?? '?'} ct=${t.completionTokens ?? '?'} tot=${t.totalTokens ?? '?'}`
  return { text, calls, tokens }
}

/** 简单毫秒钟。 */
function nowMs(): number {
  return Date.now()
}

export class AgentTraceHandler extends BaseCallbackHandler {
  name = 'mimir-agent-trace'

  private readonly level: Exclude<AgentTraceLevel, 'off'>
  private readonly toFile: boolean
  /** 本轮去重：旧（handleLLMStart）与新（handleChatModelStart）两套事件可能对同一 run 各触发一次。 */
  private readonly seenRuns = new Set<string>()
  /** tool start → { name, t0 }，toolEnd/toolError 用它补名称与耗时。 */
  private readonly toolStarted = new Map<string, { name: string; t0: number }>()
  private filePath = ''

  constructor(options: AgentTraceOptions) {
    super()
    this.level = options.level
    this.toFile = options.toFile !== false
    if (this.toFile) {
      const d = new Date()
      const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
      this.filePath = join(homedir(), '.mimir', 'logs', `agent-trace-${ymd}.jsonl`)
    }
  }

  /** 终端 [agent-trace] 输出 + 可选 JSONL 落盘。 */
  private out(event: { type: string; runId?: string; parentRunId?: string; msg: string; detail?: unknown }): void {
    const line = `[agent-trace] ${event.type}${event.runId !== undefined ? ` #${event.runId.slice(0, 6)}` : ''} ${event.msg}`
    // eslint-disable-next-line no-console
    console.log(line)
    if (this.toFile) {
      try {
        appendFileSync(
          this.filePath,
          JSON.stringify({ ts: new Date().toISOString(), level: this.level, ...event }) + '\n',
          'utf-8'
        )
      } catch {
        // 磁盘不可写时静默降级为仅终端输出
      }
    }
  }

  /** 模型调用前：记录上下文摘要。 */
  async handleLLMStart(
    llm: unknown,
    prompts: string[],
    runId: string,
    parentRunId?: string
  ): Promise<void> {
    if (this.seenRuns.has(runId)) return
    this.seenRuns.add(runId)
    const p = Array.isArray(prompts) ? prompts.join('\n').replace(/\s+/g, ' ') : String(prompts)
    const max = this.level === 'full' ? 400 : 140
    this.out({
      type: 'llm→',
      runId,
      parentRunId,
      msg: clip(p, max),
      detail: { llmName: (llm as { name?: string } | undefined)?.name }
    })
  }

  /** 若框架改走 ChatModel 事件也覆盖（与 handleLLMStart 通过 seenRuns 去重）。 */
  async handleChatModelStart(
    _llm: unknown,
    messages: unknown[][],
    runId: string,
    parentRunId?: string
  ): Promise<void> {
    if (this.seenRuns.has(runId)) return
    this.seenRuns.add(runId)
    this.out({
      type: 'llm→',
      runId,
      parentRunId,
      msg: messagesSnippet(messages as { role?: string; content?: unknown }[][])
    })
  }

  /** 模型返回：tool_calls（「是否真的发起了 load_memory」的直接证据）、文本、token。 */
  async handleLLMEnd(output: LLMResult, runId: string, parentRunId?: string): Promise<void> {
    const { text, calls, tokens } = summarizeOutput(output)
    const prefix =
      calls.length > 0
        ? `tool_calls=[${calls.join('; ')}] |`
        : text !== ''
          ? 'text='
          : ''
    this.out({
      type: 'llm←',
      runId,
      parentRunId,
      msg: `${prefix}${calls.length > 0 ? '' : text}${tokens}${calls.length > 0 && text !== '' ? ` | ${text}` : ''}`.trim(),
      detail: this.level === 'full' ? output : undefined
    })
  }

  /** 模型调用报错（限流/网络/网关拒绝 tool calling 等）。 */
  async handleLLMError(err: Error, runId: string, parentRunId?: string): Promise<void> {
    this.out({ type: 'llm✗', runId, parentRunId, msg: clip(err.message, 240) })
  }

  /** 工具开始：与 withToolTrace 互补，能捕获 deepagents 内部（含 supervisor 直属）每次工具。 */
  async handleToolStart(
    tool: { name?: string } | undefined,
    input: string,
    runId: string,
    parentRunId?: string
  ): Promise<void> {
    const name = tool?.name ?? '(?)'
    this.toolStarted.set(runId, { name, t0: nowMs() })
    const max = this.level === 'full' ? 300 : 110
    this.out({ type: 'tool→', runId, parentRunId, msg: `${name}(${clip(input, max)})` })
  }

  async handleToolEnd(output: unknown, runId: string, parentRunId?: string): Promise<void> {
    const rec = this.toolStarted.get(runId)
    const name = rec?.name ?? '(?)'
    const cost = rec !== undefined ? `${nowMs() - rec.t0}ms ` : ''
    this.toolStarted.delete(runId)
    const max = this.level === 'full' ? 600 : 160
    this.out({ type: 'tool←', runId, parentRunId, msg: `${name} ${cost}${clip(output, max)}` })
  }

  async handleToolError(err: Error, runId: string, parentRunId?: string): Promise<void> {
    const rec = this.toolStarted.get(runId)
    const name = rec?.name ?? '(?)'
    this.toolStarted.delete(runId)
    this.out({ type: 'tool✗', runId, parentRunId, msg: `${name} ${clip(err.message, 240)}` })
  }
}

/** 按级别创建 handler；off 返回 null（调用方跳过挂载，零开销）。 */
export function createAgentTraceHandler(level: AgentTraceLevel): AgentTraceHandler | null {
  if (level === 'off') return null
  return new AgentTraceHandler({ level })
}
