/**
 * Mimir 专用文件后端：继承 deepagents 的 FilesystemBackend，在**全部**访问入口上接入权限矩阵。
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
import type { FileDownloadResponse, FileUploadResponse } from 'deepagents'
import { existsSync } from 'node:fs'
import { readFile } from 'fs/promises'
import { dirname, isAbsolute, resolve } from 'path'
import { requireUserApprovalDetailed } from './approval'
import { controlPlaneRejectMessage, isControlPlanePath } from './controlPlane'
import { canonicalize, evaluate, recordResolution, rememberRoot } from './permissionService'
import type { PermissionAction } from './permissions'

/** 判定 + 必要时的批准卡。 */
export interface AuthorizeOptions {
  target: string
  action: PermissionAction
  /** 批准卡上的工具名。 */
  tool: string
  /** 批准卡上的一句话动作摘要。 */
  summary: string
  /** 批准卡上的细节（路径/覆盖提示等）。 */
  detail: string
  /**
   * 「允许并记住」时登记的根目录。
   * 缺省用 `target` 的**父目录**（写入单个文件时，用户点是意味着「这个目录以后免问」）；
   * 列举/检索类操作（ls / glob / grep）传 `target` 自身——用户授权的就是这一整棵子树。
   */
  rememberAs?: string
}

/**
 * 统一的权限入口：先按策略判定，只有 `ask` 才弹批准卡。
 *
 * 刻意**没有**把 target 的默认值或短路放行做进这里：任何调用都必须显式给出路径与动作，
 * 避免出现「没传路径就当放行」这类静默绕过。
 *
 * @returns `ok=false` 时 `message` 是给 Agent 的可读理由（会作为工具返回交给模型）
 */
export async function authorize(opts: AuthorizeOptions): Promise<{ ok: boolean; message: string }> {
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
    // 「允许并记住」落成允许列表：默认记住**父目录**（用户点是时的意图是「这个目录以后别问了」）；
    // 列举/检索类操作由调用方用 rememberAs 指定为搜索根本身。
    const remembered = rememberRoot(opts.rememberAs ?? dirname(target), action)
    recordResolution(target, action, remembered.ok ? 'remember' : 'allow')
    if (!remembered.ok) console.warn('[fsBackend] 记住目录失败：', remembered.message)
  } else {
    recordResolution(target, action, 'allow')
  }
  return { ok: true, message: '' }
}

/**
 * 从列举/检索结果里剔除落在控制平面内的条目。
 *
 * 为什么需要：ls / glob / grep 的授权对象是**搜索根**，一次放行就覆盖了整棵子树。
 * 若用户（或全权档）放行了 `~`、`/Users` 这类大范围，递归检索必然扫到 `~/.mimir`、
 * 应用配置目录里的 settings / 能力域定义 / 运行时凭据。而控制平面的规则是**硬拒绝**
 * （C4：优先于任何档位与允许列表）——放行一个父目录并不等于放行了里面的控制平面。
 * 因此这里在**返回给模型之前**做一次剔除，让「扫过大范围」与「控制平面不可读」同时成立。
 */
function withoutControlPlane<T extends { path: string }>(items: T[] | undefined): T[] | undefined {
  if (items === undefined) return undefined
  return items.filter((item) => !isControlPlanePath(item.path))
}

/**
 * 科研工作台文件后端：真实磁盘 + 权限矩阵 + 控制平面写保护。
 * `virtualMode=false` 使绝对路径原样落到宿主磁盘（这是「写桌面文档」能生效的关键）。
 */
export class MimirFsBackend extends FilesystemBackend {
  constructor() {
    super({ virtualMode: false })
  }

  /**
   * 按基类 `resolvePath` 的口径解析成绝对路径（virtualMode=false：绝对原样、相对按 cwd）。
   *
   * 授权目标必须与实际落盘的目标**逐字一致**，否则会出现「判定了 A、实际操作 B」的
   * 口径错配（软链场景下等价于绕过）。因此这里复用基类的 `cwd`，不另发明一套解析。
   */
  private toAbs(filePath: string): string {
    return isAbsolute(filePath) ? filePath : resolve(this.cwd, filePath)
  }

  override async read(filePath: string, offset?: number, limit?: number) {
    const target = this.toAbs(filePath)
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
    return super.read(target, offset, limit)
  }

