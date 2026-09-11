/**
 * Claude Code Skill 入口（Issue 3 Phase 1）。
 *
 * 在 Claude Code 的 skill/extension 机制下注册 Mimir 工具。
 *
 * ponytail: Phase 1 只提供骨架。
 * Claude Code 的 skill 注册方式取决于其 extension host 协议（可能类似
 * MCP 或者自定义的 skill registration API）。
 */

import { callMimirBridge } from './bridgeClient'

/** 工具定义列表。 */
export const CLAUDE_CODE_SKILLS = [
  {
    name: 'mimir_library_list',
    description: '列出 Mimir 文献库中的所有论文',
    bridgePath: '/api/library/papers',
    method: 'GET' as const
  },
  {
    name: 'mimir_library_projects',
    description: '列出 Mimir 文献库中的所有项目',
    bridgePath: '/api/library/projects',
    method: 'GET' as const
  },
  {
    name: 'mimir_figures_list',
    description: '列出 Mimir 图表库中的所有图片',
    bridgePath: '/api/figures/list',
    method: 'GET' as const
  },
  {
    name: 'mimir_meetings_list',
    description: '列出所有已生成的组会 PPT',
    bridgePath: '/api/meetings/list',
    method: 'GET' as const
  },
  {
    name: 'mimir_venues_list',
    description: '查询 CCF 会议截稿列表',
    bridgePath: '/api/venues/list',
    method: 'GET' as const
  }
]

/**
 * Claude Code 扩展初始化函数。
 *
 * ponytail: 输出工具清单供后续填充真实注册逻辑。
 */
export async function initializeClaudeCodeSkill(): Promise<void> {
  try {
    await callMimirBridge('GET', '/health')
    console.log(`[claude-code-skill] Mimir 桥接服务可用`)
    console.log(`[claude-code-skill] 已注册 ${CLAUDE_CODE_SKILLS.length} 个工具：`)
    for (const skill of CLAUDE_CODE_SKILLS) {
      console.log(`  - ${skill.name}: ${skill.description}`)
    }
  } catch {
    console.error('[claude-code-skill] Mimir 桥接服务不可用，请先启动 Mimir Desktop')
  }
}
