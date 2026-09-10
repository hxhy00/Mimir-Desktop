import { BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { readFile, writeFile, readdir } from 'fs/promises'
import { readFileSync } from 'fs'
import { app } from 'electron'
import { join, basename, extname, dirname, relative } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { agentService } from '../agent/agentService'
import { setApprovalSender, settleApproval } from '../agent/approval'
import { probeServer, type ProbeConfig } from '../servers/probe'
import { compileLatex, registerLatexPdfDir } from '../latex'
import {
  TECTONIC_RESOURCE_ID,
  availableEngine,
  downloadTectonicEngine,
  pickEngineExecutable,
  tectonicResourceInfo
} from '../latex/runtime'
import * as pty from 'node-pty'
import {
  loadStore,
  getStoreValue,
  setStoreValue,
  spaceRoot,
  listWorkspaces,
  getActiveWorkspace,
  getDefaultWorkspace,
  createWorkspace,
  renameWorkspace,
  removeWorkspace,
  switchWorkspace,
  setDefaultWorkspace,
} from '../library/store'
import * as library from '../library/libraryService'
import { getModelStatus, downloadModel, transcribeAudioBase64, SENSE_VOICE_MODEL } from '../speech/senseVoice'
import {
  activeMeetingModel,
  deleteMeetingDeck,
  generateMeetingDeck,
  listMeetingDecks,
  meetingDeckPath,
} from '../meetings/service'
import type { GenerateDeckRequest } from '../meetings/types'
import {
  applyFigureRename,
  importFigure,
  listFigures,
  previewFigureRename,
  removeFigure,
} from '../figures/figuresService'
import {
  listVenueDeadlines,
  refreshVenueDeadlines,
  setVenueWatch,
} from '../venues/venuesService'
import {
  capturePaperSnapshot,
  deletePaperSnapshot,
  listPaperSnapshots,
  readSnapshotFile,
  revertPaperSnapshot,
} from '../paper/snapshots'
import { listModels } from '../modelDiscovery'
import { aiFixIssue } from '../paper/aiFix'
import { readPaperBib, writePaperBib } from '../paper/bib'
import { VENUE_TEMPLATES, applyVenueTemplate } from '../paper/venueTemplates'

export interface ArxivPaper {
  id: string
  title: string
  authors: string[]
  summary: string
  published: string
  link: string
}

function parseArxivXml(xml: string): ArxivPaper[] {
  const entries: ArxivPaper[] = []
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g
  let match: RegExpExecArray | null

  while ((match = entryRegex.exec(xml)) !== null) {
    const entryXml = match[1]
    const getTag = (tag: string) => {
      const m = entryXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))
      return m ? m[1].trim() : ''
    }

    const id = getTag('id')
    const title = getTag('title').replace(/\s+/g, ' ').trim()
    const summary = getTag('summary').replace(/\s+/g, ' ').trim()
    const published = getTag('published')

    const authors: string[] = []
    const authorRegex = /<name>([\s\S]*?)<\/name>/g
    let authorMatch: RegExpExecArray | null
    while ((authorMatch = authorRegex.exec(entryXml)) !== null) {
      authors.push(authorMatch[1].trim())
    }

    entries.push({ id, title, authors, summary, published, link: `https://arxiv.org/abs/${id}` })
  }

  return entries
}

// Maximum PDF download size (64 MB)
const ARXIV_PDF_MAX_BYTES = 64 * 1024 * 1024
const ARXIV_PDF_DOWNLOAD_TIMEOUT_MS = 60_000

