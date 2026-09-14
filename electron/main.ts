import { app, shell, BrowserWindow, protocol, net } from 'electron'
import { join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { is } from '@electron-toolkit/utils'
import { setupIpcHandlers } from './ipc'
import { agentService, stopAllAgentTasks } from './agent/agentService'
import { isLatexPdfAllowed } from './latex'
import { existsSync } from 'fs'
import { paperPdfFileName } from './library/arxiv'
import { figureFilePath } from './figures/figuresService'
import { loadStore, getStoreValue, spaceRoot } from './library/store'
import { startVenueDeadlineLoop } from './venues/venuesService'
import { setTokenCounter } from './agent/contextManager'
import { countTokensCached } from './agent/tokenizer'
import { isSafeExternalUrl } from './safeUrl'

const __dirname = dirname(fileURLToPath(import.meta.url))

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
      console.log('Agent 已从保存的设置初始化')
    } catch (error) {
      console.error('Agent 初始化失败:', error)
    }
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
})