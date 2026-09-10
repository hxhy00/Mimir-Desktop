import { contextBridge, ipcRenderer } from 'electron'

/** 一条从 LaTeX 编译日志恢复的诊断信息。 */
export interface LatexIssue {
  readonly severity: 'error' | 'warning'
  /** 诊断发出时最内层打开的文件相对路径（可用时）。 */
  readonly file?: string
  /** 1-based 输入行号（日志声明时）。 */
  readonly line?: number
  readonly message: string
}

/** `latex:compile` 的结构化结果。 */
export interface LatexCompileResult {
  readonly success: boolean
  readonly engine: 'latexmk' | 'tectonic'
  readonly errors: LatexIssue[]
  readonly warnings: LatexIssue[]
  readonly logExcerpt: string
  readonly pdfPath: string | null
}

/** 生成一份组会演示文稿的请求。 */
export interface MeetingGenerateRequest {
  readonly title: string
  readonly presenter?: string | undefined
  /** YYYY-MM-DD；缺省为当天。 */
  readonly date?: string | undefined
  /** 关联项目 id（可选，用于相关性展示与排序）。 */
  readonly projectId?: string | undefined
  readonly paperIds: readonly string[]
  readonly experimentIds: readonly string[]
  /** 是否尝试 LLM 要点润色（无模型/失败自动降级确定性）。 */
  readonly enhance: boolean
  /** 是否尝试 AI 配图（封面 + 至多 4 篇概念图）；需在设置中配置图像生成服务。 */
  readonly aiImages?: boolean | undefined
}

/** 一份已生成的 deck 的展示视图。 */
export interface MeetingDeckView {
  readonly file: string
  readonly path: string
  readonly title: string
  readonly slides: number
  readonly sizeBytes: number
  readonly updatedAt: string
  readonly createdAt: string
}

/** 一张会议截稿的对外视图（ISO 时间）。 */
export interface VenueDeadlineView {
  readonly key: string
  readonly title: string
  readonly description: string
  readonly sub: string
  readonly ccfRank: 'A' | 'B' | 'C' | 'N'
  readonly dblp: string | null
  readonly conf: {
    readonly year: number
    readonly id: string
    readonly link: string
    readonly date: string
    readonly place: string
  }
  readonly nextDeadlineAt: string | null
  readonly nextDeadlineKind: 'abstract' | 'paper' | null
}

/** 一个科研空间（根目录 + 注册信息）。 */
export interface WorkspaceRecord {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** 一张已上传的图片（元信息；内容经 mimir-img:// 协议按需读取）。 */
export interface FigureRecord {
  readonly id: string
  /** 显示名（原始文件名）。 */
  readonly name: string
  /** 磁盘文件名（basename，含扩展名）。 */
  readonly fileName: string
  readonly sizeBytes: number
  readonly createdAt: string
}

export interface ElectronAPI {
  // App info
  getAppVersion: () => Promise<string>
  getPlatform: () => string

  // Agent
  sendMessage: (message: string, conversationId: string) => Promise<string>
  streamMessage: (
    message: string,
    conversationId: string,
    onChunk: (chunk: string) => void,
    onWorkerEvent?: (event: {
      taskId: string
      title: string
      status: 'running' | 'done' | 'error'
      text?: string
      kind?: 'phase' | 'task' | 'tool' | 'think' | 'think-token'
    }) => void,
    options?: {
      ultra?: {
        enabled: boolean
        strategy?: 'auto' | 'plain' | 'multi_expert' | 'critique_reflect' | 'hybrid_mix' | 'self_consistency_vote'
      }
      history?: { role: 'user' | 'assistant'; content: string }[]
      manual?: boolean
    }
  ) => Promise<string>
  /** 对较早对话历史做结构化摘要压缩（治理 Phase 1）。 */
  compressConversation: (history: { role: 'user' | 'assistant'; content: string }[]) => Promise<{
    ok: boolean
    summary?: string
    message?: string
  }>
  stopMessage: () => Promise<boolean>
  /** 「插件 → 子代理」只读目录：工具白名单 + 内置子代理元数据（展示 / 克隆用）。 */
  getSubagentCatalog: () => Promise<{
    tools: { id: string; label: string; description: string }[]
    builtin: { id: string; label: string; description: string; systemPrompt: string; toolIds: string[] }[]
  }>
  /** 按最新子代理注册重新初始化 Agent（增删改查后免重启生效）。 */
  reloadAgent: () => Promise<{ ok: boolean; message: string }>
  /** 一句话职责描述 → AI 生成自定义子代理草稿（name/说明/提示词/工具白名单）。 */
  generateSubagent: (
    prompt: string,
    takenNames: string[]
  ) => Promise<{
    ok: boolean
    draft?: { name: string; label: string; description: string; systemPrompt: string; toolIds: string[] }
    message?: string
  }>

