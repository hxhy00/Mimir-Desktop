/**
 * 子代理「禁嵌套」防火墙（D1）。
 *
 * 问题：Mimir 采用 Supervisor 编排——主管通过 deepagents 内置 `task` 工具把子任务
 * 派给模块子代理。若**子代理自身也持有 `task`（或等价的委派工具）**，就会形成
 * 「子代理 → 子代理 → …」的递归委派：拓扑不受控（可能指数级扩散调用、成本失控、
 * 深度嵌套把一条用户消息放大成几十次模型调用），且子代理的上下文是隔离的，嵌套
 * 委派的中间结果无人可审查，属于典型的 agent 图失控。
 *
 * 现状：子代理的工具来自 `subagentRegistry` 的固定白名单（`WORKER_TOOL_CATALOG`），
 * 其中**不含**任何委派工具，因此当前结构上无法嵌套。但这个「安全」是**隐式**的——
 * 一旦将来有人往白名单里加一个会 fork 子 agent 的工具（如外部 CLI tool），嵌套就
 * 会悄然发生。本模块把这个约束**显式化、可校验、Fail-Closed**：
 *   1. {@link DELEGATION_TOOL_NAMES} 列出所有「会拉起新 agent 循环」的工具名；
 *   2. {@link assertNoDelegationTools} 在构建子代理时校验其工具集不含这些名字，
 *      命中即抛错（构建期失败优于运行期失控）；
 *   3. {@link guardSubagentTools} 作为纵深防御，在运行期包裹子代理工具，若仍被调用
 *      到委派工具则直接拒绝，避免校验被绕过。
 *
 * 参考：Claude Code 泄露源码分析结论——「限制子代理嵌套深度 / 禁止子代理再委派，
 * 防止 agent 拓扑失控」。
 */

/**
 * 会「拉起一条新 agent 循环」的工具名（委派/嵌套入口）。
 * 新增此类工具时必须登记在此，子代理的工具集才会被防火墙拦截。
 */
export const DELEGATION_TOOL_NAMES: readonly string[] = [
  'task', // deepagents 内置委派工具（createSubAgentMiddleware 注入给主管）
  'Task' // 大小写变体（不同 harness 命名习惯）
]

/** 判断某工具名是否为委派/嵌套入口。 */
export function isDelegationTool(name: string): boolean {
  return DELEGATION_TOOL_NAMES.includes(name)
}

/**
 * 构建期校验：断言子代理工具集不含委派工具（D1）。
 * @throws Error 命中委派工具时——这是配置错误，必须在构建期暴露，而非运行期失控。
 */
export function assertNoDelegationTools(
  subagentId: string,
  tools: readonly { name?: string }[]
): void {
  const offenders = tools
    .map((t) => t.name)
    .filter((n): n is string => typeof n === 'string' && isDelegationTool(n))
  if (offenders.length > 0) {
    throw new Error(
      `[delegation-firewall] 子代理「${subagentId}」的工具集包含委派工具 ${offenders.join(', ')}，` +
        '会造成子代理嵌套委派（agent 图拓扑失控）。请从该子代理的工具白名单中移除。'
    )
  }
}

/** 单个子代理工具的最小调用面（仅注册表需要的字段）。 */
interface GuardedTool {
  name?: string
  invoke(input: unknown): Promise<unknown>
}

/**
 * 运行期纵深防御（D1）：包裹子代理工具，若其中的委派工具仍被调用到，直接拒绝执行。
 * 正常情况下与 {@link assertNoDelegationTools} 冗余；此处的价值是防止校验被绕过
 * （例如工具在运行期动态改名、或未来接入未登记的委派工具）。
 * @param subagentId 子代理标识（用于拒绝文案与来源标注）
 * @param tools 该子代理解析后的工具实例
 */
export function guardSubagentTools<T extends GuardedTool>(
  subagentId: string,
  tools: readonly T[]
): T[] {
  return tools.map((tool) => {
    if (typeof tool.name !== 'string' || !isDelegationTool(tool.name)) return tool
    const guarded = Object.create(tool) as T
    guarded.invoke = async () =>
      `已拒绝：子代理「${subagentId}」不允许再委派子代理（禁止嵌套，防止 agent 拓扑失控）。` +
      '请直接把该子任务完成，或把需要上级决策的问题写进返回结果里交回主管。'
    return guarded
  })
}