/** Agent 过程事件信封前缀（与渲染层 ChatView 保持一致），经文本 chunk 通道随流发送。 */
const AGENT_EVENT_PREFIX = '\u0002MIMIR_AGENT_EVENT\u0002'

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
  ipcMain.handle('agent:approval-respond', (_event, id: string, allow: boolean) => {
    settleApproval(id, allow === true)
    return true
  })

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
      const response = await fetch(url, {
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
          model: (selected.modelId as string) || 'deepseek-chat',
          baseUrl: selected.baseUrl as string | undefined
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

  // Dialog
  ipcMain.handle('dialog:open', async (_event, options) => {
    const win = winRef.current
    return win === null ? dialog.showOpenDialog(options) : dialog.showOpenDialog(win, options)
  })

  ipcMain.handle('dialog:save', async (_event, options) => {
    const win = winRef.current
    return win === null ? dialog.showSaveDialog(options) : dialog.showSaveDialog(win, options)
  })

  // Shell
  ipcMain.handle('shell:openPath', async (_event, path: string) => {
    return shell.openPath(path)
  })

  // File system
  ipcMain.handle('fs:readFile', async (_event, path: string) => {
    return readFile(path, 'utf-8')
  })

  ipcMain.handle('fs:writeFile', async (_event, path: string, content: string) => {
    const dir = join(path, '..')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return writeFile(path, content, 'utf-8')
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
      const ext = extname(filePath).replace(/^\./, '').toLowerCase()
      const mime = IMAGE_MIME_BY_EXT[ext]
      if (!mime) return { ok: false, message: '仅支持图片文件（png/jpg/webp/gif/bmp/svg/avif）' }
      const data = readFileSync(filePath)
      return { ok: true, dataUrl: `data:${mime};base64,${data.toString('base64')}` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取图片失败' }
    }
  })

  // arXiv search
  ipcMain.handle('arxiv:search', async (_event, query: string, maxResults = 10, sortBy = 'relevance') => {
    try {
      const sortParam =
        sortBy === 'submittedDate'
          ? '&sortBy=submittedDate&sortOrder=descending'
          : '&sortBy=relevance'
      const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(
        query
      )}&start=0&max_results=${maxResults}${sortParam}`

      const response = await fetch(url)
      if (!response.ok) {
        return { error: `arXiv API 请求失败: HTTP ${response.status}` }
      }
      const xml = await response.text()
      return parseArxivXml(xml)
    } catch (error) {
      return { error: error instanceof Error ? error.message : '搜索失败' }
    }
  })

  // Fetch a single paper by arXiv id
  ipcMain.handle('arxiv:fetchPaper', async (_event, id: string) => {
    try {
      const cleanId = id.trim().replace(/^https?:\/\/arxiv\.org\/abs\//, '')
      if (!cleanId) return { error: '无效的 arXiv id' }
      const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(cleanId)}&max_results=1`
      const response = await fetch(url)
      if (!response.ok) {
        return { error: `arXiv API 请求失败: HTTP ${response.status}` }
      }
      const xml = await response.text()
      const entries = parseArxivXml(xml)
      if (entries.length === 0) return { error: `arXiv 中未找到 id 为 '${cleanId}' 的记录` }
      return entries[0]
    } catch (error) {
      return { error: error instanceof Error ? error.message : '获取论文失败' }
    }
  })

  // Download a paper PDF to the userData directory
  ipcMain.handle('arxiv:downloadPdf', async (_event, id: string) => {
    try {
      const cleanId = id.trim().replace(/^https?:\/\/arxiv\.org\/abs\//, '')
      if (cleanId === '' || !/^[a-zA-Z0-9._/-]+$/.test(cleanId)) {
        return { error: '无效的 arXiv id' }
      }
      const url = `https://arxiv.org/pdf/${cleanId}`
      const response = await fetch(url, { signal: AbortSignal.timeout(ARXIV_PDF_DOWNLOAD_TIMEOUT_MS) })
      if (!response.ok) {
        return { error: `PDF 下载失败: HTTP ${response.status}` }
      }
      const contentLength = Number(response.headers.get('content-length'))
      if (Number.isFinite(contentLength) && contentLength > ARXIV_PDF_MAX_BYTES) {
        return { error: `PDF 超过 ${ARXIV_PDF_MAX_BYTES} 字节上限` }
      }
      if (response.body === null) return { error: 'arXiv 返回了空的 PDF 内容' }
      // Stream the body with a size cap
      const chunks: Buffer[] = []
      let length = 0
      const reader = response.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.length
        if (length > ARXIV_PDF_MAX_BYTES) {
          await reader.cancel()
          return { error: `PDF 超过 ${ARXIV_PDF_MAX_BYTES} 字节上限` }
        }
        chunks.push(Buffer.from(value))
      }
      const buffer = Buffer.concat(chunks)
      if (buffer.length < 5 || buffer.subarray(0, 5).toString() !== '%PDF-') {
        return { error: 'arXiv 返回的不是有效的 PDF 文件' }
      }
      const dir = join(spaceRoot(), 'papers')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const fileName = `${encodeURIComponent(cleanId)}.pdf`
      const filePath = join(dir, fileName)
      await writeFile(filePath, buffer)
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

        const response = await fetch(url, {
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
  ipcMain.handle('agent:stop', () => {
    agentService.stopStreaming()
    return true
  })

  // 会话历史摘要压缩（治理 Phase 1：渲染层发送前对超出滑动窗口的旧轮做结构化摘要）
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

  ipcMain.handle(
    'agent:sendMessage',
    async (
      _event,
      message: string,
      conversationId: string,
      options?: {
        ultra?: { enabled: boolean; strategy?: 'auto' | 'plain' | 'multi_expert' | 'critique_reflect' | 'hybrid_mix' | 'self_consistency_vote' }
        history?: { role: 'user' | 'assistant'; content: string }[]
        manual?: boolean
      }
    ) => {
      const chunkChannel = `agent:chunk:${conversationId}`

      try {
        if (!agentService.isInitialized()) {
          const response = '请先在设置中配置 API Key 和模型，然后重新启动应用。'
          winSend(chunkChannel, response)
          return response
        }

        const response = await agentService.streamMessage(
          message,
          conversationId,
          (chunk) => {
            winSend(chunkChannel, chunk)
          },
          (event) => {
            // 过程事件与文本走同一条 chunk 通道：用前缀信封包裹，渲染层拆包后喂给
            // 过程事件树。不依赖额外 IPC 通道，避免 preload 版本不一致导致事件丢。
            winSend(chunkChannel, `${AGENT_EVENT_PREFIX}${JSON.stringify(event)}`)
          },
          options
        )
        return response
      } catch (error) {
        const errorMessage = `Agent 错误: ${error instanceof Error ? error.message : '未知错误'}`
        winSend(chunkChannel, errorMessage)
        return errorMessage
      }
    }
  )

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

  // ─── Terminal (PTY) ──────────────────────────────────────────────
  const ptyInstances = new Map<string, pty.IPty>()

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
          args.push('-i', options.ssh.keyPath)
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

  // ─── LaTeX 论文编译 ────────────────────────────────────────────────
  const LATEX_COMPILE_TIMEOUT_MS = 120_000

  // 探测可用的 LaTeX 引擎（系统 latexmk / tectonic，其次内置 Tectonic）
  ipcMain.handle('latex:detectEngine', async () => {
    const engine = await availableEngine()
    if (engine === null) {
      return {
        ok: false,
        message: '未找到 LaTeX 引擎，请到「设置 → 资源下载」下载 Tectonic 引擎或安装 TeX 发行版'
      }
    }
    return { ok: true, engine: engine.kind as 'latexmk' | 'tectonic', executable: engine.executable }
  })

  // 编译项目目录中的 main.tex（自动选择系统引擎或内置 Tectonic）
  ipcMain.handle('latex:compile', async (_event, projectDir: string) => {
    try {
      const engineExecutable = await pickEngineExecutable()
      const result = await compileLatex(projectDir, engineExecutable, LATEX_COMPILE_TIMEOUT_MS)
      // 存在可预览的编译产物（main.pdf）时登记该目录，供 mimir-tex 协议白名单校验
      if (result.pdfPath !== null) registerLatexPdfDir(projectDir)
      return { ok: true, ...result }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '编译失败' }
    }
  })

  // ─── LaTeX 论文项目 ────────────────────────────────────────────────
  const LATEX_SKIP_DIRS = new Set(['build', 'aux', 'out', 'dist', 'node_modules', '.git', '.vscode'])

  // 递归收集目录内所有 .tex 相对路径，跳过产物与隐藏目录
  async function collectTexFiles(dir: string, base: string, out: string[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        if (LATEX_SKIP_DIRS.has(entry.name)) continue
        await collectTexFiles(join(dir, entry.name), base, out)
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.tex') {
        out.push(relative(base, join(dir, entry.name)))
      }
    }
  }

  // 把客户端传来的相对 .tex 路径解析到项目目录内；非法输入返回 null
  function resolveTexPath(projectDir: string, fileName: string): string | null {
    if (fileName === '' || fileName.includes('\0')) return null
    if (fileName.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(fileName)) return null
    const parts = fileName.split(/[\\/]/)
    if (parts.some((p) => p === '..' || p === '.')) return null
    const full = join(projectDir, fileName)
    if (!full.startsWith(join(projectDir)) || extname(full).toLowerCase() !== '.tex') return null
    return full
  }

  // 列出项目目录中的 .tex 文件（递归，跳过产物与隐藏目录；main.tex 优先）
  ipcMain.handle('latex:listFiles', async (_event, projectDir: string) => {
    try {
      const files: string[] = []
      await collectTexFiles(projectDir, projectDir, files)
      files.sort((a, b) => {
        const mainA = basename(a) === 'main.tex' ? 0 : 1
        const mainB = basename(b) === 'main.tex' ? 0 : 1
        if (mainA !== mainB) return mainA - mainB
        return a.localeCompare(b)
      })
      return { ok: true, files }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取目录失败' }
    }
  })

  // 读取项目内的 .tex 文件（相对路径，支持子目录章节文件）
  ipcMain.handle('latex:readFile', async (_event, projectDir: string, fileName: string) => {
    const full = resolveTexPath(projectDir, fileName)
    if (full === null) {
      return { ok: false, message: '非法文件路径：仅允许项目目录内的 .tex 相对路径' }
    }
    try {
      const content = await readFile(full, 'utf-8')
      return { ok: true, content }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取文件失败' }
    }
  })

  // 写入项目内的 .tex 文件（相对路径，支持子目录章节文件）
  ipcMain.handle('latex:writeFile', async (_event, projectDir: string, fileName: string, content: string) => {
    const full = resolveTexPath(projectDir, fileName)
    if (full === null) {
      return { ok: false, message: '非法文件路径：仅允许项目目录内的 .tex 相对路径' }
    }
    try {
      const dir = dirname(full)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      await writeFile(full, content, 'utf-8')
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '写入文件失败' }
    }
  })

  // 在父目录下创建新论文项目（main.tex 模板）
  ipcMain.handle('latex:createProject', async (_event, parentDir: string, name: string) => {
    try {
      const safeName = name.trim().replace(/[\\/:*?"<>|]/g, '_')
      if (!safeName) return { ok: false, message: '项目名不能为空' }
      const projectDir = join(parentDir, safeName)
      if (existsSync(projectDir)) {
        return { ok: false, message: `目录已存在: ${projectDir}` }
      }
      mkdirSync(projectDir, { recursive: true })
      const template = `\\documentclass[12pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage{graphicx}
\\usepackage{amsmath}
\\usepackage{hyperref}

\\title{${safeName}}
\\author{Author Name\\\\\\texttt{author@example.com}}
\\date{\\today}

\\begin{document}

\\maketitle

\\begin{abstract}
Write your abstract here.
\\end{abstract}

\\section{Introduction}
% Start writing here...

\\section{Related Work}
% Discuss related work...

\\section{Method}
% Describe your method...

\\section{Experiments}
% Present your experiments...

\\section{Conclusion}
% Conclude your work...

\\bibliographystyle{plain}
\\bibliography{references}

\\end{document}`
      await writeFile(join(projectDir, 'main.tex'), template, 'utf-8')
      return { ok: true, projectDir }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '创建项目失败' }
    }
  })

  // ─── 文献库（Library）────────────────────────────────────────────
  ipcMain.handle('library:listPapers', async () => {
    try {
      return { ok: true, papers: library.listPapers() }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取文献库失败' }
    }
  })

  ipcMain.handle('library:searchArxiv', async (_event, query: string, maxResults?: number, sortBy?: 'relevance' | 'submittedDate') => {
    try {
      const entries = await library.searchArxiv(query, maxResults, sortBy)
      return { ok: true, entries }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'arXiv 搜索失败' }
    }
  })

  ipcMain.handle('library:searchWeb', async (_event, query: string, maxResults?: number) => {
    try {
      const entries = await library.searchWeb(query, maxResults)
      return { ok: true, entries }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Web 搜索失败' }
    }
  })

  ipcMain.handle('library:importPaper', async (_event, entry: unknown, projectId?: string) => {
    try {
      const result = await library.importPaper(entry as Parameters<typeof library.importPaper>[0], projectId)
      return { ok: true, ...result }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '导入论文失败' }
    }
  })

  ipcMain.handle('library:removePaper', async (_event, arxivId: string) => {
    try {
      await library.removePaper(arxivId)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '删除论文失败' }
    }
  })

  ipcMain.handle('library:updatePaper', async (_event, request: unknown) => {
    try {
      const paper = await library.updatePaper(request as Parameters<typeof library.updatePaper>[0])
      return { ok: true, paper }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '更新论文失败' }
    }
  })

  ipcMain.handle('library:fetchPaperPdf', async (_event, arxivId: string) => {
    try {
      const paper = await library.fetchPaperPdf(arxivId)
      return { ok: true, paper }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'PDF 下载失败' }
    }
  })

  // 项目
  ipcMain.handle('library:listProjects', async () => {
    try {
      return { ok: true, projects: library.listProjects() }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取项目失败' }
    }
  })

  ipcMain.handle('library:createProject', async (_event, title: string, paperDir?: string) => {
    try {
      const project = library.createProject(title, paperDir)
      return { ok: true, project }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '创建项目失败' }
    }
  })

  ipcMain.handle('library:updateProject', async (_event, id: string, patch: unknown) => {
    try {
      const project = library.updateProject(id, patch as Parameters<typeof library.updateProject>[1])
      return { ok: true, project }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '更新项目失败' }
    }
  })

  ipcMain.handle('library:deleteProject', async (_event, id: string) => {
    try {
      await library.deleteProject(id)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '删除项目失败' }
    }
  })

  // BibTeX 导出
  ipcMain.handle('library:importPapersToBib', async (_event, projectId: string, arxivIds: string[]) => {
    try {
      const result = await library.importPapersToBib(projectId, arxivIds)
      return { ok: true, ...result }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'BibTeX 导出失败' }
    }
  })

  // arXiv 订阅
  ipcMain.handle('library:listSubscriptions', async () => {
    try {
      const subscriptions = await library.listArxivSubscriptions()
      return { ok: true, subscriptions }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取订阅失败' }
    }
  })

  ipcMain.handle('library:saveSubscription', async (_event, query: string) => {
    try {
      const subscription = await library.saveArxivSubscription(query)
      return { ok: true, subscription }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '保存订阅失败' }
    }
  })

  ipcMain.handle('library:deleteSubscription', async (_event, id: string) => {
    try {
      await library.deleteArxivSubscription(id)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '删除订阅失败' }
    }
  })

  ipcMain.handle('library:checkSubscriptions', async (_event, id?: string) => {
    try {
      const outcomes = await library.checkArxivSubscriptions(id)
      return { ok: true, outcomes }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '检查订阅失败' }
    }
  })

  // Zotero
  ipcMain.handle('library:checkZotero', async () => {
    try {
      return { ok: true, ...library.checkZotero() }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Zotero 检查失败' }
    }
  })

  ipcMain.handle('library:listZoteroCollections', async () => {
    try {
      const collections = await library.listZoteroCollections()
      return { ok: true, collections }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取 Zotero 集合失败' }
    }
  })

  ipcMain.handle('library:searchZotero', async (_event, query: string) => {
    try {
      const items = await library.searchZotero(query)
      return { ok: true, items }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Zotero 搜索失败' }
    }
  })

  ipcMain.handle('library:exportZoteroCollectionToBib', async (_event, projectId: string, collectionKey: string) => {
    try {
      const result = await library.exportZoteroCollectionToBib(projectId, collectionKey)
      return { ok: true, ...result }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Zotero 导出失败' }
    }
  })

  // AI 相关性评分：让 Agent 用 set_paper 工具写入评分
  ipcMain.handle(
    'library:scoreRelevance',
    async (_event, paper: unknown, projectId: string, projectTitle: string) => {
      try {
        if (!agentService.isInitialized()) {
          return { ok: false, message: '请先在设置中配置 API Key 和模型' }
        }
        const p = paper as { arxivId: string; title: string; authors: string[]; summary: string }
        const prompt = `请评估以下论文与项目「${projectTitle}」的相关性，并调用 set_paper 工具写入评分（0-10 分）和理由。

论文标题: ${p.title}
作者: ${p.authors.join(', ')}
摘要: ${p.summary}

项目主题: ${projectTitle}

评分标准：
- 9-10: 直接相关，是项目核心工作
- 7-8: 高度相关，方法/结论直接可用
- 4-6: 部分相关，背景或方法有参考价值
- 1-3: 弱相关，仅一般背景
- 0: 无关

调用 set_paper 工具，参数：
- arxivId: ${p.arxivId}
- projectId: ${projectId}
- relevanceScore: 0-10 的整数
- relevanceReason: 一句话简要理由`
        const response = await agentService.sendMessage(prompt, `score-${p.arxivId}-${projectId}`)
        // 启发式校验：Agent 响应过短（<10 字）或不包含评分关键词时，标记为可能未实际写入
        const isSuspicious = response.length < 10 || !/\d/.test(response)
        return {
          ok: true,
          message: isSuspicious
            ? `[警告] Agent 响应可能未包含评分，请手动检查项目「${projectTitle}」中 arxiv:${p.arxivId} 的评分。\n${response}`
            : response,
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'AI 评分失败' }
      }
    }
  )

  // ─── 组会演示文稿（Meetings）────────────────────────────────────
  ipcMain.handle('meetings:generate', async (_event, request: GenerateDeckRequest) => {
    try {
      const deck = await generateMeetingDeck(request)
      return { ok: true, deck }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '生成演示文稿失败' }
    }
  })

  ipcMain.handle('meetings:list', async () => {
    try {
      const decks = await listMeetingDecks()
      return { ok: true, decks }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取演示文稿失败' }
    }
  })

  ipcMain.handle('meetings:delete', async (_event, file: string) => {
    try {
      await deleteMeetingDeck(file)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '删除失败' }
    }
  })

  ipcMain.handle('meetings:reveal', async (_event, file: string) => {
    const path = meetingDeckPath(file)
    if (path === null) return { ok: false, message: '非法文件名' }
    shell.showItemInFolder(path)
    return { ok: true }
  })

  ipcMain.handle('meetings:config', async () => {
    const active = activeMeetingModel()
    return { ok: true, available: active !== null, modelName: active?.name }
  })

  // ─── 图表管理（Figures）──────────────────────────────────────────
  ipcMain.handle('figures:list', async () => {
    try {
      const figures = await listFigures()
      return { ok: true, figures }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取图片失败' }
    }
  })

  ipcMain.handle('figures:add', async (_event, name: string, dataUrl: string) => {
    try {
      const figure = await importFigure(name, dataUrl)
      return { ok: true, figure }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '保存图片失败' }
    }
  })

  ipcMain.handle('figures:remove', async (_event, fileName: string) => {
    try {
      await removeFigure(fileName)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '删除图片失败' }
    }
  })

  ipcMain.handle(
    'figures:renamePreview',
    async (_event, oldFile: string, newName: string, projectDirs: string[]) => {
      try {
        const plan = await previewFigureRename(oldFile, newName, projectDirs)
        return { ok: true, ...plan }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : '预览失败' }
      }
    }
  )

  ipcMain.handle(
    'figures:renameApply',
    async (_event, oldFile: string, newName: string, projectDirs: string[]) => {
      try {
        const result = await applyFigureRename(oldFile, newName, projectDirs)
        return { ok: true, ...result }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : '改名失败' }
      }
    }
  )

  // ─── 科研空间（Workspaces）─────────────────────────────────────────
  ipcMain.handle('workspaces:list', async () => {
    try {
      const workspaces = listWorkspaces()
      const activeId = getActiveWorkspace()?.id ?? null
      const defaultId = getDefaultWorkspace()?.id ?? null
      return { ok: true, workspaces, activeId, defaultId }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取科研空间失败' }
    }
  })

  ipcMain.handle('workspaces:current', async () => {
    try {
      const active = getActiveWorkspace()
      return { ok: true, active: active === null ? null : { ...active } }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取当前空间失败' }
    }
  })

  ipcMain.handle('workspaces:create', async (_event, name: string, dir?: string) => {
    try {
      const workspace = createWorkspace(name, dir)
      return { ok: true, workspace: { ...workspace } }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '创建科研空间失败' }
    }
  })

  ipcMain.handle('workspaces:rename', async (_event, id: string, name: string) => {
    try {
      const workspace = renameWorkspace(id, name)
      return { ok: true, workspace: { ...workspace } }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '重命名失败' }
    }
  })

  ipcMain.handle('workspaces:remove', async (_event, id: string) => {
    try {
      removeWorkspace(id)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '移除科研空间失败' }
    }
  })

  ipcMain.handle('workspaces:switch', async (_event, id: string) => {
    try {
      const workspace = switchWorkspace(id)
      return { ok: true, workspace: { ...workspace } }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '切换科研空间失败' }
    }
  })

  ipcMain.handle('workspaces:setDefault', async (_event, id: string) => {
    try {
      setDefaultWorkspace(id)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '设置默认空间失败' }
    }
  })

  // ─── 会议截稿（Venues）───────────────────────────────────────────
  ipcMain.handle('venues:list', async () => {
    try {
      const payload = await listVenueDeadlines()
      return { ok: true, ...payload }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取截稿目录失败' }
    }
  })

  ipcMain.handle('venues:refresh', async () => {
    try {
      const fetchedAt = await refreshVenueDeadlines()
      return { ok: true, fetchedAt }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '刷新失败（旧缓存已保留）' }
    }
  })

  ipcMain.handle('venues:setWatch', async (_event, seriesKey: string, watched: boolean) => {
    try {
      setVenueWatch(seriesKey, watched)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '更新关注失败' }
    }
  })

  // ─── 论文快照（Paper Snapshots）───────────────────────────────────
  ipcMain.handle('snapshots:capture', async (_event, projectDir: string) => {
    try {
      const result = await capturePaperSnapshot(projectDir)
      return { ok: true, ...result }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '快照失败' }
    }
  })

  ipcMain.handle('snapshots:list', async (_event, projectDir: string) => {
    try {
      const snapshots = await listPaperSnapshots(projectDir)
      return { ok: true, snapshots }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取快照失败' }
    }
  })

  ipcMain.handle('snapshots:read', async (_event, projectDir: string, id: string, rel: string) => {
    try {
      const content = await readSnapshotFile(projectDir, id, rel)
      return { ok: true, content }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取快照文件失败' }
    }
  })

  ipcMain.handle('snapshots:revert', async (_event, projectDir: string, id: string) => {
    try {
      const result = await revertPaperSnapshot(projectDir, id)
      return { ok: true, ...result }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '回退失败' }
    }
  })

  ipcMain.handle('snapshots:remove', async (_event, projectDir: string, id: string) => {
    try {
      await deletePaperSnapshot(projectDir, id)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '删除快照失败' }
    }
  })

  ipcMain.handle(
    'paper:aiFix',
    async (_event, request: { projectDir: string; fileName: string; line: number; message: string }) => {
      try {
        const result = await aiFixIssue(request)
        return { ok: true, ...result }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'AI 修复失败' }
      }
    }
  )

  ipcMain.handle('paper:bibRead', async (_event, projectDir: string) => {
    try {
      const result = await readPaperBib(projectDir)
      return { ok: true, entries: result.entries, path: result.path }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取参考文献失败' }
    }
  })

  ipcMain.handle('paper:bibWrite', async (_event, projectDir: string, entries: unknown) => {
    try {
      await writePaperBib(projectDir, entries as Parameters<typeof writePaperBib>[1])
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '保存参考文献失败' }
    }
  })

  ipcMain.handle('paper:venueTemplates', async () => {
    try {
      return { ok: true, templates: VENUE_TEMPLATES }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取会议模板失败' }
    }
  })

  ipcMain.handle('paper:applyVenueTemplate', async (_event, projectDir: string, templateId: string) => {
    try {
      const path = await applyVenueTemplate(projectDir, templateId)
      return { ok: true, path }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '应用会议模板失败' }
    }
  })
}
