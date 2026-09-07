/**
 * Wiki 笔记轻量检索工具（治理 P0「文档 ID 引用」的最小可用形态）。
 * 只读扫描当前科研空间 wiki/*.md，按标题/正文关键词命中并返回 top-K 文件与片段（≤400 字），
 * 供 Agent 按需取片段，不把整篇笔记复制进 prompt。
 */
import { tool } from 'langchain/tools'
import { z } from 'zod'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { spaceRoot } from '../../library/store'

const SNIPPET_MAX = 400
const FILE_READ_CAP = 120_000

function snippetAround(text: string, token: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat === '') return ''
  const idx = flat.toLowerCase().indexOf(token.toLowerCase())
  if (idx === -1) return flat.length > max ? `${flat.slice(0, max)}…` : flat
  const start = Math.max(0, idx - Math.floor(max * 0.35))
  const end = Math.min(flat.length, start + max)
  const head = start > 0 ? '…' : ''
  const tail = end < flat.length ? '…' : ''
  return `${head}${flat.slice(start, end)}${tail}`
}

export const wikiSearchTool = tool(
  async ({ query, limit = 5 }) => {
    try {
      const norm = query.trim()
      if (norm === '') return '检索关键词为空。'
      const wanted = Math.min(Math.max(Math.trunc(limit), 1), 8)
      const tokens = norm
        .toLowerCase()
        .split(/[\s,，、;；]+/)
        .filter((t) => t !== '')

      const wikiDir = join(spaceRoot(), 'wiki')
      let files: string[]
      try {
        files = (await readdir(wikiDir)).filter((f) => f.toLowerCase().endsWith('.md'))
      } catch {
        return '当前科研空间还没有 Wiki 笔记（wiki/ 目录不存在或为空）。可让 Agent 先写一条 wiki_note 笔记。'
      }

      const hits: { file: string; title: string; score: number; snippet: string }[] = []
      for (const file of files) {
        let content = ''
        try {
          content = await readFile(join(wikiDir, file), 'utf-8')
        } catch {
          continue
        }
        if (content.length > FILE_READ_CAP) content = content.slice(0, FILE_READ_CAP)
        const titleFromFile = file.replace(/\.md$/, '').replace(/_/g, ' ')
        const firstLine = content.split('\n').find((l) => l.startsWith('# '))
        const title = (firstLine?.replace(/^#\s*/, '') ?? titleFromFile).trim()
        const titleScore = tokens.filter((t) => title.toLowerCase().includes(t)).length
        const bodyScore = tokens.filter((t) => content.toLowerCase().includes(t)).length
        const score = titleScore * 4 + bodyScore
        if (score <= 0) continue
        const token = tokens.find((t) => content.toLowerCase().includes(t)) ?? tokens[0]
        hits.push({ file, title, score, snippet: snippetAround(content, token ?? '', SNIPPET_MAX) })
      }
      hits.sort((a, b) => b.score - a.score)

      if (hits.length === 0) {
        return 'Wiki 笔记中没有命中。提示：可让 Agent 新建/检索到相关文献后用 wiki_note 记录。'
      }
      const top = hits.slice(0, wanted)
      const lines = [`Wiki 笔记命中 ${hits.length} 篇（显示前 ${top.length}）：`]
      for (const hit of top) {
        lines.push(
          `### ${hit.title}\n` +
            `- 文件: ${hit.file}\n` +
            `- 片段: ${hit.snippet !== '' ? hit.snippet : '（无正文片段）'}`
        )
      }
      return lines.join('\n\n')
    } catch (error) {
      return `检索 Wiki 笔记失败: ${error instanceof Error ? error.message : '未知错误'}`
    }
  },
  {
    name: 'wiki_search',
    description:
      '只读检索当前科研空间的 Wiki 笔记（按标题与正文关键词匹配），返回 top-K 笔记文件与命中片段。' +
      '当你需要回顾历史研究笔记、在写作中引用之前沉淀的结论时使用。新建/追加笔记请用 wiki_note。',
    schema: z.object({
      query: z.string().describe('检索关键词，如 "多模态 对比学习"'),
      limit: z.number().optional().default(5).describe('返回条数，默认 5，最多 8')
    })
  }
)