  // Speech-to-text
  transcribeAudio: (options: {
    audioBase64: string
    baseUrl?: string
    apiKey?: string
    model?: string
  }) => Promise<{ text?: string; error?: string }>

  // Local speech-to-text (SenseVoice)
  transcribeLocal: (audioBase64: string) => Promise<{ text?: string; error?: string }>

  // Resource download (SenseVoice model)
  getResourceStatus: () => Promise<{
    resources: { id: string; name: string; description: string; sizeBytes: number; installed: boolean }[]
  }>
  downloadResource: (resourceId: string) => Promise<{ ok: boolean; message?: string }>
  onResourceProgress: (callback: (info: { resourceId: string; percent: number; status: string; message?: string }) => void) => () => void

  // Settings
  getSettings: () => Promise<Record<string, unknown>>
  setSettings: (settings: Record<string, unknown>) => Promise<void>

  // Model connectivity test
  testModel: (config: { baseUrl: string; modelId: string; apiKey: string }) => Promise<{ ok: boolean; message: string }>
  /** OpenAI 兼容端点模型发现：按 baseUrl + apiKey 拉取 /v1/models。 */
  listModels: (config: { baseUrl: string; apiKey: string }) => Promise<{
    ok: boolean
    message?: string
    models?: { id: string; ownedBy?: string }[]
    endpoint?: string
  }>

  // Dialog
  showOpenDialog: (options: Electron.OpenDialogOptions) => Promise<Electron.OpenDialogReturnValue>
  showSaveDialog: (options: Electron.SaveDialogOptions) => Promise<Electron.SaveDialogReturnValue>

  // File system
  readFile: (path: string) => Promise<string>
  writeFile: (path: string, content: string) => Promise<void>
  readImageDataUrl: (path: string) => Promise<{ ok: boolean; dataUrl?: string; message?: string }>

  // Store data
  getStoreValue: <T>(key: string) => Promise<T | undefined>
  setStoreValue: <T>(key: string, value: T) => Promise<void>

  // arXiv search
  searchArxiv: (query: string, maxResults?: number, sortBy?: 'relevance' | 'submittedDate') => Promise<unknown>
  fetchPaper: (id: string) => Promise<unknown>
  downloadPdf: (id: string) => Promise<unknown>
  openPath: (path: string) => Promise<void>

  // Terminal
  createTerminal: (
    id: string,
    options?: { cols?: number; rows?: number; ssh?: { host: string; port: number; user: string; keyPath?: string } }
  ) => Promise<boolean>
  writeTerminal: (id: string, data: string) => Promise<void>
  resizeTerminal: (id: string, cols: number, rows: number) => Promise<void>
  closeTerminal: (id: string) => Promise<void>
  onTerminalData: (id: string, callback: (data: string) => void) => void
  onTerminalExit: (id: string, callback: (exitCode: number) => void) => void

  // GPU Server
  probeServer: (config: { host: string; port: number; user: string; gpuCount: number; keyPath?: string }) => Promise<{
    status: 'online' | 'offline'
    message: string | null
    stage: string
    tcpLatencyMs: number | null
    gpus: { name: string; utilizationPct: number; memoryUsedMb: number; memoryTotalMb: number }[]
  }>

  // Agent 副作用确认
  onApprovalRequest: (callback: (request: { id: string; tool: string; summary: string; detail?: string }) => void) => () => void
  approvalRespond: (id: string, allow: boolean) => Promise<boolean>

