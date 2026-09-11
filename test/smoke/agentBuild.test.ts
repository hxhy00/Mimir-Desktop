/**
 * 无头冒烟测试 ①：agent 图构建（不需要真实模型、不需要 GUI）。
 *
 * 价值：agent 的工具/中间件类问题**在构建图的那一刻就会抛错**（例如自定义工具与
 * deepagents 内置工具撞名会抛 MiddlewareError），根本不需要真的调用工具。
 * 因此「构建一次 agent 并断言不抛错」是最廉价、覆盖最广的一道防线。
 *
 * 用假的 config（任意字符串 Key）即可——构建阶段不会发网络请求。
 */
import { describe, expect, it } from 'vitest'
import { createDeepAgent } from 'deepagents'
import { ChatOpenAI } from '@langchain/openai'
import { tool } from 'langchain/tools'
import { z } from 'zod'
import { MimirFsBackend } from '../../electron/agent/fsBackend'
import { loadSubAgentDefs, BUILTIN_SUBAGENTS } from '../../electron/agent/subagentRegistry'

/** 复刻 agentService.initialize 的装配方式（保持与生产一致）。 */
function buildSupervisor(): unknown {
  const model = new ChatOpenAI({
    apiKey: 'sk-test-not-used',
    model: 'test-model',
    temperature: 0.7
  })
  const memoryTool = tool(async () => 'ok', {
    name: 'load_memory',
    description: '读取长期记忆（测试桩）',
    schema: z.object({ reason: z.string().optional() })
  })
  const { agents } = loadSubAgentDefs()
  return createDeepAgent({
    model,
    systemPrompt: '你是 Mimir（测试）。',
    tools: [memoryTool] as never,
    subagents: agents.map((a) => ({
      name: a.id,
      description: a.description,
      systemPrompt: a.systemPrompt,
      tools: a.tools as never
    })) as never,
    backend: new MimirFsBackend() as never
  })
}

describe('无头冒烟：agent 图可构建（拦截中间件/撞名类错误）', () => {
  it('用生产同款装配构建 Supervisor，不抛错', () => {
    expect(() => buildSupervisor()).not.toThrow()
  })

  it('构建出的 agent 具备 invoke / streamEvents 调用面', () => {
    const agent = buildSupervisor() as {
      invoke?: unknown
      streamEvents?: unknown
    }
    expect(typeof agent.invoke).toBe('function')
    expect(typeof agent.streamEvents).toBe('function')
  })

  it('子代理注册表加载成功：内置子代理全部在场且均带工具', () => {
    const { agents, rejected } = loadSubAgentDefs()
    expect(rejected).toEqual([])
    const ids = agents.map((a) => a.id)
    for (const b of BUILTIN_SUBAGENTS) {
      expect(ids).toContain(b.id)
    }
    // 文件 Agent 至少应持有 read_dir（内置 read_file/write_file 由 middleware 注入）
    const files = agents.find((a) => a.id === 'files')
    expect(files?.tools.length).toBeGreaterThan(0)
  })

  it('回归守护：与内置同名的直属工具会被 deepagents 拒绝（重现历史踩坑）', () => {
    // 已验证的真实机制：deepagents 在构建期校验「直属自定义工具 vs 内置工具」，
    // 撞名直接抛 ConfigurationError: Tool name(s) [read_file] conflict with built-in tools.
    const model = new ChatOpenAI({ apiKey: 'sk-test-not-used', model: 'test-model', temperature: 0 })
    const clashing = tool(async () => 'x', {
      name: 'read_file',
      description: '与内置 read_file 同名（应被拒绝）',
      schema: z.object({ path: z.string() })
    })
    expect(() =>
      createDeepAgent({
        model,
        systemPrompt: 'x',
        tools: [clashing] as never
      })
    ).toThrow(/conflict with built-in tools/i)
  })
})