  override async readRaw(filePath: string) {
    const target = this.toAbs(filePath)
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
    return super.readRaw(target)
  }

  override async write(filePath: string, content: string) {
    const target = this.toAbs(filePath)
    // 覆盖提示只用 `existsSync`（**仅取元数据，不读内容**），与 canonicalize 的口径一致。
    //
    // ⚠️ 修复（原实现的越权读取）：此前为生成「现有文件开头」提示，在 authorize **之前**
    // 无条件 `readFile(target)` —— 于是任何未授权路径（含控制平面）都会被先读一遍，
    // 权限检查形同虚设（写被拒时内容其实已经读进内存）。现在**任何内容读取都发生在
    // 授权通过之后**；代价是批准卡不再回显旧内容片段，安全性优先于这点提示价值。
    const overwriteHint = existsSync(target) ? '目标文件已存在，本次将整篇覆盖。' : '目标文件不存在，将新建。'

    const allowed = await authorize({
      target,
      action: 'write',
      tool: 'write_file',
      summary: `写入文档 ${target}`,
      detail:
        `${overwriteHint}将创建父目录并写入 ${content.length} 字符文本内容（本次分析/调研产出）。` +
        '若信任该目录，可点「允许并记住」以免后续重复确认。'
    })
    if (!allowed.ok) return { error: allowed.message } as never

    // 幂等短路：内容与磁盘现状完全一致时不落盘。
    // 背景：模型偶发会在同一轮把同一批 write_file 连发两遍（deepagents 内置 write 是无条件
    // 覆盖写），导致文件被物理重写两次——浪费 IO、可能触发下游 watch/编译风暴，且在时间线上
    // 呈现为「同一文件凭空写了两遍」。这里以「内容未变」为准做去重：第二遍命中短路，磁盘只动一次。
    // 读磁盘现状放在授权之后：未授权的路径一次都不会被读。
    const existingText = await readFile(target, 'utf-8').catch(() => null)
    if (existingText !== null && existingText === content) {
      return { path: target } as never
    }
    return super.write(target, content)
  }