  // ─── 文献库（Library）────────────────────────────────────────────
  library: {
    listPapers: () => Promise<{ ok: boolean; papers?: unknown[]; message?: string }>
    searchArxiv: (query: string, maxResults?: number, sortBy?: 'relevance' | 'submittedDate') => Promise<{ ok: boolean; entries?: unknown[]; message?: string }>
    searchWeb: (query: string, maxResults?: number) => Promise<{ ok: boolean; entries?: unknown[]; message?: string }>
    importPaper: (entry: unknown, projectId?: string) => Promise<{ ok: boolean; imported?: boolean; message?: string }>
    removePaper: (arxivId: string) => Promise<{ ok: boolean; message?: string }>
    updatePaper: (request: unknown) => Promise<{ ok: boolean; paper?: unknown; message?: string }>
    fetchPaperPdf: (arxivId: string) => Promise<{ ok: boolean; paper?: unknown; message?: string }>
    listProjects: () => Promise<{ ok: boolean; projects?: unknown[]; message?: string }>
    createProject: (title: string, paperDir?: string) => Promise<{ ok: boolean; project?: unknown; message?: string }>
    updateProject: (id: string, patch: unknown) => Promise<{ ok: boolean; project?: unknown; message?: string }>
    deleteProject: (id: string) => Promise<{ ok: boolean; message?: string }>
    importPapersToBib: (projectId: string, arxivIds: string[]) => Promise<{ ok: boolean; added?: string[]; skipped?: string[]; bibPath?: string; message?: string }>
    listSubscriptions: () => Promise<{ ok: boolean; subscriptions?: unknown[]; message?: string }>
    saveSubscription: (query: string) => Promise<{ ok: boolean; subscription?: unknown; message?: string }>
    deleteSubscription: (id: string) => Promise<{ ok: boolean; message?: string }>
    checkSubscriptions: (id?: string) => Promise<{ ok: boolean; outcomes?: unknown[]; message?: string }>
    checkZotero: () => Promise<{ ok: boolean; configured?: boolean; message?: string }>
    listZoteroCollections: () => Promise<{ ok: boolean; collections?: unknown[]; message?: string }>
    searchZotero: (query: string) => Promise<{ ok: boolean; items?: unknown[]; message?: string }>
    exportZoteroCollectionToBib: (projectId: string, collectionKey: string) => Promise<{ ok: boolean; added?: string[]; skipped?: string[]; bibPath?: string; message?: string }>
    scoreRelevance: (paper: unknown, projectId: string, projectTitle: string) => Promise<{ ok: boolean; message?: string }>
  }

  // ─── 组会演示文稿（Meetings）────────────────────────────────────
  meetings: {
    generate: (request: MeetingGenerateRequest) => Promise<{ ok: boolean; deck?: MeetingDeckView; message?: string }>
    list: () => Promise<{ ok: boolean; decks?: MeetingDeckView[]; message?: string }>
    delete: (file: string) => Promise<{ ok: boolean; message?: string }>
    reveal: (file: string) => Promise<{ ok: boolean; message?: string }>
    config: () => Promise<{ ok: boolean; available: boolean; modelName?: string; message?: string }>
  }

  // ─── 图表管理（Figures）──────────────────────────────────────────
  figures: {
    list: () => Promise<{ ok: boolean; figures?: FigureRecord[]; message?: string }>
    add: (name: string, dataUrl: string) => Promise<{ ok: boolean; figure?: FigureRecord; message?: string }>
    remove: (fileName: string) => Promise<{ ok: boolean; message?: string }>
    renamePreview: (
      oldFile: string,
      newName: string,
      projectDirs: string[]
    ) => Promise<{
      ok: boolean
      newFile?: string
      usages?: { dir: string; file: string; count: number }[]
      message?: string
    }>
    renameApply: (
      oldFile: string,
      newName: string,
      projectDirs: string[]
    ) => Promise<{ ok: boolean; newFile?: string; replaced?: number; message?: string }>
  }

  // ─── 论文快照（Paper Snapshots）───────────────────────────────────
  snapshots: {
    capture: (projectDir: string) => Promise<{
      ok: boolean
      id?: string
      skipped?: boolean
      files?: number
      message?: string
    }>
    list: (projectDir: string) => Promise<{
      ok: boolean
      snapshots?: { id: string; createdAt: string; files: { path: string; sizeBytes: number }[] }[]
      message?: string
    }>
    read: (projectDir: string, id: string, rel: string) => Promise<{ ok: boolean; content?: string; message?: string }>
    revert: (projectDir: string, id: string) => Promise<{ ok: boolean; restored?: number; message?: string }>
    remove: (projectDir: string, id: string) => Promise<{ ok: boolean; message?: string }>
  }

