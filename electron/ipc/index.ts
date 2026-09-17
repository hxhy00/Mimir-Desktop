import { BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { readFile, writeFile, readdir } from 'fs/promises'
import { readFileSync } from 'fs'
import { app } from 'electron'
import { join, basename, extname, dirname, relative, resolve } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { agentService } from '../agent/agentService'
import { isControlPlanePath } from '../agent/controlPlane'
import { isSafeExternalUrl } from '../safeUrl'
import { startBridge, stopBridge, isBridgeRunning, getBridgePort, getConfirmToken } from '../plugins/bridge'
import { setApprovalSender, settleApproval } from '../agent/approval'
import { permissionsService } from '../agent/permissionService'
import { probeServer, type ProbeConfig } from '../servers/probe'
import {
  listServers,
  createServer,
  updateServer,
  deleteServer,
} from '../servers/serversService'
import type { ServerDraft, ServerPatch } from '../servers/types'
import { httpFetch } from '../http'
import {
  TECTONIC_RESOURCE_ID,
  downloadTectonicEngine,
  tectonicResourceInfo
} from '../latex/runtime'
import * as pty from 'node-pty'
import {
  loadStore,
  getStoreValue,
  setStoreValue,
  spaceRoot,
} from '../library/store'
import { fetchArxivPdf, paperPdfFileName } from '../library/arxiv'
import {
  appendLedger,
  listLedgerEntries,
  type LedgerEntryType
} from '../ledger/ledgerService'
import { getModelStatus, downloadModel, transcribeAudioBase64, SENSE_VOICE_MODEL } from '../speech/senseVoice'
import { listModels } from '../modelDiscovery'
// 论文创作域按域拆分的子模块（每个文件注册一组同前缀的 IPC handler）
import { registerLatexHandlers } from './latex'
import { registerLibraryHandlers } from './library'
import { registerMeetingsHandlers } from './meetings'
import { registerFiguresHandlers } from './figures'
import { registerWorkspacesHandlers } from './workspaces'
import { registerVenuesHandlers } from './venues'
import { registerPaperHandlers } from './paper'

// Maximum PDF download size (64 MB)
const ARXIV_PDF_DOWNLOAD_TIMEOUT_MS = 60_000

/** 流式事件协议（结构化事件 + seq/streamId），见 `agent/streamProtocol.ts`。 */
import { createSequencer, type AgentStreamEventDraft } from '../agent/streamProtocol';
/** 统一日志设施（主进程落盘）；`streamLog` 用于流式链路埋点。 */
import log, { streamLog } from '../logger'

/**
 * 存活的终端（PTY）实例，按 id 索引。
 *
 * 放在模块作用域而非 `setupIpcHandlers` 内：退出时要能遍历回收
 * （见 {@link disposeIpcResources}），否则 `node-pty` 的子进程会拖住主进程退出。
 */
const ptyInstances = new Map<string, pty.IPty>()

/**
 * 用户在原生文件对话框里**显式选中**过的路径（文件与目录，绝对路径）。
 *
 * `fs:readFile` 是渲染层唯一能读任意文本的通道（附件解析用）。若无边界，任何被注入的
 * 渲染内容都能借它读走整块磁盘 —— 与 Agent 侧 fsBackend 的权限矩阵形成两条口径不一的
 * 旁路。这里改为**白名单**：只有用户自己在对话框里点过的路径才可访问。
 *
 * 目录同样收进来：论文模块的项目目录（`latex:*` / `snapshots:*` / `paper:*`）都由
 * `dialog:open`（`openDirectory`）选出，与「选中文件」是同一类用户意图。
 *
 * 用 `Set` 而非持久化：选择是本次会话的行为，关窗即失效，避免长期漂开放大攻击面。
 */
const pickedPaths = new Set<string>()

/** 当前科研空间根目录；取不到（store 未就绪等）时返回空串，由调用方按「越界」处理。 */
function safeSpaceRoot(): string {
  try {
    return resolve(spaceRoot())
  } catch {
    return ''
  }
}

/**
 * `target` 是否等于 `root` 或位于 `root` 之下。
 *
 * 口径与 Agent 侧 `electron/agent/permissions.ts` 的 `isInside` 一致（该函数未导出，
 * 这里按同样规则实现，避免 IPC 与 Agent 两条通道出现不同的边界判定）。
 */
function isWithin(target: string, root: string): boolean {
  if (root === '') return false
  const t = resolve(target)
  const r = resolve(root)
  return t === r || t.startsWith(r.endsWith('/') ? r : `${r}/`)
}

/** 控制平面拒绝文案（settings / 能力域 / 技能 / 桥接凭据；与 Agent 侧同一条硬约束）。 */
const CONTROL_PLANE_REJECTED = '已拒绝：该路径属于 Mimir 的配置/能力控制平面，不允许经此通道访问。'

/**
 * **渲染层路径边界的唯一入口**：所有接收路径参数的 IPC 处理器都必须先过这里。
 *
 * 放行三条（顺序即优先级）：
 * 1. 控制平面 → 硬拒绝（与 Agent 侧同口径，见 {@link isControlPlanePath}）；
 * 2. 当前科研空间根目录内 —— 用户自己的资料库；
 * 3. 用户在本会话里经原生对话框显式选中的路径及其子路径（见 {@link pickedPaths}）。
 *
 * 其余一律拒绝并给出可见原因（渲染层的 `dialog:open` 可重新授权）。
 *
 * @throws 越界时抛错（IPC invoke 会把错误回传渲染层，调用方已在 try/catch 内）。
 */
function assertRendererPath(input: unknown, mode: 'read' | 'write' = 'read'): string {
  if (typeof input !== 'string' || input.trim() === '') throw new Error('无效路径')
  const target = resolve(input)
  if (isControlPlanePath(target)) throw new Error(CONTROL_PLANE_REJECTED)
  if (isWithin(target, safeSpaceRoot())) return target
  for (const picked of pickedPaths) {
    if (isWithin(target, picked)) return target
  }
  throw new Error(
    mode === 'write'
      ? '已拒绝：写入目标不在当前科研空间内，也不是你在本会话中选择过的目录。请重新选择该目录后再试。'
      : '已拒绝：目标不在当前科研空间内，也不是你在本会话中选择过的文件或目录。请重新选择后再试。'
  )
}

/**
 * 校验渲染层**文件**通道的目标路径（`fs:readFile` / `fs:readImageDataUrl` / `fs:writeFile`）。
 *
 * 在 {@link assertRendererPath} 的同一套基元（控制平面 / {@link isWithin}）之上再收紧一层：
 * - 读：只放行「用户经原生对话框显式选择过的**这个文件自身**」，或**用户已保存进设置的
 *   工作台背景图**（跨重启仍然有效，否则重启后背景图读取会被误拒）—— 读通道比目录通道
 *   更敏感：它能把任意文本读进上下文，因此不放行「选中目录下的任意子文件」；
 * - 写：仅放行科研空间根目录内（渲染层的 `fs:writeFile` 当前无调用方，
 *   保留通道但把边界收到与 Agent 侧一致）。
 *
 * @throws 越界时抛错（IPC invoke 会把错误回传渲染层，调用方已在 try/catch 内）。
 */
function assertRendererFilePath(input: unknown, mode: 'read' | 'write' = 'read'): string {
  if (typeof input !== 'string' || input.trim() === '') throw new Error('无效路径')
  const target = resolve(input)
  if (isControlPlanePath(target)) throw new Error(CONTROL_PLANE_REJECTED)
  if (mode === 'read') {
    if (pickedPaths.has(target) || target === resolveWallpaperPath()) return target
    throw new Error('已拒绝：仅允许读取你在文件对话框中主动选择的文件。')
  }
  if (!isWithin(target, safeSpaceRoot())) {
    throw new Error('已拒绝：写入目标必须位于当前科研空间内。')
  }
  return target
}

/**
 * 校验「项目目录数组」（`figures:renamePreview` / `figures:renameApply`）。
 *
 * 数组形态的入参不能逐个手写在处理器里——漏一个就是一个旁路，因此统一走这里。
 * 空数组是合法输入（不在任何项目里改名）。
 */
function assertProjectDirs(input: unknown): string[] {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) throw new Error('无效路径')
  return input.map((dir) => assertRendererPath(dir, 'write'))
}

