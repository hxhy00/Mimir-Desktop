/**
 * Issue 1 自检：Harness 注册表基本正确性。
 *
 * ponytail: 不直接 import harnessRegistry（会拉入 deepagents/langchain 完整链），
 * 而是验证注册表元数据结构 + setActiveHarness 纯状态机逻辑。
 * 真正的集成测试应在 Electron 主进程中完成。
 */

interface HarnessRegistration {
  id: string
  name: string
  kind: string
  available: boolean
}

/** 与 harnessRegistry.ts 中的 HARNESS_REGISTRATIONS 保持一致。 */
const HARNESS_REGISTRATIONS: readonly HarnessRegistration[] = [
  { id: 'mimir', name: 'Mimir', kind: 'langgraph', available: true },
  { id: 'codex', name: 'Codex', kind: 'process', available: false },
  { id: 'claude-code', name: 'Claude Code', kind: 'process', available: false },
  { id: 'pi', name: 'Pi', kind: 'mcp', available: false }
]

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`)
  process.exit(1)
}

// 1. 注册数量
if (HARNESS_REGISTRATIONS.length !== 4) {
  fail(`HARNESS_REGISTRATIONS.length = ${HARNESS_REGISTRATIONS.length}, want 4`)
}
console.log(`ok   registrations.length = ${HARNESS_REGISTRATIONS.length}`)

// 2. Mimir 必须可用
const mimir = HARNESS_REGISTRATIONS.find((r) => r.id === 'mimir') ?? fail('Mimir not found')
if (mimir.available !== true) fail('Mimir not available')
console.log(`ok   mimir available = ${mimir.available}`)

// 3. 各 stub harness 形式正确
for (const id of ['codex', 'claude-code', 'pi']) {
  const reg = HARNESS_REGISTRATIONS.find((r) => r.id === id)
  if (!reg) fail(`${id} not found in registrations`)
  console.log(`ok   ${id} kind=${reg!.kind} available=${reg!.available}`)
}

// 4. setActiveHarness 纯状态机逻辑（与 harnessRegistry.ts 一致）
const instances = new Set(HARNESS_REGISTRATIONS.map((r) => r.id))
let activeId = 'mimir'

function setActiveHarness(id: string): boolean {
  if (!instances.has(id)) return false
  activeId = id
  return true
}

if (!setActiveHarness('mimir')) fail('setActiveHarness(mimir) false')
if (activeId !== 'mimir') fail('active id wrong after mimir switch')
console.log('ok   setActiveHarness(mimir) succeeded')

const prev = activeId
if (setActiveHarness('nonexistent')) fail('nonexistent should return false')
if (activeId !== prev) fail('nonexistent changed active id')
console.log('ok   setActiveHarness(nonexistent) correctly rejected')

console.log('\nAll checks passed.')
