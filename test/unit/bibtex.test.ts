/**
 * BibTeX 解析/序列化单测 —— 锁定"不污染用户 .bib"的核心契约。
 *
 * 背景：`electron/library/bibtex.ts` 原本是全手写解析器，且序列化会**整文件重排**
 * （压平花括号、展开 @string、丢注释）。现改用 `@retorquere/bibtex-parser`，
 * 并引入"原文保留"写回。本组用例锁定以下行为，防止将来退化：
 *
 * 1. **读取不改语义**：LaTeX 转义不被转成 Unicode、标题不被 sentence-case 改写；
 * 2. **回写字节稳定**：导入后再导出，未改动的条目**逐字符不变**（含花括号风格、字段顺序）；
 * 3. **@string 引用不被展开破坏**：原文里的 `journal = ieee` 保持 `ieee`；
 * 4. **畸形输入有明确报错**，且调用方可据此中止写入（不静默丢条目）。
 */
import { describe, expect, it } from 'vitest'
import { parseBibtex, serializeBibtex, bibKeyOf, entryFromPaper } from '../../electron/library/bibtex'
import type { BibEntry } from '../../electron/library/types'

/** 便捷：解析后按原文映射回写（模拟"未做任何改动就保存"） */
function roundTrip(text: string): string {
  const { entries, rawByKey, errors } = parseBibtex(text)
  expect(errors).toEqual([])
  const originalByKey = new Map(entries.map((e) => [e.key, e]))
  return serializeBibtex(entries, rawByKey, originalByKey)
}

describe('parseBibtex：基础解析', () => {
  it('解析出条目、类型与字段', () => {
    const { entries, errors } = parseBibtex('@article{smith2020, author={John Smith}, title={A Title}, year={2020}}')
    expect(errors).toEqual([])
    expect(entries).toHaveLength(1)
    expect(entries[0]!.key).toBe('smith2020')
    expect(entries[0]!.type).toBe('article')
    expect(entries[0]!.fields.title).toBe('A Title')
    expect(entries[0]!.fields.year).toBe('2020')
  })

  it('空文本返回空结果', () => {
    const { entries, errors } = parseBibtex('   \n  ')
    expect(entries).toEqual([])
    expect(errors).toEqual([])
  })

  it('字段名统一小写', () => {
    const { entries } = parseBibtex('@article{k, Title={T}, YEAR={2020}}')
    expect(entries[0]!.fields.title).toBe('T')
    expect(entries[0]!.fields.year).toBe('2020')
  })
})

describe('parseBibtex：忠实还原用户原文（不转 Unicode、不改大小写）', () => {
  it('LaTeX 转义保持原样，不被转成 Unicode', () => {
    const { entries } = parseBibtex('@article{k, author={Jean-Fran{\\\'c}ois M{\\"u}ller}, title={T}, year={2020}}')
    const author = entries[0]!.fields.author!
    // 关键：不得出现 ć / ü 这类 Unicode 转换结果
    expect(author).toContain("{\\'c}")
    expect(author).toContain('{\\"u}')
    expect(author).not.toContain('ć')
    expect(author).not.toContain('ü')
  })

  it('标题大小写不被 sentence-case 改写', () => {
    const { entries } = parseBibtex('@article{k, title={The Great Gatsby: A Novel}, year={2020}}')
    expect(entries[0]!.fields.title).toBe('The Great Gatsby: A Novel')
  })

  it('花括号大小写保护被保留', () => {
    const { entries } = parseBibtex('@article{k, title={A {C}ase of {DNA}}, year={2020}}')
    expect(entries[0]!.fields.title).toBe('A {C}ase of {DNA}')
  })
})

describe('parseBibtex：字段拍平适配（保持 Record<string,string> 契约）', () => {
  it('多作者用 and 连接为字符串', () => {
    const { entries } = parseBibtex('@article{k, author={John Smith and Jane Doe}, year={2020}}')
    expect(typeof entries[0]!.fields.author).toBe('string')
    expect(entries[0]!.fields.author).toBe('John Smith and Jane Doe')
  })

  it('keywords 等数组字段用逗号连接为字符串', () => {
    const { entries } = parseBibtex('@article{k, keywords={alpha, beta}, year={2020}}')
    expect(typeof entries[0]!.fields.keywords).toBe('string')
    expect(entries[0]!.fields.keywords).toBe('alpha, beta')
  })

  it('所有字段值均为字符串类型', () => {
    const { entries } = parseBibtex(
      '@article{k, author={A and B}, title={T}, keywords={x,y}, publisher={P1 and P2}, year={2020}}'
    )
    for (const value of Object.values(entries[0]!.fields)) {
      expect(typeof value).toBe('string')
    }
  })
})

