/**
 * 「防嵌套」防火墙（D1）。
 *
 * ── 背景变更（Supervisor → 单 Agent → 单 Agent + 可委派子代理）───────────────
 * 最初形态：主管 Agent 通过 deepagents 内置 `task` 工具把子任务派给模块子代理，若子代理
 * 自身也持有 `task`，就会形成「子代理 → 子代理 → …」的递归，拓扑不受控。
 *
 * 中间形态：架构曾去除 Supervisor，**单 Agent 直接持有全部工具**，于是本模块转为
 * 只做纵深防御（拦截任何会 fork 新 agent 的工具）。
 *
 * 当前形态：**主 Agent 恢复持有 `task`**（每轮自主决定是否把整块工作委派给能力域子代理，
 * 对齐 WorkBuddy / Trae 的默认行为）。因此本模块的约束从「一律禁止」收敛为
 * **「限制嵌套深度」**：
 *   - `depth: 0`（主 Agent）：允许持有 `task`，这是委派入口；
 *   - `depth >= 1`（子代理）：仍然禁止，杜绝递归委派。
 *
 * 三层保障不变（只是作用域随深度判定）：
 *   1. {@link DELEGATION_TOOL_NAMES} 列出所有「会拉起新 agent 循环」的工具名；
 *   2. {@link assertNoDelegationTools} 构建期校验：按**运行期真实深度**判断是否越权，
 *      命中即抛错（构建期失败优于运行期失控）；
 *   3. {@link guardSubagentTools} 运行期兜底：同样按真实深度判断，包裹后的委派入口
 *      被调用时若已在上限深度，直接拒绝执行（Fail-Closed）。
 *
 * ── 为什么必须有「运行期深度状态」（历史缺陷）────────────────────────────────
 * 旧实现把 depth 当成**调用方自报的数字**：agentService 写死 `{ depth: 0 }`、
 * buildDomainSubagents 写死 `{ depth: 1 }`，而工具集又来自静态白名单
 * （WORKER_TOOL_CATALOG 里根本不可能出现 task）。于是 `offenders` 恒为空、断言恒真通过，
 * 防火墙退化成一行注释。同时它对「工具没有 name、无法核验是不是嵌套入口」的情况
 * 一律放行（Fail-Open）——只要有人往工具集里塞未登记的东西，防线就静默失效。
 *
 * 现在：深度是**随委派调用实时进出**的状态，用 Node 官方 `AsyncLocalStorage` 承载
 * （与 approval.ts 的 `withApprovalSource` 同一机制、同一理由：异步链自动传播、
 * 并发安全，不需要在每个工具里透传参数）。每次放行一次委派入口，它的整段执行都跑在
 * depth+1 的上下文里，因此**链条内的任何再次委派都会被拒绝**，而不是靠调用方自觉。
 * 无法核验的工具（缺 name）与命中的嵌套入口一样按违规处理，不再静默放行。
 *
 * 参考：Claude Code 源码分析结论——「限制嵌套深度 / 禁止再拉起新 agent，防止 agent 拓扑失控」。
 */
import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * 会「拉起一条新 agent 循环」的工具名（嵌套入口）。
 * 新增此类工具时必须登记在此，单 Agent 的工具集才会被防火墙拦截。
 */
export const DELEGATION_TOOL_NAMES: readonly string[] = [
  'task', // deepagents 内置任务工具（createSubAgentMiddleware 注入）
  'Task' // 大小写变体（不同 harness 命名习惯）
]

/** 判断某工具名是否为嵌套入口。 */
export function isDelegationTool(name: string): boolean {
  return DELEGATION_TOOL_NAMES.includes(name)
}

/**
 * 允许持有委派工具的层级。
 *
 * 架构变更（单 Agent → 单 Agent + 可委派子代理）：
 * 主 Agent 现在**允许**持有 `task` —— 这是「主 Agent 自主决定是否委派」的入口，
 * 与 WorkBuddy / Trae 的默认形态一致。
 *
 * 但「子代理不得再持有 task」这条**不变**：否则会形成
 * 主 → 子 → 孙 → … 的递归委派，拓扑与成本不受控（Claude Code 的处理方式，
 * 即限制嵌套深度而非禁止委派）。
 */
export const DELEGATION_ALLOWED_DEPTH = 1

/**
 * 子代理层级（主 Agent 派出的第一层）常量。
 *
 * 此前调用方各自写魔法数字 `{ depth: 1 }`（capabilityDomains / 测试各写各的），
 * 口径一旦调整必漏一处。统一从这里导出，形成单点。
 */
