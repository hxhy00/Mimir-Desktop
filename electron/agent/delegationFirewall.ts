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
 *   2. {@link assertNoDelegationTools} 构建期校验：按 depth 判断是否越权，命中即抛错
 *      （构建期失败优于运行期失控）；
 *   3. {@link guardSubagentTools} 运行期兜底：同样按 depth 判断，防止构建期校验被绕过。
 *
 * 参考：Claude Code 源码分析结论——「限制嵌套深度 / 禁止再拉起新 agent，防止 agent 拓扑失控」。
 */

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

/** 断言工具集持有者的层级是否允许携带委派工具。 */
export interface DelegationScope {
  /**
   * 该工具集在委派树中的层级：0 = 主 Agent（允许 task），≥1 = 子代理（禁止 task）。
   * 省略时按 {@link DELEGATION_ALLOWED_DEPTH} 判定，即「主 Agent 可委派」。
   */
  depth?: number
}

/**
 * 构建期校验：断言工具集不含越权的嵌套入口工具（D1）。
 *
 * @param ownerId 工具集归属标识（用于报错文案）
 * @param tools 待校验的工具集
 * @param scope 层级约束；`depth: 0` 表示主 Agent（放行 `task`），`depth >= 1` 表示子代理（拦截）
 * @throws Error 命中越权的嵌套入口工具时——这是配置错误，必须在构建期暴露，而非运行期失控。
 */
export function assertNoDelegationTools(
  ownerId: string,
  tools: readonly { name?: string }[],
  scope: DelegationScope = {}
): void {
  const depth = scope.depth ?? 0
  // 主 Agent 层级允许持有委派工具：这是「可委派」的入口，不视为违规。
  if (depth < DELEGATION_ALLOWED_DEPTH) return
  const offenders = tools
    .map((t) => t.name)
    .filter((n): n is string => typeof n === 'string' && isDelegationTool(n))
  if (offenders.length > 0) {
    throw new Error(
      `[delegation-firewall]「${ownerId}」的工具集包含嵌套入口工具 ${offenders.join(', ')}，` +
        '会造成递归委派（agent 图拓扑失控）。子代理不得再持有 task，请从该工具集中移除。'
    )
  }
}

/** 单个工具的最小调用面（仅防火墙需要的字段）。 */
export interface GuardedTool {
  name?: string
  invoke(input: unknown): Promise<unknown>
}

/**
 * 运行期纵深防御（D1）：包裹工具，若其中的嵌套入口工具仍被调用到，直接拒绝执行。
 * 正常情况下与 {@link assertNoDelegationTools} 冗余；此处的价值是防止校验被绕过
 * （例如工具在运行期动态改名、或未来接入未登记的嵌套入口）。
 * @param ownerId 工具集归属标识（用于拒绝文案）
 * @param tools 解析后的工具实例
 */
export function guardSubagentTools<T extends GuardedTool>(
  ownerId: string,
  tools: readonly T[],
  scope: DelegationScope = {}
): T[] {
  const depth = scope.depth ?? 0
  // 主 Agent 层级放行：委派工具是合法入口，不应被拦截。
  if (depth < DELEGATION_ALLOWED_DEPTH) return [...tools]
  return tools.map((tool) => {
    if (typeof tool.name !== 'string' || !isDelegationTool(tool.name)) return tool
    const guarded = Object.create(tool) as T
    guarded.invoke = async () =>
      `已拒绝：「${ownerId}」不允许嵌套调用（防止递归委派、agent 拓扑失控）。` +
      '请直接完成该任务，或把需要用户决策的问题写进最终回复。'
    return guarded
  })
}
