import { describe, it, expect } from 'vitest'
import { isImeComposing, isSubmitEnter } from '../../src/lib/keyboard'

/** 构造一个最小键盘事件（只带判据真正读取的字段）。 */
function key(overrides: Partial<{ key: string; shiftKey: boolean; isComposing: boolean }> = {}) {
  return {
    key: overrides.key ?? 'Enter',
    shiftKey: overrides.shiftKey ?? false,
    nativeEvent: { isComposing: overrides.isComposing ?? false }
  }
}

describe('isImeComposing', () => {
  it('输入法组合中的回车被识别为「确认候选词」', () => {
    expect(isImeComposing(key({ isComposing: true }))).toBe(true)
  })

  it('非组合状态下为 false', () => {
    expect(isImeComposing(key({ isComposing: false }))).toBe(false)
  })
})

describe('isSubmitEnter', () => {
  it('普通回车提交', () => {
    expect(isSubmitEnter(key())).toBe(true)
  })

  it('输入法组合中的回车不提交（中文打字选字误发送的回归测试）', () => {
    expect(isSubmitEnter(key({ isComposing: true }))).toBe(false)
  })

  it('Shift+Enter 不提交（留给换行）', () => {
    expect(isSubmitEnter(key({ shiftKey: true }))).toBe(false)
  })

  it('输入法组合中即使同时按住 Shift 也不提交', () => {
    expect(isSubmitEnter(key({ shiftKey: true, isComposing: true }))).toBe(false)
  })

  it('非回车键不提交', () => {
    expect(isSubmitEnter(key({ key: 'a' }))).toBe(false)
    expect(isSubmitEnter(key({ key: 'Escape' }))).toBe(false)
  })
})
