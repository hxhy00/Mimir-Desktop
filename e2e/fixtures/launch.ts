/**
 * 启动被测 Electron 应用。
 *
 * 设计要点：
 *
 * 1. **测构建产物而非 dev server**：启动 `out/main/index.js`（`electron-vite build` 产出）。
 *    理由是产物路径与用户真实运行一致，且顺带验证打包链——本仓库历史上出现过
 *    「能 build 但起不来」的问题（如 preload 被命名为 .mjs 却指向 .js）。
 *
 * 2. **数据隔离**：注入临时 HOME，使 `~/.mimir/store.json` 与默认科研空间
 *    `~/Mimir/<名称>` 都落在临时目录，绝不触碰开发者真实数据。
 *
 * 3. **原生 dialog 必须主进程替换**：Playwright 无法拦截 `dialog.showOpenDialog`
 *    等原生 API（它们直接调 OS），必须用 `electronApp.evaluate` 在主进程覆写。
 *    覆写持续到应用关闭，因此每个新实例都要重设。
 */
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, realpathSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { createTempHome, type TempHome } from '../helpers/tempHome'
import { installDialogHandler, type DialogRecorder } from '../helpers/confirm'
import { writeSeed, type SeedData, defaultSeed } from './seed'

// 本包是 ESM（package.json "type": "module"），没有 __dirname。
const __dirname = dirname(fileURLToPath(import.meta.url))

/** 仓库根目录（本文件位于 e2e/fixtures/） */
export const repoRoot = join(__dirname, '..', '..')

/** 构建产物入口 */
export const mainEntry = join(repoRoot, 'out', 'main', 'index.js')

export interface LaunchOptions {
  /** 预置数据；不传则用 defaultSeed()（1 个科研空间 + 空设置，可绕过首启动向导） */
  seed?: SeedData
  /**
   * seed 变换：在 `defaultSeed(tempHome.home)` **之后**、落盘之前调用。
   *
   * 为什么需要它而不是直接传 `seed`：默认 seed 依赖临时 HOME 路径（空间根落在其中），
   * 而该路径只有 launchApp 内部才知道。需要「保留默认 seed 形状、只改 settings」的场景
   * （如注入桩网关模型配置）若改成传完整 seed，就得在这里重复一遍路径拼接逻辑，
   * 一旦默认值变动就会悄悄不一致。这里让调用方拿到「已算好路径的 seed」再改。
   */
  transformSeed?: (seed: SeedData) => SeedData
  /** 原生打开对话框返回的文件路径 */
  openDialogPaths?: string[]
  /** 原生保存对话框返回的路径 */
  saveDialogPath?: string
  /** 额外环境变量 */
  env?: Record<string, string>
  /** 应用启动超时（毫秒）。默认 60s：主进程要装载 LangChain 全家桶，冷启慢。 */
  timeout?: number
}

export interface LaunchedApp {
  app: ElectronApplication
  page: Page
  tempHome: TempHome
  /** 主进程侧实际生效的路径，用于断言隔离是否真的生效 */
  paths: { userData: string; home: string }
  /** window.confirm/alert 自动应答器（每实例注册一次） */
  dialogs: DialogRecorder
  cleanup: () => Promise<void>
}

