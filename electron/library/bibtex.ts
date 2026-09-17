/**
 * BibTeX 解析/序列化。
 *
 * 解析改用成熟库 `@retorquere/bibtex-parser`（BibTeX/BibLaTeX 解析事实标准，
 * Zotero/better-bibtex 同源级工具链），不再自研词法器。
 *
 * ── 两条必须遵守的约束（否则会污染用户 .bib）──────────────────────
 *
 * 1. **解析强制 `raw: true` + `sentenceCase: false`**。
 *    该库默认会把 LaTeX 转成 Unicode（`{\'c}` → `ć`）、把英文标题转句首大写。
 *    这两个改写对"读取即回写"的流程等于篡改用户原文，必须关闭。
 *
 * 2. **回写一律原文保留**。库的每个条目都带 `entry.input`（该条目的原始文本片段，
 *    含花括号、LaTeX 源、`@string` 引用名）。序列化时未改动的条目直接输出 `input`，
 *    只有新增/改动的条目才生成新文本。这是"导入后再导出、未改动条目字节级不变"的保证。
 *
 * 之前的手写实现把整个文件重新格式化（压平花括号、展开宏、丢注释），是本模块的最高风险点。
 */
import { parse as parseBibtexLib } from '@retorquere/bibtex-parser'
import type { PaperRecord, BibEntry } from './types'

/** 解析结果：条目 + 原文映射 + 错误列表 */
export interface ParsedBib {
  /** 文件顺序的条目列表（字段已拍平为字符串） */
  entries: BibEntry[]
  /** 引用键 → 该条目的原文片段（用于原样回写） */
  rawByKey: Map<string, string>
  /** 解析错误（非空时调用方应中止回写，避免把未解析出的条目当作"不存在"而丢弃） */
  errors: string[]
}

/**
 * 把库返回的字段值拍平回字符串，保持 `BibEntry.fields: Record<string, string>` 契约。
 *
 * 库对部分字段做了结构化：
 * - creator 类（author/editor…）→ `[{lastName, firstName, ...}]`，需拼回 `A and B`
 * - 数组类（keywords/publisher/institution…）→ `string[]`，需拼回 `a, b`
 * - 其余 → `string`
 */
function flattenField(name: string, value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts = value.map((item) => {
      if (typeof item === 'string') return item
      if (item !== null && typeof item === 'object') {
        const c = item as { name?: unknown; firstName?: unknown; lastName?: unknown; prefix?: unknown; suffix?: unknown }
        // 库已给现成的 name 时直接用（如机构作者）；否则按 bibtex 惯例拼
        if (typeof c.name === 'string' && c.name !== '') return c.name
        const given = typeof c.firstName === 'string' ? c.firstName : ''
        const family = typeof c.lastName === 'string' ? c.lastName : ''
        const prefix = typeof c.prefix === 'string' ? c.prefix : ''
        const suffix = typeof c.suffix === 'string' ? c.suffix : ''
        return [prefix, given, family, suffix].filter((s) => s !== '').join(' ').trim()
      }
      return String(item)
    })
    // creator 类字段用 ` and ` 连接（BibTeX 作者分隔符）；其余用 `, `
    const isCreator = /^(author|bookauthor|collaborator|commentator|director|editor[a-z]?|editors|holder|scriptwriter|translator)$/i.test(name)
    return parts.filter((p) => p !== '').join(isCreator ? ' and ' : ', ')
  }
  if (value === null || value === undefined) return ''
  return String(value)
}

/**
 * 解析 .bib 文本为条目列表（文件顺序）。
 *
 * 强制 `raw: true`（不转 Unicode）与 `sentenceCase: false`（不改标题大小写），
 * 保证读取不改变用户原文语义。
 */
