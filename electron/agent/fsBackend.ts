/**
 * Mimir 专用文件后端：继承 deepagents 的 FilesystemBackend，在访问副作用上接入**权限矩阵**。
 *
 * ── 背景（为什么需要它）────────────────────────────────────────────────────
 * deepagents 内置的文件工具（read_file/write_file/edit_file/ls/glob/grep/delete/execute）由
 * FilesystemMiddleware 在 wrapModelCall 里注入，名字固定、无法改名或替换实例（LangChain v1
 * AgentNode 会校验「同名换实例」并抛错）。因此要用内置工具，就必须通过 backend 注入行为。
 *
 * ── 权限模型（改动前后对照）────────────────────────────────────────────────
 * 改动前是「一刀切」：写入一律弹卡、空间外读取弹卡。问题是**批准疲劳** —— 科研用户一天
 * 要写二十个文件就点二十次批准，最后必然无脑点是，安全性反而下降。
 *
 * 现在改为 `decidePermission` 的策略矩阵（详见 `permissions.ts`）：
 * - 空间内写盘默认**免批准**（空间是用户自己的资料库，产出笔记/图表/PPT 是核心路径）；
 * - 空间外写盘仍弹卡，但可「允许并记住该目录」→ 下次同类动作不再打扰；
 * - 只读档下一律拒绝写盘；全权档放行（控制平面除外）；
 * - **控制平面永远硬拒绝，任何档位与允许列表都不可绕过**（防自我提权）。
 *
 * 每次判定都会写审计日志（`permissionService.recordAudit`），用户可在设置页回看
 * 「Agent 到底动了我哪些文件」——这是把「每次问」换成「问一次」的前提。
 */
import { FilesystemBackend } from 'deepagents'
import { readFile } from 'fs/promises'
import { dirname, resolve } from 'path'
import { requireUserApprovalDetailed } from './approval'
import { controlPlaneRejectMessage, isControlPlanePath } from './controlPlane'
import { canonicalize, evaluate, recordResolution, rememberRoot } from './permissionService'
import type { PermissionAction } from './permissions'

/** 判定 + 必要时的批准卡。 */
interface AuthorizeOptions {
  target: string
  action: PermissionAction
  /** 批准卡上的工具名。 */
  tool: string
  /** 批准卡上的一句话动作摘要。 */
  summary: string
  /** 批准卡上的细节（路径/覆盖提示等）。 */
  detail: string
}

/**
 * 统一的权限入口：先按策略判定，只有 `ask` 才弹批准卡。
 *
 * @returns `ok=false` 时 `message` 是给 Agent 的可读理由（会作为工具返回交给模型）
 */
async function authorize(opts: AuthorizeOptions): Promise<{ ok: boolean; message: string }> {
  const { action, tool, summary, detail } = opts
  // 判定与「记住」两侧统一用实体路径（见 canonicalize 的说明）。
  const target = canonicalize(opts.target)

  // 控制平面单独给更具体的文案（说明原因 + 正确操作路径），优先于通用判定
  if (isControlPlanePath(target)) return { ok: false, message: controlPlaneRejectMessage(target) }

  const decision = evaluate(target, action)
  if (decision === 'allow') return { ok: true, message: '' }
  if (decision === 'deny') {
    return {
      ok: false,
      message:
        action === 'write'
          ? '已拒绝：当前权限档位（只读档）不允许写盘。可在「设置 → 权限与安全」切换为「工作区可写」。'
          : '已拒绝：该路径不在允许范围内。'
    }
  }

  // decision === 'ask'：交给用户裁决（三态：拒绝 / 允许一次 / 允许并记住）
  // rememberable=true：文件访问能把「这一次」升级为「这个目录以后免问」。
  const outcome = await requireUserApprovalDetailed({ tool, summary, detail, rememberable: true })
  if (!outcome.allow) {
    recordResolution(target, action, 'deny')
    return { ok: false, message: '已取消：未获得用户确认（或等待超时）。请先向用户说明要访问的文件并再次发起。' }
  }
  if (outcome.remember) {
    // 「允许并记住」落成允许列表：记住**父目录**（用户点是时的意图是「这个目录以后别问了」）。
    const remembered = rememberRoot(dirname(target), action)
    recordResolution(target, action, remembered.ok ? 'remember' : 'allow')
    if (!remembered.ok) console.warn('[fsBackend] 记住目录失败：', remembered.message)
  } else {
    recordResolution(target, action, 'allow')
  }
  return { ok: true, message: '' }
}

