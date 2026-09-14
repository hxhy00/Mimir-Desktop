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
 *   原样展示，让用户能区分「主 Agent 直接调用」与「能力域工具链内部发起」（C3）。
 * - 同一时刻允许多个 pending（理论极少并发），各自独立超时；
 * - 等待超时（默认 120s）按「拒绝」处理，工具返回已取消文案，避免永远挂死。
 */
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { loadPolicy, recordAudit } from './permissionService'

/**
 * 批准卡「来源标识」的传递通道（C3）。
 *
 * 副作用工具内部调用 {@link requireUserApproval} 时并不知道自己是「主 Agent 直接调用」
 * 还是「能力域工具链内部发起」；渲染层批准卡因此无法告诉用户「谁在申请」。
 *
 * 方案：用 Node 官方 `AsyncLocalStorage` 建立一条随异步调用链自动传播的来源上下文。
 * 能力域工具链的执行在外层 `withApprovalSource(...)` 包裹，于是该链内所有工具调用
 * （含嵌套异步、Promise.all 并发）都能读到正确来源，无需逐个工具改签名，并发安全。
 * `AsyncLocalStorage` 及 `withApprovalSource` / `readApprovalSourceContext` 均定义在 approval.ts 本体内；
 * 生产侧由 agentService.ts 的工具包装器（withToolTrace）调用 `withApprovalSource` 注入来源，
 * 不存在额外的 approvalSource.ts 转发层。
 */
const sourceStorage = new AsyncLocalStorage<ApprovalSource>()

/** 在指定来源下执行一段异步逻辑；期间所有 requireUserApproval 都会带上该来源。 */
export function withApprovalSource<T>(source: ApprovalSource, fn: () => T): T {
  return sourceStorage.run(source, fn)
}

/** 读取当前异步上下文中的批准来源；不在任何包裹中时返回主 Agent。 */
export function readApprovalSourceContext(): ApprovalSource {
  return sourceStorage.getStore() ?? { origin: 'main' }
}

/** 批准请求的发起来源：谁在申请这个副作用动作。 */
export interface ApprovalSource {
  /** 直接发起方：主 Agent，或某个能力域工具链内部。
   *  字段名 `subagent` 为历史命名，语义为「来自能力域工具链内部」。 */
  readonly origin: 'main' | 'subagent'
  /** 能力域标识（origin === 'subagent' 时存在；`subagentId` 为历史字段名）。 */
  readonly subagentId?: string
  /** 能力域展示名（用于批准卡「来自：X」；`subagentLabel` 为历史字段名）。 */
  readonly subagentLabel?: string
}

export interface ApprovalPrompt {
  /** 发起确认的工具名。 */
  readonly tool: string
  /** 一句话动作摘要（渲染层展示）。 */
  readonly summary: string
  /** 可选细节（参数/路径等，渲染层可折叠展示）。 */
  readonly detail?: string
  /** 发起来源（C3：让用户在批准卡上看到「谁在申请」）。缺省视为主 Agent。 */
  readonly source?: ApprovalSource
  /**
   * 该请求是否支持「允许并记住」。
   *
   * 只有能把这次放行**落成策略**的调用方才应置 true（例如文件后端记住目录）。
   * 其余工具（实验记录、PPT 生成等）没有可记忆的维度，前端不应给出误导性的第三个按钮。
   */
  readonly rememberable?: boolean
}

export interface ApprovalRequest extends ApprovalPrompt {
  readonly id: string
  readonly at: number
}

/**
 * 批准结果（三态交互的载体）。
 *
 * `remember` 是「允许并记住」：把这一次的放行升级为**这一类的允许**（由调用方落成策略，
 * 例如写入批准卡上的「记住该目录」）。它是解决**批准疲劳**的关键 —— 只给「允许一次」
 * 会让同类动作反复弹卡，最终把人训练成无脑点是，安全性反而下降。
 */
export interface ApprovalOutcome {
  allow: boolean
  remember: boolean
}

/** 拒绝 / 超时 / 无通道的统一结果（Fail-Closed）。 */
const DENIED: ApprovalOutcome = { allow: false, remember: false }

const APPROVAL_TIMEOUT_MS = 120_000

type Sender = (request: ApprovalRequest) => void

/**
 * 批准裁决器：测试环境可在无 GUI 下装「假渲染层」自动裁决。
 * 一旦装过（即使之后重置为 null）也视为「已有明确裁决通道」，不再走无通道拒绝分支。
 */
let sender: Sender | null = null
let negotiated = false
const pending = new Map<string, { resolve: (outcome: ApprovalOutcome) => void; timer: NodeJS.Timeout }>()

/** 由 IPC 层注册：把批准请求推给渲染进程（生产环境）。 */
export function setApprovalSender(fn: Sender): void {
  sender = fn
  negotiated = true
}

/**
 * 测试专用：装一个「无人值守裁决器」——收到请求即按 `fn` 的返回值裁决。
 * 与 {@link setApprovalSender} 的区别：它自己就把 pending 结掉，测试不必手动回填。
 */
export function setApprovalDecider(fn: (request: ApprovalRequest) => boolean): void {
  sender = (request) => {
    queueMicrotask(() => settleApproval(request.id, fn(request)))
  }
  negotiated = true
}

/** 供测试/窗口销毁时清理：解绑发送器并拒绝所有在途请求（Fail-Closed）。 */
export function resetApprovalSender(): void {
  sender = null
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer)
    entry.resolve(DENIED)
    pending.delete(id)
  }
}

