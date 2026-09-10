/**
 * Codex Extension 入口（Issue 3 Phase 1）。
 *
 * 在 Codex 的 extension/plugin 机制下注册 Mimir 工具。
 * 这个文件是 Codex 扩展的初始化入口，负责：
 * 1. 连接到 Mimir 桥接服务（通过 ~/.mimir/bridge.json 发现端口）
 * 2. 把 Mimir 的科研能力注册为 Codex 工具
 *
 * ponytail: Phase 1 只提供骨架和工具注册说明。
 * 真正的 Codex 扩展 API 取决于 Codex 的 extension host 协议。
 *
 * 工具注册方式（占位）：
 *   codex.registerTool({
 *     name: 'mimir_library_list',
 *     description: '列出 Mimir 文献库中的所有论文',
 *     execute: async (args) => callMimirBridge('GET', '/api/library/papers')
 *   })
 */

import { callMimirBridge } from './bridgeClient'

/** 工具定义列表（与 MCP 共享同一套工具元数据）。 */
export const CODEX_TOOLS = [
  {
    name: 'mimir_library_list',
    description: '列出 Mimir 文献库中的所有论文',
    bridgePath: '/api/library/papers',
    method: 'GET' as const,
    sideEffect: 'read' as const
  },
  {
    name: 'mimir_library_projects',
    description: '列出 Mimir 文献库中的所有项目',
    bridgePath: '/api/library/projects',
    method: 'GET' as const,
    sideEffect: 'read' as const
  },
  {
    name: 'mimir_figures_list',
    description: '列出 Mimir 图表库中的所有图片',
    bridgePath: '/api/figures/list',
    method: 'GET' as const,
    sideEffect: 'read' as const
  },
  {
    name: 'mimir_meetings_list',
    description: '列出所有已生成的组会 PPT',
    bridgePath: '/api/meetings/list',
    method: 'GET' as const,
    sideEffect: 'read' as const
  },
  {
    name: 'mimir_venues_list',
    description: '查询 CCF 会议截稿列表',
    bridgePath: '/api/venues/list',
    method: 'GET' as const,
    sideEffect: 'read' as const
  }
]

/**
 * Codex 扩展初始化函数。
 *
 * 在真实的 Codex 扩展环境中，这里会调用 Codex 的 extension API：
 *   codex.registerTool({ name, description, execute })
 *
 * 当前 Phase 1 只输出工具注册清单，供后续填充。
 */
export async function initializeCodexExtension(): Promise<void> {
  const ok = await callMimirBridge('GET', '/health').then(() => true).catch(() => false)
  if (!ok) {
    console.error('[codex-extension] Mimir 桥接服务不可用，请先启动 Mimir Desktop')
    return
  }

  console.log(`[codex-extension] Mimir 桥接服务可用`)
  console.log(`[codex-extension] 已注册 ${CODEX_TOOLS.length} 个工具：`)
  for (const tool of CODEX_TOOLS) {
    console.log(`  - ${tool.name}: ${tool.description}`)
  }
}
