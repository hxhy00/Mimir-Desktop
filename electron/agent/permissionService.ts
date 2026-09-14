/**
 * 权限服务（策略持久化 + 审计日志）。
 *
 * 分工：`permissions.ts` 是**纯判定**（给一个路径，返回 allow/deny/ask）；
 * 本模块负责它周围的副作用 —— 读写 `settings.permissions`、把「允许并记住」落成允许列表、
 * 记录审计日志。之所以拆开，是为了让判定逻辑能被单测完全覆盖、不被 store 污染。
 *
 * 存储约定（复用项目既有的空间层 store）：
 * - `settings.permissions` —— 策略本体（沙箱档位、空间内是否弹卡、两个允许列表）；
 * - `permissions:audit`    —— 审计日志（有上限，只留最近 N 条）。
 *
 * 为什么审计很重要：权限矩阵把「每次都问」换成「问一次、以后放行」，用户必须能事后
 * **看见 Agent 到底动了他哪些文件**，否则放行就变成了黑箱。审计日志是这个交换的前提。
 */
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { getStoreValue, setStoreValue, spaceRoot } from '../library/store'
import { isControlPlanePath } from './controlPlane'
import {
  DEFAULT_POLICY,
  coercePolicy,
  decidePermission,
  normalizeAllowedRoot,
  type PermissionAction,
  type PermissionDecision,
  type PermissionPolicy
} from './permissions'

/** 策略在 settings 里的键名。 */
export const PERMISSIONS_SETTINGS_KEY = 'permissions'
/** 审计日志在 store 里的键名。 */
export const PERMISSIONS_AUDIT_KEY = 'permissions:audit'
/** 审计日志保留上限（条）。 */
const AUDIT_LIMIT = 200

/** 一次权限判定的审计记录。 */
export interface PermissionAuditEntry {
  /** ISO 时间。 */
  at: string
  action: PermissionAction
  target: string
  /** 策略给出的判定（allow / deny / ask）。 */
  decision: PermissionDecision
  /** ask 场景下用户最终怎么选的（未弹卡时缺省）。 */
  resolved?: 'allow' | 'deny' | 'remember'
}

/** 读取当前策略（脏数据自动收敛到合法值）。 */
export function loadPolicy(): PermissionPolicy {
  try {
    const settings = (getStoreValue<Record<string, unknown>>('settings') ?? {}) as Record<string, unknown>
    return coercePolicy(settings[PERMISSIONS_SETTINGS_KEY])
  } catch {
    return { ...DEFAULT_POLICY }
  }
}

/** 写回策略（与 settings 里的其它字段合并，不覆盖别人的改动）。 */
function savePolicy(next: PermissionPolicy): void {
  const settings = (getStoreValue<Record<string, unknown>>('settings') ?? {}) as Record<string, unknown>
  setStoreValue('settings', { ...settings, [PERMISSIONS_SETTINGS_KEY]: next })
}

/** 记录一条审计（尽力而为：写失败不影响主流程）。 */
export function recordAudit(entry: PermissionAuditEntry): void {
  try {
    const prev = getStoreValue<PermissionAuditEntry[]>(PERMISSIONS_AUDIT_KEY) ?? []
    const next = [...prev, entry]
    setStoreValue(PERMISSIONS_AUDIT_KEY, next.length > AUDIT_LIMIT ? next.slice(next.length - AUDIT_LIMIT) : next)
  } catch (error) {
    console.warn('[permissions] 写审计日志失败：', error)
  }
}

/**
 * 判定一次访问并记录审计。fsBackend 的统一入口。
 * @returns 判定结果（调用方据此放行 / 拒绝 / 弹卡）
 */
export function evaluate(target: string, action: PermissionAction): PermissionDecision {
  const decision = decidePermission({
    // 目标与空间根都用实体路径，避免软链导致的失配/绕过（见 canonicalize）
    target: canonicalize(target),
    action,
    spaceRoot: canonicalize(safeSpaceRoot()),
    policy: loadPolicy(),
    isControlPlane: isControlPlanePath
  })
  recordAudit({ at: new Date().toISOString(), action, target, decision })
  return decision
}

/**
 * 记录一次「弹卡后用户怎么选」。
 *
 * 写法上**就地更新上一条 ask 记录**，而不是再追加一条：`evaluate` 已经为同一次判定
 * 写过一条 `decision: 'ask'`，若这里再 push，设置页会把一次批准显示成两条（一条
 * 「询问中」+ 一条「已允许」），审计从「谁动了我的文件」退化成噪音。
 */
export function recordResolution(target: string, action: PermissionAction, resolved: 'allow' | 'deny' | 'remember'): void {
  try {
    const prev = getStoreValue<PermissionAuditEntry[]>(PERMISSIONS_AUDIT_KEY) ?? []
    const last = prev[prev.length - 1]
    if (last !== undefined && last.decision === 'ask' && last.resolved === undefined && last.target === target && last.action === action) {
      setStoreValue(PERMISSIONS_AUDIT_KEY, [...prev.slice(0, -1), { ...last, resolved }])
      return
    }
    // 对不上（如并发批准导致顺序错位）时退化为追加，宁可多一条也不要漏记用户的选择。
    recordAudit({ at: new Date().toISOString(), action, target, decision: 'ask', resolved })
  } catch (error) {
    console.warn('[permissions] 写审计日志失败：', error)
  }
}