export function parseBibtex(text: string): ParsedBib {
  const empty: ParsedBib = { entries: [], rawByKey: new Map(), errors: [] }
  if (text.trim() === '') return empty

  let library: ReturnType<typeof parseBibtexLib>
  try {
    library = parseBibtexLib(text, { raw: true, sentenceCase: false })
  } catch (error) {
    return {
      entries: [],
      rawByKey: new Map(),
      errors: [error instanceof Error ? error.message : String(error)],
    }
  }

  const entries: BibEntry[] = []
  const rawByKey = new Map<string, string>()
  for (const entry of library.entries) {
    const fields: Record<string, string> = {}
    for (const [name, value] of Object.entries(entry.fields)) {
      fields[name.toLowerCase()] = flattenField(name, value)
    }
    entries.push({ key: entry.key, type: entry.type.toLowerCase(), fields })
    // 原文片段：仅当非空时才可用于回写
    if (typeof entry.input === 'string' && entry.input.trim() !== '') {
      rawByKey.set(entry.key, entry.input.trim())
    }
  }

  const errors = library.errors.map((e) => (e.input ? `${e.error} :: ${e.input}` : e.error))
  return { entries, rawByKey, errors }
}

/** 生成一条条目的规范化文本（仅用于新增/改动条目） */
function renderEntry(entry: BibEntry): string {
  const fields = Object.entries(entry.fields)
    .map(([name, value]) => `  ${name} = {${value}},`)
    .join('\n')
  return fields === ''
    ? `@${entry.type}{${entry.key}}`
    : `@${entry.type}{${entry.key},\n${fields}\n}`
}

/**
 * 序列化条目回 .bib 文本。
 *
 * `rawByKey` 提供时启用**原文保留**：键命中且条目内容未变 → 输出原文；
 * 否则生成新文本。这保证"只定向修改、不重排其余条目"。
 *
 * 判定"是否改动"的方式是**逐字段比对**：调用方传来的 `entries` 与原文解析出的
 * 内容一致时保留原文，任何字段真正变了才重写该条目。
 */
export function serializeBibtex(
  entries: readonly BibEntry[],
  rawByKey?: Map<string, string>,
  originalByKey?: Map<string, BibEntry>
): string {
  const blocks = entries.map((entry) => {
    if (rawByKey !== undefined) {
      const raw = rawByKey.get(entry.key)
      const original = originalByKey?.get(entry.key)
      if (raw !== undefined && original !== undefined && sameEntry(entry, original)) return raw
    }
    return renderEntry(entry)
  })
  return blocks.join('\n\n') + (blocks.length > 0 ? '\n' : '')
}

/** 两个条目是否完全一致（键、类型、字段名与值） */
function sameEntry(a: BibEntry, b: BibEntry): boolean {
  if (a.key !== b.key || a.type.toLowerCase() !== b.type.toLowerCase()) return false
  const ak = Object.keys(a.fields)
  const bk = Object.keys(b.fields)
  if (ak.length !== bk.length) return false
  return ak.every((key) => b.fields[key] === a.fields[key])
}

/** 一个 arXiv id 的 BibTeX 合法引用键 */
export function bibKeyOf(arxivId: string): string {
  return arxivId.replace(/[^a-zA-Z0-9_-]/g, '')
}

/** 把一篇文献库论文投影为 @misc BibTeX 条目 */
export function entryFromPaper(paper: PaperRecord): BibEntry {
  const fields: Record<string, string> = {
    author: paper.authors.join(' and '),
    title: paper.title,
  }
  const year = Number(paper.addedAt.slice(0, 4))
  if (Number.isInteger(year) && year > 1900 && year < 3000) fields.year = String(year)
  fields.eprint = paper.arxivId
  fields.archivePrefix = 'arXiv'
  fields.url = paper.url === '' ? `https://arxiv.org/abs/${paper.arxivId}` : paper.url
  if (paper.notes.trim() !== '') fields.note = paper.notes.trim()
  return { key: bibKeyOf(paper.arxivId), type: 'misc', fields }
}