/**
 * 请求用户批准一个副作用动作，返回**三态结果**（是否放行 + 是否记住）。
 *
 * 这是实现的真身；{@link requireUserApproval} 是它的布尔便捷版 —— 绝大多数工具只需要
 * 「放行 / 不放行」，只有能落成策略的调用方（如文件后端记住目录）才需要 `remember`。
 */
export function requireUserApprovalDetailed(prompt: ApprovalPrompt): Promise<ApprovalOutcome> {
  if (sender === null) {
    // Fail-Closed（C1）：没有裁决通道 = 无法获得用户授权 = 拒绝。
    // 仅当从未协商过（negotiated === false，如初始化早期的极端时序）才告警区分。
    console.warn(
      `[approval] 无批准通道，按拒绝处理工具「${prompt.tool}」：${prompt.summary}` +
        (negotiated ? '（通道已被解绑，可能在窗口销毁后）' : '（发送器尚未注册）'),
    )
    return Promise.resolve(DENIED)
  }
  const id = randomUUID()
  // C3：来源优先取显式传入；否则从 AsyncLocalStorage 读当前异步链的来源（能力域场景）。
  const source: ApprovalSource = prompt.source ?? readApprovalSourceContext()
  const request: ApprovalRequest = { ...prompt, source, id, at: Date.now() }
  const deliver: Sender = sender
  return new Promise<ApprovalOutcome>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve(DENIED) // 超时按拒绝（Fail-Closed）
    }, APPROVAL_TIMEOUT_MS)
    pending.set(id, { resolve, timer })
    deliver(request)
  })
}

/** 请求用户批准一个副作用动作；用户放行返回 true，拒绝/超时/无通道返回 false。 */
export async function requireUserApproval(prompt: ApprovalPrompt): Promise<boolean> {
  return (await requireUserApprovalDetailed(prompt)).allow
}

/**
 * 「危险动作」判定：不可撤销或影响面大的操作，**任何档位都要弹卡**。
 *
 * 全权档（danger-full-access）的语义对齐 Codex：「除自我提权外不问」，但删除类操作
 * 不在豁免之列——误删一篇论文 / 一张图 / 一条记录没有后悔药，静默放行的风险不对称。
 *
 * 识别口径是批准卡的 `summary` **必须以破坏性动词开头**（删除 / 移除 / 清空）。
 * 之所以看 summary 而不是全文扫描：detail 常含解释性文字（如 latex 编译的"不修改你的
 * 源文件"），关键词全文匹配会把非破坏动作误判成破坏、错误地保留弹卡。
 * 各工具构造确认卡时删除类动作统一以「删除」开头描述（见 experiments / figures /
 * ledger / paperTools）；新增删除类工具沿用该措辞即自动纳入。
 */
const DESTRUCTIVE_PREFIX_RE = /^\s*(删除|移除|清空)/
export function isDestructiveApproval(prompt: ApprovalPrompt): boolean {
  return DESTRUCTIVE_PREFIX_RE.test(prompt.summary ?? '')
}

/**
 * 业务动作批准卡是否会被「全权档」自动放行（纯判定，供设置页提示与单测复用）。
 * 口径与 {@link requireBusinessApproval} 一致：非破坏性 + 当前档位为 danger-full-access。
 */
export function wouldAutoApproveUnderFullAccess(
  prompt: ApprovalPrompt,
  policy: { sandbox: string }
): boolean {
  return !isDestructiveApproval(prompt) && policy.sandbox === 'danger-full-access'
}

/**
 * 业务动作批准卡的档位感知入口（非文件系统的工具用）。
 *
 * 背景：权限矩阵落地时只接管了文件读写（fsBackend → decidePermission），而文献入库、
 * PPT 生成、LaTeX 编译这类「业务副作用卡」在各工具里硬编码为**无条件弹卡**——于是出现
 * 「设了全权档还被反复要求点批准」的失配。本函数把沙箱档位接进这条路径：
 * - 全权档：非破坏性动作直接放行（记审计 decision=allow, resolved=auto，让设置页看得见
 *   「哪些卡被档位跳过了」——放行必须可追溯，这是「问一次换不问了」的前提）；
 * - 破坏性动作（删除/不可撤销）与其余档位：照常弹卡。
 *
 * store 读取失败时按「弹卡」处理（fail-closed），不因策略读不到而意外放行。
 */
export async function requireBusinessApproval(prompt: ApprovalPrompt): Promise<boolean> {
  if (!isDestructiveApproval(prompt)) {
    try {
      if (loadPolicy().sandbox === 'danger-full-access') {
        // decision=allow + 不写 resolved：语义是「档位自动放行、未经人工裁决」，
        // 与「用户点了允许（resolved=allow）」区分开，审计里能看出哪些卡被档位跳过。
        recordAudit({
          at: new Date().toISOString(),
          action: 'write',
          target: `business:${prompt.tool}`,
          decision: 'allow'
        })
        return true
      }
    } catch {
      // 读不到策略 → 不放行，继续走弹卡
    }
  }
  return requireUserApproval(prompt)
}

/** 渲染层经 IPC 回填结果；`remember` 为「允许并记住」（调用方据此落成策略）。 */
export function settleApproval(id: string, allow: boolean, remember = false): void {
  const entry = pending.get(id)
  if (entry === undefined) return
  clearTimeout(entry.timer)
  pending.delete(id)
  entry.resolve(allow === true ? { allow: true, remember: remember === true } : DENIED)
}

/** 供渲染层/测试展示超时时长（毫秒）。 */
export const approvalTimeoutMs = APPROVAL_TIMEOUT_MS
