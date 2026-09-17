/**
 * OTel 埋点配置解析与生命周期（`electron/agent/otelTrace.ts`）。
 *
 * 这些用例守护的是**「不配置即零开销」**这条硬约束：默认态绝不能初始化 SDK、
 * 绝不能对未配置的端点发起请求。以及在配置存在时能正确建 span 树。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'

// store / logger 都依赖 Electron 运行时，这里 mock 掉，只测配置解析逻辑本身。
vi.mock('../../electron/library/store', () => ({
  getStoreValue: vi.fn()
}))
vi.mock('../../electron/logger', () => ({
  agentLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { getStoreValue } from '../../electron/library/store'
import {
  readOtelConfigFromEnv,
  readOtelConfigFromSettings,
  resolveOtelConfig,
  isOtelEnabled,
  getTracer,
  shutdownOtel
} from '../../electron/agent/otelTrace'

const ENV_KEYS = [
  'MIMIR_OTEL_ENDPOINT',
  'MIMIR_OTEL_HEADERS',
  'MIMIR_OTEL_SERVICE_NAME',
  'MIMIR_OTEL_ENVIRONMENT',
  'MIMIR_OTEL_CAPTURE_CONTENT'
] as const

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  vi.mocked(getStoreValue).mockReset()
})

describe('readOtelConfigFromEnv', () => {
  it('未设端点时不启用（返回 null，而不是用默认地址）', () => {
    expect(readOtelConfigFromEnv()).toBeNull()
  })

  it('端点为空串 / 全空格同样视为未配置', () => {
    process.env.MIMIR_OTEL_ENDPOINT = '   '
    expect(readOtelConfigFromEnv()).toBeNull()
  })

  it('设了端点则启用，并给出服务名与环境的兜底值', () => {
    process.env.MIMIR_OTEL_ENDPOINT = 'http://localhost:4318/v1/traces'
    const cfg = readOtelConfigFromEnv()
    expect(cfg?.endpoint).toBe('http://localhost:4318/v1/traces')
    expect(cfg?.serviceName).toBe('mimir-desktop')
    expect(cfg?.environment).not.toBe('')
    // 用户口径是完整上报，缺省必须为 true
    expect(cfg?.captureContent).toBe(true)
  })

  it('可显式关闭完整上报（将来切云后端的降级开关）', () => {
    process.env.MIMIR_OTEL_ENDPOINT = 'http://localhost:4318/v1/traces'
    process.env.MIMIR_OTEL_CAPTURE_CONTENT = 'false'
    expect(readOtelConfigFromEnv()?.captureContent).toBe(false)
  })

  it('解析多行 headers，忽略空行与非法行（冒号在首位）', () => {
    process.env.MIMIR_OTEL_ENDPOINT = 'http://x/v1/traces'
    process.env.MIMIR_OTEL_HEADERS = 'Authorization: Bearer abc\n\n:bad\nX-Env: prod'
    expect(readOtelConfigFromEnv()?.headers).toEqual({
      Authorization: 'Bearer abc',
      'X-Env': 'prod'
    })
  })
})

describe('readOtelConfigFromSettings', () => {
  it('enabled 非 true 时不启用', () => {
    vi.mocked(getStoreValue).mockReturnValue({ otel: { enabled: false, endpoint: 'http://x/v1/traces' } })
    expect(readOtelConfigFromSettings()).toBeNull()
  })

  it('enabled 为 true 但端点为空时不启用（避免静默发去默认地址）', () => {
    vi.mocked(getStoreValue).mockReturnValue({ otel: { enabled: true, endpoint: '' } })
    expect(readOtelConfigFromSettings()).toBeNull()
  })

  it('enabled + 端点齐备时启用', () => {
    vi.mocked(getStoreValue).mockReturnValue({
      otel: { enabled: true, endpoint: ' http://localhost:4318/v1/traces ', serviceName: 'mimir-dev' }
    })
    const cfg = readOtelConfigFromSettings()
    expect(cfg?.endpoint).toBe('http://localhost:4318/v1/traces')
    expect(cfg?.serviceName).toBe('mimir-dev')
  })

  it('settings 里没有 otel 键时返回 null', () => {
    vi.mocked(getStoreValue).mockReturnValue({})
    expect(readOtelConfigFromSettings()).toBeNull()
  })

  it('store 抛错时不冒泡（观测配置读取失败不能拖垮启动）', () => {
    vi.mocked(getStoreValue).mockImplementation(() => {
      throw new Error('store 未就绪')
    })
    expect(() => readOtelConfigFromSettings()).not.toThrow()
    expect(readOtelConfigFromSettings()).toBeNull()
  })
})

describe('resolveOtelConfig 优先级与环境变量独占性', () => {
  it('环境变量优先于设置页', () => {
    process.env.MIMIR_OTEL_ENDPOINT = 'http://env/v1/traces'
    vi.mocked(getStoreValue).mockReturnValue({
      otel: { enabled: true, endpoint: 'http://settings/v1/traces' }
    })
    expect(resolveOtelConfig()?.endpoint).toBe('http://env/v1/traces')
  })

  it('环境变量只给了端点时，不与设置页的字段混用', () => {
    process.env.MIMIR_OTEL_ENDPOINT = 'http://env/v1/traces'
    vi.mocked(getStoreValue).mockReturnValue({
      otel: { enabled: true, endpoint: 'http://settings/v1/traces', serviceName: 'from-settings' }
    })
    // 环境变量命中即整体采用环境变量，serviceName 走兜底而非设置页
    expect(resolveOtelConfig()?.serviceName).toBe('mimir-desktop')
  })

  it('两处都未配置时返回 null（默认零开销态）', () => {
    vi.mocked(getStoreValue).mockReturnValue({})
    expect(resolveOtelConfig()).toBeNull()
  })
})

describe('未启用时的零开销保证', () => {
  it('未初始化时 isOtelEnabled 为 false、getTracer 返回 null', () => {
    expect(isOtelEnabled()).toBe(false)
    expect(getTracer()).toBeNull()
  })

  it('未启用时 shutdown 是幂等的空操作', async () => {
    await expect(shutdownOtel()).resolves.toBeUndefined()
    await expect(shutdownOtel()).resolves.toBeUndefined()
  })
})
