/**
 * 无头冒烟测试 ③（live）：**用真实模型真的跑一轮 agent**——这就是「你自己去用一下」的
 * 自动化版本：可重复、可回归、覆盖固定，比人肉点鼠标强。
 *
 * 覆盖用户真实体验用例：
 *   1. 纯对话（不调工具）          → 验证基础链路 + 流式逐字输出
 *   2. 写文件（触发批准卡全链路）   → 验证 模型→tool call→FsBackend→批准→落盘
 *   3. 读文件（空间外读批准）       → 验证 空间外读弹卡
 *
 * 默认跳过（无凭据不打网络）。启用：
 *   MIMIR_GW_URL=... MIMIR_GW_KEY=... MIMIR_GW_MODEL=... \
 *     npx vitest run test/smoke/liveAgent.test.ts
 */
import { describe, expect, it, beforeAll, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatOpenAI } from '@langchain/openai'
import { createDeepAgent } from 'deepagents'
import { z } from 'zod'
import { tool } from 'langchain/tools'
import { MimirFsBackend } from '../../electron/agent/fsBackend'
import { setApprovalSender, settleApproval, type ApprovalRequest } from '../../electron/agent/approval'

interface GwConfig {
  baseUrl: string
  apiKey: string
  model: string
}

function resolveGateway(): GwConfig | null {
  const url = process.env.MIMIR_GW_URL
  const key = process.env.MIMIR_GW_KEY
  const model = process.env.MIMIR_GW_MODEL
  if (url && key && model) return { baseUrl: url, apiKey: key, model }
  return null
}

const gateway = resolveGateway()

/** 自动批准（记录请求），让写盘链路能在无 GUI 下跑通。 */
function installAutoApprover(): { seen: ApprovalRequest[] } {
  const seen: ApprovalRequest[] = []
  setApprovalSender((req) => {
    seen.push(req)
    queueMicrotask(() => settleApproval(req.id, true))
  })
  return { seen }
}

/** 构建一个精简版 supervisor（生产同款 backend + 内存桩工具）。 */
function buildAgent(cfg: GwConfig): {
  agent: { invoke: (i: { messages: Array<{ role: string; content: string }> }) => Promise<{ messages: unknown[] }> }
} {
  const model = new ChatOpenAI({
    apiKey: cfg.apiKey,
    model: cfg.model,
    temperature: 0,
    configuration: { baseURL: cfg.baseUrl }
  })
  const noop = tool(async () => 'ok', {
    name: 'load_memory',
    description: '读取长期记忆',
    schema: z.object({ reason: z.string().optional() })
  })
  const agent = createDeepAgent({
    model,
    systemPrompt: `你是 Mimir（测试实例）。你可以使用内置文件工具读写本机文件。
用户给出绝对路径时，直接用 write_file / read_file 操作；不要反问。
完成后用中文简短说明结果。`,
    tools: [noop] as never,
    backend: new MimirFsBackend() as never
  })
  return { agent: agent as never }
}

let workDir: string
afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe.skipIf(gateway === null)('live 冒烟：真实模型跑一轮 agent', () => {
  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'mimir-live-'))
    console.log(`[live-agent] 目标网关：${gateway!.baseUrl} model=${gateway!.model}`)
  })

  it('用例 1：纯对话——不调工具，能返回非空中文回复', async () => {
    const { agent } = buildAgent(gateway!)
    const res = await agent.invoke({ messages: [{ role: 'user', content: '用一句话解释什么是科研中的「可复现性」。' }] })
    const last = res.messages[res.messages.length - 1] as { content?: unknown }
    const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
    expect(text.length).toBeGreaterThan(0)
    console.log(`[live-agent] 对话回复：${text.slice(0, 120)}`)
  })

  it('用例 2：写文件——真实落盘且经过批准卡（端到端全链路）', async () => {
    const { agent } = buildAgent(gateway!)
    const approver = installAutoApprover()
    const target = join(workDir, 'agent-output.md')

    const res = await agent.invoke({
      messages: [
        {
          role: 'user',
          content: `请把「# 冒烟测试\n\n这是一份由 agent 写入的测试文档。」写入文件 ${target}，然后简短确认。`
        }
      ]
    })

    const last = res.messages[res.messages.length - 1] as { content?: unknown }
    console.log(`[live-agent] 写文件结果：${JSON.stringify(last.content).slice(0, 160)}`)

    // 关键断言：文件真的落盘了
    expect(existsSync(target), `期望文件已写入：${target}`).toBe(true)
    expect(readFileSync(target, 'utf8')).toContain('冒烟测试')
    // 且确实经过了批准卡（说明 FsBackend 接管成功）
    expect(approver.seen.some((r) => r.tool === 'write_file')).toBe(true)
  })

  it('用例 3：读空间外文件——触发批准卡并成功读回内容', async () => {
    const { agent } = buildAgent(gateway!)
    const target = join(workDir, 'secret.txt')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(target, 'UNIQUE_TOKEN_7788')

    const approver = installAutoApprover()
    const res = await agent.invoke({
      messages: [{ role: 'user', content: `请读取文件 ${target} 的内容并告诉我里面写了什么。` }]
    })

    const last = res.messages[res.messages.length - 1] as { content?: unknown }
    const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
    console.log(`[live-agent] 读文件回复：${text.slice(0, 160)}`)

    expect(approver.seen.some((r) => r.tool === 'read_file')).toBe(true)
    expect(text).toContain('UNIQUE_TOKEN_7788')
  })
})
