/**
 * 通用本地文件系统工具（files agent 专用）：让 Agent 具备「读写磁盘上用户文件」的能力，
 * 覆盖研发型任务的常见诉求：读某个项目/工作文件夹内容做上下文、把调研/综述结论写成指定文档。
 *
 * 安全模型（配合 electron/agent/approval.ts 的批准卡，与 Supervisor/worker 解耦）：
 * - read_dir / read_file：只读、不落盘、不执行。位于当前激活科研空间根（spaceRoot()）内的
 *   路径免批准（属于用户自己的研究资料，等价于 wiki_search）；对空间外的任意绝对路径读取会弹
 *   一次批准卡，避免无感把用户机器敏感文件读进外发模型上下文。
 * - write_file：把内容创建/覆盖写入任意路径，属于写副作用，一律弹批准卡；自动创建父目录。
 *
 * 内容保护：文本读取上限 100KB，避免把巨型/二进制文件灌进上下文；超过上限拒绝整读并给出提示，
 * 不作为「只读整篇」兜底。write_file 只接受文本型内容，不写二进制。
 */
import { tool } from 'langchain/tools'
import { z } from 'zod'
import { readdir, readFile, writeFile, mkdir, stat } from 'fs/promises'
import { dirname, resolve, sep } from 'path'
import { spaceRoot } from '../../library/store'
import { requireUserApproval } from '../approval'

/** 单次读取纳入上下文的文本字节上限。 */
const READ_TEXT_CAP = 100_000
/** read_dir 单次最多回显的条目数（防超大目录刷爆响应）。 */
const DIR_LIST_CAP = 500

/** 目标是否位于当前激活科研空间内。空间内视为用户自有资料（免批准只读），否则进入批准流程。 */
function isInsideSpace(p: string): boolean {
  try {
    const root = resolve(spaceRoot())
    const target = resolve(p)
    return target === root || target.startsWith(root + sep)
  } catch {
    return false
  }
}

export const readDirTool = tool(
  async ({ dir }) => {
    try {
      if (typeof dir !== 'string' || dir.trim() === '') return '读取失败：dir 不能为空（需为目录绝对路径）。'
      const target = resolve(dir.trim())
      if (!isInsideSpace(target)) {
        const allowed = await requireUserApproval({
          tool: 'read_dir',
          summary: `读取目录 ${target}`,
          detail: '该目录位于当前科研空间之外。将只读列出文件名与类型，不修改任何内容；目录内容可能含系统/敏感文件。',
        })
        if (!allowed) return '已取消：读取未获得用户确认（或等待超时）。请先向用户说明要读取的目录并再次发起。'
      }
      const entries = await readdir(target, { withFileTypes: true })
      const rows = entries.map((e) => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
      }))
      rows.sort((a, b) => (a.name === b.name ? 0 : a.name < b.name ? -1 : 1))
      const shown = rows.slice(0, DIR_LIST_CAP)
      const lines = [`目录 ${target} 共 ${rows.length} 项，已列出前 ${shown.length} 项：`]
      for (const row of shown) lines.push(`- [${row.type}] ${row.name}`)
      if (rows.length > DIR_LIST_CAP) lines.push('…（条目过多已截断）')
      lines.push('如需更深的子目录内容，可再将该子目录的绝对路径作为 dir 调用。')
      return lines.join('\n')
    } catch (error) {
      return `读取目录失败: ${error instanceof Error ? error.message : '未知错误'}`
    }
  },
  {
    name: 'read_dir',
    description:
      '只读列出本地某个目录下的条目（文件名与类型），在处理用户项目/文件夹前先探清里面有什么。' +
      '读取科研空间根内的目录免批准；读取空间外任意目录会弹批准卡，卡片通过后返回列表。一次仅列一层。',
    schema: z.object({
      dir: z.string().describe('要列出的目录绝对路径'),
    }),
  },
)

