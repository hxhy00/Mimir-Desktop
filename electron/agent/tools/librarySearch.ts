/**
 * 文献库轻量检索工具（治理 P0「文档 ID 引用」的最小可用形态）。
 * 只读检索当前科研空间的文献库（title / authors / summary / tags / 阅读笔记），
 * 返回 top-K 命中的来源与片段（≤400 字/条），供 Agent 按需取用，不复制整库进 prompt。
 * 关键词匹配，不做语义检索；未命中时明确引导其它检索工具。
 */
import { tool } from 'langchain/tools'
import { z } from 'zod'
import { listPapers } from '../../library/libraryService'

const SNIPPET_MAX = 400
const OUTPUT_MAX = 4000

/** 把长文本压缩成命中点附近的一段摘要（优先取首次命中的上下文）。 */
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

export const librarySearchTool = tool(
  async ({ query, projectId, tags, limit = 5 }) => {
    try {
      const norm = query.trim()
      if (norm === '') return '检索关键词为空。'
      const wanted = Math.min(Math.max(Math.trunc(limit), 1), 8)
      const tokens = norm
        .toLowerCase()
        .split(/[\s,，、;；]+/)
        .filter((t) => t !== '')

      // 领域字段加权：title > tags > notes > summary > authors
      const weigh = (text: string, weight: number): number =>
        tokens.filter((t) => text.toLowerCase().includes(t)).length * weight

      const scored = listPapers()
        .filter((p) => (projectId === undefined ? true : p.projectIds.includes(projectId)))
        .filter((p) =>
          tags === undefined || tags.length === 0
            ? true
            : tags.some((tag) => p.tags.some((pt) => pt.toLowerCase() === tag.toLowerCase()))
        )
        .map((p) => {
          const score =
            weigh(p.title, 5) +
            weigh(p.tags.join(' '), 4) +
            weigh(p.notes, 3) +
            weigh(p.summary, 2) +
            weigh(p.authors.join(' '), 1)
          if (score <= 0) return null
          const firstToken = tokens.find(
            (t) =>
              p.title.toLowerCase().includes(t) ||
              p.notes.toLowerCase().includes(t) ||
              p.summary.toLowerCase().includes(t) ||
              p.tags.join(' ').toLowerCase().includes(t)
          )
          return { p, score, firstToken }
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .sort((a, b) => b.score - a.score)
        .slice(0, wanted)

      if (scored.length === 0) {
        return (
          '文献库中没有与关键词匹配的论文。提示：可改用 arxiv_search 搜索外部 arXiv、web_search 搜网页，' +
          '找到后用 paper_fetch 保存进文献库再检索。'
        )
      }

      const lines: string[] = []
      lines.push(`文献库命中 ${scored.length} 篇：`)
      for (const { p, firstToken } of scored) {
        const at = firstToken ?? ''
        // 在命中字段上截取片段，避免整段摘要/笔记复制进模型上下文
        const noteHit = at !== '' && p.notes.toLowerCase().includes(at) ? snippetAround(p.notes, at, SNIPPET_MAX) : ''
        const summaryHit =
          at === '' || p.summary.toLowerCase().includes(at) ? snippetAround(p.summary, at, SNIPPET_MAX) : ''
        const snippet = noteHit !== '' ? `笔记：${noteHit}` : summaryHit !== '' ? `摘要：${summaryHit}` : ''
        const url = p.url || `https://arxiv.org/abs/${p.arxivId}`
        lines.push(
          `### ${p.title}\n` +
            `- arXiv id: ${p.arxivId}\n` +
            `- 标签: ${p.tags.length > 0 ? p.tags.join('、') : '无'}\n` +
            `- 入库时间: ${p.addedAt.slice(0, 10)}\n` +
            `${snippet !== '' ? `- 片段: ${snippet}\n` : ''}` +
            `- 链接: ${url}`
        )
      }
      const output = lines.join('\n\n')
      return output.length > OUTPUT_MAX ? `${output.slice(0, OUTPUT_MAX)}…` : output
    } catch (error) {
      return `检索文献库失败: ${error instanceof Error ? error.message : '未知错误'}`
    }
  },
  {
    name: 'library_search',
    description:
      '只读检索当前科研空间「文献库」中已收藏的论文（标题/作者/摘要/标签/阅读笔记做关键词匹配），返回 top-K 命中与片段。' +
      '当你需要基于用户已收藏论文作答、回顾笔记、或确认某篇论文是否已在库中时使用。外部论文请用 arxiv_search，入库用 paper_fetch。',
    schema: z.object({
      query: z.string().describe('检索关键词，如 "vision transformer 注意力"'),
      projectId: z.string().optional().describe('限定某研究项目 id（只查关联该项目的论文）'),
      tags: z.array(z.string()).optional().describe('按标签过滤（任一命中即可）'),
      limit: z.number().optional().default(5).describe('返回条数，默认 5，最多 8')
    })
  }
)
