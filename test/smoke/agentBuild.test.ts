/**
 * 无头冒烟测试 ①：主 Agent + 能力域子代理图构建（不需要真实模型、不需要 GUI）。
 *
 * 价值：agent 的工具/中间件类问题**在构建图的那一刻就会抛错**（例如自定义工具与
 * deepagents 内置工具撞名会抛 MiddlewareError），根本不需要真的调用工具。
 * 因此「构建一次 agent 并断言不抛错」是最廉价、覆盖最广的一道防线。
 *
 * 装配方式复刻 agentService.initialize 的**主 Agent + 可委派子代理**形态：
 * 一个主 Agent 持有全部能力域工具 + 只读记忆工具，同时把每个能力域编译成 `subagents`
 * （deepagents 据此注入 `task` 委派工具）。用假的 config（任意字符串 Key）即可——
 * 构建阶段不会发网络请求。
 */
import { describe, expect, it } from 'vitest'
import { createDeepAgent } from 'deepagents'
import { ChatOpenAI } from '@langchain/openai'
import { tool } from 'langchain/tools'
import { z } from 'zod'
import { MimirFsBackend } from '../../electron/agent/fsBackend'
import {
  loadCapabilityDomains,
  resolveAllWorkerTools,
  buildDomainSubagents,
  buildSubagentPrompt,
  BUILTIN_DOMAINS
} from '../../electron/agent/capabilityDomains'
import { assertNoDelegationTools, guardSubagentTools } from '../../electron/agent/delegationFirewall'

/** 工具最小调用面（与生产一致：能力域工具均实现了 invoke）。 */
interface ToolLike {
  name: string
  invoke(input: unknown): Promise<unknown>
}

/** 复刻 agentService.initialize 的主 Agent + 子代理装配（与生产一致）。 */
function buildMainAgent(): unknown {
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
  // 主 Agent 工具集：全部能力域工具。depth=0 → 允许持有 task（委派入口）。
  const raw = resolveAllWorkerTools() as ToolLike[]
  assertNoDelegationTools('main-agent', raw, { depth: 0 })
  const tools = guardSubagentTools('main-agent', raw, { depth: 0 })
  // 能力域 → 子代理：与生产同款，逐个以 depth>=1 过防火墙（禁递归委派）。
  const { domains } = loadCapabilityDomains()
  const subagents = buildDomainSubagents(domains)
  for (const spec of subagents) {
    assertNoDelegationTools(`subagent:${spec.name}`, spec.tools as { name?: string }[], {
      depth: 1
    })
    guardSubagentTools(`subagent:${spec.name}`, spec.tools as ToolLike[], { depth: 1 })
  }
  return createDeepAgent({
    model,
    systemPrompt: '你是 Mimir（测试）。',
    tools: [memoryTool, ...tools] as never,
    subagents: subagents as never,
    backend: new MimirFsBackend() as never
  })
}

describe('无头冒烟：主 Agent + 子代理图可构建（拦截中间件/撞名/委派配置类错误）', () => {
  it('用生产同款装配构建主 Agent（含 subagents），不抛错', () => {
    expect(() => buildMainAgent()).not.toThrow()
  })

  it('构建出的 agent 具备 invoke / streamEvents 调用面', () => {
    const agent = buildMainAgent() as {
      invoke?: unknown
      streamEvents?: unknown
    }
    expect(typeof agent.invoke).toBe('function')
    expect(typeof agent.streamEvents).toBe('function')
  })

  it('每个内置能力域都编译出合法子代理：name/description/systemPrompt 非空且 mode=isolated', () => {
    const { domains } = loadCapabilityDomains()
    const specs = buildDomainSubagents(domains)
    // 内置 6 域至少都在（自定义域可能追加）
    expect(specs.length).toBeGreaterThanOrEqual(BUILTIN_DOMAINS.length)
    const ids = specs.map((s) => s.name)
    for (const b of BUILTIN_DOMAINS) {
      // 保护意图：每个内置能力域都必须真的能作为一个可委派子代理被拉起
      expect(ids).toContain(b.id)
      const spec = specs.find((s) => s.name === b.id)
      expect(spec?.description.length ?? 0).toBeGreaterThan(0)
      expect(spec?.systemPrompt.length ?? 0).toBeGreaterThan(0)
      expect(spec?.mode).toBe('isolated')
      expect(spec?.tools.length ?? 0).toBeGreaterThan(0)
    }
  })

  it('委派时机说明包含「不要委派小事」的反向提示（防止简单任务也走一遍往返）', () => {
    const { domains } = loadCapabilityDomains()
    for (const spec of buildDomainSubagents(domains)) {
      expect(spec.description).toMatch(/不要委派|直接调用/)
    }
  })

  it('能力域加载成功：内置能力域全部在场，且每个都至少解析出 1 个工具', () => {
    const { domains, rejected } = loadCapabilityDomains()
    expect(rejected).toEqual([])
    const ids = domains.map((d) => d.id)
    for (const b of BUILTIN_DOMAINS) {
      expect(ids).toContain(b.id)
      // 保护意图：能力覆盖不出现空洞——每个内置能力域都要有真实工具落地
      const domain = domains.find((d) => d.id === b.id)
      expect(domain?.tools.length ?? 0).toBeGreaterThan(0)
    }
  })

  it('每个内置能力域都有职业岗位名，且委派说明以职业身份开场', () => {
    const { domains } = loadCapabilityDomains()
    for (const b of BUILTIN_DOMAINS) {
      // 职业名不能退回成工具口径（括号里的能力描述）
      expect(b.role.trim().length).toBeGreaterThan(0)
      expect(b.role).not.toMatch(/工具|检索员|专家/)
      const spec = buildDomainSubagents(domains).find((s) => s.name === b.id)
      // 主 Agent 只凭 description 决定委派给谁，必须以「职业身份：职责」开场
      expect(spec?.description.startsWith(`「${b.role}」`)).toBe(true)
    }
  })

  it('归档类工具归实验管理员（职责划分，非工具种类划分）', () => {
    const experiment = BUILTIN_DOMAINS.find((b) => b.id === 'experiment')
    expect(experiment?.role).toBe('实验管理员')
    // paper_fetch/set_paper 是数据归档动作 → 归管理员；研究员只负责调研
    expect(experiment?.toolIds).toEqual(expect.arrayContaining(['paper_fetch', 'set_paper']))
    const literature = BUILTIN_DOMAINS.find((b) => b.id === 'literature')
    expect(literature?.toolIds).not.toContain('paper_fetch')
  })

  it('每个职业角色的提示词都写明「不做什么」的边界', () => {
    const { domains } = loadCapabilityDomains()
    for (const b of BUILTIN_DOMAINS) {
      const prompt = buildSubagentPrompt(domains.find((d) => d.id === b.id)!)
      // 岗位说明书三要素：身份 / 准则 / 边界
      expect(prompt).toMatch(/# 你不做什么/)
      expect(prompt).toMatch(/# 交付格式/)
    }
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