export const SUBAGENT_DEPTH = 1

/**
 * 运行期委派深度上下文。
 *
 * 存的是「当前异步调用链处在委派树的第几层」：0 = 主 Agent（树根），1 = 第一层子代理……
 * 用 `AsyncLocalStorage` 而非模块级计数器：后者在并发委派时会互相覆盖（A 与 B 同时委派，
 * 计数器被加到 2，两边都被误判成「超过上限」/互相抵消），前者天然按调用链隔离。
 * 与 approval.ts 的 sourceStorage 完全同构。
 */
const depthStorage = new AsyncLocalStorage<number>()

/** 当前异步调用链所处的委派深度（不在任何委派上下文中时为 0，即主 Agent 层）。 */
export function currentDelegationDepth(): number {
  return depthStorage.getStore() ?? 0
}

/**
 * 在指定委派深度下执行一段逻辑：期间及其派生的所有异步调用都能读到该深度。
 *
 * 这是「随委派进入 / 退出增减」的载体——`run` 返回即自动退出该深度（等价于 -1），
 * 不需要调用方记得 finally 里回收，异常路径也不会泄漏深度。
 */
export function runAtDelegationDepth<T>(depth: number, fn: () => T): T {
  return depthStorage.run(depth, fn)
}

/** 处在 `depth` 的这一层，能否再往下开一层 agent（再派一次）。 */
export function canDelegateFrom(depth: number): boolean {
  return typeof depth === 'number' && Number.isFinite(depth) && depth < DELEGATION_ALLOWED_DEPTH
}

/** 断言工具集持有者的层级是否允许携带委派工具。 */
export interface DelegationScope {
  /**
   * 该工具集在委派树中的**静态声明层级**：0 = 主 Agent（允许 task），≥1 = 子代理（禁止 task）。
   * 省略时取运行期实际深度（见 {@link resolveDelegationDepth}），不允许以此自我降级。
   */
  depth?: number
}

/**
 * 生效深度 = **声明深度与运行期真实深度取较大者**（Fail-Closed）。
 *
 * 取「较大者」而不是相信声明值：声明值由调用方填，被人填错/漏填就会变成自我豁免
 * （这正是「恒真断言」的老路）；运行期深度无法伪造。两侧不一致时按更严的一侧处理。
 */
export function resolveDelegationDepth(scope: DelegationScope = {}): number {
  const declared =
    typeof scope.depth === 'number' && Number.isFinite(scope.depth) ? scope.depth : 0
  return Math.max(declared, currentDelegationDepth())
}

/** 委派深度超限：统一的错误类型，便于调用方区分「配置错误」与运行期异常。 */
export class DelegationDepthError extends Error {
  /** 触发拒绝的深度。 */
  readonly depth: number
  /** 被拒绝的工具集归属标识。 */
  readonly ownerId: string
  constructor(message: string, ownerId: string, depth: number) {
    super(message)
    this.name = 'DelegationDepthError'
    this.ownerId = ownerId
    this.depth = depth
  }
}

/**
 * 收集工具集里「不能证明自己不是嵌套入口」的项。
 *
 * Fail-Closed 口径：不止命中的 {@link isDelegationTool} 算违规，
 * **连名字都拿不到的工具也算** —— 无法核验即无法放行，否则往工具集里塞一个匿名对象
 * 就能绕过整条防火墙。
 */
function collectOffenders(tools: readonly { name?: string }[]): string[] {
  const offenders: string[] = []
  tools.forEach((tool, index) => {
    if (typeof tool.name !== 'string') {
      offenders.push(`<unnamed#${String(index)}>`)
      return
    }
    if (isDelegationTool(tool.name)) offenders.push(tool.name)
  })
  return offenders
}

/**
 * 构建期校验：断言工具集不含越权的嵌套入口工具（D1）。
 *
 * @param ownerId 工具集归属标识（用于报错文案）
 * @param tools 待校验的工具集
 * @param scope 层级约束；实际生效深度取「声明值」与「运行期真实深度」的较大者
 * @throws DelegationDepthError 命中越权的嵌套入口工具、或存在无法核验的工具时——
 *   这是配置错误，必须在构建期暴露，而非运行期失控。
 */
