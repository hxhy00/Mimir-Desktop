/**
 * 本地文件系统工具（files agent 专用）。
 *
 * 关于 read_file / write_file：
 *   本模块**不再**自定义 read_file / write_file。原因：deepagents 内置的 FilesystemMiddleware
 *   在 wrapModelCall 里注入同名内置工具（FILESYSTEM_TOOL_NAMES 含 read_file / write_file / ls /
 *   edit_file / delete / glob / grep / execute），LangChain v1 的 AgentNode 禁止「同名换实例」，
 *   自定义同名工具会抛 `You have modified a tool in "wrapModelCall" hook ...`。
 *   因此读/写文件统一走内置工具，由 agentService 给 createDeepAgent 配置 backend: MimirFsBackend
 *   （见 electron/agent/fsBackend.ts）：真实磁盘读写 + 写/空间外读接入批准卡，等价原自定义工具语义。
 *
 * read_dir 不在内置工具名单内、不冲突，保留在此：只读列目录，空间外读取弹批准卡。
 */
import { tool } from 'langchain/tools'
import { z } from 'zod'
import { readdir } from 'fs/promises'
import { resolve, sep } from 'path'
import { spaceRoot } from '../../library/store'
import { requireUserApproval } from '../approval'

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
