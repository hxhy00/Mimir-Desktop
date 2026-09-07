import { tool } from 'langchain/tools'
import { z } from 'zod'
import { importPaper, updatePaper, listProjects } from '../../library/libraryService'
import { getStoreValue, currentSpaceEpoch, assertSpaceUnchanged } from '../../library/store'
import { requireUserApproval } from '../approval'
import type { ArxivEntry } from '../../library/types'

/**
 * paper_fetch 工具：获取一篇 arXiv 论文并自动保存到文献库，
 * 关联到指定项目（缺省关联最近更新的项目）。
 */
export const paperFetchTool = tool(
  async ({ arxivId, projectId, notes, tags }) => {
    try {
      const epoch = currentSpaceEpoch()
      const id = arxivId.trim().replace(/^https?:\/\/arxiv\.org\/abs\//, '')
      if (!id) return '无效的 arXiv id。'
      const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}&max_results=1`
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      if (!response.ok) return `arXiv API 请求失败: HTTP ${response.status}`
      const xml = await response.text()
      const entries = parseArxivFeed(xml)
      if (entries.length === 0) return `arXiv 中未找到 id 为 '${id}' 的记录。`
      const entry = entries[0]!

      // 解析项目 id：显式指定或最近更新的项目
      let targetProjectId: string | undefined = projectId
      if (targetProjectId) {
        const projects = await listProjects()
        if (!projects.some((p) => p.id === targetProjectId)) {
          return `项目不存在: ${targetProjectId}。可用项目: ${projects.map((p) => `${p.id}(${p.title})`).join(', ')}`
        }
      } else {
        const projects = await listProjects()
        targetProjectId = projects[0]?.id
      }

      assertSpaceUnchanged(epoch)

      // 副作用确认：保存论文到文献库
      const allowed = await requireUserApproval({
        tool: 'paper_fetch',
        summary: `保存论文「${entry.title.slice(0, 60)}」到文献库`,
        detail: `arXiv id: ${id}\n作者: ${entry.authors.join(', ')}${targetProjectId ? `\n关联项目: ${targetProjectId}` : ''}`,
      })
      if (!allowed) return '已取消：保存论文操作未获得用户确认。'

      await importPaper(entry, targetProjectId)
      assertSpaceUnchanged(epoch)

      // 附加笔记（追加到现有笔记）
      if (notes && notes.trim()) {
        const current = await getPaperNotes(id)
        await updatePaper({ arxivId: id, notes: current ? `${current}\n\n${notes.trim()}` : notes.trim() })
        assertSpaceUnchanged(epoch)
      }
      // 附加标签
      if (tags && tags.length > 0) {
        const current = await getPaperTags(id)
        await updatePaper({ arxivId: id, tags: [...new Set([...current, ...tags.map((t) => t.trim()).filter(Boolean)])] })
        assertSpaceUnchanged(epoch)
      }

      return `论文已保存到文献库: ${entry.title}\n- arXiv id: ${id}\n- 作者: ${entry.authors.join(', ')}\n- 链接: ${entry.url}`
    } catch (error) {
      return `保存论文失败: ${error instanceof Error ? error.message : '未知错误'}`
    }
  },
  {
    name: 'paper_fetch',
    description:
      '获取一篇 arXiv 论文并自动保存到文献库，关联到指定项目（缺省关联最近更新的项目）。可附带笔记和标签。',
    schema: z.object({
      arxivId: z.string().describe('arXiv 论文 id，如 "2301.12345" 或完整链接'),
      projectId: z.string().optional().describe('要关联的项目 id；缺省使用最近更新的项目'),
      notes: z.string().optional().describe('这篇论文为什么有用；追加到现有笔记'),
      tags: z.array(z.string()).optional().describe('组织标签，合并到论文')
    })
  }
)

/**
 * set_paper 工具：更新文献库中一篇论文的组织字段（标签、笔记、AI 相关性评分）。
 * 用于 AI 相关性评分流程：agent 对论文打分后通过本工具持久化。
 */
export const setPaperTool = tool(
  async ({ arxivId, tags, notes, projectId, relevanceScore, relevanceReason }) => {
    try {
      const epoch = currentSpaceEpoch()
      const id = arxivId.trim().replace(/^https?:\/\/arxiv\.org\/abs\//, '')
      if (!id) return '无效的 arXiv id。'

      const patch: { arxivId: string; tags?: string[]; notes?: string; relevance?: { projectId: string; score: number; reason: string } } = { arxivId: id }
      if (tags !== undefined) patch.tags = tags
      if (notes !== undefined) patch.notes = notes
      if (projectId !== undefined && relevanceScore !== undefined) {
        patch.relevance = {
          projectId,
          score: relevanceScore,
          reason: relevanceReason ?? ''
        }
      }

      assertSpaceUnchanged(epoch)

      // 副作用确认：更新论文
      const parts: string[] = []
      if (tags !== undefined) parts.push(`标签: ${tags.join(', ') || '(清空)'}`)
      if (notes !== undefined) parts.push(`笔记: ${notes ? '已设置' : '(清空)'}`)
      if (projectId !== undefined && relevanceScore !== undefined) parts.push(`项目 ${projectId} 相关性: ${relevanceScore}/10`)
      const allowed = await requireUserApproval({
        tool: 'set_paper',
        summary: `更新论文 ${id}`,
        detail: parts.join('\n') || '无变更',
      })
      if (!allowed) return '已取消：更新论文操作未获得用户确认。'

      const updated = await updatePaper(patch)
      assertSpaceUnchanged(epoch)
      return `论文已更新: ${updated.title}\n- 标签: ${updated.tags.join(', ') || '无'}\n- 笔记: ${updated.notes ? '已设置' : '无'}\n- 相关性评分: ${updated.relevance?.[projectId ?? ''] ? `${updated.relevance[projectId!].score}/10` : '未设置'}`
    } catch (error) {
      return `更新论文失败: ${error instanceof Error ? error.message : '未知错误'}`
    }
  },
  {
    name: 'set_paper',
    description:
      '更新文献库中一篇论文的组织字段：标签、笔记、AI 相关性评分（0-10 分 + 理由，按项目）。用于 AI 相关性评分流程。',
    schema: z.object({
      arxivId: z.string().describe('arXiv 论文 id'),
      tags: z.array(z.string()).optional().describe('组织标签（整体替换）'),
      notes: z.string().optional().describe('笔记内容（整体替换）'),
      projectId: z.string().optional().describe('评分针对的项目 id'),
      relevanceScore: z.number().min(0).max(10).optional().describe('与项目的相关性评分 0-10'),
      relevanceReason: z.string().optional().describe('评分理由')
    })
  }
)

/** 解析 arXiv Atom feed（与 library/arxiv.ts 的 parseArxivFeed 一致） */
function parseArxivFeed(xml: string): ArxivEntry[] {
  const entries: ArxivEntry[] = []
  const entryBlocks = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? []
  for (const block of entryBlocks) {
    const getTag = (tag: string) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))
      return m ? m[1].trim().replace(/\s+/g, ' ') : ''
    }
    const rawId = getTag('id')
    const id = rawId.replace(/^https?:\/\/arxiv\.org\/abs\//, '')
    if (id.length === 0) continue
    const authors = [...block.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => m[1]!.trim())
    entries.push({
      id,
      title: getTag('title'),
      authors,
      summary: getTag('summary'),
      published: getTag('published'),
      url: `https://arxiv.org/abs/${id}`,
    })
  }
  return entries
}

/** 读取论文现有笔记（内部辅助） */
async function getPaperNotes(arxivId: string): Promise<string> {
  const table = getStoreValue<Record<string, { notes?: string }>>('library:papers') ?? {}
  return table[arxivId]?.notes ?? ''
}

/** 读取论文现有标签（内部辅助） */
async function getPaperTags(arxivId: string): Promise<string[]> {
  const table = getStoreValue<Record<string, { tags?: string[] }>>('library:papers') ?? {}
  return table[arxivId]?.tags ?? []
}