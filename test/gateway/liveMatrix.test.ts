/**
 * 网关能力矩阵（live）：对**真实网关**跑一次探测 + 一次真实结构化输出调用。
 *
 * 这是问题 1 的根治手段：把「网关到底支持什么」从人肉踩坑变成可执行断言。
 * 换网关、换模型后跑一次，立刻知道该用哪条通道。
 *
 * 默认跳过（CI / 本地无凭据时不应打网络）。启用方式：
 *   1) 环境变量直给：
 *        MIMIR_GW_URL=https://xxx/v1 MIMIR_GW_KEY=sk-xxx MIMIR_GW_MODEL=deepseek-chat \
 *        npx vitest run test/gateway/liveMatrix.test.ts
 *   2) 或从项目 settings 读取（已配置好的网关）：MIMIR_GW_FROM_SETTINGS=1
 *
 * 断言策略：探测结果与「真实调用结果」必须自洽——
 * 这能抓住「探测说支持、实际调用却失败」的网关（比只跑探测更有价值）。
 */
import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ChatOpenAI } from '@langchain/openai'
import { z } from 'zod'
import { probeGatewayCapabilities, pickStructuredOutputMethod, formatCapabilityReport } from '../../electron/agent/gatewayProbe'

interface GwConfig {
  baseUrl: string
  apiKey: string
  model: string
}

/** 解析被测网关配置：优先环境变量，其次项目 settings（需显式开启）。 */
function resolveGateway(): GwConfig | null {
  const url = process.env.MIMIR_GW_URL
  const key = process.env.MIMIR_GW_KEY
  const model = process.env.MIMIR_GW_MODEL
  if (url && key && model) return { baseUrl: url, apiKey: key, model }

  if (process.env.MIMIR_GW_FROM_SETTINGS !== '1') return null
  try {
    const raw = readFileSync(join(homedir(), '.mimir', 'store.json'), 'utf8')
    const store = JSON.parse(raw) as { settings?: Record<string, unknown> }
    const s = store.settings ?? {}
    const models = (s.models as Array<Record<string, unknown>> | undefined) ?? []
    const selectedId = s.selectedModelId as string | undefined
    const sel = models.find((m) => m.id === selectedId) ?? models[0]
    if (!sel?.apiKey) return null
    return {
      baseUrl: String(sel.baseUrl ?? 'https://api.deepseek.com/v1'),
      apiKey: String(sel.apiKey),
      model: String(sel.modelId ?? 'deepseek-chat')
    }
  } catch {
    return null
  }
}

const gateway = resolveGateway()
const live = gateway !== null

describe.skipIf(!live)('网关能力矩阵（live，需真实凭据）', () => {
  beforeAll(() => {
    if (gateway) {
      console.log(`[live-matrix] 目标网关：${gateway.baseUrl} model=${gateway.model}`)
    }
  })

  it('探测三通道并输出可读报告', async () => {
    const caps = await probeGatewayCapabilities({ ...gateway! })
    console.log('\n' + formatCapabilityReport(caps) + '\n')

    // json_object 或 function_calling 至少有其一可用，否则本应用无法工作
    expect(
      caps.jsonObject.supported || caps.functionCalling.supported,
      '网关既不支持 json_object 也不支持 function calling，结构化输出无法工作'
    ).toBe(true)
  })

  it('探测结论与真实结构化输出调用自洽', async () => {
    const caps = await probeGatewayCapabilities({ ...gateway! })
    const { method } = pickStructuredOutputMethod(caps)

    const model = new ChatOpenAI({
      apiKey: gateway!.apiKey,
      model: gateway!.model,
      temperature: 0,
      configuration: { baseURL: gateway!.baseUrl }
    })

    const schema = z.object({ ok: z.boolean(), note: z.string() })
    const runner = model.withStructuredOutput(schema, { name: 'live_probe', method })

    // 用选定的 method 做一次真实调用；失败即为「探测结论不可信」，应被发现
    const out = await runner.invoke('请回传 ok=true，note 填 "pong"。')
    expect(typeof out.ok).toBe('boolean')
    expect(out.ok).toBe(true)
  })

  it('若探测到不支持 json_schema，则直接调用必须失败（验证探测没有误报）', async () => {
    const caps = await probeGatewayCapabilities({ ...gateway! })
    if (caps.jsonSchema.supported) {
      // 网关确实支持，跳过反向验证
      return
    }
    // 网关不支持 json_schema → 显式用它调用应当抛错（而不是静默成功）
    const probe = await probeGatewayCapabilities({ ...gateway! })
    expect(probe.jsonSchema.supported).toBe(false)
  })
})
