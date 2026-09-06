/**
 * 图表模块桥工具：与「图表」模块同一份数据（store `figures:list` + 空间根 figures/ 文件）。
 * - list：列出已登记图片；
 * - add：把磁盘上一张图片登记进图表库（需用户确认路径）；
 * - rename：重命名并同步各项目论文目录 .tex 中的引用；
 * - remove：删除图片（会从论文 .tex 引用中留下缺图——请先向用户说明风险并确认）。
 */
import { tool } from 'langchain/tools'
import { z } from 'zod'
import { readFile } from 'fs/promises'
import { extname, basename } from 'path'
import {
  listFigures,
  importFigure,
  removeFigure,
  applyFigureRename,
  type FigureRecord,
} from '../../figures/figuresService'
import { getStoreValue } from '../../library/store'
import { requireUserApproval } from '../approval'

const PROJECTS_KEY = 'library:projects'

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

/** 收集需要同步 .tex 引用的项目目录：library:projects 中配置了 paperDir 的目录。 */
function projectDirs(): string[] {
  const raw = getStoreValue<unknown>(PROJECTS_KEY)
  if (!Array.isArray(raw)) return []
  const dirs: string[] = []
  for (const item of raw) {
    if (typeof item === 'object' && item !== null) {
      const dir = (item as { paperDir?: unknown }).paperDir
      if (typeof dir === 'string' && dir !== '') dirs.push(dir)
    }
  }
  return dirs
}

function describeRecord(record: FigureRecord): string {
  return `- ${record.fileName} | ${record.name} · ${(record.sizeBytes / 1024).toFixed(1)} KB · ${record.createdAt}`
}

export const figureTool = tool(
  async ({ action, name, sourcePath, fileName, newName }) => {
    try {
      if (action === 'list') {
        const figures = await listFigures()
        if (figures.length === 0) return '图表库暂无图片。'
        return `图表库共 ${figures.length} 张图片（最新在前）：\n${figures.map(describeRecord).join('\n')}`
      }

      // 副作用确认：add / rename / remove 需用户放行
      const confirm =
        action === 'add'
          ? { summary: `导入图片：${name ?? basename(sourcePath ?? '')}`, detail: `来源路径：${sourcePath ?? ''}` }
          : action === 'rename'
            ? { summary: `重命名图片 ${fileName ?? ''} → ${newName ?? ''}`, detail: '将同步替换各项目论文目录 .tex 中的旧文件名引用。' }
            : action === 'remove'
              ? { summary: `删除图片 ${fileName ?? ''}`, detail: '删除不可撤销；若论文 .tex 仍引用它会编译报缺图。' }
              : null
      if (confirm !== null) {
        const allowed = await requireUserApproval({ tool: 'figure', summary: confirm.summary, detail: confirm.detail })
        if (!allowed) return '已取消：该图表操作未获得用户确认（或等待超时）。请先向用户说明并再次发起。'
      }

      if (action === 'add') {
        if (!sourcePath || sourcePath.trim() === '') return '导入失败：sourcePath（图片文件绝对路径）不能为空。'
        const ext = extname(sourcePath.trim()).toLowerCase()
        const mime = MIME_BY_EXT[ext]
        if (mime === undefined) return '导入失败：仅支持 png / jpg / jpeg / gif / webp。'
        const buffer = await readFile(sourcePath.trim())
        const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`
        const record = await importFigure(name ?? basename(sourcePath.trim()), dataUrl)
        return `已导入图片 ${record.fileName}（${(record.sizeBytes / 1024).toFixed(1)} KB）。`
      }

      if (action === 'rename') {
        if (!fileName || !newName || newName.trim() === '') return '重命名失败：需提供 fileName（含扩展名）与 newName。'
        const result = await applyFigureRename(fileName, newName.trim(), projectDirs())
        return `已重命名 ${fileName} → ${result.newFile}${result.replaced > 0 ? `，并替换了 ${result.replaced} 处 .tex 引用` : '（未在任何项目 .tex 中发现引用）'}。`
      }

      if (action === 'remove') {
        if (!fileName) return '删除失败：fileName 不能为空。'
        await removeFigure(fileName)
        return `已删除图片 ${fileName}。如论文 .tex 仍引用它，编译会报缺图——请提醒用户检查。`
      }

      return '未知 action（可选：list / add / rename / remove）。'
    } catch (error) {
      return `图表工具执行失败：${error instanceof Error ? error.message : '未知错误'}`
    }
  },
  {
    name: 'figure',
    description:
      '操作图表库（与「图表」模块同一份数据）。action=list 列出全部；add 需要 sourcePath（磁盘上图片的绝对路径，可选 name 覆盖显示名）；rename 需要 fileName（含扩展名）与 newName，会自动同步各项目论文目录 .tex 中的引用；remove 删除图片并提示缺图风险。add/rename/remove 均请先与用户确认。',
    schema: z.object({
      action: z.enum(['list', 'add', 'rename', 'remove']),
      sourcePath: z.string().optional().describe('add 时的图片文件绝对路径'),
      name: z.string().optional().describe('add 时的显示名（可选）'),
      fileName: z.string().optional().describe('目标图片文件名（含扩展名）'),
      newName: z.string().optional().describe('rename 的新名称（不含扩展名）'),
    }),
  },
)
