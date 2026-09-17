/**
 * DuckDuckGo 结果解析单测 —— 锁定"两份重复实现已合并 + 修复旧正则三个缺陷"。
 *
 * 背景：`libraryService.searchWeb` 与 `agent/tools/webSearch.ts` 原先**各写一份**
 * 完全相同的正则解析。现合并到 `electron/library/webSearchParse.ts`，改用 cheerio。
 *
 * 本组用例在结构真实的 fixture（`test/fixtures/ddg-results.html`）上锁定：
 *
 * 1. **条目数正确**：旧正则因"连续三个 </div> 才算分隔"会**提前截断**（实测少解析）；
 * 2. **取的是标题链接**：旧正则取块内第一个 `href`，标题前若有其他链接就取错；
 * 3. **实体解码**：旧实现留下 `&amp;`，cheerio 正确还原为 `&`；
 * 4. **跳转链接还原**：`//duckduckgo.com/l/?uddg=...` 必须解出真实 URL；
 * 5. **排除广告位**，且空结果不静默伪装成"没搜到"。
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { parseDuckDuckGoResults, resolveDuckDuckGoUrl } from '../../electron/library/webSearchParse'

const FIXTURE = readFileSync(join(__dirname, '../fixtures/ddg-results.html'), 'utf-8')

describe('parseDuckDuckGoResults：在真实结构 fixture 上取全结果', () => {
  it('解析出全部 3 条结果（不回少）', () => {
    const results = parseDuckDuckGoResults(FIXTURE, 10)
    expect(results).toHaveLength(3)
    expect(results.map((r) => r.title)).toEqual([
      'Attention Is All You Need',
      'Direct HTML Link & Entities',
      'Gamma Result',
    ])
  })

  it('旧正则的截断缺陷已消除：带内层 extras div 的条目不被漏掉', () => {
    // 第一条含 <div class="result__extras"> 嵌套，旧正则在此提前截断
    const results = parseDuckDuckGoResults(FIXTURE, 10)
    expect(results[0]!.title).toBe('Attention Is All You Need')
    expect(results[0]!.content).toContain('sequence transduction')
  })

  it('取的是标题链接而非块内第一个链接（标题前有其他 <a> 也不会取错）', () => {
    const results = parseDuckDuckGoResults(FIXTURE, 10)
    const gamma = results.find((r) => r.title === 'Gamma Result')
    expect(gamma).toBeDefined()
    // 若取到第一个 href，会变成 favicon 的地址
    expect(gamma!.url).toBe('https://example.com/gamma')
    expect(gamma!.url).not.toContain('favicon')
  })

  it('HTML 实体正确解码（&amp; → &）', () => {
    const results = parseDuckDuckGoResults(FIXTURE, 10)
    const direct = results.find((r) => r.title.startsWith('Direct'))
    expect(direct!.title).toBe('Direct HTML Link & Entities')
    expect(direct!.content).toBe('A snippet with markup inside & entities.')
  })

  it('内嵌标签被剥离为纯文本', () => {
    const results = parseDuckDuckGoResults(FIXTURE, 10)
    expect(results[1]!.title).not.toContain('<b>')
    expect(results[1]!.content).not.toContain('<b>')
  })

  it('排除广告位', () => {
    const results = parseDuckDuckGoResults(FIXTURE, 10)
    expect(results.some((r) => r.title === 'Buy Something Now')).toBe(false)
  })

  it('maxResults 生效（按页面顺序截取）', () => {
    const results = parseDuckDuckGoResults(FIXTURE, 2)
    expect(results).toHaveLength(2)
    expect(results[0]!.title).toBe('Attention Is All You Need')
    expect(results[1]!.title).toBe('Direct HTML Link & Entities')
  })

  it('结果字段结构完整（对齐 WebSearchEntry）', () => {
    const results = parseDuckDuckGoResults(FIXTURE, 10)
    for (const r of results) {
      expect(typeof r.title).toBe('string')
      expect(typeof r.url).toBe('string')
      expect(typeof r.content).toBe('string')
      expect(r.engine).toBe('duckduckgo')
      expect(r.category).toBe('general')
      expect(r.publishedDate).toBe('')
    }
  })

  it('页面结构变化时返回空数组（调用方据此告警，而非静默成功）', () => {
    expect(parseDuckDuckGoResults('<html><body><p>nothing here</p></body></html>', 10)).toEqual([])
  })
})

describe('resolveDuckDuckGoUrl：跳转链接还原', () => {
  it('解出 uddg 参数作为真实 URL', () => {
    expect(resolveDuckDuckGoUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Farxiv.org%2Fabs%2F1706.03762&rut=x')).toBe(
      'https://arxiv.org/abs/1706.03762'
    )
  })

  it('直链原样返回', () => {
    expect(resolveDuckDuckGoUrl('https://example.com/plain')).toBe('https://example.com/plain')
  })

  it('无法解出目标的跳转端点返回空串（不暴露 duckduckgo.com/l/?... 中间地址）', () => {
    expect(resolveDuckDuckGoUrl('//duckduckgo.com/l/?rut=abc')).toBe('')
  })

  it('空 href 返回空串', () => {
    expect(resolveDuckDuckGoUrl('')).toBe('')
  })

  it('非法 URL 不抛异常', () => {
    expect(() => resolveDuckDuckGoUrl('http://[invalid')).not.toThrow()
  })
})