export function assertNoDelegationTools(
  ownerId: string,
  tools: readonly { name?: string }[],
  scope: DelegationScope = {}
): void {
  const depth = resolveDelegationDepth(scope)
  // 该层本身还能往下派一层 → 持有委派工具合法（主 Agent 的委派入口），不视为违规。
  if (canDelegateFrom(depth)) return
  const offenders = collectOffenders(tools)
  if (offenders.length > 0) {
    throw new DelegationDepthError(
      `[delegation-firewall]「${ownerId}」的工具集包含嵌套入口工具 ${offenders.join(', ')}，` +
        '会造成递归委派（agent 图拓扑失控）。' +
        `当前生效深度 ${depth}（上限 ${DELEGATION_ALLOWED_DEPTH}）；子代理不得再持有 task，` +
        '请从该工具集中移除。',
      ownerId,
      depth
    )
  }
}

/** 单个工具的最小调用面（仅防火墙需要的字段）。 */
export interface GuardedTool {
  name?: string
  invoke(input: unknown): Promise<unknown>
}

/**
 * 给「委派入口工具」装上深度闸门（单个工具版本）。
 *
 * 语义（Fail-Closed）：
 * - 调用时先读**运行期真实深度**（不是构造时写死的那个数字）；
 * - 深度已达上限 → 拒绝执行、记录日志，返回拒绝文案给模型（不是抛错，
 *   工具结果是要进模型上下文的，这里与批准卡的口径一致）；
 * - 深度未达上限 → 放行，但整段执行跑在 `depth + 1` 上下文里，
 *   于是**该委派内部的任何再次委派都会走到拒绝分支**，深度由状态机而非自觉保证。
 *
 * 包裹后返回的实例以原工具为原型（`Object.create`），
 * 因此 name / description / schema 等字段照常可读，不影响 deepagents 的工具注册。
 *
 * @param ownerId 工具归属标识（用于拒绝文案）
 * @param tool 被包裹的工具
 * @param scope 静态声明深度（实际以 {@link resolveDelegationDepth} 生效）
 */
export function withDelegationDepthGuard<T extends GuardedTool>(
  ownerId: string,
  tool: T,
  scope: DelegationScope = {}
): T {
  const declaredDepth =
    typeof scope.depth === 'number' && Number.isFinite(scope.depth) ? scope.depth : 0
  const guarded = Object.create(tool) as T
  guarded.invoke = async (input: unknown): Promise<unknown> => {
    const depth = Math.max(declaredDepth, currentDelegationDepth())
    if (!canDelegateFrom(depth)) {
      // 失败必须显式可见：除了返回给模型的拒绝文案，主进程日志也留痕。
      console.error(
        `[delegation-firewall] 已拒绝「${ownerId}」的委派调用：当前深度 ${String(depth)} ≥ 上限 ${String(
          DELEGATION_ALLOWED_DEPTH
        )}（防止递归委派、agent 拓扑失控）。`
      )
      return (
        `已拒绝：「${ownerId}」不允许嵌套调用（防止递归委派、agent 拓扑失控）。` +
        `当前委派深度 ${String(depth)}，上限 ${String(DELEGATION_ALLOWED_DEPTH)}。` +
        '请直接完成该任务，或把需要用户决策的问题写进最终回复。'
      )
    }
    // 放行，并在更深一层上下文里执行：退出自动回到 depth（AsyncLocalStorage 语义）。
    return runAtDelegationDepth(depth + 1, () => Promise.resolve(tool.invoke(input)))
  }
  return guarded
}

/**
 * 运行期纵深防御（D1）：逐个工具过 {@link withDelegationDepthGuard}。
 *
 * 正常情况下与 {@link assertNoDelegationTools} 冗余；此处的价值是防止校验被绕过
 * （例如工具在运行期动态改名、或未来接入未登记的嵌套入口）。
 * 非嵌套入口的工具**原实例返回**（不包一层代理，避免没必要的行为差异）。
 *
 * @param ownerId 工具集归属标识（用于拒绝文案）
 * @param tools 解析后的工具实例
 * @param scope 层级约束
 */
export function guardSubagentTools<T extends GuardedTool>(
  ownerId: string,
  tools: readonly T[],
  scope: DelegationScope = {}
): T[] {
  return tools.map((tool) => {
    // 无法核验 + 命中清单：两种都按「可能是嵌套入口」上闸门，由运行期根据真实深度裁决。
    if (typeof tool.name === 'string' && !isDelegationTool(tool.name)) return tool
    return withDelegationDepthGuard(ownerId, tool, scope)
  })
}
