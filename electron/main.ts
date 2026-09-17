import { app, shell, BrowserWindow, protocol, net, dialog } from 'electron'
import { join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { is } from '@electron-toolkit/utils'
import { setupIpcHandlers, disposeIpcResources } from './ipc'
import { agentService, stopAllAgentTasks } from './agent/agentService'
import { shutdownOtel } from './agent/otelTrace'
import { resetApprovalSender } from './agent/approval'
import { isLatexPdfAllowed } from './latex'
import { existsSync } from 'fs'
import { paperPdfFileName } from './library/arxiv'
import { figureFilePath } from './figures/figuresService'
import { loadStore, getStoreValue, spaceRoot } from './library/store'
import { setS2KeyProvider, setOpenAlexKeyProvider } from './agent/paperSearch'
import { setOpenAlexKeyProvider as oaLocationSetOpenAlexKeyProvider } from './library/oaLocation'
import { startVenueDeadlineLoop } from './venues/venuesService'
import { setTokenCounter } from './agent/contextManager'
import { countTokensCached } from './agent/tokenizer'
import { isSafeExternalUrl } from './safeUrl'
import { stopBridge } from './plugins/bridge'
import log, { initLogger } from './logger'

const __dirname = dirname(fileURLToPath(import.meta.url))

// 日志设施初始化：必须在 app ready 之前完成，才能捕获后续启动流程中的日志。
// （initLogger 内部只用 app.isPackaged / app.getName()，这两者在 ready 前可用。）
initLogger()

// 必须在 app ready 之前注册：mimir-pdf 协议供文献库 iframe 内嵌阅读本地 PDF；
// mimir-tex 协议供论文模块 iframe 内嵌预览项目目录内编译出的 main.pdf
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'mimir-pdf',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  },
  {
    scheme: 'mimir-tex',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  },
  {
    // 图表管理：按需内联展示本地图片文件
    scheme: 'mimir-img',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

let mainWindow: BrowserWindow | null = null
/** 供 IPC 层读取当前窗口的可变引用：窗口重建/关闭后始终指向最新实例。 */
const windowRef: { current: BrowserWindow | null } = { current: null }

/** 从全局设置（~/.mimir/store.json 的 settings，见 library/store.ts）取出当前选中模型并初始化 Agent。 */
async function initAgentFromSettings(): Promise<void> {
  const settings = getStoreValue<Record<string, unknown>>('settings') ?? {}
  const models = (settings.models as Array<Record<string, unknown>> | undefined) || []
  const selectedModelId = settings.selectedModelId as string | undefined
  const selected = models.find((m) => m.id === selectedModelId) || models[0]

  if (selected?.apiKey) {
    try {
      await agentService.initialize({
        apiKey: selected.apiKey as string,
        // 兜底模型名与 ipc/index.ts 保持一致：`deepseek-chat` 已退役。
        model: (selected.modelId as string) || 'deepseek-flash',
        baseUrl: selected.baseUrl as string | undefined,
        // 模型设置里的「支持推理」显式开关；未设置时由 autoReasoningFor(baseUrl) 兜底。
        reasoning: selected.supportsReasoning as boolean | undefined
      })
      log.info('Agent 已从保存的设置初始化')
    } catch (error) {
      // 非致命（用户可在设置里重填 Key 后继续用），但必须落日志而不是 console 里沉掉。
      log.error('Agent 初始化失败:', error)
    }
  }
}

/**
 * 把致命失败**显式暴露**出来：落日志 + 系统错误框。
 *
 * 为什么必须有：启动链此前没有兜底，任何一步抛错都只让 `app.whenReady().then(...)` 的
 * Promise 静默 reject —— 用户看到的是「双击图标后窗口永远不出现」，日志里也没有线索。
 * 失败必须可见，因此这里同时写主进程日志并弹一个用户能看见的框。
 */
function reportFatalError(title: string, error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  log.error(`[${title}] ${detail}`)
  try {
    dialog.showErrorBox(title, detail)
  } catch (dialogError) {
    // 极早期（对话框不可用）时至少别把原始错误吞掉。
    console.error(title, detail, dialogError)
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1140,
    height: 768,
    minWidth: 800,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      // electron-vite 在 package.json 为 ESM（"type": "module"）时会把 preload
      // 产物命名为 index.mjs；指向 .js 会导致 preload 加载失败、渲染进程拿不到
      // contextBridge 暴露的 window.electronAPI。
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  windowRef.current = mainWindow

  mainWindow.on('closed', () => {
    // 窗口销毁后其 IPC 目标已失效：中止该窗口名下所有会话的后台任务，避免残留任务空转写事件
    stopAllAgentTasks()
    if (windowRef.current === mainWindow) windowRef.current = null
    mainWindow = null
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // 只放行 http(s)：`shell.openExternal` 会把任意 scheme 交给操作系统处理，
    // `file:` / 自定义 scheme 都可能在系统侧产生副作用。链接可能来自模型返回的
    // Markdown（渲染层渲染），因此必须与 `shell:openExternal` IPC 用同一套白名单。
    if (isSafeExternalUrl(details.url)) {
      void shell.openExternal(details.url)
    } else {
      console.warn('[window] 拒绝打开非 http(s) 链接：', details.url)
    }
    return { action: 'deny' }
  })

  // Load the app
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Quit when all windows are closed
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    mainWindow = null
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.whenReady().then(async () => {
  // 注册 mimir-pdf:// 自定义协议：供文献库 iframe 内嵌阅读本地 PDF
  protocol.handle('mimir-pdf', (request) => {
    const url = new URL(request.url)
    const fileName = url.hostname === 'paper' ? url.pathname.replace(/^\//, '') : ''
    if (fileName === '') return new Response('Not Found', { status: 404 })
    const filePath = join(spaceRoot(), 'papers', fileName)
    if (!existsSync(filePath)) return new Response('Not Found', { status: 404 })
    return net.fetch(`file://${filePath}`)
  })

  // 注册 mimir-tex:// 自定义协议：iframe 内嵌预览 LaTeX 项目编译产物 main.pdf
  // URL 形态：mimir-tex://pdf/?p=<encodeURIComponent(绝对路径)>
  // 安全约束：仅放行「本会话登记过的论文项目目录」或「当前科研空间根目录内」的 PDF，
  // 避免渲染页被注入后借协议越权读取任意本地 PDF。
  protocol.handle('mimir-tex', (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'pdf') return new Response('Not Found', { status: 404 })
      const filePath = url.searchParams.get('p') ?? ''
      if (filePath === '' || !filePath.toLowerCase().endsWith('.pdf')) {
        return new Response('Not Found', { status: 404 })
      }
      if (!existsSync(filePath)) return new Response('Not Found', { status: 404 })
      if (!isLatexPdfAllowed(filePath, spaceRoot())) {
        return new Response('Forbidden', { status: 403 })
      }
      return net.fetch(pathToFileURL(filePath).toString())
    } catch {
      return new Response('Bad Request', { status: 400 })
    }
  })

  // 注册 mimir-img:// 自定义协议：iframe/img 内联展示空间根 figures/ 下的图片
  // URL 形态：mimir-img://figures/<encodeURIComponent(fileName)>
  protocol.handle('mimir-img', (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'figures') return new Response('Not Found', { status: 404 })
      const fileName = decodeURIComponent(url.pathname.replace(/^\//, ''))
      const filePath = figureFilePath(fileName)
      if (filePath === null || !existsSync(filePath)) return new Response('Not Found', { status: 404 })
      return net.fetch(pathToFileURL(filePath).toString())
    } catch {
      return new Response('Bad Request', { status: 400 })
    }
  })

  // 装载全局 store（首次会迁移旧版 userData/store.json → ~/.mimir/），
  // 并完成默认科研空间注册 / 恢复上次激活的空间
  loadStore()

  // S2 API key 接缝：统一访问层经 provider 读设置页保存的 key（环境变量兜底）。
  // 不直读 process.env——打包后的 ESM bundle 里它会被构建期静态替换，运行时改值失效。
  setS2KeyProvider(() => {
    const settings = getStoreValue<Record<string, unknown>>('settings') ?? {}
    return typeof settings.s2ApiKey === 'string' ? settings.s2ApiKey : ''
  })

  // OpenAlex API key 接缝（免费 key，额度 ×10；未配置时回退 mailto 标识）。同 S2 理由。
  // paperSearch 与 oaLocation 各持一份同形 provider，装配同一读取逻辑。
  const readOpenAlexKey = (): string => {
    const settings = getStoreValue<Record<string, unknown>>('settings') ?? {}
    return typeof settings.openAlexApiKey === 'string' ? settings.openAlexApiKey : ''
  }
  setOpenAlexKeyProvider(readOpenAlexKey)
  oaLocationSetOpenAlexKeyProvider(readOpenAlexKey)

  // 上下文治理的 token 计数接缝：把真实 tokenizer 注入 contextManager（见 agent/contextManager.ts）。
  // 在进程启动时一次性注入，而不是在 Agent 初始化时——因为治理在「Agent 未初始化」时也可能被调用，
  // 且 token 口径属于进程级约定，不该随模型配置反复切换（countTokens 自身按模型名选词表）。
  // 用带 LRU 的版本：历史文本每轮都会被重复计数，缓存能省下热路径上的 BPE 开销。
  setTokenCounter(countTokensCached)

  // 会议截稿：首刷延迟 2s，之后每 6h 自动刷新
  startVenueDeadlineLoop()

  // Auto-initialize agent from saved settings
  await initAgentFromSettings()

  // IPC handler 只在进程启动时注册一次；渲染层窗口重建（macOS dock 重新激活）
  // 时通过 windowRef 指向最新窗口，避免 ipcMain.handle 重复注册崩溃。
  setupIpcHandlers(windowRef)

  createWindow()
}).catch((error: unknown) => {
  // 启动链兜底：协议注册 / store 装载 / IPC 注册 / 建窗任一步抛错都会落到这里。
  // 不静默 —— 弹框告知用户，并显式退出（否则会留下一个没有窗口的僵尸进程）。
  reportFatalError('Mimir 启动失败', error)
  app.quit()
})

/** 退出清理是否已触发：防止 `app.quit()` 再次进入 `before-quit` 形成死循环。 */
let quitting = false

/** 退出清理的最长等待：某个清理卡住时也要保证进程能退出（见应用规则「禁止静默挂起」）。 */
const SHUTDOWN_TIMEOUT_MS = 3_000

/**
 * 退出前的显式资源回收（复用各模块**已有**的关闭接口，不新造生命周期）：
 *
 * - `stopAllAgentTasks()`：中止所有在途 Agent 会话（各自持有 AbortController，
 *   也是 arXiv / 网页抓取等在途网络请求的取消源）；
 * - `resetApprovalSender()`：解绑批准通道并按 Fail-Closed 拒绝所有在途批准请求；
 * - `disposeIpcResources()`：终止存活的 PTY 子进程（node-pty 不随主进程退出）；
 * - `stopBridge()`：关闭本地桥接 HTTP 服务，释放端口；
 * - `shutdownOtel()`：把 OTel batch processor 缓冲区里的 span 刷给后端（不刷会丢最后几条 trace）。
 *
 * 未覆盖（如实记录）：会议截稿的刷新定时器已 `unref()`，不阻塞退出；
 * `library/arxiv` 的下载走 `AbortSignal.timeout`，随进程结束自然失效——两者都没有
 * 对外暴露 dispose，且都不会拖住退出，故未做额外处理。
 */
async function shutdown(): Promise<void> {
  try {
    stopAllAgentTasks()
  } catch (error) {
    log.warn('[shutdown] 中止 Agent 任务失败：', error)
  }
  try {
    resetApprovalSender()
  } catch (error) {
    log.warn('[shutdown] 重置批准通道失败：', error)
  }
  try {
    disposeIpcResources()
  } catch (error) {
    log.warn('[shutdown] 回收 IPC 资源失败：', error)
  }
  try {
    await stopBridge()
  } catch (error) {
    log.warn('[shutdown] 停止桥接服务失败：', error)
  }
  try {
    await shutdownOtel()
  } catch (error) {
    log.warn('[shutdown] 停止可观测性上报失败：', error)
  }
}

app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  // 先拦住退出，做完异步清理再真正 quit（Electron 不等待 before-quit 里的异步工作）。
  event.preventDefault()
  void Promise.race([
    shutdown(),
    new Promise<void>((resolve) => {
      setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref?.()
    })
  ]).finally(() => {
    app.quit()
  })
})