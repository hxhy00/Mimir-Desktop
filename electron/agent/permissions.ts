/**
 * 权限策略（沙箱等级 × 路径记忆）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * 改动前是「一刀切」：写入一律弹批准卡。科研用户一天要写二十个文件就要点二十次批准，
 * 结果必然是**批准疲劳**（rubber-stamping）—— 用户开始无脑点是，安全性不升反降。
 * 成熟的 agent 产品（Codex / Claude Code）都用**权限矩阵**解决：沙箱等级决定「允许动哪里」，
 * 批准策略决定「什么时候还得问」，并允许把「这一次的决定」升级为「这一类的允许」。
 * 本模块只做**纯判定**（不读 store、不弹卡、不碰文件系统），因此可被单测完全覆盖。
 *
 * ── 改动前后对照 ────────────────────────────────────────────────────────────
 * | | 改动前 | 改动后 |
 * | --- | --- | --- |
 * | 空间内写盘 | 每次都弹卡 | 默认免批准（`askInsideSpace: false`） |
 * | 空间外写盘 | 弹卡，且每次都要再点 | 弹卡，可「允许并记住该目录」 |
 * | 只读档 | 无此概念 | 一律拒绝写盘（只放行只读工具） |
 * | 控制平面 | 硬拒绝 | **硬拒绝（任何档位都不可绕过，见规则 1）** |
 *
 * 参考的成熟范式：Codex 的「沙箱（read-only / workspace-write / danger-full-access）×
 * 批准策略（on-request / never）」；此处沿用其档位语义，只是把「工作区」落到本产品的科研空间。
 */

/** 沙箱等级：决定「允许动哪里」。 */
export type SandboxLevel = 'read-only' | 'workspace-write' | 'danger-full-access'

/** 受判定的动作类型。 */
export type PermissionAction = 'read' | 'write'

/** 判定结果：放行 / 拒绝 / 弹批准卡。 */
export type PermissionDecision = 'allow' | 'deny' | 'ask'

/** 权限策略（持久化在 `settings.permissions`）。 */
export interface PermissionPolicy {
  sandbox: SandboxLevel
  /**
   * 科研空间内写盘是否仍要弹卡。
   * 默认 `false`：空间是用户自己指定的资料库，Agent 在里面产出笔记/图表/PPT 是核心价值路径。
   */
  askInsideSpace: boolean
  /** 已记住的可写根目录（绝对路径、已规范化）；命中即免批准。 */
  allowedWriteRoots: string[]
  /** 已记住的可读根目录（空间外免批准读）。 */
  allowedReadRoots: string[]
}

/** 默认策略：工作区可写、空间内免批准、空间外逐个授权。 */
export const DEFAULT_POLICY: PermissionPolicy = {
  sandbox: 'workspace-write',
  askInsideSpace: false,
  allowedWriteRoots: [],
  allowedReadRoots: []
}

/** 沙箱等级的中文说明（设置页与文档共用一份，避免各处重写）。 */
export const SANDBOX_LABELS: Record<SandboxLevel, { label: string; desc: string }> = {
  'read-only': {
    label: '只读档',
    desc: '禁止任何写盘与落盘类操作（只放行只读工具）；空间外读取仍需逐个批准。'
  },
  'workspace-write': {
    label: '工作区可写（默认）',
    desc: '当前科研空间与「已记住的目录」可写；空间外写入逐个批准。'
  },
  'danger-full-access': {
    label: '全权档',
    desc: '除控制平面外均可写、空间外可读。仅供清楚风险的高级用户使用。'
  }
}

/** 判定入参。 */
export interface PermissionInput {
  /** 目标绝对路径（内部会规范化）。 */
  target: string
  action: PermissionAction
  /** 当前科研空间根目录。 */
  spaceRoot: string
  policy: PermissionPolicy
  /** 控制平面判定函数（注入以便纯函数测试；生产传 `isControlPlanePath`）。 */
  isControlPlane: (path: string) => boolean
}

/** 路径是否落在某个根之下（含根自身）。两者都会被规范化。 */
function isInsideAny(target: string, roots: readonly string[]): boolean {
  for (const root of roots) {
    if (isInside(target, root)) return true
  }
  return false
}

/** target 是否等于 root 或位于 root 之下。 */
function isInside(target: string, root: string): boolean {
  const t = normalizePath(target)
  const r = normalizePath(root)
  if (r === '') return false
  return t === r || t.startsWith(r.endsWith('/') ? r : `${r}/`)
}

/**
 * 规范化路径：统一分隔符、去掉末尾斜杠、解析 `.` / `..`。
 *
 * 不解析符号链接（`realpath`）——那是文件系统操作，会破坏本模块的纯函数性质；
 * 调用方在**把目录写进允许列表**时负责 realpath（见 {@link normalizeAllowedRoot}），
 * 从而避免「记忆时是软链、判定时是实体路径」的绕过。
 */
