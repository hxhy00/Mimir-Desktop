/**
 * Mimir 专用文件后端：继承 deepagents 的 FilesystemBackend，在写副作用上接入「用户批准卡」。
 *
 * 背景（为什么需要它）：
 *   deepagents 内置的文件工具（read_file/write_file/edit_file/ls/glob/grep/delete/execute）由
 *   FilesystemMiddleware 在 wrapModelCall 里注入，名字固定、无法改名或替换实例（LangChain v1
 *   AgentNode 会校验「同名换实例」并抛错）。因此我们要用内置工具，就必须通过 backend 注入行为。
 *
 * 能力对照（与旧的自定义 read_file/write_file 等价）：
 *   - 真实磁盘读写：FilesystemBackend（virtualMode=false）直接操作宿主文件系统，绝对路径原样生效；
 *   - 写操作批准卡：覆写 write/edit/delete，落盘前 requireUserApproval（人工确认后再写）；
 *   - 读取批准卡：read/readRaw 对「科研空间外」的路径弹批准卡（空间内免批准，等价旧语义）。
 *
 * 未覆写的方法（ls/glob/grep）保持只读原样，不做批准。
 */
import { FilesystemBackend } from 'deepagents'
import { resolve, sep } from 'path'
import { spaceRoot } from '../library/store'
import { requireUserApproval } from './approval'

/** 目标是否位于当前激活科研空间内（空间内视为用户自有资料，只读免批准）。 */
function isInsideSpace(p: string): boolean {
  try {
    const root = resolve(spaceRoot())
    const target = resolve(p)
    return target === root || target.startsWith(root + sep)
  } catch {
    return false
  }
}

/** 读取批准：空间外路径需用户确认；空间内直接放行。 */
async function approveRead(path: string, kind: string): Promise<boolean> {
  const target = resolve(path)
  if (isInsideSpace(target)) return true
  return requireUserApproval({
    tool: 'read_file',
    summary: `${kind} ${target}`,
    detail: '该路径位于当前科研空间之外。将只读其文本并入分析上下文，不修改文件；内容可能含敏感信息。',
  })
}

/** 写入批准：一律需用户确认（含覆盖提示）。 */
async function approveWrite(summary: string, detail: string): Promise<boolean> {
  return requireUserApproval({ tool: 'write_file', summary, detail })
}

/**
 * 科研工作台文件后端：真实磁盘 + 批准卡。
 * virtualMode=false 使绝对路径原样落到宿主磁盘（这是「写桌面文档」能生效的关键）。
 */
export class MimirFsBackend extends FilesystemBackend {
  constructor() {
    super({ virtualMode: false })
  }

  override async read(filePath: string, offset?: number, limit?: number) {
    const allowed = await approveRead(filePath, '读取文件')
    if (!allowed) {
      return { content: '已取消：读取未获得用户确认（或等待超时）。请先向用户说明要读取的文件并再次发起。' }
    }
    return super.read(filePath, offset, limit)
  }

  override async readRaw(filePath: string) {
    const allowed = await approveRead(filePath, '读取文件')
    if (!allowed) {
      // readRaw 返回 ReadRawResult；用 error 字段表达取消（不抛错，避免中断整条 agent 图）。
      return { error: '已取消：读取未获得用户确认（或等待超时）。' } as never
    }
    return super.readRaw(filePath)
  }

  override async write(filePath: string, content: string) {
    const target = resolve(filePath)
    const existing = await super.read(target).catch(() => null)
    const existingText =
      existing !== null && typeof existing === 'object' && 'content' in existing
        ? String((existing as { content?: unknown }).content ?? '')
        : null
    const overwriteHint = existingText === null ? '目标文件不存在，将新建。' : '目标文件已存在，本次将整篇覆盖。'
    const allowed = await approveWrite(
      `写入文档 ${target}`,
      `${overwriteHint}将创建父目录并写入 ${content.length} 字符文本内容（本次分析/调研产出）。` +
        (existingText !== null && existingText !== '' ? `\n--- 现有文件开头 ---\n${existingText.slice(0, 300)}` : '')
    )
    if (!allowed) {
      return { error: '已取消：写入未获得用户确认（或等待超时）。请先与用户确认目标路径与内容后再发起。' } as never
    }
    return super.write(target, content)
  }

  override async edit(filePath: string, oldString: string, newString: string, replaceAll?: boolean) {
    const target = resolve(filePath)
    const allowed = await approveWrite(
      `编辑文档 ${target}`,
      `将以替换方式修改该文件（oldString → newString，${replaceAll === true ? '全部替换' : '首个匹配'}）。`
    )
    if (!allowed) {
      return { error: '已取消：编辑未获得用户确认（或等待超时）。' } as never
    }
    return super.edit(target, oldString, newString, replaceAll)
  }

  override async delete(filePath: string) {
    const target = resolve(filePath)
    const allowed = await approveWrite(`删除 ${target}`, '将删除该文件或整个目录（含其内容）。此操作不可撤销。')
    if (!allowed) {
      return { error: '已取消：删除未获得用户确认（或等待超时）。' } as never
    }
    return super.delete(target)
  }
}
