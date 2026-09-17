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
import { resolve } from 'path'
import { requireUserApprovalDetailed } from '../approval'
import { controlPlaneRejectMessage, isControlPlanePath } from '../controlPlane'
import { canonicalize, evaluate, recordResolution, rememberRoot } from '../permissionService'
// `~` 展开是 read_dir / server 两个工具共用的语义，收敛在 pathUtils 里，
// 避免一处修了另一处没修（server 的 keyPath 就曾漏掉，见该模块注释）。
import { expandHome } from '../pathUtils'

/** read_dir 单次最多回显的条目数（防超大目录刷爆响应）。 */
const DIR_LIST_CAP = 500

export const readDirTool = tool(
  async ({ dir }) => {
    try {
      if (typeof dir !== 'string' || dir.trim() === '') return '读取失败：dir 不能为空（需为目录绝对路径）。'
      const target = resolve(expandHome(dir.trim()))
      // 读权限统一走权限矩阵（evaluate）：全权档 / 空间内 / 已记住目录 → 免批准；
      // 仅当判定为 ask 才弹卡。此前该工具绕过策略硬弹卡，导致「设了全权档还被反复问」。
      //
      // ⚠️ 三态必须**全部**处理：此前只判断 `=== 'ask'`，`deny` 会直接穿透到下面的 readdir
      // ——「策略判定为拒绝」被当成了「放行」，只读工具反而成了绕过权限体系的口子
      // （控制平面目录因此可被任意列出）。口径与 fsBackend.authorize 保持一致：
      // 控制平面给具体文案，其余 deny 给通用拒绝文案。
      const decision = evaluate(target, 'read')
      if (decision === 'deny') {
        const canonical = canonicalize(target)
        return isControlPlanePath(canonical)
          ? controlPlaneRejectMessage(canonical)
          : '已拒绝：该目录不在允许范围内，当前权限档位不允许读取。'
      }
      if (decision === 'ask') {
        const allowed = await requireUserApprovalDetailed({
          tool: 'read_dir',
          summary: `读取目录 ${target}`,
          detail: '该目录位于当前科研空间之外。将只读列出文件名与类型，不修改任何内容；目录内容可能含系统/敏感文件。若信任该目录，可点「允许并记住」以免后续重复确认。',
          rememberable: true
        })
        if (!allowed.allow) {
          recordResolution(target, 'read', 'deny')
          return '已取消：读取未获得用户确认（或等待超时）。请先向用户说明要读取的目录并再次发起。'
        }
        // 「允许并记住」必须真正落成策略（写入 allowedReadRoots），否则卡片上的第三个
        // 按钮是空承诺：用户以为不再问了，下次照样弹卡——批准疲劳没被解决，反而多了一次
        // 无效点击。落成失败（如目标是主目录本身、不允许进允许列表）降级为「仅本次允许」。
        if (allowed.remember) {
          const remembered = rememberRoot(target, 'read')
          recordResolution(target, 'read', remembered.ok ? 'remember' : 'allow')
          if (!remembered.ok) console.warn('[read_dir] 记住目录失败：', remembered.message)
        } else {
          recordResolution(target, 'read', 'allow')
        }
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
      '读取科研空间根内的目录免批准；读取空间外任意目录会弹批准卡，卡片通过后返回列表。一次仅列一层。' +
      'dir 支持 ~ 写法（如 ~/.ssh，会自动展开为真实主目录），无需先向用户索要绝对路径。',
    schema: z.object({
      dir: z.string().describe('要列出的目录绝对路径；支持 ~ 或 ~/ 开头（自动展开为主目录）'),
    }),
  },
)