/**
 * 科研工作台文件后端：真实磁盘 + 权限矩阵 + 控制平面写保护。
 * `virtualMode=false` 使绝对路径原样落到宿主磁盘（这是「写桌面文档」能生效的关键）。
 */
export class MimirFsBackend extends FilesystemBackend {
  constructor() {
    super({ virtualMode: false })
  }

  override async read(filePath: string, offset?: number, limit?: number) {
    const target = resolve(filePath)
    const allowed = await authorize({
      target,
      action: 'read',
      tool: 'read_file',
      summary: `读取文件 ${target}`,
      detail:
        '该路径不在当前科研空间与已授权目录内。将只读其文本并入分析上下文，不修改文件；' +
        '内容可能含敏感信息。若信任该目录，可点「允许并记住」以免后续重复确认。'
    })
    if (!allowed.ok) return { content: allowed.message }
    return super.read(filePath, offset, limit)
  }

  override async readRaw(filePath: string) {
    const target = resolve(filePath)
    const allowed = await authorize({
      target,
      action: 'read',
      tool: 'read_file',
      summary: `读取文件 ${target}`,
      detail: '该路径不在当前科研空间与已授权目录内。将只读其文本并入分析上下文，不修改文件。'
    })
    if (!allowed.ok) {
      // readRaw 返回 ReadRawResult；用 error 字段表达取消（不抛错，避免中断整条 agent 图）。
      return { error: allowed.message } as never
    }
    return super.readRaw(filePath)
  }

  override async write(filePath: string, content: string) {
    const target = resolve(filePath)
    // 覆盖提示：让用户在批准卡上看到「要动的是一个已存在的文件」。
    // ⚠️ 这里读的是**待写目标自身**，且仅用于生成提示文案，不把内容并入模型上下文；
    // 因此走 `readFile` 直读而非 `super.read`——后者会再触发一次 authorize('read')，
    // 在「空间外可写、但未授予读」的场景下会先因读被拒而拿不到提示，属于误拒。
    const existingText = await readFile(target, 'utf-8').catch(() => null)
    // 幂等短路：内容与磁盘现状完全一致时直接返回成功，不落盘。
    // 背景：模型偶发会在同一轮把同一批 write_file 连发两遍（deepagents 内置 write 是无条件
    // 覆盖写），导致文件被物理重写两次——浪费 IO、可能触发下游 watch/编译风暴，且在时间线上
    // 呈现为「同一文件凭空写了两遍」。这里以「内容未变」为准做去重：第二遍命中短路，磁盘只动一次。
    if (existingText !== null && existingText === content) {
      return { path: target } as never
    }

    const overwriteHint = existingText === null ? '目标文件不存在，将新建。' : '目标文件已存在，本次将整篇覆盖。'

    const allowed = await authorize({
      target,
      action: 'write',
      tool: 'write_file',
      summary: `写入文档 ${target}`,
      detail:
        `${overwriteHint}将创建父目录并写入 ${content.length} 字符文本内容（本次分析/调研产出）。` +
        '若信任该目录，可点「允许并记住」以免后续重复确认。' +
        (existingText !== null && existingText !== '' ? `\n--- 现有文件开头 ---\n${existingText.slice(0, 300)}` : '')
    })
    if (!allowed.ok) return { error: allowed.message } as never
    return super.write(target, content)
  }

  override async edit(filePath: string, oldString: string, newString: string, replaceAll?: boolean) {
    const target = resolve(filePath)
    const allowed = await authorize({
      target,
      action: 'write',
      tool: 'write_file',
      summary: `编辑文档 ${target}`,
      detail: `将以替换方式修改该文件（oldString → newString，${replaceAll === true ? '全部替换' : '首个匹配'}）。`
    })
    if (!allowed.ok) return { error: allowed.message } as never
    return super.edit(target, oldString, newString, replaceAll)
  }

  override async delete(filePath: string) {
    const target = resolve(filePath)
    const allowed = await authorize({
      target,
      action: 'write',
      tool: 'write_file',
      summary: `删除 ${target}`,
      detail: '将删除该文件或整个目录（含其内容）。此操作不可撤销。'
    })
    if (!allowed.ok) return { error: allowed.message } as never
    return super.delete(target)
  }
}
