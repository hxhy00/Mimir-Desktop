/**
 * 网关能力探测：离线确定性测试（不发网络请求）。
 * 用注入的 fetch 桩模拟各类网关的真实响应，验证判定逻辑正确。
 *
 * 这一步很关键：它保证「探测逻辑本身」是对的——
 * 只有逻辑可信，真实网关矩阵（live）的结论才有意义。
 */
import { describe, expect, it } from 'vitest'
import {
  probeGatewayCapabilities,
  pickStructuredOutputMethod,
  formatCapabilityReport,
  type GatewayCapabilities
} from '../../electron/agent/gatewayProbe'

/** 构造一个按「参数特征」返回不同状态码的 fetch 桩，模拟不同网关性格。 */
function makeFetchStub(profile: {
  jsonSchema?: number
  jsonObject?: number
  toolCalling?: number
  jsonSchemaBody?: string
}): typeof fetch {
  const ok = (): Response =>
    new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  const err = (status: number, body: string): Response =>
    new Response(body, { status, headers: { 'Content-Type': 'application/json' } })

  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    const rf = payload.response_format as { type?: string } | undefined
    const hasTools = Array.isArray(payload.tools) && (payload.tools as unknown[]).length > 0

    if (hasTools) {
      const status = profile.toolCalling ?? 200
      return status === 200 ? ok() : err(status, '{"error":{"message":"tools unsupported"}}')
    }
    if (rf?.type === 'json_schema') {
      const status = profile.jsonSchema ?? 200
      return status === 200
        ? ok()
        : err(status, profile.jsonSchemaBody ?? '{"error":{"message":"This response_format type is unavailable now"}}')
    }
    if (rf?.type === 'json_object') {
      const status = profile.jsonObject ?? 200
      return status === 200 ? ok() : err(status, '{"error":{"message":"response_format json_object unsupported"}}')
    }
    return ok()
  }) as unknown as typeof fetch
}

const base = { baseUrl: 'https://gw.example.com/v1', apiKey: 'sk-test', model: 'test-model' }

describe('网关能力探测：判定逻辑（离线）', () => {
  it('全能力网关：三通道均支持，优先选 functionCalling', async () => {
    const caps = await probeGatewayCapabilities({ ...base, fetchImpl: makeFetchStub({}) })
    expect(caps.jsonSchema.supported).toBe(true)
    expect(caps.jsonObject.supported).toBe(true)
    expect(caps.functionCalling.supported).toBe(true)
    const picked = pickStructuredOutputMethod(caps)
    expect(picked.method).toBe('functionCalling')
    // json_schema 即便可用也不选（兼容网关上最脆弱）
    expect(picked.method).not.toBe('jsonSchema')
  })

  it('复现真实踩坑：aipy 式网关拒绝 json_schema，但支持 function calling', async () => {
    const caps = await probeGatewayCapabilities({
      ...base,
      fetchImpl: makeFetchStub({ jsonSchema: 400 })
    })
    expect(caps.jsonSchema.supported).toBe(false)
    expect(caps.jsonSchema.reason).toContain('json_schema')
    expect(caps.functionCalling.supported).toBe(true)
    expect(pickStructuredOutputMethod(caps).method).toBe('functionCalling')
  })

  it('只支持 json_object 的老式网关：降级为 jsonMode', async () => {
    const caps = await probeGatewayCapabilities({
      ...base,
      fetchImpl: makeFetchStub({ jsonSchema: 400, toolCalling: 400 })
    })
    expect(caps.functionCalling.supported).toBe(false)
    expect(caps.jsonObject.supported).toBe(true)
    expect(pickStructuredOutputMethod(caps).method).toBe('jsonMode')
  })

  it('鉴权失败时判定为「结论不可用」，而非「不支持」', async () => {
    const caps = await probeGatewayCapabilities({
      ...base,
      fetchImpl: makeFetchStub({ jsonSchema: 401, jsonObject: 401, toolCalling: 401 })
    })
    expect(caps.jsonSchema.reason).toContain('鉴权失败')
    expect(caps.functionCalling.reason).toContain('鉴权失败')
  })

  it('网络异常不崩溃，归类为网络失败', async () => {
    const throwing = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const caps = await probeGatewayCapabilities({ ...base, fetchImpl: throwing })
    expect(caps.jsonSchema.status).toBe(0)
    expect(caps.jsonSchema.reason).toContain('网络/超时失败')
    // 仍能给出可用的默认建议，不抛错
    expect(pickStructuredOutputMethod(caps).method).toBe('jsonMode')
  })

  it('baseUrl 末尾多余斜杠被规整（不产生 //chat/completions）', async () => {
    let seenUrl = ''
    const spy = (async (url: string | URL | Request) => {
      seenUrl = String(url)
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    await probeGatewayCapabilities({ ...base, baseUrl: 'https://gw.example.com/v1///', fetchImpl: spy })
    expect(seenUrl).toBe('https://gw.example.com/v1/chat/completions')
  })

  it('能力报告可读且包含最终选用的 method', async () => {
    const caps = await probeGatewayCapabilities({ ...base, fetchImpl: makeFetchStub({ jsonSchema: 400 }) })
    const report = formatCapabilityReport(caps)
    expect(report).toContain('json_schema')
    expect(report).toContain('functionCalling')
    expect(report).toContain('✗')
    expect(report).toContain('✓')
  })

  it('fingerprint 用于缓存失效判断（baseUrl + model）', async () => {
    const caps = await probeGatewayCapabilities({ ...base, fetchImpl: makeFetchStub({}) })
    expect(caps.fingerprint).toBe('https://gw.example.com/v1::test-model')
    expect(caps.probedAt).toBeGreaterThan(0)
  })
})
