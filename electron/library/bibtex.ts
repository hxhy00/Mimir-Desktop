/**
 * 依赖零的 BibTeX 解析/序列化（从 Mimir 移植），
 * 以及 PaperRecord → @misc 投影，用于文献库导入 references.bib。
 */
import type { PaperRecord, BibEntry } from './types'

/** 解析时跳过的条目类型 */
const SKIPPED_TYPES = new Set(['string', 'preamble', 'comment'])

/** 读取一个字段值：{花括号}（嵌套感知）、"引号"（转义感知）或裸 token */
function readValue(text: string, start: number): { value: string; end: number } | undefined {
  const opener = text[start]
  if (opener === '{') {
    let depth = 1
    let index = start + 1
    while (index < text.length && depth > 0) {
      const char = text[index]
      if (char === '\\') index += 1
      else if (char === '{') depth += 1
      else if (char === '}') depth -= 1
      index += 1
    }
    if (depth !== 0) return undefined
    return { value: text.slice(start + 1, index - 1), end: index }
  }
  if (opener === '"') {
    let index = start + 1
    while (index < text.length) {
      const char = text[index]
      if (char === '\\') index += 2
      else if (char === '"') return { value: text.slice(start + 1, index), end: index + 1 }
      else index += 1
    }
    return undefined
  }
  const match = /^[^,}\)\s]+/.exec(text.slice(start))
  if (match === null) return undefined
  return { value: match[0], end: start + match[0].length }
}

/** 解析一个 @type{…} 块 */
function readEntry(text: string, at: number): { entry: BibEntry | undefined; end: number } | undefined {
  const head = /^@([a-zA-Z]+)\s*([{(])\s*/.exec(text.slice(at))
  if (head === null) return undefined
  const type = head[1]!.toLowerCase()
  const closer = head[2] === '{' ? '}' : ')'
  let index = at + head[0].length
  if (SKIPPED_TYPES.has(type)) {
    let depth = 1
    while (index < text.length && depth > 0) {
      const char = text[index]
      if (char === '\\') index += 1
      else if (char === '{' || char === '(') depth += 1
      else if (char === '}' || char === ')') depth -= 1
      index += 1
    }
    return { entry: undefined, end: index }
  }
  const keyMatch = /^[^,\s}\)]+/.exec(text.slice(index))
  if (keyMatch === null) return undefined
  const key = keyMatch[0]
  index += key.length
  const fields: Record<string, string> = {}
  let closed = false
  while (index < text.length) {
    const skip = /^(?:\s|%[^\n]*|,)+/.exec(text.slice(index))
    if (skip !== null) index += skip[0].length
    const char = text[index]
    if (char === undefined) return undefined
    if (char === closer) { closed = true; index += 1; break }
    const nameMatch = /^[a-zA-Z][\w-]*\s*=\s*/.exec(text.slice(index))
    if (nameMatch === null) return undefined
    const name = nameMatch[0].replace(/[\s=]/g, '').toLowerCase()
    index += nameMatch[0].length
    const read = readValue(text, index)
    if (read === undefined) return undefined
    fields[name] = read.value
    index = read.end
    const concat = /^\s*#\s*/.exec(text.slice(index))
    if (concat !== null) {
      const next = readValue(text, index + concat[0].length)
      if (next === undefined) return undefined
      fields[name] += next.value
      index = next.end
    }
  }
  if (!closed) return undefined
  return { entry: { key, type, fields }, end: index }
}

/** 解析 .bib 文本为条目列表（文件顺序） */
export function parseBibtex(text: string): BibEntry[] {
  const entries: BibEntry[] = []
  let index = 0
  while (index < text.length) {
    const at = text.indexOf('@', index)
    if (at === -1) break
    const read = readEntry(text, at)
    if (read === undefined) { index = at + 1; continue }
    if (read.entry !== undefined) entries.push(read.entry)
    index = Math.max(read.end, at + 1)
  }
  return entries
}

/** 序列化条目回 .bib 文本 */
export function serializeBibtex(entries: readonly BibEntry[]): string {
  return entries.map((entry) => {
    const fields = Object.entries(entry.fields)
      .map(([name, value]) => `  ${name} = {${value}},`)
      .join('\n')
    return fields === ''
      ? `@${entry.type}{${entry.key}}`
      : `@${entry.type}{${entry.key},\n${fields}\n}`
  }).join('\n\n') + (entries.length > 0 ? '\n' : '')
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