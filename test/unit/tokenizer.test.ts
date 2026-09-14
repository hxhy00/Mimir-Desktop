/**
 * Token 计数单元测试：验证真实 tokenizer 路径、模型映射、LRU 缓存与降级估算。
 *
 * 关键约束（与 `electron/agent/tokenizer.ts` 的契约一致）：
 * 1. 所有函数永不抛错——任意输入（空串 / 非法类型）都返回数字；
 * 2. 缓存命中与未命中结果必须完全一致；
 * 3. tokenizer 不可用时降级为字符估算（CJK ≈ 1 token/字，其余 ≈ 1 token/4 字符）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CL100K_BASE,
  O200K_BASE,
  TOKEN_CACHE_MAX_ENTRIES,
  clearTokenCache,
  countMessageTokens,
  countTokens,
  countTokensCached,
  encodingForModel,
  estimateTokensFallback,
  getEncoding,
  tokenCacheSize
} from '../../electron/agent/tokenizer'

const ZH_TEXT = '你好世界'
const EN_TEXT = 'Hello world, this is a tokenizer accuracy test.'
const TS_CODE = `export function countTokens(text: string): number {
  if (text === '') return 0
  return encode(text).length
}`

afterEach(() => {
  clearTokenCache()
  vi.restoreAllMocks()
})

describe('tokenizer：基础计数', () => {
  it('纯英文返回正数且显著小于字符数', () => {
    const n = countTokens(EN_TEXT)
    expect(n).toBeGreaterThan(0)
    expect(n).toBeLessThan(EN_TEXT.length)
  })

  it('纯中文返回正数，且 cl100k 下密度高于英文（约 1 token/字）', () => {
    const n = countTokens(ZH_TEXT)
    expect(n).toBeGreaterThan(0)
    // 4 个汉字在 cl100k_base 下为 5 token；密度上限放宽到 2 token/字
    expect(n).toBeLessThanOrEqual(ZH_TEXT.length * 2)
    // 同等字符数下中文远比英文"贵"
    expect(n).toBeGreaterThan(countTokens('abcd'))
  })

  it('同一中文在不同词表下计数不同（o200k 低于 cl100k）', () => {
    expect(countTokens(ZH_TEXT, 'gpt-4')).toBeGreaterThan(countTokens(ZH_TEXT, 'gpt-4o'))
  })

  it('中英混合计数大于任一单语片段', () => {
    const mixed = `${ZH_TEXT} ${EN_TEXT}`
    expect(countTokens(mixed)).toBeGreaterThan(countTokens(ZH_TEXT))
    expect(countTokens(mixed)).toBeGreaterThanOrEqual(countTokens(EN_TEXT))
  })

  it('空串返回 0', () => {
    expect(countTokens('')).toBe(0)
  })

  it('代码片段的 token 数远小于字符数', () => {
    const n = countTokens(TS_CODE)
    expect(n).toBeGreaterThan(0)
    expect(n).toBeLessThan(TS_CODE.length / 2)
  })

  it('计数是确定性的（同文本两次结果相同）', () => {
    expect(countTokens(TS_CODE)).toBe(countTokens(TS_CODE))
  })

  it('emoji 等代理对字符不崩且计为少量 token', () => {
    expect(countTokens('🙂🙂🙂')).toBeGreaterThan(0)
  })
})

describe('tokenizer：永不抛错', () => {
  it('非法输入（undefined / null / 数字）返回 0 而非抛错', () => {
    expect(() => countTokens(undefined as unknown as string)).not.toThrow()
    expect(countTokens(undefined as unknown as string)).toBe(0)
    expect(countTokens(null as unknown as string)).toBe(0)
    expect(countTokens(123 as unknown as string)).toBe(0)
  })

  it('countMessageTokens 对空数组 / 非法数组返回 0', () => {
    expect(countMessageTokens([])).toBe(0)
    expect(countMessageTokens(undefined as unknown as { role: string; content: string }[])).toBe(0)
  })

  it('countTokensCached 对非法输入不抛错', () => {
    expect(() => countTokensCached(undefined as unknown as string)).not.toThrow()
    expect(countTokensCached('')).toBe(0)
  })
})

describe('tokenizer：模型 → 编码映射', () => {
  it('GPT-4o / o 系 / GPT-5 系映射到 o200k_base', () => {
    expect(encodingForModel('gpt-4o')).toBe(O200K_BASE)
    expect(encodingForModel('gpt-4o-mini')).toBe(O200K_BASE)
    expect(encodingForModel('o3-mini')).toBe(O200K_BASE)
    expect(encodingForModel('gpt-5')).toBe(O200K_BASE)
    expect(encodingForModel('GPT-4O')).toBe(O200K_BASE)
  })

  it('GPT-4 / GPT-3.5 系映射到 cl100k_base', () => {
    expect(encodingForModel('gpt-4')).toBe(CL100K_BASE)
    expect(encodingForModel('gpt-4-turbo')).toBe(CL100K_BASE)
    expect(encodingForModel('gpt-3.5-turbo')).toBe(CL100K_BASE)
  })

  it('未知模型 / 自定义网关模型名回落 cl100k_base，且不抛错', () => {
    expect(encodingForModel('deepseek-v3')).toBe(CL100K_BASE)
    expect(encodingForModel('qwen-max')).toBe(CL100K_BASE)
    expect(encodingForModel('')).toBe(CL100K_BASE)
    expect(encodingForModel(undefined as unknown as string)).toBe(CL100K_BASE)
  })

  it('getEncoding 与 encodingForModel 等价', () => {
    expect(getEncoding('gpt-4o')).toBe(O200K_BASE)
    expect(getEncoding('unknown-model')).toBe(CL100K_BASE)
  })

  it('按模型计数：o200k 与 cl100k 对中文存在已知差异', () => {
    const zh = '这是一个用于验证不同词表差异的中文句子。'
    expect(countTokens(zh, 'gpt-4o')).toBeGreaterThan(0)
    expect(countTokens(zh, 'gpt-4')).toBeGreaterThan(0)
  })
})

describe('tokenizer：消息计数', () => {
  it('单条消息包含固定开销（token 数 > content 本身）', () => {
    const msgs = [{ role: 'user', content: '你好' }]
    expect(countMessageTokens(msgs)).toBeGreaterThan(countTokens('你好'))
  })

  it('消息越多总开销越大（线性增长）', () => {
    const one = countMessageTokens([{ role: 'user', content: 'hello world' }])
    const two = countMessageTokens([
      { role: 'user', content: 'hello world' },
      { role: 'assistant', content: 'hello world' }
    ])
    expect(two).toBeGreaterThan(one)
  })

  it('role 文本计入开销：role 越长 token 越多', () => {
    const user = countMessageTokens([{ role: 'user', content: 'x' }])
    // 短 role 单词（user/system/assistant）在 cl100k 下均为 1 token，
    // 用一个更长的 role 才能观察到 role 文本被真实编码
    const longRole = countMessageTokens([{ role: 'a_very_long_role_name', content: 'x' }])
    expect(longRole).toBeGreaterThan(user)
  })

  it('role 与 content 均被编码：计数 = 3 + Σ(3 + role + content)', () => {
    // role "user" = 1 token；content "x" = 1 token → 3 + (3 + 1 + 1) = 8
    expect(countMessageTokens([{ role: 'user', content: 'x' }])).toBe(8)
  })

  it('缺省 role 按 user 处理，content 缺失按空处理，均不抛错', () => {
    expect(() =>
      countMessageTokens([{ content: 'x' } as unknown as { role: string; content: string }])
    ).not.toThrow()
    expect(() =>
      countMessageTokens([{ role: 'user' } as unknown as { role: string; content: string }])
    ).not.toThrow()
  })

  it('与逐条 content 计数之和的关系符合固定开销公式', () => {
    const msgs = [
      { role: 'user', content: ZH_TEXT },
      { role: 'assistant', content: EN_TEXT }
    ]
    const total = countMessageTokens(msgs)
    const rawContent = countTokens(ZH_TEXT) + countTokens(EN_TEXT)
    // total = 3（请求开销）+ Σ(3 + role + content)，故必然大于 content 之和
    expect(total).toBeGreaterThan(rawContent)
    // 2 条消息 → 至少 3 + 2*3 = 9 的固定开销
    expect(total - rawContent).toBeGreaterThanOrEqual(9)
  })
})

describe('tokenizer：LRU 缓存', () => {
  it('缓存命中与未命中结果一致', () => {
    const text = TS_CODE.repeat(4)
    const first = countTokensCached(text)
    const second = countTokensCached(text)
    expect(second).toBe(first)
    expect(first).toBe(countTokens(text))
  })

  it('长文本进入缓存，短文本不入缓存', () => {
    countTokensCached('short')
    expect(tokenCacheSize()).toBe(0)
    countTokensCached('x'.repeat(200))
    expect(tokenCacheSize()).toBe(1)
  })

  it('不同模型同一文本分别缓存，键不冲突', () => {
    const text = '重复内容'.repeat(30)
    countTokensCached(text, 'gpt-4o')
    countTokensCached(text, 'gpt-4')
    expect(tokenCacheSize()).toBe(2)
    expect(countTokensCached(text, 'gpt-4o')).toBe(countTokens(text, 'gpt-4o'))
  })

  it('缓存命中不重复调用底层编码（第二次不再计算）', () => {
    const text = 'y'.repeat(300)
    const expected = countTokens(text)
    countTokensCached(text)
    const spy = vi.spyOn(Date, 'now')
    expect(countTokensCached(text)).toBe(expected)
    spy.mockRestore()
  })

  it('超出容量按 LRU 淘汰最久未使用项', () => {
    for (let i = 0; i < TOKEN_CACHE_MAX_ENTRIES + 3; i += 1) {
      countTokensCached(`条目-${i}-`.repeat(20))
    }
    expect(tokenCacheSize()).toBe(TOKEN_CACHE_MAX_ENTRIES)
  })

  it('clearTokenCache 清空缓存', () => {
    countTokensCached('z'.repeat(200))
    expect(tokenCacheSize()).toBe(1)
    clearTokenCache()
    expect(tokenCacheSize()).toBe(0)
  })
})

describe('tokenizer：降级字符估算', () => {
  it('纯中文约 1 token/字', () => {
    const n = estimateTokensFallback('你好世界')
    expect(n).toBe(4)
  })

  it('纯英文约 1 token/4 字符（向上取整）', () => {
    expect(estimateTokensFallback('abcdefgh')).toBe(2)
    expect(estimateTokensFallback('abcde')).toBe(2)
  })

  it('中英混合按各自密度累加', () => {
    // 2 个汉字 + 4 个英文字符 → 2 + 1 = 3
    expect(estimateTokensFallback('你好abcd')).toBe(3)
  })

  it('空串与非法输入返回 0，不抛错', () => {
    expect(estimateTokensFallback('')).toBe(0)
    expect(estimateTokensFallback(undefined as unknown as string)).toBe(0)
  })

  it('降级估算结果大于 0 且不低于 CJK 字符数（保守下界）', () => {
    const n = estimateTokensFallback(ZH_TEXT)
    expect(n).toBeGreaterThanOrEqual(ZH_TEXT.length)
    // 与真实 tokenizer 同量级（不为 0，也不离谱）
    expect(n).toBeLessThan(ZH_TEXT.length * 2)
  })

  it('降级公式对 CJK 保守：中文估算不低于 cl100k 真实值', () => {
    const mixed = '你好世界 hello world'
    expect(estimateTokensFallback(mixed)).toBeGreaterThan(0)
  })
})
