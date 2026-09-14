import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  parseRetryAfterMs,
  ttlForKey,
  __circuitTestHooks
} from '../../electron/agent/tools/arxivSearch'

/**
 * arXiv 访问层「限流加固」三项改动的纯逻辑单测（不触网）：
 * - L1 Retry-After 解析（秒数 / HTTP-date / 封顶 / 非法回落）
 * - L4 差异化缓存 TTL（fetch 比 search 耐久）
 * - L2 熔断器状态迁移（CLOSED → OPEN → HALF_OPEN）
 */
describe('arXiv L1：Retry-After 头解析', () => {
  it('秒数格式转毫秒', () => {
    expect(parseRetryAfterMs('30')).toBe(30_000)
    expect(parseRetryAfterMs('0')).toBe(0)
  })

  it('超过上限封顶到 60s，避免异常头挂死任务', () => {
    expect(parseRetryAfterMs('999999')).toBe(60_000)
  })

  it('HTTP-date 格式按与当前时间之差解析', () => {
    const future = new Date(Date.now() + 10_000).toUTCString()
    const ms = parseRetryAfterMs(future)
    expect(ms).toBeTypeOf('number')
    // 允许 ±2s 误差（Date.parse 精度与执行耗时）
    expect(ms!).toBeGreaterThan(7_000)
    expect(ms!).toBeLessThanOrEqual(12_000)
  })

  it('null / 无法解析时返回 undefined（由调用方回落预设退避）', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined()
    expect(parseRetryAfterMs('not-a-number-nor-date')).toBeUndefined()
  })
})

describe('arXiv L4：差异化缓存 TTL', () => {
  it('单篇 id 读取（kind=fetch）TTL 长于关键词搜索', () => {
    const fetchTtl = ttlForKey('kind=fetch&id=2301.12345')
    const searchTtl = ttlForKey('kind=search&q=abc&n=5&s=relevance')
    expect(fetchTtl).toBeGreaterThan(searchTtl)
  })
})

describe('arXiv L2：熔断器状态迁移', () => {
  afterEach(() => {
    vi.useRealTimers()
    __circuitTestHooks.reset()
  })

  it('未达阈值保持 closed、不拦截请求', () => {
    __circuitTestHooks.reset()
    __circuitTestHooks.recordThrottle()
    __circuitTestHooks.recordThrottle()
    expect(__circuitTestHooks.state()).toBe('closed')
    expect(__circuitTestHooks.blocks()).toBe(false)
  })

  it('连续达到阈值后打开熔断并拦截', () => {
    __circuitTestHooks.reset()
    for (let i = 0; i < 3; i += 1) __circuitTestHooks.recordThrottle()
    expect(__circuitTestHooks.state()).toBe('open')
    expect(__circuitTestHooks.blocks()).toBe(true)
  })

  it('一次成功即重置计数回到 closed', () => {
    __circuitTestHooks.reset()
    __circuitTestHooks.recordThrottle()
    __circuitTestHooks.recordThrottle()
    __circuitTestHooks.recordSuccess()
    expect(__circuitTestHooks.state()).toBe('closed')
    // 重置后再来两次仍不应打开（计数已清零）
    __circuitTestHooks.recordThrottle()
    __circuitTestHooks.recordThrottle()
    expect(__circuitTestHooks.state()).toBe('closed')
  })

  it('OPEN 到期自动转 HALF_OPEN 放行探测', () => {
    vi.useFakeTimers()
    __circuitTestHooks.reset()
    __circuitTestHooks.setOpenUntil(Date.now() + 1_000)
    expect(__circuitTestHooks.blocks()).toBe(true)
    vi.advanceTimersByTime(1_500)
    // 冷却到期：blocks 内部把状态推进到 half-open 并放行一条
    expect(__circuitTestHooks.blocks()).toBe(false)
    expect(__circuitTestHooks.state()).toBe('half-open')
  })

  it('HALF_OPEN 下再遇限流立即重新打开', () => {
    vi.useFakeTimers()
    __circuitTestHooks.reset()
    __circuitTestHooks.setOpenUntil(Date.now())
    __circuitTestHooks.blocks() // 触发 open → half-open
    expect(__circuitTestHooks.state()).toBe('half-open')
    __circuitTestHooks.recordThrottle()
    expect(__circuitTestHooks.state()).toBe('open')
  })
})