  // ─── 论文（AI 修复等）────────────────────────────────────────────
  paper: {
    aiFix: (request: { projectDir: string; fileName: string; line: number; message: string }) => Promise<{
      ok: boolean
      applied?: boolean
      replaced?: number
      suggestion?: string
      message?: string
    }>
    bibRead: (projectDir: string) => Promise<{
      ok: boolean
      entries?: { key: string; type: string; fields: Record<string, string> }[]
      path?: string
      message?: string
    }>
    bibWrite: (
      projectDir: string,
      entries: { key: string; type: string; fields: Record<string, string> }[]
    ) => Promise<{ ok: boolean; message?: string }>
    venueTemplates: () => Promise<{
      ok: boolean
      templates?: { id: string; name: string; series: string; url: string; checklist: string }[]
      message?: string
    }>
    applyVenueTemplate: (projectDir: string, templateId: string) => Promise<{ ok: boolean; path?: string; message?: string }>
  }

  // ─── 会议截稿（Venues）───────────────────────────────────────────
  venues: {
    list: () => Promise<{
      ok: boolean
      venues?: VenueDeadlineView[]
      journals?: { title: string; fullName: string; sub: string; publisher: string }[]
      watched?: string[]
      fetchedAt?: string | null
      message?: string
    }>
    refresh: () => Promise<{ ok: boolean; fetchedAt?: string; message?: string }>
    setWatch: (seriesKey: string, watched: boolean) => Promise<{ ok: boolean; message?: string }>
  }

  // ─── 科研空间（Workspaces）───────────────────────────────────────
  workspaces: {
    list: () => Promise<{
      ok: boolean
      workspaces?: WorkspaceRecord[]
      activeId?: string | null
      defaultId?: string | null
      message?: string
    }>
    current: () => Promise<{ ok: boolean; active?: WorkspaceRecord | null; message?: string }>
    create: (name: string, dir?: string) => Promise<{ ok: boolean; workspace?: WorkspaceRecord; message?: string }>
    rename: (id: string, name: string) => Promise<{ ok: boolean; workspace?: WorkspaceRecord; message?: string }>
    remove: (id: string) => Promise<{ ok: boolean; message?: string }>
    switch: (id: string) => Promise<{ ok: boolean; workspace?: WorkspaceRecord; message?: string }>
    setDefault: (id: string) => Promise<{ ok: boolean; message?: string }>
  }

