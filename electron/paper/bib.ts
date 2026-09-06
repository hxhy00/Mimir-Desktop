/**
 * 论文项目参考文献（references.bib）读写：复用 bibtex 解析/序列化。
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
  return { entries: parseBibtex(text), path }
}

/** 把条目列表整体序列化写回 references.bib。 */
export async function writePaperBib(projectDir: string, entries: readonly BibEntry[]): Promise<void> {
  const path = bibPathOf(projectDir)
  await writeFile(path, serializeBibtex(entries), 'utf-8')
}
