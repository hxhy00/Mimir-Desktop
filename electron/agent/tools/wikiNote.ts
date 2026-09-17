import { tool } from 'langchain/tools'
import { z } from 'zod'
import { existsSync } from 'node:fs'
import { writeFile, mkdir, readFile } from 'fs/promises'
import { join } from 'path'
import { spaceRoot, currentSpaceEpoch, assertSpaceUnchanged } from '../../library/store'
import { requireBusinessApproval } from '../approval'
import { authorize } from '../fsBackend'

/**
 * Wiki note tool - save notes to the current research space's wiki directory.
 *
 * 写工具的三道门（与其它写工具 experiment / project / ledger 对齐）：
 *   ① 落盘权限矩阵（{@link authorize}）：控制平面硬拒绝、只读档拒绝、空间外弹卡；
 *   ② 业务批准卡（{@link requireBusinessApproval}）：档位感知，全权档下非破坏性动作自动放行并落审计；
 *   ③ 空间代际校验（{@link assertSpaceUnchanged}）：跨「读已有笔记 → await 用户批准 → 写回」的
 *      异步边界，期间空间若被切换则中止，避免把笔记写进另一个空间。
 *
 * 此前本工具三道门一道都没有：既没有审批卡、也没有空间校验，且直接 `writeFile` 落盘，
 * 是全项目唯一完全绕开权限矩阵的写工具。
 */
export const wikiNoteTool = tool(
  async ({ title, content }) => {
    try {
      const epoch = currentSpaceEpoch()
      const wikiDir = join(spaceRoot(), 'wiki')
      const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_')
      const filePath = join(wikiDir, `${safeTitle}.md`)
      // 只取元数据（不读内容），用于批准卡上说明「新建」还是「追加」；
      // 与 `canonicalize` / `authorize` 内部已有的存在性检查同一口径。
      const noteExists = existsSync(filePath)
      const modeHint = noteExists ? '已存在同名笔记，本次将在文末追加一节。' : '将新建该笔记文件。'

      // ① 落盘权限：与 MimirFsBackend 走同一套矩阵，不存在「工具自己写盘就不受管」的特例。
      const permitted = await authorize({
        target: filePath,
        action: 'write',
        tool: 'wiki_note',
        summary: `写入研究笔记 ${filePath}`,
        detail: `笔记标题「${title}」。${modeHint}共 ${content.length} 字符。`
      })
      if (!permitted.ok) return permitted.message

      // ② 业务批准卡（档位感知）：全权档下自动放行并记审计，其余档位交由用户裁决。
      const approved = await requireBusinessApproval({
        tool: 'wiki_note',
        summary: `保存研究笔记「${title}」`,
        detail: `写入路径：${filePath}\n${modeHint}\n内容 ${content.length} 字符。`
      })
      if (!approved) {
        return '已取消：保存笔记未获得用户确认（或等待超时）。请先向用户说明要记录的内容并再次发起。'
      }

      // ③ 空间代际校验：批准等待期间空间可能已被切换，此时写回会污染新空间。
      assertSpaceUnchanged(epoch)

      await mkdir(wikiDir, { recursive: true })

      let existing = ''
      try {
        existing = await readFile(filePath, 'utf-8')
      } catch {
        // File doesn't exist yet
      }

      const timestamp = new Date().toISOString()
      const newContent = existing
        ? `${existing}\n\n---\n\n## ${timestamp}\n\n${content}`
        : `# ${title}\n\n> 创建于 ${timestamp}\n\n${content}`

      await writeFile(filePath, newContent, 'utf-8')

      return `笔记已保存到 ${filePath}`
    } catch (error) {
      return `保存笔记失败: ${error instanceof Error ? error.message : '未知错误'}`
    }
  },
  {
    name: 'wiki_note',
    description: '创建或追加 Wiki 笔记。将研究笔记保存到本地 wiki 目录，支持追加内容。写操作会弹批准卡，需先与用户确认。',
    schema: z.object({
      title: z.string().describe('笔记标题'),
      content: z.string().describe('笔记内容，支持 Markdown 格式')
    })
  }
)