describe('serializeBibtex：原文保留（核心防污染验收）', () => {
  it('未改动时逐字符不变 —— 非常规排版也不重排', () => {
    // 故意使用紧凑、非规范排版
    const text = '@article{a, title={T},author={A and B},year=2020}'
    expect(roundTrip(text).trim()).toBe(text)
  })

  it('字段顺序不变', () => {
    const text = '@article{a,\n  year = {2020},\n  title = {T},\n  author = {A}\n}'
    expect(roundTrip(text).trim()).toBe(text.trim())
  })

  it('@string 引用不被展开破坏', () => {
    const text = '@string{ieee = "IEEE Trans"}\n\n@article{a, journal = ieee, year = 2020}'
    const out = roundTrip(text)
    // 原文里的 journal = ieee 必须保持引用名，而不是被展开成 "IEEE Trans"
    expect(out).toContain('journal = ieee')
    expect(out).not.toContain('journal = "IEEE Trans"')
  })

  it('双花括号等原始包裹形式保留', () => {
    const text = '@article{a, title = {{Protected Title}}, year = 2020}'
    expect(roundTrip(text)).toContain('{{Protected Title}}')
  })

  it('多条目顺序保持', () => {
    const text = '@article{b, year=2020}\n\n@book{a, year=2019}'
    const out = roundTrip(text)
    expect(out.indexOf('@article{b')).toBeLessThan(out.indexOf('@book{a'))
  })

  it('真正改动某条目时，只有该条目被重写，其余保持原文', () => {
    const text = '@article{a, title={T}, year=2020}\n\n@article{b, title={U}, year=2019}'
    const { entries, rawByKey } = parseBibtex(text)
    const originalByKey = new Map(entries.map((e) => [e.key, e]))
    // 只改 b 的标题
    const edited = entries.map((e) => (e.key === 'b' ? { ...e, fields: { ...e.fields, title: 'Changed' } } : e))
    const out = serializeBibtex(edited, rawByKey, originalByKey)
    // a 保持原文原样
    expect(out).toContain('@article{a, title={T}, year=2020}')
    // b 被重写为新值
    expect(out).toContain('Changed')
    expect(out).not.toContain('title={U}')
  })

  it('新增条目正常渲染', () => {
    const text = '@article{a, title={T}, year=2020}'
    const { entries, rawByKey } = parseBibtex(text)
    const originalByKey = new Map(entries.map((e) => [e.key, e]))
    const added: BibEntry = { key: 'new1', type: 'misc', fields: { title: 'New' } }
    const out = serializeBibtex([...entries, added], rawByKey, originalByKey)
    expect(out).toContain('@misc{new1')
    expect(out).toContain('title = {New}')
    expect(out).toContain('@article{a, title={T}, year=2020}')
  })
})

describe('parseBibtex：畸形输入不得静默吞掉', () => {
  it('未闭合的花括号产生 errors', () => {
    const { errors } = parseBibtex('@article{broken, title={unclosed')
    expect(errors.length).toBeGreaterThan(0)
  })

  it('无条目时 errors 为空', () => {
    const { entries, errors } = parseBibtex('@comment{just a comment}')
    expect(entries).toEqual([])
    expect(errors).toEqual([])
  })
})

describe('bibKeyOf / entryFromPaper', () => {
  it('引用键过滤非法字符', () => {
    expect(bibKeyOf('2103.00020v2')).toBe('210300020v2')
    expect(bibKeyOf('doi:10.1/x')).toBe('doi101x')
  })

  it('论文投影为 @misc 条目', () => {
    const entry = entryFromPaper({
      arxivId: '1512.03385',
      title: 'Deep Residual Learning',
      authors: ['Kaiming He', 'Xiangyu Zhang'],
      summary: '',
      url: '',
      notes: '',
      tags: [],
      projectIds: [],
      addedAt: '2020-05-01T00:00:00.000Z',
    })
    expect(entry.type).toBe('misc')
    expect(entry.fields.author).toBe('Kaiming He and Xiangyu Zhang')
    expect(entry.fields.year).toBe('2020')
    expect(entry.fields.url).toBe('https://arxiv.org/abs/1512.03385')
  })
})