export async function launchApp(options: LaunchOptions = {}): Promise<LaunchedApp> {
  if (!existsSync(mainEntry)) {
    throw new Error(
      `未找到构建产物：${mainEntry}\n` +
        `E2E 测试的是 electron-vite build 的产物，请先运行 \`pnpm build\`（或直接用 \`pnpm test:e2e\`，它隐含构建）。`
    )
  }

  const tempHome = createTempHome()
  const baseSeed = options.seed ?? defaultSeed(tempHome.home)
  const seed = options.transformSeed ? options.transformSeed(baseSeed) : baseSeed

  // 必须在 Electron 启动**之前**落盘，应用 boot 时才能读到「已有空间」而不弹向导。
  writeSeed(tempHome, seed)

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    // 隔离的核心：homedir() 跟随 HOME（macOS/Linux），进而重定向 ~/.mimir 与 ~/Mimir
    HOME: tempHome.home,
    USERPROFILE: tempHome.home, // Windows 等价物
    // 关掉可能干扰的观测/网关环境变量，确保用例不误连真实服务。
    // OTel 三件套都置空：只清 endpoint 时若配置项改从别处读取，会漏掉（见 otelTrace.ts）。
    MIMIR_OTEL_ENDPOINT: '',
    MIMIR_OTEL_PUBLIC_KEY: '',
    MIMIR_OTEL_SECRET_KEY: '',
    ...options.env
  }

  const app = await electron.launch({
    args: [mainEntry, `--user-data-dir=${tempHome.userData}`],
    cwd: repoRoot,
    env,
    timeout: options.timeout ?? 60_000
  })

  // ── 隔离硬校验 ────────────────────────────────────────────────────────
  // 判据是「store.ts 实际用的路径」而非 app.getPath('home')。
  // 原因（实测结论，2026-09-16）：macOS 上 app.getPath('home') 走系统 API，
  // **不跟随 HOME 环境变量**；而 store.ts 用 Node 的 os.homedir()，**跟随 HOME**。
  // 两者行为不同，因此必须校验真正决定数据落点的那个。
  const paths = await app.evaluate(({ app: electronApp }) => ({
    userData: electronApp.getPath('userData')
  }))

  // 归一化后比对：realpath 消除 macOS /var → /private/var 这类符号链接差异
  const userDataReal = realpathSync(paths.userData)
  if (!isInside(userDataReal, tempHome.root)) {
    await app.close()
    tempHome.cleanup()
    throw new Error(
      `userData 隔离未生效，已中止以免污染真实数据。\n` +
        `  期望位于: ${tempHome.root}\n` +
        `  实际值:   ${userDataReal}`
    )
  }

  // 等首个窗口就绪后，校验 store 真的落在临时 HOME（此时应用已完成 store 初始化）
  const firstWindow = await app.firstWindow()
  const storeFile = join(tempHome.home, '.mimir', 'store.json')
  const contamination = await waitFor(() => existsSync(storeFile), 10_000)
  if (!contamination) {
    await app.close()
    tempHome.cleanup()
    throw new Error(
      `数据隔离未生效：临时 HOME 下未生成 ~/.mimir/store.json。\n` +
        `  期望路径: ${storeFile}\n` +
        `  说明: store.ts 的 os.homedir() 未跟随 HOME 环境变量，` +
        `隔离手段需改（见 spec.md 契约 2）。\n` +
        `  已中止以免污染真实 ~/.mimir（其中含明文凭据）。`
    )
  }

  // 原生 dialog 覆写（同步变体也要处理：它们直接返回值而非 Promise）
  const openPaths = options.openDialogPaths ?? []
  const savePath = options.saveDialogPath ?? join(tempHome.root, 'saved-output.txt')
  await app.evaluate(
    ({ dialog }, payload) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: payload.openPaths })
      // 同步变体：返回 string[]，取消时为空数组
      dialog.showOpenDialogSync = () => payload.openPaths
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: payload.savePath })
      dialog.showSaveDialogSync = () => payload.savePath
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
      dialog.showMessageBoxSync = () => 0
    },
    { openPaths, savePath }
  )

  const page = firstWindow
  await page.waitForLoadState('domcontentloaded')

  // dialog 自动应答器：每个应用实例只注册一次（page 跨用例共享，重复注册会抢答）
  const dialogs = installDialogHandler(page)

  return {
    app,
    page,
    tempHome,
    dialogs,
    paths: { userData: paths.userData, home: tempHome.home },
    cleanup: async () => {
      try {
        await app.close()
      } finally {
        tempHome.cleanup()
      }
    }
  }
}

/** 轮询等待条件成立（仅用于文件系统等非 Playwright 对象）。 */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return predicate()
}

/**
 * child 是否位于 parent 之内（含 parent 自身）。
 * 用路径分隔符补齐后再比对，避免 `/a/bc` 被误判为在 `/a/b` 之内。
 */
function isInside(child: string, parent: string): boolean {
  const normalizedParent = parent.endsWith('/') ? parent : `${parent}/`
  return child === parent || child.startsWith(normalizedParent)
}
