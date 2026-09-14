/**
 * Agent 侧通用文本工具（纯函数，零业务依赖）。
 *
 * 抽出来的原因：这两个函数原先只长在 `agentService.ts` 里，而 `ultra.ts` 与评测执行器
 * 也需要它们。放在这里让**生产与评测共用同一份实现**，避免任一侧各写一遍导致行为漂移。
 *
 * - {@link truncateSummary}：把任意值压成单行短摘要（过程日志 / 事件文本用）；
 * - {@link humanizeAgentError}：把网关抛出的长错误压成一行可读中文（去掉 Troubleshooting URL、
 *   嵌套 JSON 等噪音），用于事件文本与用户可见的错误说明。
 */

/** 截断一段输入/输出用于过程日志。 */
export function truncateSummary(value: unknown, max = 160): string {
  let text = ''
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 把 langchain/网关的长错误压成一行可读中文（去掉 Troubleshooting URL、嵌套 JSON 等噪音）。 */
export function humanizeAgentError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (raw.length > 240) return `${raw.slice(0, 240)}…`
  return raw
}
