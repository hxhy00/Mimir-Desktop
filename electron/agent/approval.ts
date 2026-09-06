/**
 * Agent 副作用工具的「用户确认握手」。
 *
 * 机制：桥工具在真正写盘/长耗时前调用 {@link requireUserApproval}，主进程挂起
 * 该工具调用并把请求经 webContents 推给渲染层；用户在聊天区批准/拒绝后，
 * IPC（agent:approval-respond）回填结果并继续或中止工具。
 *
 * 约束：
 * - 同一时刻允许多个 pending（理论极少并发），各自独立超时；
 * - 等待超时（默认 120s）按「拒绝」处理，工具返回已取消文案，避免永远挂死；
 * - 未注册发送器（罕见：无窗口/测试环境）时保守放行并告警，避免阻塞 Agent。
 */
import { randomUUID } from 'node:crypto'

export interface ApprovalPrompt {
  /** 发起确认的工具名。 */
  readonly tool: string
  /** 一句话动作摘要（渲染层展示）。 */
  readonly summary: string
  /** 可选细节（参数/路径等，渲染层可折叠展示）。 */
  readonly detail?: string
}

export interface ApprovalRequest extends ApprovalPrompt {
  readonly id: string
  readonly at: number
}

const APPROVAL_TIMEOUT_MS = 120_000

type Sender = (request: ApprovalRequest) => void

let sender: Sender | null = null
const pending = new Map<string, { resolve: (allow: boolean) => void; timer: NodeJS.Timeout }>()

/** 由 IPC 层注册：把批准请求推给渲染进程。 */
export function setApprovalSender(fn: Sender): void {
  sender = fn
}

/** 请求用户批准一个副作用动作；用户放行返回 true，拒绝/超时返回 false。 */
export function requireUserApproval(prompt: ApprovalPrompt): Promise<boolean> {
  if (sender === null) {
    console.warn(`[approval] 未注册发送器，自动放行工具「${prompt.tool}」：${prompt.summary}`)
    return Promise.resolve(true)
  }
  const id = randomUUID()
  const request: ApprovalRequest = { ...prompt, id, at: Date.now() }
  const deliver: Sender = sender
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve(false)
    }, APPROVAL_TIMEOUT_MS)
    pending.set(id, { resolve, timer })
    deliver(request)
  })
}

/** 渲染层经 IPC 回填结果。 */
export function settleApproval(id: string, allow: boolean): void {
  const entry = pending.get(id)
  if (entry === undefined) return
  clearTimeout(entry.timer)
  pending.delete(id)
  entry.resolve(allow === true)
}

/** 供渲染层/测试展示超时时长（毫秒）。 */
export const approvalTimeoutMs = APPROVAL_TIMEOUT_MS
