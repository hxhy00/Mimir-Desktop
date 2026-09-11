/**
 * Harness 注册表：管理可用 harness 的实例和当前选中项。
 *
 * ponytail: 当前只有 Mimir harness 是可运行的；Codex/Claude Code/Pi 只在 UI 中
 * 展示为灰色「即将支持」占位项。用户选中 Mimir 时走完整流程；选中其它 harness
 * 时上层收到「尚未支持」错误。
 */

import type { HarnessAdapter, HarnessRegistration } from './harness.ts'
import { MimirHarness } from './harnesses/mimir.ts'
import { CodexHarness } from './harnesses/codex.ts'
import { ClaudeCodeHarness } from './harnesses/claudeCode.ts'
import { PiHarness } from './harnesses/pi.ts'

/** 所有已注册的 harness（实例共享，避免重复创建）。 */
const HARNESS_INSTANCES: Map<string, HarnessAdapter> = new Map<string, HarnessAdapter>([
  ['mimir', new MimirHarness()],
  ['codex', new CodexHarness()],
  ['claude-code', new ClaudeCodeHarness()],
  ['pi', new PiHarness()]
])

/** 当前激活的 harness id（默认 Mimir，可由设置页切换）。 */
let activeHarnessId = 'mimir'

/** 注册表元数据（UI 展示用）。 */
export const HARNESS_REGISTRATIONS: readonly HarnessRegistration[] = [
  { id: 'mimir', name: 'Mimir', kind: 'langgraph', available: true },
  { id: 'codex', name: 'Codex', kind: 'process', available: false },
  { id: 'claude-code', name: 'Claude Code', kind: 'process', available: false },
  { id: 'pi', name: 'Pi', kind: 'mcp', available: false }
]

/** 获取当前激活的 HarnessAdapter 实例。 */
export function getActiveHarness(): HarnessAdapter {
  return HARNESS_INSTANCES.get(activeHarnessId) ?? HARNESS_INSTANCES.get('mimir')!
}

/** 获取指定 id 的 HarnessAdapter 实例（不存在时返回 null）。 */
export function getHarnessById(id: string): HarnessAdapter | null {
  return HARNESS_INSTANCES.get(id) ?? null
}

/** 设置当前激活的 harness id；无效 id 不做更改，返回 false。 */
export function setActiveHarness(id: string): boolean {
  if (!HARNESS_INSTANCES.has(id)) return false
  activeHarnessId = id
  return true
}

/** 获取当前激活的 harness id。 */
export function getActiveHarnessId(): string {
  return activeHarnessId
}

/** 从 settings 对象中读取 selectedHarness 字段并激活。 */
export function applyHarnessFromSettings(settings: Record<string, unknown>): void {
  const raw = settings.selectedHarness
  if (typeof raw === 'string' && HARNESS_INSTANCES.has(raw)) {
    activeHarnessId = raw
  }
}
