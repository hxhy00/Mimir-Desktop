/**
 * E2E 数据隔离：为每次测试运行创建独立的「假 HOME」，让应用把
 * `~/.mimir/store.json` 与默认科研空间 `~/Mimir/<名称>` 都落在临时目录里。
 *
 * 为什么必须要它：应用的全局层 store 存的是**明文 API Key 与服务器口令**
 * （见 electron/library/store.ts 的 CREDENTIAL_FILE_MODE 注释）。若 e2e 直接
 * 跑在开发者真实 HOME 下，一次用例就会把测试数据写进真实 `~/.mimir`，
 * 既可能覆盖用户凭据，也让用例结果受本机历史数据影响而不确定。
 */
import { mkdtempSync, rmSync, mkdirSync, existsSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

export interface TempHome {
  /** 传给 Electron 的 HOME / USERPROFILE，承载 `~/.mimir` 与 `~/Mimir/<空间名>` */
  readonly home: string
  /** 传给 Electron 的 userData 目录（`--user-data-dir` 或 Electron 的默认推导目标） */
  readonly userData: string
  /** 本次运行的根临时目录，cleanup 时整体删除 */
  readonly root: string
  cleanup: () => void
}

/**
 * 创建一套隔离目录。
 *
 * 结构：
 * ```
 * <tmp>/mimir-e2e-XXXX/
 *   home/        ← HOME：`~/.mimir/store.json`、`~/Mimir/科研空间` 落在这里
 *   userData/    ← Electron userData：缓存、日志等
 * ```
 */
export function createTempHome(): TempHome {
  const raw = mkdtempSync(join(tmpdir(), 'mimir-e2e-'))
  // macOS 上 tmpdir() 常返回 /var/folders/...，而 /var 是指向 /private/var 的符号链接。
  // Electron 报回的是解析后的 /private/var/...，若不做归一化，前缀比对会误判为「隔离失效」。
  const root = realpathSync(raw)
  const home = join(root, 'home')
  const userData = join(root, 'userData')
  mkdirSync(home, { recursive: true })
  mkdirSync(userData, { recursive: true })

  return {
    root,
    home,
    userData,
    cleanup: () => {
      if (existsSync(root)) rmSync(root, { recursive: true, force: true })
    }
  }
}
