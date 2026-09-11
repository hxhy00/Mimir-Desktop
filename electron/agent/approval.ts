/**
 * Agent 副作用工具的「用户确认握手」。
 *
 * 机制：副作用工具在真正写盘/长耗时前调用 {@link requireUserApproval}，主进程挂起
 * 该工具调用并把请求经 webContents 推给渲染层；用户在聊天区批准/拒绝后，
 * IPC（agent:approval-respond）回填结果并继续或中止工具。
 *
 * 安全模型（Fail-Closed）：
 * - **默认拒绝**：无法确定用户意图时（无发送器 / 超时 / 异常）一律按「拒绝」处理。
 *   绝不存在「拿不到用户答复就自动放行」的路径——这是安全收口（C1）的核心。
 * - **来源可溯**：每次请求携带 {@link ApprovalSource}（发起者 + 所属工具），渲染层批准卡
 *   原样展示，让用户能区分「主 agent 直接调用」与「子代理委派调用」（C3）。
 * - 同一时刻允许多个 pending（理论极少并发），各自独立超时；
 * - 等待超时（默认 120s）按「拒绝」处理，工具返回已取消文案，避免永远挂死。
 */
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * 批准卡「来源标识」的传递通道（C3）。
 *
 * 副作用工具内部调用 {@link requireUserApproval} 时并不知道自己是「主 agent 直接调用」
 * 还是「某子代理委派调用」；渲染层批准卡因此无法告诉用户「谁在申请」。
 *
 * 方案：用 Node 官方 `AsyncLocalStorage` 建立一条随异步调用链自动传播的来源上下文。
 * 子代理的工具执行在外层 `withApprovalSource(...)` 包裹，于是该子代理内所有工具调用
 * （含嵌套异步、Promise.all 并发）都能读到正确来源，无需逐个工具改签名，并发安全。
 * 定义在本模块内以避免与 approval.ts 形成循环依赖；对外由 `approvalSource.ts` 提供包装 API。
 */
const sourceStorage = new AsyncLocalStorage<ApprovalSource>()

/** 在指定来源下执行一段异步逻辑；期间所有 requireUserApproval 都会带上该来源。 */
export function withApprovalSource<T>(source: ApprovalSource, fn: () => T): T {
  return sourceStorage.run(source, fn)
}

/** 读取当前异步上下文中的批准来源；不在任何包裹中时返回主 agent。 */
export function readApprovalSourceContext(): ApprovalSource {
  return sourceStorage.getStore() ?? { origin: 'main' }
}

/** 批准请求的发起来源：谁在申请这个副作用动作。 */
export interface ApprovalSource {
  /** 直接发起方：主 agent 或某个被委派的子代理。 */
  readonly origin: 'main' | 'subagent'
  /** 子代理标识（origin === 'subagent' 时存在）。 */
  readonly subagentId?: string
  /** 子代理展示名（用于批准卡「来自：X」）。 */
  readonly subagentLabel?: string
}

export interface ApprovalPrompt {
  /** 发起确认的工具名。 */
  readonly tool: string
  /** 一句话动作摘要（渲染层展示）。 */
  readonly summary: string
  /** 可选细节（参数/路径等，渲染层可折叠展示）。 */
  readonly detail?: string
  /** 发起来源（C3：让用户在批准卡上看到「谁在申请」）。缺省视为主 agent。 */
  readonly source?: ApprovalSource
}

export interface ApprovalRequest extends ApprovalPrompt {
  readonly id: string
  readonly at: number
}

const APPROVAL_TIMEOUT_MS = 120_000

type Sender = (request: ApprovalRequest) => void

/**
 * 批准裁决器：测试环境可在无 GUI 下装「假渲染层」自动裁决。
 * 一旦装过（即使之后重置为 null）也视为「已有明确裁决通道」，不再走无通道拒绝分支。
 */
let sender: Sender | null = null
let negotiated = false
const pending = new Map<string, { resolve: (allow: boolean) => void; timer: NodeJS.Timeout }>()

/** 由 IPC 层注册：把批准请求推给渲染进程（生产环境）。 */
export function setApprovalSender(fn: Sender): void {
  sender = fn
  negotiated = true
}

/**
 * 测试专用：装一个绕过 IPC 的自动裁决器。
 * 与 {@link setApprovalSender} 的区别是语义上明确「无人值守裁决」，用于离线测试全链路。
 */
export function setApprovalDecider(fn: (request: ApprovalRequest) => boolean): void {
  sender = (request) => fn(request)
  negotiated = true
}

/** 供测试/窗口销毁时清理：解绑发送器并拒绝所有在途请求（Fail-Closed）。 */
export function resetApprovalSender(): void {
  sender = null
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer)
    entry.resolve(false)
    pending.delete(id)
  }
}

/** 请求用户批准一个副作用动作；用户放行返回 true，拒绝/超时/无通道返回 false。 */
export function requireUserApproval(prompt: ApprovalPrompt): Promise<boolean> {
  if (sender === null) {
    // Fail-Closed（C1）：没有裁决通道 = 无法获得用户授权 = 拒绝。
    // 仅当从未协商过（negotiated === false，如初始化早期的极端时序）才告警区分。
    console.warn(
      `[approval] 无批准通道，按拒绝处理工具「${prompt.tool}」：${prompt.summary}` +
        (negotiated ? '（通道已被解绑，可能在窗口销毁后）' : '（发送器尚未注册）'),
    )
    return Promise.resolve(false)
  }
  const id = randomUUID()
  // C3：来源优先取显式传入；否则从 AsyncLocalStorage 读当前异步链的委派来源（子代理场景）。
  const source: ApprovalSource = prompt.source ?? readApprovalSourceContext()
  const request: ApprovalRequest = { ...prompt, source, id, at: Date.now() }
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
