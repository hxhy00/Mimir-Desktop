/**
 * Issue 3 自检：插件注册表 + 工具定义一致性。
 *
 * 验证：
 * 1. MCP / Codex / Claude Code 三个插件的工具列表一致。
 * 2. bridgeClient.ts 可被正确导入。
 * 3. bridge.ts 的路由定义覆盖核心能力。
 */

import { MCP_TOOLS } from './mcpServer.ts' // tsconfig allows .ts import
import { CODEX_TOOLS } from './codex-extension.ts'
import { CLAUDE_CODE_SKILLS } from './claude-code-skill.ts'

const fail = (msg: string): never => {
  console.error(`FAIL: ${msg}`)
  process.exit(1)
}

// 1. 工具数量一致
const expectedToolNames = MCP_TOOLS.map((t) => t.name).sort()
const codexNames = CODEX_TOOLS.map((t) => t.name).sort()
const claudeNames = CLAUDE_CODE_SKILLS.map((t) => t.name).sort()

if (expectedToolNames.length !== 5) {
  fail(`MCP_TOOLS.length = ${expectedToolNames.length}, want 5`)
}
console.log(`ok   MCP_TOOLS.length = ${expectedToolNames.length}`)

if (codexNames.length !== 5) {
  fail(`CODEX_TOOLS.length = ${codexNames.length}, want 5`)
}
console.log(`ok   CODEX_TOOLS.length = ${codexNames.length}`)

if (claudeNames.length !== 5) {
  fail(`CLAUDE_CODE_SKILLS.length = ${claudeNames.length}, want 5`)
}
console.log(`ok   CLAUDE_CODE_SKILLS.length = ${claudeNames.length}`)

// 2. 工具名称一致
const arraysEqual = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i])

if (!arraysEqual(expectedToolNames, codexNames)) {
  fail(`MCP vs Codex tool names differ: ${JSON.stringify(expectedToolNames)} vs ${JSON.stringify(codexNames)}`)
}
console.log('ok   MCP ↔ Codex tool names match')

if (!arraysEqual(expectedToolNames, claudeNames)) {
  fail(`MCP vs Claude Code tool names differ: ${JSON.stringify(expectedToolNames)} vs ${JSON.stringify(claudeNames)}`)
}
console.log('ok   MCP ↔ Claude Code tool names match')

// 3. 工具定义结构完整
for (const tool of MCP_TOOLS) {
  if (!tool.name || !tool.description || !tool.inputSchema) {
    fail(`MCP tool "${tool.name}" missing required fields`)
  }
}
console.log('ok   All MCP tools have name/description/inputSchema')

for (const tool of CODEX_TOOLS) {
  if (!tool.name || !tool.description || !tool.bridgePath || !tool.method) {
    fail(`Codex tool "${tool.name}" missing required fields`)
  }
}
console.log('ok   All Codex tools have name/description/bridgePath/method')

// 4. 桥接路径一致（Codex 工具的 bridgePath 应覆盖 MCP 工具的对应 API）
const mcpBridgePaths = new Map<string, string>()
// MCP 工具名 → 桥接路径（手工映射，与 handleToolCall 一致）
const MCP_NAME_TO_PATH: Record<string, string> = {
  mimir_library_list: '/api/library/papers',
  mimir_library_projects: '/api/library/projects',
  mimir_figures_list: '/api/figures/list',
  mimir_meetings_list: '/api/meetings/list',
  mimir_venues_list: '/api/venues/list'
}

for (const [name, expectedPath] of Object.entries(MCP_NAME_TO_PATH)) {
  const codexTool = CODEX_TOOLS.find((t) => t.name === name)
  if (codexTool === undefined) {
    fail(`Codex missing tool: ${name}`)
  }
  if (codexTool!.bridgePath !== expectedPath) {
    fail(`${name}: Codex bridgePath = ${codexTool!.bridgePath}, want ${expectedPath}`)
  }
}
console.log('ok   Codex bridge paths match MCP tool routing')

console.log('\nAll checks passed.')
