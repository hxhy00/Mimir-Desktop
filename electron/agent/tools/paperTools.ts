import { tool } from 'langchain/tools'
import { z } from 'zod'
import { importPaper, updatePaper, listProjects } from '../../library/libraryService'
import { getStoreValue, currentSpaceEpoch, assertSpaceUnchanged } from '../../library/store'
import { requireBusinessApproval } from '../approval'
import { resolvePaperById } from '../paperSearch'

/**
 * paper_fetch 工具：按 arXiv id / DOI 解析论文并自动保存到文献库，
 * 关联到指定项目（缺省关联最近更新的项目）。
 *
 * 元数据解析走统一访问层 `paperSearch`（OpenAlex → Semantic Scholar 回退链），
 * 不再直连 arXiv API —— 旧实现裸调 export.arxiv.org（无节流、无重试），
 * 会话早前被限流时这里会连锁失败并误报「paper-not-found」。
 */
export const paperFetchTool = tool(
  async ({ arxivId, projectId, notes, notesMode, tags, tagsMode }) => {
    try {
      const epoch = currentSpaceEpoch()
      let entry
      try {
        entry = await resolvePaperById(arxivId)
      } catch (error) {
        return `保存论文失败: ${error instanceof Error ? error.message : '未知错误'}`
      }
      const id = entry.id

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
      const allowed = await requireBusinessApproval({
        tool: 'paper_fetch',
        summary: `保存论文「${entry.title.slice(0, 60)}」到文献库`,
        detail: `id: ${id}（来源: ${entry.source ?? 'arxiv'}）\n作者: ${entry.authors.join(', ')}${targetProjectId ? `\n关联项目: ${targetProjectId}` : ''}`,
      })
      if (!allowed) return '已取消：保存论文操作未获得用户确认。'

      await importPaper(entry, targetProjectId)
      assertSpaceUnchanged(epoch)

      // 附加笔记：mode 显式决定追加或覆盖，缺省 append（保守，不破坏既有内容）
      const overwritten: string[] = []
      if (notes && notes.trim()) {
        const current = await getPaperNotes(id)
        const next =
          notesMode === 'replace' ? notes.trim() : current ? `${current}\n\n${notes.trim()}` : notes.trim()
        if (notesMode === 'replace' && current) overwritten.push('笔记')
        await updatePaper({ arxivId: id, notes: next })
        assertSpaceUnchanged(epoch)
      }
      // 附加标签：mode 显式决定合并或覆盖，缺省 merge（保守，不丢弃既有标签）
      if (tags && tags.length > 0) {
        const incoming = tags.map((t) => t.trim()).filter(Boolean)
        const current = await getPaperTags(id)
        const next = tagsMode === 'replace' ? [...new Set(incoming)] : [...new Set([...current, ...incoming])]
        if (tagsMode === 'replace' && current.length > 0) overwritten.push('标签')
        await updatePaper({ arxivId: id, tags: next })
        assertSpaceUnchanged(epoch)
      }

      const warn = overwritten.length > 0 ? `\n- 注意: 已覆盖原有${overwritten.join('与')}` : ''
      return `论文已保存到文献库: ${entry.title}\n- id: ${id}（来源: ${entry.source ?? 'arxiv'}）\n- 作者: ${entry.authors.join(', ')}\n- 链接: ${entry.url}${warn}`
    } catch (error) {
      return `保存论文失败: ${error instanceof Error ? error.message : '未知错误'}`
    }
  },
  {
    name: 'paper_fetch',
    description:
      '按 arXiv id 或 DOI 获取一篇论文并自动保存到文献库（走 OpenAlex/Semantic Scholar，不受 arXiv 限流影响），关联到指定项目（缺省关联最近更新的项目）。可附带笔记和标签。默认「追加笔记、合并标签」，不会丢失已有内容；需覆盖时显式传 notesMode="replace" / tagsMode="replace"。只有标题没有 id 时先用 paper_search/检索拿到 id。',
    schema: z.object({
      arxivId: z.string().describe('arXiv 论文 id（如 "2301.12345"、完整链接）或 DOI（如 "10.1109/cvpr.2016.90"）'),
      projectId: z.string().optional().describe('要关联的项目 id；缺省使用最近更新的项目'),
      notes: z.string().optional().describe('这篇论文为什么有用'),
      notesMode: z.enum(['append', 'replace']).optional().describe('笔记写入方式：append 追加到现有笔记（默认），replace 覆盖原有笔记'),
      tags: z.array(z.string()).optional().describe('组织标签'),
      tagsMode: z.enum(['merge', 'replace']).optional().describe('标签写入方式：merge 合并到现有标签（默认），replace 覆盖原有标签')
    })
  }
)

