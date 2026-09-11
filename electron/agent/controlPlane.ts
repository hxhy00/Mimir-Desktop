/**
 * 控制平面上锁（C4）。
 *
 * 问题：Agent 拥有真实磁盘读写（`MimirFsBackend` → `FilesystemBackend(virtualMode:false)`）。
 * 若不加约束，它可以改写宿主的**配置与能力定义**，实现「自我提权」：
 *   - 改 `settings`（模型/网关/批准相关配置）→ 绕过后续策略；
 *   - 改 `plugins:subagents`（子代理定义、工具白名单）→ 给自己新增工具；
 *   - 改技能目录 / 记忆档案 → 篡改自身行为指令。
 * 这类写入必须被**硬拒绝**（不是弹卡让用户选——用户无法审查隐藏的提权后果），
 * 且与用户从 UI 主动修改设置是两条路径：UI 走 IPC，不经此守卫。
 *
 * 判定依据是**文件系统路径**（Agent 的工具只认路径），而非 store key。
 * 守卫在主进程侧、进程内生效（`process.env.MIMIR_CONTROL_PLANE_GUARD !== 'off'`），
 * 对 deepagents 内置 fs 工具与任何自定义工具的路径写入统一生效。
 *
 * 参考：Claude Code 泄露源码分析结论——「保护控制平面（设置/技能目录强制只读，防自我提权）」。
 */
import { resolve, sep, join, normalize } from 'node:path'
import { homedir } from 'node:os'

/** 受保护目录/文件（绝对路径，规范化后前缀匹配）。 */
function protectedPaths(): string[] {
  const home = homedir()
  const appData =
    process.platform === 'darwin'
      ? join(home, 'Library', 'Application Support')
      : process.platform === 'win32'
        ? (process.env.APPDATA ?? join(home, 'AppData', 'Roaming'))
        : (process.env.XDG_CONFIG_HOME ?? join(home, '.config'))
  const out = [
    join(home, '.mimir'), // 桥接配置、运行时凭据
    join(appData, 'mimir-desktop'), // 应用配置目录（settings / plugins 均落在此
    join(appData, 'Mimir') // 名称变体，保险
  ]
  return out.map((p) => normalize(resolve(p)))
}

/** 判断目标路径是否落在受保护的控制平面内。 */
export function isControlPlanePath(target: string): boolean {
  let t: string
  try {
    t = normalize(resolve(target))
  } catch {
    return false
  }
  for (const root of protectedPaths()) {
    if (t === root || t.startsWith(root + sep)) return true
  }
  return false
}

/** 控制平面提示文案（写入被拒时回给 Agent，说明原因与正确路径）。 */
export function controlPlaneRejectMessage(target: string): string {
  return (
    `已拒绝：${target} 属于 Mimir 的配置/能力控制平面（settings、子代理与技能定义、运行时凭据），` +
    '应用层不允许 Agent 直接改写——这属于自我提权，会绕过用户审查。' +
    '如需修改，请告知用户在「设置 / 插件」界面中操作。'
  )
}
