/**
 * 组会模块桥工具：列出已生成的演示文稿，或按用户要求生成一份 .pptx。
 * 生成逻辑与「组会」模块同一套（pptxgenjs 渲染，enhance 需配置模型，失败自动降级）。
 * 生成可能耗时较长（数十秒至数分钟），请先与用户确认主题与选材后再调用。
 */
import { tool } from 'langchain/tools'
import { z } from 'zod'
import { generateMeetingDeck, listMeetingDecks } from '../../meetings/service'
import { requireUserApproval } from '../approval'

export const meetingDeckTool = tool(
  async ({ action, title, presenter, date, projectId, paperIds, experimentIds, enhance, aiImages }) => {
    try {
      if (action === 'list') {
        const decks = await listMeetingDecks()
        if (decks.length === 0) return '尚未生成过组会演示文稿。'
        return `已有 ${decks.length} 份演示文稿：\n` +
          decks
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map((deck) => `- ${deck.file} | ${deck.title} · ${deck.slides} 页 · ${new Date(deck.createdAt).toLocaleString('zh-CN')}\n  路径：${deck.path}`)
            .join('\n')
      }

      if (action === 'generate') {
        if (!title || title.trim() === '') return '生成失败：title（汇报主题）不能为空。'
        // 副作用确认：真实生成 .pptx（可长耗时）需用户放行
        const allowed = await requireUserApproval({
          tool: 'meeting_deck',
          summary: `生成组会演示文稿「${title.trim()}」`,
          detail: `汇报人：${presenter ?? '未填'}；日期：${date ?? '今天'}；论文 ${(paperIds ?? []).length} 篇、实验 ${(experimentIds ?? []).length} 条；${enhance !== false ? '启用 AI 要点提炼（无模型自动降级）' : '关闭 AI 要点'}${aiImages === true ? '；启用 AI 配图' : ''}。生成可能耗时数十秒到数分钟。`,
        })
        if (!allowed) return '已取消：演示文稿生成未获得用户确认（或等待超时）。请先向用户说明并再次发起。'
        const view = await generateMeetingDeck({
          title: title.trim(),
          ...(presenter && presenter.trim() !== '' ? { presenter: presenter.trim() } : {}),
          ...(date && date.trim() !== '' ? { date: date.trim() } : {}),
          ...(projectId && projectId.trim() !== '' ? { projectId: projectId.trim() } : {}),
          paperIds: paperIds ?? [],
          experimentIds: experimentIds ?? [],
          enhance: enhance !== false,
          ...(aiImages === true ? { aiImages: true } : {}),
        })
        return [
          `已生成演示文稿：${view.file}`,
          `标题：${view.title}`,
          `页数：${String(view.slides)}`,
          `路径：${view.path}`,
          '用户可在「组会」模块查看、打开所在文件夹或删除。',
        ].join('\n')
      }

      return '未知 action（可选：list / generate）。'
    } catch (error) {
      return `组会工具执行失败：${error instanceof Error ? error.message : '未知错误'}`
    }
  },
  {
    name: 'meeting_deck',
    description:
      '列出或生成组会演示文稿 .pptx。action=list 查看历史；action=generate 需要 title（汇报主题），' +
      '可选 presenter / date(YYYY-MM-DD) / projectId（关联项目，用于相关性排序）/ paperIds（文献库论文 arXiv id 列表，空则不包含文献小节）/ experimentIds（实验 id 列表，空则不包含实验小节）/ enhance（是否用已配置模型提炼分享要点，缺省 true，失败自动降级）/ aiImages（是否 AI 配图，需配置图像生成服务）。' +
      '生成可能耗时数十秒到数分钟；选材与主题请先与用户确认。',
    schema: z.object({
      action: z.enum(['list', 'generate']),
      title: z.string().optional().describe('汇报主题（generate 必填）'),
      presenter: z.string().optional(),
      date: z.string().optional().describe('YYYY-MM-DD，缺省今天'),
      projectId: z.string().optional(),
      paperIds: z.array(z.string()).optional().describe('文献库论文 arXiv id'),
      experimentIds: z.array(z.string()).optional().describe('实验 id'),
      enhance: z.boolean().optional().describe('是否启用 AI 提炼分享要点，缺省 true'),
      aiImages: z.boolean().optional().describe('是否启用 AI 配图（需已配置图像生成服务）'),
    }),
  },
)