  // ─── LaTeX 论文项目（论文编辑模块）───────────────────────────────
  latex: {
    detectEngine: () => Promise<{ ok: boolean; engine?: 'latexmk' | 'tectonic'; executable?: string; message?: string }>
    listFiles: (projectDir: string) => Promise<{ ok: boolean; files?: string[]; message?: string }>
    readFile: (projectDir: string, fileName: string) => Promise<{ ok: boolean; content?: string; message?: string }>
    writeFile: (projectDir: string, fileName: string, content: string) => Promise<{ ok: boolean; message?: string }>
    compile: (projectDir: string) => Promise<{ ok: boolean; result?: LatexCompileResult; message?: string }>
    createProject: (parentDir: string, name: string) => Promise<{ ok: boolean; projectDir?: string; message?: string }>
  }
}

const electronAPI: ElectronAPI = {
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  getPlatform: () => process.platform,

  sendMessage: (message, conversationId) =>
    ipcRenderer.invoke('agent:sendMessage', message, conversationId),

  streamMessage: (message, conversationId, onChunk, onWorkerEvent, options) => {
    const channel = `agent:chunk:${conversationId}`
    // 先移除同会话旧监听，避免每次发送叠加监听导致后续同会话重复回调
    ipcRenderer.removeAllListeners(channel)
    const chunkListener = (_event: unknown, chunk: string): void => {
      onChunk(chunk)
    }
    ipcRenderer.on(channel, chunkListener)
    return ipcRenderer.invoke('agent:sendMessage', message, conversationId, options).finally(() => {
      ipcRenderer.removeListener(channel, chunkListener)
    })
  },
  compressConversation: (history) => ipcRenderer.invoke('agent:compress', history),
  stopMessage: () => ipcRenderer.invoke('agent:stop'),
  getSubagentCatalog: () => ipcRenderer.invoke('agent:subagentCatalog'),
  reloadAgent: () => ipcRenderer.invoke('agent:reload'),
  generateSubagent: (prompt, takenNames) => ipcRenderer.invoke('agent:subagentGenerate', prompt, takenNames),

  transcribeAudio: (options) => ipcRenderer.invoke('speech:transcribe', options),

  transcribeLocal: (audioBase64) => ipcRenderer.invoke('speech:transcribeLocal', audioBase64),

  getResourceStatus: () => ipcRenderer.invoke('resources:getStatus'),
  downloadResource: (resourceId) => ipcRenderer.invoke('resources:download', resourceId),
  onResourceProgress: (callback) => {
    const listener = (_event: unknown, info: { resourceId: string; percent: number; status: string; message?: string }) => callback(info)
    ipcRenderer.on('resources:progress', listener)
    return () => {
      ipcRenderer.removeListener('resources:progress', listener)
    }
  },

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (settings) => ipcRenderer.invoke('settings:set', settings),

  testModel: (config) => ipcRenderer.invoke('model:test', config),

  listModels: (config) => ipcRenderer.invoke('model:list', config),

  showOpenDialog: (options) => ipcRenderer.invoke('dialog:open', options),
  showSaveDialog: (options) => ipcRenderer.invoke('dialog:save', options),

  readFile: (path) => ipcRenderer.invoke('fs:readFile', path),
  writeFile: (path, content) => ipcRenderer.invoke('fs:writeFile', path, content),
  readImageDataUrl: (path) => ipcRenderer.invoke('fs:readImageDataUrl', path),

  getStoreValue: <T>(key: string) => ipcRenderer.invoke('store:get', key),
  setStoreValue: <T>(key: string, value: T) => ipcRenderer.invoke('store:set', key, value),

  searchArxiv: (query, maxResults, sortBy) => ipcRenderer.invoke('arxiv:search', query, maxResults, sortBy),
  fetchPaper: (id) => ipcRenderer.invoke('arxiv:fetchPaper', id),
  downloadPdf: (id) => ipcRenderer.invoke('arxiv:downloadPdf', id),
  openPath: (path) => ipcRenderer.invoke('shell:openPath', path),

  createTerminal: (id, options) => ipcRenderer.invoke('terminal:create', id, options),
  writeTerminal: (id, data) => ipcRenderer.invoke('terminal:write', id, data),
  resizeTerminal: (id, cols, rows) => ipcRenderer.invoke('terminal:resize', id, cols, rows),
  closeTerminal: (id) => ipcRenderer.invoke('terminal:close', id),
  onTerminalData: (id, callback) => {
    ipcRenderer.on(`terminal:data:${id}`, (_event, data: string) => callback(data))
  },
  onTerminalExit: (id, callback) => {
    ipcRenderer.on(`terminal:exit:${id}`, (_event, exitCode: number) => callback(exitCode))
  },

  probeServer: (config) => ipcRenderer.invoke('server:probe', config),

  onApprovalRequest: (callback) => {
    const listener = (_event: unknown, request: { id: string; tool: string; summary: string; detail?: string }) => callback(request)
    ipcRenderer.on('agent:approval-request', listener)
    return () => {
      ipcRenderer.removeListener('agent:approval-request', listener)
    }
  },
  approvalRespond: (id, allow) => ipcRenderer.invoke('agent:approval-respond', id, allow),

  library: {
    listPapers: () => ipcRenderer.invoke('library:listPapers'),
    searchArxiv: (query, maxResults, sortBy) => ipcRenderer.invoke('library:searchArxiv', query, maxResults, sortBy),
    searchWeb: (query, maxResults) => ipcRenderer.invoke('library:searchWeb', query, maxResults),
    importPaper: (entry, projectId) => ipcRenderer.invoke('library:importPaper', entry, projectId),
    removePaper: (arxivId) => ipcRenderer.invoke('library:removePaper', arxivId),
    updatePaper: (request) => ipcRenderer.invoke('library:updatePaper', request),
    fetchPaperPdf: (arxivId) => ipcRenderer.invoke('library:fetchPaperPdf', arxivId),
    listProjects: () => ipcRenderer.invoke('library:listProjects'),
    createProject: (title, paperDir) => ipcRenderer.invoke('library:createProject', title, paperDir),
    updateProject: (id, patch) => ipcRenderer.invoke('library:updateProject', id, patch),
    deleteProject: (id) => ipcRenderer.invoke('library:deleteProject', id),
    importPapersToBib: (projectId, arxivIds) => ipcRenderer.invoke('library:importPapersToBib', projectId, arxivIds),
    listSubscriptions: () => ipcRenderer.invoke('library:listSubscriptions'),
    saveSubscription: (query) => ipcRenderer.invoke('library:saveSubscription', query),
    deleteSubscription: (id) => ipcRenderer.invoke('library:deleteSubscription', id),
    checkSubscriptions: (id) => ipcRenderer.invoke('library:checkSubscriptions', id),
    checkZotero: () => ipcRenderer.invoke('library:checkZotero'),
    listZoteroCollections: () => ipcRenderer.invoke('library:listZoteroCollections'),
    searchZotero: (query) => ipcRenderer.invoke('library:searchZotero', query),
    exportZoteroCollectionToBib: (projectId, collectionKey) => ipcRenderer.invoke('library:exportZoteroCollectionToBib', projectId, collectionKey),
    scoreRelevance: (paper, projectId, projectTitle) => ipcRenderer.invoke('library:scoreRelevance', paper, projectId, projectTitle)
  },

  latex: {
    detectEngine: () => ipcRenderer.invoke('latex:detectEngine'),
    listFiles: (projectDir) => ipcRenderer.invoke('latex:listFiles', projectDir),
    readFile: (projectDir, fileName) => ipcRenderer.invoke('latex:readFile', projectDir, fileName),
    writeFile: (projectDir, fileName, content) => ipcRenderer.invoke('latex:writeFile', projectDir, fileName, content),
    compile: (projectDir) => ipcRenderer.invoke('latex:compile', projectDir),
    createProject: (parentDir, name) => ipcRenderer.invoke('latex:createProject', parentDir, name)
  },

  meetings: {
    generate: (request) => ipcRenderer.invoke('meetings:generate', request),
    list: () => ipcRenderer.invoke('meetings:list'),
    delete: (file) => ipcRenderer.invoke('meetings:delete', file),
    reveal: (file) => ipcRenderer.invoke('meetings:reveal', file),
    config: () => ipcRenderer.invoke('meetings:config')
  },

  figures: {
    list: () => ipcRenderer.invoke('figures:list'),
    add: (name, dataUrl) => ipcRenderer.invoke('figures:add', name, dataUrl),
    remove: (fileName) => ipcRenderer.invoke('figures:remove', fileName),
    renamePreview: (oldFile, newName, projectDirs) => ipcRenderer.invoke('figures:renamePreview', oldFile, newName, projectDirs),
    renameApply: (oldFile, newName, projectDirs) => ipcRenderer.invoke('figures:renameApply', oldFile, newName, projectDirs)
  },

  workspaces: {
    list: () => ipcRenderer.invoke('workspaces:list'),
    current: () => ipcRenderer.invoke('workspaces:current'),
    create: (name, dir) => ipcRenderer.invoke('workspaces:create', name, dir),
    rename: (id, name) => ipcRenderer.invoke('workspaces:rename', id, name),
    remove: (id) => ipcRenderer.invoke('workspaces:remove', id),
    switch: (id) => ipcRenderer.invoke('workspaces:switch', id),
    setDefault: (id) => ipcRenderer.invoke('workspaces:setDefault', id)
  },

  venues: {
    list: () => ipcRenderer.invoke('venues:list'),
    refresh: () => ipcRenderer.invoke('venues:refresh'),
    setWatch: (seriesKey, watched) => ipcRenderer.invoke('venues:setWatch', seriesKey, watched)
  },

  paper: {
    aiFix: (request) => ipcRenderer.invoke('paper:aiFix', request),
    bibRead: (projectDir) => ipcRenderer.invoke('paper:bibRead', projectDir),
    bibWrite: (projectDir, entries) => ipcRenderer.invoke('paper:bibWrite', projectDir, entries),
    venueTemplates: () => ipcRenderer.invoke('paper:venueTemplates'),
    applyVenueTemplate: (projectDir, templateId) => ipcRenderer.invoke('paper:applyVenueTemplate', projectDir, templateId)
  },

  snapshots: {
    capture: (projectDir) => ipcRenderer.invoke('snapshots:capture', projectDir),
    list: (projectDir) => ipcRenderer.invoke('snapshots:list', projectDir),
    read: (projectDir, id, rel) => ipcRenderer.invoke('snapshots:read', projectDir, id, rel),
    revert: (projectDir, id) => ipcRenderer.invoke('snapshots:revert', projectDir, id),
    remove: (projectDir, id) => ipcRenderer.invoke('snapshots:remove', projectDir, id)
  }
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)