/**
 * 用户已保存的工作台背景图路径（settings.wallpaper.path），无则返回空串。
 *
 * 背景图在「设置」里选择后落盘，**下次启动**仍要从磁盘读回；此时用户当次会话并未经过
 * 文件对话框，单纯的内存白名单会把它误拒。因此把「用户已显式保存的这张图」视为授权路径。
 */
function resolveWallpaperPath(): string {
  try {
    const settings = getStoreValue<Record<string, unknown>>('settings')
    const wp = settings?.wallpaper
    if (wp === null || typeof wp !== 'object') return ''
    const p = (wp as { path?: unknown }).path
    return typeof p === 'string' && p !== '' ? resolve(p) : ''
  } catch {
    return ''
  }
}

export function setupIpcHandlers(winRef: { current: BrowserWindow | null }): void {
  loadStore()

  /** 安全地把消息发给当前窗口（窗口可能已关闭/重建，做空值与销毁检查）。 */
  const winSend = (channel: string, ...args: unknown[]): void => {
    const win = winRef.current
    if (win !== null && !win.isDestroyed()) {
      win.webContents.send(channel, ...args)
    }
  }

  // ── Agent 副作用确认握手 ──────────────────────────────────────
  setApprovalSender((request) => {
    winSend('agent:approval-request', request)
  })
  ipcMain.handle('agent:approval-respond', (_event, id: string, allow: boolean, remember?: boolean) => {
    // 三态：拒绝 / 允许一次 / 允许并记住（remember 由调用方落成策略，如「记住该目录」）。
    settleApproval(id, allow === true, remember === true)
    return true
  })

  // ── 权限策略（沙箱档位 + 已记住目录）────────────────────────────
  ipcMain.handle('permissions:get', () => permissionsService.get())
  ipcMain.handle('permissions:set', (_event, patch: unknown) => permissionsService.set(patch))
  ipcMain.handle('permissions:allowRoot', (_event, dir: string, action: 'read' | 'write') =>
    permissionsService.allowRoot(dir, action === 'read' ? 'read' : 'write')
  )
  ipcMain.handle('permissions:revokeRoot', (_event, dir: string) => permissionsService.revokeRoot(dir))
  ipcMain.handle('permissions:audit', () => permissionsService.readAudit())

  // App info
  ipcMain.handle('app:getVersion', () => {
    return app.getVersion()
  })

  // Model connectivity test
  ipcMain.handle('model:test', async (_event, config: { baseUrl: string; modelId: string; apiKey: string }) => {
    const { baseUrl, modelId, apiKey } = config
    if (!baseUrl || !modelId || !apiKey) {
      return { ok: false, message: '请填写完整的连接信息' }
    }
    try {
      const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15000)
      const response = await httpFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
          stream: false
        }),
        signal: controller.signal
      })
      clearTimeout(timeout)
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        return { ok: false, message: `HTTP ${response.status}: ${text.slice(0, 200)}` }
      }
      return { ok: true, message: '连接成功' }
    } catch (error) {
      const message = error instanceof Error ? error.message : '连接失败'
      return { ok: false, message }
    }
  })

  // 模型发现：按 baseUrl + apiKey 拉取 /v1/models，渲染层可快速填入模型 ID。
  ipcMain.handle('model:list', async (_event, args: { baseUrl: string; apiKey: string }) => {
    return listModels({ baseUrl: args?.baseUrl ?? '', apiKey: args?.apiKey ?? '' })
  })

  // ─── 本地桥接服务（Issue 3）──────────────────────────────────────
  ipcMain.handle('bridge:start', async () => {
    if (isBridgeRunning()) {
      return { ok: true, port: getBridgePort(), message: '桥接服务已在运行' }
    }
    try {
      const { port } = await startBridge()
      return { ok: true, port, message: `桥接服务已启动 (127.0.0.1:${port})` }
    } catch (error) {
      return { ok: false, port: 0, message: error instanceof Error ? error.message : '启动失败' }
    }
  })

  ipcMain.handle('bridge:stop', async () => {
    await stopBridge()
    return { ok: true }
  })

  ipcMain.handle('bridge:status', async () => {
    return {
      running: isBridgeRunning(),
      port: getBridgePort(),
      confirmToken: getConfirmToken()
    }
  })

  // Settings
  ipcMain.handle('settings:get', () => {
    return getStoreValue<Record<string, unknown>>('settings') || {}
  })

  ipcMain.handle('settings:set', async (_event, settings) => {
    setStoreValue('settings', settings)

    // Initialize agent from models list
    const s = settings as Record<string, unknown>
    const models = (s.models as Array<Record<string, unknown>> | undefined) || []
    const selectedModelId = s.selectedModelId as string | undefined
    const selected = models.find((m) => m.id === selectedModelId) || models[0]

    if (selected?.apiKey) {
      try {
        await agentService.initialize({
          apiKey: selected.apiKey as string,
          // 兜底模型名用官方现行名：`deepseek-chat` 已退役，传入会被官方端点判为
          // invalid_request_error（实测："supported API model names are deepseek-flash,
          // deepseek-v4-pro"）。
          model: (selected.modelId as string) || 'deepseek-flash',
          baseUrl: selected.baseUrl as string | undefined,
          // 思考模式：优先用模型设置里的显式开关；未设置时由 autoReasoningFor(baseUrl) 兜底。
          reasoning: selected.supportsReasoning as boolean | undefined
        })
      } catch (error) {
        console.error('Agent 初始化失败:', error)
      }
    }
    return true
  })

  // Store generic key-value
  ipcMain.handle('store:get', (_event, key: string) => {
    return getStoreValue<unknown>(key)
  })

  ipcMain.handle('store:set', (_event, key: string, value: unknown) => {
    setStoreValue(key, value)
    return true
  })

  // ─── 科研记录（Ledger）─────────────────────────────────────────────
  // 自动条目在主进程各处埋点写入，渲染层统一走这两个 IPC，避免两条读写路径不一致。
  ipcMain.handle('ledger:list', () => {
    return { ok: true, entries: listLedgerEntries() }
  })

  ipcMain.handle(
    'ledger:append',
    (
      _event,
      input: { title: string; content: string; type: LedgerEntryType; date?: string }
    ) => {
      const title = input.title.trim()
      if (title === '') return { ok: false, message: '标题不能为空' }
      const entry = appendLedger({
        title,
        content: input.content,
        type: input.type,
        ...(input.date !== undefined ? { date: input.date } : {})
      })
      return { ok: true, entry }
    }
  )

  ipcMain.handle('ledger:remove', (_event, id: string) => {
    const entries = listLedgerEntries().filter((e) => e.id !== id)
    setStoreValue('ledger:entries', entries)
    return { ok: true }
  })

  // Dialog
  ipcMain.handle('dialog:open', async (_event, options) => {
    const win = winRef.current
    const result = win === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(win, options)
    // 记住用户显式选择的路径（文件与目录）：它们是渲染层路径白名单的唯一来源
    // （见 assertRendererPath / assertRendererFilePath）。
    if (!result.canceled) {
      for (const p of result.filePaths) pickedPaths.add(resolve(p))
    }
    return result
  })

  ipcMain.handle('dialog:save', async (_event, options) => {
    const win = winRef.current
    return win === null ? dialog.showSaveDialog(options) : dialog.showSaveDialog(win, options)
  })

  // Shell
  ipcMain.handle('shell:openPath', async (_event, path: string) => {
    // 与 fs 通道同一边界：只打开用户选中过 / 科研空间内的路径，避免借系统默认程序
    // 打开任意文件（可执行文件等）。
    try {
      return shell.openPath(assertRendererPath(path, 'read'))
    } catch (error) {
      const message = error instanceof Error ? error.message : '无效路径'
      console.warn('[shell] 拒绝打开越界路径：', path, message)
      return message
    }
  })

  /**
   * 用系统浏览器打开外链（执行过程里的来源链接：arXiv / 论文页 / 网页）。
   *
   * ⚠️ **只放行 http(s)**：`shell.openExternal` 会把任意 scheme 交给操作系统处理，
   * 而 `file:` / 自定义 scheme / `javascript:` 都可能在系统侧产生副作用。
   * 链接内容来自工具返回（模型可影响），因此必须在这里做白名单，而不是只在渲染层判。
   */
  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    // 白名单与窗口层 setWindowOpenHandler 共用同一实现（electron/main.ts），避免两处口径漂移。
    if (!isSafeExternalUrl(url)) {
      console.warn('[shell] 拒绝打开非 http(s) 链接：', url)
      return false
    }
    await shell.openExternal(new URL(url).toString())
    return true
  })

  // 在系统文件管理器中定位到文件（对话内产物「打开所在文件夹」）
  ipcMain.handle('shell:revealPath', async (_event, path: string) => {
    // 同一边界：越界路径直接拒绝（渲染层会拿到 ok=false 的原因）。
    try {
      const target = assertRendererPath(path, 'read')
      if (!existsSync(target)) return
      shell.showItemInFolder(target)
    } catch (error) {
      console.warn(
        '[shell] 拒绝定位越界路径：',
        path,
        error instanceof Error ? error.message : String(error)
      )
    }
  })

  // File system
  ipcMain.handle('fs:readFile', async (_event, path: string) => {
    return readFile(assertRendererFilePath(path), 'utf-8')
  })

  ipcMain.handle('fs:writeFile', async (_event, path: string, content: string) => {
    const target = assertRendererFilePath(path)
    const dir = dirname(target)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return writeFile(target, content, 'utf-8')
  })

  // 背景图等本地图片 → dataURL（渲染进程可直接作为 <img>/背景引用）
  const IMAGE_MIME_BY_EXT: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    avif: 'image/avif'
  }
  ipcMain.handle('fs:readImageDataUrl', async (_event, filePath: string) => {
    try {
      // 与 fs:readFile 同一边界：只允许用户经原生对话框主动选中的图片。
      // 此前仅按扩展名放行，任意路径的图片都能被读出 dataURL —— 同一类旁路（见 assertRendererFilePath）。
      const target = assertRendererFilePath(filePath)
      const ext = extname(target).replace(/^\./, '').toLowerCase()
      const mime = IMAGE_MIME_BY_EXT[ext]
      if (!mime) return { ok: false, message: '仅支持图片文件（png/jpg/webp/gif/bmp/svg/avif）' }
      const data = readFileSync(target)
      return { ok: true, dataUrl: `data:${mime};base64,${data.toString('base64')}` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取图片失败' }
    }
  })

  // arXiv search（渲染层无调用方；保留 handler 时改走统一访问层，不再裸调 export.arxiv.org——
  // 旧实现绕过 UA/节流/缓存，一次调用即可把后续真实检索全部打进 429 冷却）
  ipcMain.handle('arxiv:search', async (_event, query: string, maxResults = 10, sortBy = 'relevance') => {
    try {
      const { searchPapers } = await import('../agent/paperSearch')
      return await searchPapers(query, maxResults)
    } catch (error) {
      return { error: error instanceof Error ? error.message : '搜索失败' }
    }
  })

  // Fetch a single paper by arXiv id（同上：走统一访问层 OpenAlex → S2 回退链）
  ipcMain.handle('arxiv:fetchPaper', async (_event, id: string) => {
    try {
      const cleanId = id.trim().replace(/^https?:\/\/arxiv\.org\/abs\//, '')
      if (!cleanId) return { error: '无效的 arXiv id' }
      const { resolvePaperById } = await import('../agent/paperSearch')
      return await resolvePaperById(cleanId)
    } catch (error) {
      return { error: error instanceof Error ? error.message : '获取论文失败' }
    }
  })

  // Download a paper PDF to the userData directory（复用 library/arxiv 的下载层：
  // export 主通道 + UA 标识 + 主站回退，两处行为一致）
  ipcMain.handle('arxiv:downloadPdf', async (_event, id: string) => {
    try {
      const cleanId = id.trim().replace(/^https?:\/\/arxiv\.org\/abs\//, '')
      if (cleanId === '' || !/^[a-zA-Z0-9._/-]+$/.test(cleanId)) {
        return { error: '无效的 arXiv id' }
      }
      const bytes = await fetchArxivPdf(cleanId, AbortSignal.timeout(ARXIV_PDF_DOWNLOAD_TIMEOUT_MS))
      const dir = join(spaceRoot(), 'papers')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const filePath = join(dir, paperPdfFileName(cleanId))
      await writeFile(filePath, bytes)
      return { ok: true, path: filePath }
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'PDF 下载失败' }
    }
  })

  // Speech-to-text (OpenAI-compatible /audio/transcriptions)
  ipcMain.handle(
    'speech:transcribe',
    async (
      _event,
      options: { audioBase64: string; baseUrl?: string; apiKey?: string; model?: string }
    ) => {
      const { audioBase64, baseUrl, apiKey, model } = options
      if (!audioBase64 || !apiKey) {
        return { error: '缺少音频数据或 API Key' }
      }
      try {
        const base = (baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '')
        const url = `${base}/audio/transcriptions`
        const buffer = Buffer.from(audioBase64, 'base64')
        const form = new FormData()
        form.append('file', new Blob([buffer], { type: 'audio/webm' }), 'recording.webm')
        form.append('model', model || 'whisper-1')
        form.append('language', 'zh')

        const response = await httpFetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form
        })
        if (!response.ok) {
          const text = await response.text().catch(() => '')
          return { error: `语音识别失败 (HTTP ${response.status}): ${text.slice(0, 200)}` }
        }
        const data = (await response.json()) as { text?: string }
        return { text: data.text || '' }
      } catch (error) {
        return { error: error instanceof Error ? error.message : '语音识别失败' }
      }
    }
  )

  // ─── 本地语音识别（SenseVoice）──────────────────────────────────
  ipcMain.handle('speech:transcribeLocal', async (_event, audioBase64: string) => {
    return transcribeAudioBase64(audioBase64)
  })

  // ─── 资源下载（SenseVoice 模型 / Tectonic LaTeX 引擎）────────────
  ipcMain.handle('resources:getStatus', () => {
    try {
      const status = getModelStatus()
      return {
        resources: [
          tectonicResourceInfo(),
          {
            id: SENSE_VOICE_MODEL.id,
            name: SENSE_VOICE_MODEL.name,
            description: SENSE_VOICE_MODEL.description,
            sizeBytes: SENSE_VOICE_MODEL.sizeBytes,
            installed: status.installed
          }
        ]
      }
    } catch (error) {
      console.error('[resources:getStatus] 构建资源列表失败:', error)
      return { resources: [] }
    }
  })

  ipcMain.handle('resources:download', async (event, resourceId: string) => {
    const report = (payload: {
      percent: number
      status: string
      message?: string
    }): void => {
      winSend('resources:progress', { resourceId, ...payload })
    }
    try {
      if (resourceId === TECTONIC_RESOURCE_ID) {
        await downloadTectonicEngine((percent) => {
          report({ percent, status: 'downloading' })
        })
      } else if (resourceId === SENSE_VOICE_MODEL.id) {
        await downloadModel((percent) => {
          report({ percent, status: 'downloading' })
        })
      } else {
        return { ok: false, message: `未知资源: ${resourceId}` }
      }
      report({ percent: 100, status: 'done' })
      return { ok: true }
    } catch (error) {
      report({ percent: 0, status: 'error', message: error instanceof Error ? error.message : '下载失败' })
      return { ok: false, message: error instanceof Error ? error.message : '下载失败' }
    }
  })

  // Agent
  ipcMain.handle('agent:stop', (_event, conversationId?: string) => {
    // 指定会话则只停该会话；缺省停全部（兼容旧调用）
    agentService.stopStreaming(typeof conversationId === 'string' ? conversationId : undefined)
    return true
  })

  // 当前在跑的会话任务列表（渲染层侧栏「后台任务」态；多会话并行的可见性来源）
  ipcMain.handle('agent:runningTasks', () => agentService.runningConversationIds())

  // 会话历史摘要压缩：上下文治理已下沉主进程（见 agent/contextManager.ts），治理路径内部
  // 直接调用 agentService.compressHistory；此通道保留为独立能力（如未来的手动压缩入口）。
  ipcMain.handle(
    'agent:compress',
    async (_event, history: { role: 'user' | 'assistant'; content: string }[]) => {
      try {
        if (!agentService.isInitialized()) {
          return { ok: false, message: 'Agent 未初始化，请先在设置中配置 API Key 和模型。' }
        }
        const summary = await agentService.compressHistory(history)
        return { ok: true, summary }
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : '摘要压缩失败'
        }
      }
    }
  )

  // 重置某会话的上下文治理状态（清失效提醒与压缩熔断计数）；
  // includeArchive=true 时连归档原文一并清除（删除会话时用）。
  ipcMain.handle('agent:resetContext', (_event, conversationId: string, includeArchive?: boolean) => {
    if (typeof conversationId === 'string' && conversationId !== '') {
      agentService.resetConversationContext(conversationId, includeArchive === true)
    }
    return true
  })

  ipcMain.handle(
    'agent:sendMessage',
    async (
      _event,
      message: string,
      conversationId: string,
      options?: {
        ultra?: { enabled: boolean; strategy?: 'auto' | 'multi_expert' | 'critique_reflect' | 'hybrid_mix' | 'self_consistency_vote' }
        /** 本会话历史**原文**；治理（窗口/压缩/熔断/失效提醒）由主进程完成。 */
        history?: { role: 'user' | 'assistant'; content: string }[]
        /** 渲染层 slash 目录（技能/指令）触发词与标题，供压缩后重建能力声明。 */
        skills?: { trigger: string; title: string }[]
        manual?: boolean
      }
    ) => {
      const chunkChannel = `agent:chunk:${conversationId}`
      // 本次回复流的编排器：给每个事件补单调 seq 与 streamId。
      // 渲染层据此（a）检测跳号=确定丢包（b）丢弃陈旧流的迟到事件。
      const sequencer = createSequencer()
      // 主进程侧正文累计长度：由 text-delta 的 delta 长度累加，用于结束事件对账。
      let outboundChars = 0
      // 正文 text-delta 的外发**批数**。攒批后事件总数不再等于模型产出量，
      // 单看 events 会误判；用本值 + outboundChars 一起对账（批数≈时长/50ms）。
      let textDeltas = 0
      /** 统一外发：编排 seq/streamId 后经 IPC 送出（单一出口，杜绝多处直发）。 */
      const sendEvent = (draft: AgentStreamEventDraft): void => {
        if (draft.type === 'text-delta') {
          outboundChars += draft.delta.length
          textDeltas += 1
        }
        winSend(chunkChannel, sequencer.next(draft))
      }

      try {
        if (!agentService.isInitialized()) {
          const response = '请先在设置中配置 API Key 和模型，然后重新启动应用。'
          sendEvent({ type: 'text-delta', delta: response })
          // 未初始化路径同样发结束事件，保证渲染层能定稿并关灯。
          sendEvent({ type: 'end', finalLength: response.length })
          return response
        }

        const response = await agentService.streamMessage(
          message,
          conversationId,
          sendEvent,
          options
        )
        // stream.end.out：正文流结束 + 主进程实际转发字符数。
        // 与渲染层 stream.end.in 对照，可判断「主进程没发全」还是「渲染层没接全」。
        streamLog.info(
          `stream.end.out conv=${conversationId} stream=${sequencer.streamId} events=${sequencer.count} textDeltas=${textDeltas} chars=${outboundChars} finalLen=${response.length}`
        )
        return response
      } catch (error) {
        const errorMessage = `Agent 错误: ${error instanceof Error ? error.message : '未知错误'}`
        streamLog.error(
          `stream.error conv=${conversationId} stream=${sequencer.streamId} chars=${outboundChars} err=${error instanceof Error ? error.message : String(error)}`
        )
        sendEvent({ type: 'error', message: errorMessage })
        // 异常路径补发结束事件（零长度）：agentService 抛错时内部来不及发，
        // 这里兜底确保渲染层能定稿并释放运行态。
        sendEvent({ type: 'end', finalLength: outboundChars })
        return errorMessage
      }
    }
  )

  // 渲染进程日志桥：渲染层经此把日志送到主进程统一写文件（见 electron/preload.ts 的 mimirLog）。
  // `send`（非 invoke）语义：日志是 fire-and-forget，不应阻塞渲染层。
  ipcMain.on('log:write', (_event, level: string, scope: string, message: string) => {
    const scoped = scope ? log.scope(scope) : log
    const lvl = level as 'error' | 'warn' | 'info' | 'verbose' | 'debug' | 'silly'
    const fn = typeof scoped[lvl] === 'function' ? scoped[lvl].bind(scoped) : scoped.info.bind(scoped)
    fn(message)
  })

  ipcMain.handle('agent:subagentCatalog', () => agentService.getSubagentCatalog())

  ipcMain.handle('agent:subagentGenerate', async (_event, prompt: string, takenNames: string[]) => {
    if (!agentService.isInitialized()) {
      return { ok: false, message: 'Agent 尚未初始化，请先在设置中配置 API Key。' }
    }
    return agentService.generateSubagentFromPrompt(prompt, takenNames)
  })

  ipcMain.handle('agent:reload', async () => {
    if (!agentService.isInitialized()) {
      return { ok: false, message: 'Agent 尚未初始化，请先在设置中配置 API Key。' }
    }
    return agentService.reload()
  })

  // ─── GPU Server Management ────────────────────────────────────────
  // 探测实现见 electron/servers/probe.ts（IPC 与 Agent 工具共用同一实现）。
  ipcMain.handle('server:probe', async (_event, config: ProbeConfig) => probeServer(config))

  // 服务器 CRUD：**必须**经 serversService（唯一写入口）。
  // 界面不要再走 store:set('servers:list', 整表) —— 那是竞态来源（见 service 文件头注释）。
  ipcMain.handle('servers:list', () => listServers())
  ipcMain.handle('servers:create', (_event, draft: ServerDraft) => createServer(draft))
  ipcMain.handle('servers:update', (_event, id: string, patch: ServerPatch) => updateServer(id, patch))
  ipcMain.handle('servers:delete', (_event, id: string) => {
    deleteServer(id)
    return true
  })

  // ─── Terminal (PTY) ──────────────────────────────────────────────

  ipcMain.handle(
    'terminal:create',
    async (
      _event,
      id: string,
      options?: { cols?: number; rows?: number; ssh?: { host: string; port: number; user: string; keyPath?: string } }
    ) => {
      const existing = ptyInstances.get(id)
      if (existing) existing.kill()

      let command: string
      let args: string[]
      const cwd = process.env.HOME || '/'

      if (options?.ssh) {
        // SSH mode: spawn ssh client in PTY
        command = 'ssh'
        args = [
          '-p', String(options.ssh.port),
          '-o', 'StrictHostKeyChecking=accept-new'
        ]
        if (options.ssh.keyPath) {
          // SSH 私钥路径来自「服务器配置」（用户在表单里填的持久化配置），不是文件对话框，
          // 因此走不了 pickedPaths 白名单；且 PTY 本身就是完整 shell，限制该路径并不增加
          // 实际安全边界。这里仍做两件必做的事：拒绝控制平面路径、拒绝含 NUL 的入参
          // （NUL 会截断 execve 参数，属注入面）。
          const keyPath = options.ssh.keyPath
          if (keyPath.includes('\0') || isControlPlanePath(resolve(keyPath))) {
            throw new Error('已拒绝：无效的 SSH 私钥路径。')
          }
          args.push('-i', keyPath)
        }
        args.push(`${options.ssh.user}@${options.ssh.host}`)
      } else {
        // Local mode: spawn local shell
        command = process.env.SHELL || '/bin/bash'
        args = []
      }

      const term = pty.spawn(command, args, {
        name: 'xterm-256color',
        cols: options?.cols || 80,
        rows: options?.rows || 24,
        cwd,
        env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>
      })

      ptyInstances.set(id, term)

      term.onData((data: string) => {
        winSend(`terminal:data:${id}`, data)
      })

      term.onExit(({ exitCode }: { exitCode: number }) => {
        winSend(`terminal:exit:${id}`, exitCode)
        ptyInstances.delete(id)
      })

      return true
    }
  )

  ipcMain.handle('terminal:write', async (_event, id: string, data: string) => {
    const term = ptyInstances.get(id)
    if (term) term.write(data)
  })

  ipcMain.handle('terminal:resize', async (_event, id: string, cols: number, rows: number) => {
    const term = ptyInstances.get(id)
    if (term) term.resize(cols, rows)
  })

  ipcMain.handle('terminal:close', async (_event, id: string) => {
    const term = ptyInstances.get(id)
    if (term) {
      term.kill()
      ptyInstances.delete(id)
    }
  })

  // ─── 论文创作域（LaTeX / 文献库 / 组会 / 图表 / 空间 / 截稿 / 快照）──────
  // 各域拆到 electron/ipc/<domain>.ts，只注入其真正依赖的边界校验函数。
  registerLatexHandlers({ assertRendererPath })
  registerLibraryHandlers({ assertRendererPath })
  registerMeetingsHandlers()
  registerFiguresHandlers({ assertProjectDirs })
  registerWorkspacesHandlers({ assertRendererPath })
  registerVenuesHandlers()
  registerPaperHandlers({ assertRendererPath })
}

/**
 * 回收 IPC 层持有的资源（应用退出时由 `main.ts` 的 `before-quit` 调用）。
 *
 * 只做「不回收就会拖住/污染退出」的两件事：
 * - 终止存活的 PTY 子进程（node-pty 不随主进程自动退出）；
 * - 清空会话级路径白名单（进程已退出，语义上等同于关窗失效）。
 *
 * 刻意**不**在这里 unregister ipcMain handler：进程即将结束，卸载没有意义，
 * 反而可能在 handler 仍在途时制造「通道不存在」的竞态。
 */
export function disposeIpcResources(): void {
  for (const [id, term] of ptyInstances) {
    try {
      term.kill()
    } catch (error) {
      console.warn(`[ipc] 终止终端 ${id} 失败：`, error)
    }
  }
  ptyInstances.clear()
  pickedPaths.clear()
}
