/**
 * 交流语言中间件单测。
 *
 * 修复的问题：Agent 最终回答是中文，但**工具调用之间的过程叙述整段英文**
 * （"I'll help you..." / "Let me check..."）。原因是语言规则只写在静态 systemPrompt 里，
 * 对多轮 ReAct 循环的中间轮次约束力不足。修法是在**每次模型调用时**把语言指令前置注入。
 *
 * 本测试锁定：指令内容随设置热变化（无需重建 Agent）、前置到 systemMessage 最前、
 * 其余 systemMessage 内容不被破坏、不改动调用方对象。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { currentInteractLanguage, createLanguageMiddleware, languageDirective } from '../../electron/agent/languageMiddleware'

/** 模拟 store 的读函数（真实逻辑：读 settings.identity.interactLanguage）。 */
function readerOf(value: unknown): (key: string) => unknown {
  return () => value
}

afterEach(() => {
  // 本文件全部为纯函数断言，无共享状态需要清理
})

describe('languageMiddleware：交流语言判定与指令生成', () => {
  it('中文档：指令要求使用中文并禁止中英混杂旁白', () => {
    const text = languageDirective('zh')
    expect(text).toContain('中文')
    expect(text).toContain('禁止中英混杂')
    // 明确覆盖「工具调用之间的过程叙述」这一真实漏点
    expect(text).toContain('过程叙述')
    // 回归守护：英文材料（论文/代码）→ 整段英文总结，是实测的另一漏点，须显式约束最终总结
    expect(text).toContain('最终总结')
  })

  it('英文档：指令要求使用英文', () => {
    const text = languageDirective('en')
    expect(text).toContain('English')
    expect(text).toContain('过程叙述')
  })

  it('设置为英文时判定为 en（热生效的数据通路）', () => {
    expect(currentInteractLanguage(readerOf({ identity: { interactLanguage: 'en' } }))).toBe('en')
  })

  it('设置为中文时判定为 zh', () => {
    expect(currentInteractLanguage(readerOf({ identity: { interactLanguage: 'zh' } }))).toBe('zh')
  })

  it('脏数据回落中文：非法取值 / 缺 identity / store 抛错都不注入英文', () => {
    expect(currentInteractLanguage(readerOf({ identity: { interactLanguage: 'fr' } }))).toBe('zh')
    expect(currentInteractLanguage(readerOf({}))).toBe('zh')
    expect(currentInteractLanguage(readerOf(undefined))).toBe('zh')
    expect(
      currentInteractLanguage(() => {
        throw new Error('store not loaded')
      })
    ).toBe('zh')
  })

  it('默认落中文：未配置身份时（系统默认语言）不打英文标记', () => {
    const text = languageDirective(currentInteractLanguage(readerOf({})))
    expect(text).toContain('中文')
    expect(text).not.toContain('English')
  })

  it('wrapModelCall：语言指令前置到 systemMessage 最前，原内容保留在后', async () => {
    const mw = createLanguageMiddleware() as unknown as {
      wrapModelCall: (req: unknown, handler: (r: never) => Promise<unknown>) => Promise<unknown>
    }
    let captured: { systemMessage: { content: string } } | undefined
    await mw.wrapModelCall(
      { systemMessage: { content: '你是 Mimir，原始系统提示。' } },
      async (r: never) => {
        captured = r as { systemMessage: { content: string } }
        return 'done'
      }
    )

    const content = captured?.systemMessage.content ?? ''
    expect(content.indexOf('交流语言')).toBeLessThan(content.indexOf('你是 Mimir'))
    expect(content).toContain('你是 Mimir，原始系统提示。')
  })

  it('wrapModelCall：不改动调用方传入的 systemMessage 对象', async () => {
    const original = { content: '原始提示' }
    const mw = createLanguageMiddleware() as unknown as {
      wrapModelCall: (req: unknown, handler: (r: never) => Promise<unknown>) => Promise<unknown>
    }
    await mw.wrapModelCall({ systemMessage: original }, async () => 'done')

    expect(original.content).toBe('原始提示')
  })
})
