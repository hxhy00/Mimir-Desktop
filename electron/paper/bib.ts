/**
 * 论文项目参考文献（references.bib）读写：复用 bibtex 解析/序列化。
 *
 * 写回采用**原文保留**策略：读取时记录各条目的原文片段，保存时未改动的条目
 * 原样输出，只有新增/改动的条目才重新渲染。避免"保存一次就把整个文件重排"。
 */
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import { parseBibtex, serializeBibtex } from '../library/bibtex'
import type { BibEntry } from '../library/types'

function bibPathOf(projectDir: string): string {
  return join(projectDir, 'references.bib')
}

/** 读取项目 references.bib（不存在时返回空列表）。 */
export async function readPaperBib(projectDir: string): Promise<{ entries: BibEntry[]; path: string }> {
  const path = bibPathOf(projectDir)
  if (!existsSync(path)) return { entries: [], path }
  const text = await readFile(path, 'utf-8')
  const parsed = parseBibtex(text)
  if (parsed.errors.length > 0) {
    throw new Error(`references.bib 解析失败：${parsed.errors[0]}`)
  }
  return { entries: parsed.entries, path }
}

/**
 * 把条目列表写回 references.bib。
 *
 * 重新读取磁盘原文以获得"原文映射 + 原始条目内容"，据此对未改动条目保留原文。
 * 这样 UI 里只改了一个字段，也不会动其他条目一个字符。
 */
export async function writePaperBib(projectDir: string, entries: readonly BibEntry[]): Promise<void> {
  const path = bibPathOf(projectDir)
  let existing = ''
  try {
    existing = await readFile(path, 'utf-8')
  } catch {
    // 文件不存在 → 全新写入
  }
  const { entries: originals, rawByKey, errors } = parseBibtex(existing)
  if (errors.length > 0) {
    throw new Error(`现有 references.bib 解析失败，已中止写入以保护原文件：${errors[0]}`)
  }
  const originalByKey = new Map(originals.map((e) => [e.key, e]))
  await writeFile(path, serializeBibtex(entries, rawByKey, originalByKey), 'utf-8')
}