/**
 * set_paper 工具：更新文献库中一篇论文的组织字段（标签、笔记、AI 相关性评分）。
 * 用于 AI 相关性评分流程：agent 对论文打分后通过本工具持久化。
 */
export const setPaperTool = tool(
  async ({ arxivId, tags, tagsMode, notes, notesMode, projectId, relevanceScore, relevanceReason }) => {
    try {
      const epoch = currentSpaceEpoch()
      const id = arxivId.trim().replace(/^https?:\/\/arxiv\.org\/abs\//, '')
      if (!id) return '无效的 arXiv id。'

      const patch: { arxivId: string; tags?: string[]; notes?: string; relevance?: { projectId: string; score: number; reason: string } } = { arxivId: id }
      const overwritten: string[] = []

      if (tags !== undefined) {
        if (tagsMode === 'replace') {
          if (tags.length > 0) {
            const current = await getPaperTags(id)
            if (current.length > 0) overwritten.push('标签')
          }
          patch.tags = tags
        } else {
          // 缺省 merge：并集去重，不丢弃既有标签
          const current = await getPaperTags(id)
          patch.tags = [...new Set([...current, ...tags.map((t) => t.trim()).filter(Boolean)])]
        }
      }
      if (notes !== undefined) {
        if (notesMode === 'replace') {
          const current = await getPaperNotes(id)
          if (current) overwritten.push('笔记')
          patch.notes = notes
        } else {
          // 缺省 append：拼接到既有笔记之后；空笔记视为清空（保持与显式清空一致）
          const current = await getPaperNotes(id)
          patch.notes = notes.trim() ? (current ? `${current}\n\n${notes.trim()}` : notes.trim()) : notes
        }
      }
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
      if (tags !== undefined) parts.push(`标签: ${patch.tags!.join(', ') || '(清空)'}`)
      if (notes !== undefined) parts.push(`笔记: ${patch.notes ? '已更新' : '(清空)'}`)
      if (projectId !== undefined && relevanceScore !== undefined) parts.push(`项目 ${projectId} 相关性: ${relevanceScore}/10`)
      const allowed = await requireBusinessApproval({
        tool: 'set_paper',
        summary: `更新论文 ${id}`,
        detail: parts.join('\n') || '无变更',
      })
      if (!allowed) return '已取消：更新论文操作未获得用户确认。'

      const updated = await updatePaper(patch)
      assertSpaceUnchanged(epoch)
      const warn = overwritten.length > 0 ? `\n- 注意: 已覆盖原有${overwritten.join('与')}` : ''
      return `论文已更新: ${updated.title}\n- 标签: ${updated.tags.join(', ') || '无'}\n- 笔记: ${updated.notes ? '已设置' : '无'}\n- 相关性评分: ${updated.relevance?.[projectId ?? ''] ? `${updated.relevance[projectId!].score}/10` : '未设置'}${warn}`
    } catch (error) {
      return `更新论文失败: ${error instanceof Error ? error.message : '未知错误'}`
    }
  },
  {
    name: 'set_paper',
    description:
      '更新文献库中一篇论文的组织字段：标签、笔记、AI 相关性评分（0-10 分 + 理由，按项目）。用于 AI 相关性评分流程。默认「追加笔记、合并标签」，不会丢失已有内容；需覆盖时显式传 notesMode="replace" / tagsMode="replace"。',
    schema: z.object({
      arxivId: z.string().describe('arXiv 论文 id'),
      tags: z.array(z.string()).optional().describe('组织标签'),
      tagsMode: z.enum(['merge', 'replace']).optional().describe('标签写入方式：merge 合并到现有标签（默认），replace 覆盖原有标签'),
      notes: z.string().optional().describe('笔记内容'),
      notesMode: z.enum(['append', 'replace']).optional().describe('笔记写入方式：append 追加到现有笔记（默认），replace 覆盖原有笔记'),
      projectId: z.string().optional().describe('评分针对的项目 id'),
      relevanceScore: z.number().min(0).max(10).optional().describe('与项目的相关性评分 0-10'),
      relevanceReason: z.string().optional().describe('评分理由')
    })
  }
)

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