function normalizePath(p: string): string {
  const normalized = p.replace(/\\/g, '/').replace(/\/+/g, '/')
  const isAbs = normalized.startsWith('/')
  const parts: string[] = []
  for (const seg of normalized.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      parts.pop()
      continue
    }
    parts.push(seg)
  }
  const joined = parts.join('/')
  return isAbs ? `/${joined}` : joined
}

/**
 * 判定一次文件访问的权限。**顺序即优先级，短路返回**。
 *
 * 1. **控制平面 → 硬拒绝**。任何档位、任何允许列表都不可绕过：那是 Agent 给自己加工具、
 *    改策略的提权入口，一旦可授权就等于权限模型自我瓦解。
 * 2. 只读档下的写入 → 拒绝。
 * 3. 全权档 → 放行（仅受规则 1 约束）。
 * 4. 空间内 → 读取放行；写入视 `askInsideSpace`（默认放行）。
 * 5. 命中已记住的可写根（仅写入）→ 放行。
 * 6. 命中已记住的可读根（仅读取）→ 放行。
 * 7. 其余 → 弹批准卡。
 */
export function decidePermission(input: PermissionInput): PermissionDecision {
  const { target, action, spaceRoot, policy, isControlPlane } = input

  // 1) 控制平面：无条件硬拒绝（先于一切档位判断）
  if (isControlPlane(target)) return 'deny'

  // 2) 只读档：写入一律拒绝
  if (action === 'write' && policy.sandbox === 'read-only') return 'deny'

  // 3) 全权档：放行
  if (policy.sandbox === 'danger-full-access') return 'allow'

  // 4) 科研空间内
  if (isInside(target, spaceRoot)) {
    return action === 'write' && policy.askInsideSpace ? 'ask' : 'allow'
  }

  // 5) 已记住的可写根（写）/ 可读根（读）
  if (action === 'write' && isInsideAny(target, policy.allowedWriteRoots)) return 'allow'
  if (action === 'read' && isInsideAny(target, policy.allowedReadRoots)) return 'allow'

  // 7) 其余：交给用户裁决
  return 'ask'
}

/** 把持久化里的任意值收敛成合法策略（缺字段用默认值，非法档位回落默认档）。 */
export function coercePolicy(raw: unknown): PermissionPolicy {
  const rec = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const sandbox =
    rec.sandbox === 'read-only' || rec.sandbox === 'workspace-write' || rec.sandbox === 'danger-full-access'
      ? rec.sandbox
      : DEFAULT_POLICY.sandbox
  const roots = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(normalizePath) : []
  return {
    sandbox,
    askInsideSpace: rec.askInsideSpace === true,
    allowedWriteRoots: roots(rec.allowedWriteRoots),
    allowedReadRoots: roots(rec.allowedReadRoots)
  }
}

/** 允许列表的写入校验结果。 */
export interface RootValidation {
  ok: boolean
  /** 规范化后的绝对路径（ok 为 true 时存在）。 */
  root?: string
  /** 拒绝原因（面向用户，可直接展示）。 */
  reason?: string
}

/**
 * 校验一个「要记住的目录」是否可以进允许列表。
 *
 * 拒绝以下情况（都是会让权限模型失去意义的输入）：
 * - 空值 / 根目录 `/`（等于全权，应当走 danger-full-access 档而不是偷偷记住）；
 * - 用户主目录本身（范围过大，等于把整个家目录交出去）；
 * - 落在控制平面内或包含控制平面的路径。
 *
 * ⚠️ 调用方需在**磁盘上真实存在**时先做 `realpathSync` 再传进来：本函数只做字符串规范化，
 * 这样「记住的是软链、判定的是实体路径」不会构成绕过。
 */
export function normalizeAllowedRoot(
  raw: string,
  ctx: { home: string; isControlPlane: (path: string) => boolean }
): RootValidation {
  const trimmed = (raw ?? '').trim()
  if (trimmed === '') return { ok: false, reason: '路径为空。' }
  const root = normalizePath(trimmed)
  if (!root.startsWith('/')) return { ok: false, reason: '请提供绝对路径。' }
  if (root === '/') return { ok: false, reason: '不能把整个文件系统加进允许列表。' }
  const home = normalizePath(ctx.home)
  if (home !== '' && root === home) {
    return { ok: false, reason: '不能把用户主目录本身加进允许列表（范围过大）。请选择更具体的子目录。' }
  }
  if (ctx.isControlPlane(root)) {
    return { ok: false, reason: '该目录属于 Mimir 的配置/能力控制平面，不允许 Agent 写入。' }
  }
  return { ok: true, root }
}