function safeSpaceRoot(): string {
  try {
    return spaceRoot()
  } catch {
    return ''
  }
}

/**
 * 把路径规范化成**磁盘上的实体路径**（判定口径的唯一来源）。
 *
 * 为什么必须统一：判定、空间根、允许列表三处必须用同一套路径口径，否则会静默失配。
 * macOS 上 `/var` 是 `/private/var` 的软链 —— 实测出现过两类失配：
 * ① 记住的是 realpath、判定用的是原始路径 → 「记住了目录但下次照样弹卡」；
 * ② 目标用 realpath、空间根用原始路径 → 「空间内的文件被判定成空间外」。
 *
 * 除失配外，规范化还是个**安全边界**：软链可以绕过前缀匹配，控制平面判定同理受益。
 * 目标不存在时（新建文件）退化为「父目录 realpath + 文件名」。
 */
export function canonicalize(p: string): string {
  if (p === '') return ''
  const abs = resolve(p)
  try {
    if (existsSync(abs)) return realpathSync(abs)
    const dir = dirname(abs)
    if (dir !== abs && existsSync(dir)) return join(realpathSync(dir), basename(abs))
  } catch {
    // 规范化失败（权限 / 竞态）不阻断流程，落回原路径
  }
  return abs
}

/**
 * 把「记住」落成允许列表。
 *
 * 磁盘上真实存在时先做 `realpathSync`：这样记住的是**实体路径**，
 * 避免「记忆时是软链、判定时是实体路径」造成的绕过或失配。
 */
export function rememberRoot(
  dir: string,
  action: PermissionAction
): { ok: boolean; message: string; policy?: PermissionPolicy } {
  const resolved = canonicalize(dir)
  const checked = normalizeAllowedRoot(resolved, { home: homedir(), isControlPlane: isControlPlanePath })
  if (!checked.ok || checked.root === undefined) {
    return { ok: false, message: checked.reason ?? '该目录不可加入允许列表。' }
  }
  const policy = loadPolicy()
  const key = action === 'write' ? 'allowedWriteRoots' : 'allowedReadRoots'
  if (policy[key].includes(checked.root)) {
    return { ok: true, message: `已在允许列表中：${checked.root}`, policy }
  }
  const next: PermissionPolicy = { ...policy, [key]: [...policy[key], checked.root] }
  savePolicy(next)
  return { ok: true, message: `已记住：${activityLabel(action)} 免批准 ${checked.root}`, policy: next }
}

/** 从两个允许列表里移除一个目录。 */
export function revokeRoot(dir: string): { ok: boolean; message: string; policy: PermissionPolicy } {
  const target = canonicalize(dir)
  const policy = loadPolicy()
  const next: PermissionPolicy = {
    ...policy,
    allowedWriteRoots: policy.allowedWriteRoots.filter((r) => r !== target),
    allowedReadRoots: policy.allowedReadRoots.filter((r) => r !== target)
  }
  savePolicy(next)
  return { ok: true, message: `已移除：${target}`, policy: next }
}

function activityLabel(action: PermissionAction): string {
  return action === 'write' ? '写入' : '读取'
}

// ─────────────────────────── IPC 面（渲染层调用） ───────────────────────────

/** 设置页需要的一次性读取：当前策略 + 审计（最近若干条，倒序）。 */
export function getPermissionState(): {
  policy: PermissionPolicy
  audit: PermissionAuditEntry[]
  spaceRoot: string
  home: string
} {
  const audit = (() => {
    try {
      return getStoreValue<PermissionAuditEntry[]>(PERMISSIONS_AUDIT_KEY) ?? []
    } catch {
      return []
    }
  })()
  return {
    policy: loadPolicy(),
    // 倒序：设置页最关心「最近发生了什么」
    audit: [...audit].reverse(),
    // 与判定口径保持一致（显示实体路径，避免用户看到 /var 但实际判 /private/var）
    spaceRoot: canonicalize(safeSpaceRoot()),
    home: homedir()
  }
}

/** 渲染层保存策略（只接受白名单字段，非法值由 coercePolicy 收敛）。 */
export function savePolicyFromRenderer(patch: unknown): PermissionPolicy {
  const merged = coercePolicy({ ...loadPolicy(), ...(typeof patch === 'object' && patch !== null ? patch : {}) })
  savePolicy(merged)
  return merged
}

/** 供 ipc 层使用的单例门面（保持 ipc/index.ts 的调用简洁）。 */
export const permissionsService = {
  get: getPermissionState,
  set: savePolicyFromRenderer,
  allowRoot: (dir: string, action: PermissionAction) => rememberRoot(dir, action),
  revokeRoot,
  readAudit: () => getPermissionState().audit
}