  override async edit(filePath: string, oldString: string, newString: string, replaceAll?: boolean) {
    const target = this.toAbs(filePath)
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
    const target = this.toAbs(filePath)
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

  // ───────────────────────── 列举 / 检索（此前未接管 = 绕过口） ─────────────────────────

  /**
   * 列目录（内置 `ls` 工具）。
   *
   * 此前未被覆盖，模型用 `ls` 就能列出任意目录（含控制平面），权限矩阵被整体绕过。
   * 现在与 read 同一口径：控制平面硬拒绝 → 策略 deny 拒绝 → ask 弹卡 → allow 放行。
   */
  override async ls(dirPath: string) {
    const target = this.toAbs(dirPath)
    const allowed = await authorize({
      target,
      action: 'read',
      tool: 'ls',
      summary: `列出目录 ${target}`,
      detail:
        '该目录不在当前科研空间与已授权目录内。将只读列出条目名、类型与大小，不读取文件内容、不做任何修改。' +
        '若信任该目录，可点「允许并记住」以免后续重复确认。',
      rememberAs: target
    })
    if (!allowed.ok) return { error: allowed.message }
    const result = await super.ls(target)
    return { ...result, files: withoutControlPlane(result.files) }
  }

  /**
   * 按模式匹配文件（内置 `glob` 工具，递归遍历）。
   *
   * 与基类口径保持一致：`searchPath` 缺省或为 `/` 时基类按 `this.cwd` 解析，
   * 授权目标必须与基类真正遍历的根**是同一个**，否则等于判定了一个路径、读了另一个。
   */
  override async glob(pattern: string, searchPath?: string) {
    const target = searchPath === undefined || searchPath === '/' ? this.cwd : this.toAbs(searchPath)
    const allowed = await authorize({
      target,
      action: 'read',
      tool: 'glob',
      summary: `在 ${target} 中按模式 ${pattern} 检索文件`,
      detail:
        '该目录不在当前科研空间与已授权目录内。将**递归**遍历其子树并回显命中的文件名与路径，不读取文件内容、不做任何修改。' +
        '若信任该目录，可点「允许并记住」以免后续重复确认。',
      rememberAs: target
    })
    if (!allowed.ok) return { error: allowed.message }
    const result = await super.glob(pattern, target)
    return { ...result, files: withoutControlPlane(result.files) }
  }

  /**
   * 全文检索（内置 `grep` 工具，递归遍历并读取文件内容）。
   *
   * 这是覆盖面最大的一个入口：它会把子树内**每个文件的内容**读出来匹配，
   * 未接管时等价于「一次调用读走整个磁盘」。与基类口径保持一致：
   * `dirPath` 缺省时基类的默认值是 `/`（其注释写的「当前目录」与实现不符，此处按实现）。
   */
  override async grep(pattern: string, dirPath?: string, glob?: string | null, maxCount?: number | null) {
    const target = this.toAbs(dirPath ?? '/')
    const allowed = await authorize({
      target,
      action: 'read',
      tool: 'grep',
      summary: `在 ${target} 中搜索「${pattern}」`,
      detail:
        '该目录不在当前科研空间与已授权目录内。将**递归**读取其子树下所有文件的内容做匹配，' +
        '并把命中的行文本并入分析上下文，不做任何修改；可能读到敏感信息。' +
        '若信任该目录，可点「允许并记住」以免后续重复确认。',
      rememberAs: target
    })
    if (!allowed.ok) return { error: allowed.message }
    const result = await super.grep(pattern, target, glob, maxCount)
    return { ...result, matches: withoutControlPlane(result.matches) }
  }

  // ───────────────────────── 批量上传 / 下载 ─────────────────────────

  /**
   * 批量写文件。逐个过 `authorize('write')`，**被拒的只拒绝自己**，不影响同批其它文件。
   *
   * 返回顺序与入参一致（被拒项按其原始下标占位），失败以 `error: 'permission_denied'`
   * 显式表达——`FileOperationError` 只有枚举没有文案位，具体拒绝理由同时打到主进程日志，
   * 便于排查「为什么这个文件没写进去」。
   */
  override async uploadFiles(files: Array<[string, Uint8Array]>) {
    const results: FileUploadResponse[] = []
    const passed: Array<{ index: number; target: string; content: Uint8Array }> = []
    for (let i = 0; i < files.length; i += 1) {
      const [filePath, content] = files[i]
      const target = this.toAbs(filePath)
      const allowed = await authorize({
        target,
        action: 'write',
        tool: 'upload_files',
        summary: `写入文件 ${target}`,
        detail: `将写入 ${content.byteLength} 字节（自动创建父目录；已存在则整篇覆盖）。`
      })
      if (!allowed.ok) {
        console.warn('[fsBackend] uploadFiles 拒绝写入：', target, allowed.message)
        results[i] = { path: filePath, error: 'permission_denied' }
        continue
      }
      passed.push({ index: i, target, content })
    }
    if (passed.length > 0) {
      const responses = await super.uploadFiles(passed.map((p) => [p.target, p.content] as [string, Uint8Array]))
      passed.forEach((p, k) => {
        results[p.index] = responses[k]
      })
    }
    return results
  }

  /**
   * 批量读文件。逐个过 `authorize('read')`，被拒项返回空内容 + `permission_denied`。
   */
  override async downloadFiles(paths: string[]) {
    const results: FileDownloadResponse[] = []
    const passed: Array<{ index: number; target: string }> = []
    for (let i = 0; i < paths.length; i += 1) {
      const filePath = paths[i]
      const target = this.toAbs(filePath)
      const allowed = await authorize({
        target,
        action: 'read',
        tool: 'download_files',
        summary: `读取文件 ${target}`,
        detail: '该路径不在当前科研空间与已授权目录内。将读取其原始字节内容，不修改文件；内容可能含敏感信息。'
      })
      if (!allowed.ok) {
        console.warn('[fsBackend] downloadFiles 拒绝读取：', target, allowed.message)
        results[i] = { path: filePath, content: null, error: 'permission_denied' }
        continue
      }
      passed.push({ index: i, target })
    }
    if (passed.length > 0) {
      const responses = await super.downloadFiles(passed.map((p) => p.target))
      passed.forEach((p, k) => {
        results[p.index] = responses[k]
      })
    }
    return results
  }
}