export const readFileTool = tool(
  async ({ path }) => {
    try {
      if (typeof path !== 'string' || path.trim() === '') return '读取失败：path 不能为空（需为文件绝对路径）。'
      const target = resolve(path.trim())
      if (!isInsideSpace(target)) {
        const allowed = await requireUserApproval({
          tool: 'read_file',
          summary: `读取文件 ${target}`,
          detail: '该文件位于当前科研空间之外。将只读其文本并入分析上下文，不修改文件；内容可能含敏感信息。',
        })
        if (!allowed) return '已取消：读取未获得用户确认（或等待超时）。请先向用户说明要读取的文件并再次发起。'
      }
      const st = await stat(target)
      if (!st.isFile()) return `不是普通文件：${target}`
      if (st.size > READ_TEXT_CAP) {
        return `文件过大（${st.size} 字节）。单次读取上限 ${READ_TEXT_CAP} 字节，拒绝整读以免污染上下文。请在编辑器里自行查看长文件，或把要处理的具体片段（草稿/日志/表格）粘贴给 Agent。`
      }
      let text: string
      try {
        text = await readFile(target, 'utf-8')
      } catch {
        return `该文件不是可用 UTF-8 解码的文本（${
          st.size
        } 字节）。本工具只处理文本文件；请勿传入二进制/图片路径（论文配图请走 figure 工具）。`
      }
      return `文件: ${target} · ${st.size} 字节\n\n${text}`
    } catch (error) {
      return `读取文件失败: ${error instanceof Error ? error.message : '未知错误'}`
    }
  },
  {
    name: 'read_file',
    description:
      '只读读取本地一个文本文件的内容（绝对路径，UTF-8），把用户项目/工作目录里的文件纳入分析上下文，' +
      '用于读取已有草稿、笔记、配置后做综述、续写或评审。读取空间外的文件会弹批准卡。超大文本与二进制文件请勿传入。',
    schema: z.object({
      path: z.string().describe('要读取的文件绝对路径'),
    }),
  },
)

export const writeFileTool = tool(
  async ({ path, content }) => {
    try {
      if (typeof path !== 'string' || path.trim() === '') return '写入失败：path 不能为空（需为目标文件绝对路径）。'
      const target = resolve(path.trim())
      if (typeof content !== 'string') return '写入失败：content 需为文本内容；本工具只写文本/Markdown，不写二进制。'
      if (content.length > 1_000_000) return '写入失败：单次内容超 1MB，建议拆为多个文档分段写入。'

      // 已存在则回显现状给用户，避免无意整篇覆盖重要文件
      const existing = await readFile(target, 'utf-8').catch(() => null)
      const overwriteHint = existing === null ? '目标文件不存在，将新建。' : `目标文件已存在（${existing.length} 字符），本次将整篇覆盖。`
      const existingHead = existing !== null ? existing.slice(0, 300) : ''

      const allowed = await requireUserApproval({
        tool: 'write_file',
        summary: `写入文档 ${target}`,
        detail:
          `${overwriteHint}将创建父目录并写入 ${content.length} 字符文本内容（本次分析/调研产出）。` +
          (existingHead !== '' ? `\n--- 现有文件开头 ---\n${existingHead}` : '')
      })
      if (!allowed) return '已取消：写入未获得用户确认（或等待超时）。请先与用户确认目标路径与内容后再发起。'

      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, 'utf-8')
      return `已写入 ${target}（${content.length} 字符）。`
    } catch (error) {
      return `写入文件失败: ${error instanceof Error ? error.message : '未知错误'}`
    }
  },
  {
    name: 'write_file',
    description:
      '把一段文本/Markdown 内容创建或覆盖写入用户的任意绝对路径文档（自动创建父目录），' +
      '主要用于交付产物：把调研/综述/评审/方案结论落成用户指定路径的一份 .md 等文件。' +
      '此写操作会先弹批准卡请用户确认目标文件与是否覆盖；请提供明确完整的目标路径与完整正文。',
    schema: z.object({
      path: z.string().describe('要创建或覆盖写入的目标文件绝对路径（含文件名与扩展名），如 /Users/me/docs/review.md 或 D:/docs/review.md'),
      content: z.string().describe('要写入的完整文本/Markdown 内容'),
    }),
  },
)
