/// <reference types="vite/client" />

interface ElectronAPI {
  getAppVersion: () => Promise<string>
  getPlatform: () => string
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
  getSettings: () => Promise<Record<string, unknown>>
  setSettings: (settings: Record<string, unknown>) => Promise<void>
  transcribeLocal: (audioBase64: string) => Promise<{ text?: string; error?: string }>
  getResourceStatus: () => Promise<{
    resources: { id: string; name: string; description: string; sizeBytes: number; installed: boolean }[]
  }>
  downloadResource: (resourceId: string) => Promise<{ ok: boolean; message?: string }>
  onResourceProgress: (callback: (info: { resourceId: string; percent: number; status: string; message?: string }) => void) => () => void
  testModel: (config: { baseUrl: string; modelId: string; apiKey: string }) => Promise<{ ok: boolean; message: string }>
  /** OpenAI 兼容端点模型发现：按 baseUrl + apiKey 拉取 /v1/models。 */
  listModels: (config: { baseUrl: string; apiKey: string }) => Promise<{
    ok: boolean
    message?: string
    models?: { id: string; ownedBy?: string }[]
    endpoint?: string
  }>
  showOpenDialog: (options: any) => Promise<any>
  showSaveDialog: (options: any) => Promise<any>
  readFile: (path: string) => Promise<string>
  writeFile: (path: string, content: string) => Promise<void>
  readImageDataUrl: (path: string) => Promise<{ ok: boolean; dataUrl?: string; message?: string }>
  getStoreValue: <T>(key: string) => Promise<T | undefined>
  setStoreValue: <T>(key: string, value: T) => Promise<void>
  searchArxiv: (query: string, maxResults?: number, sortBy?: 'relevance' | 'submittedDate') => Promise<unknown>
  fetchPaper: (id: string) => Promise<unknown>
  downloadPdf: (id: string) => Promise<unknown>
  openPath: (path: string) => Promise<void>
  createTerminal: (
    id: string,
    options?: { cols?: number; rows?: number; ssh?: { host: string; port: number; user: string; keyPath?: string } }
  ) => Promise<boolean>
  writeTerminal: (id: string, data: string) => Promise<void>
  resizeTerminal: (id: string, cols: number, rows: number) => Promise<void>
  closeTerminal: (id: string) => Promise<void>
  onTerminalData: (id: string, callback: (data: string) => void) => void
  onTerminalExit: (id: string, callback: (exitCode: number) => void) => void
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
  latex: {
    detectEngine: () => Promise<{ ok: boolean; engine?: 'latexmk' | 'tectonic'; executable?: string; message?: string }>
    listFiles: (projectDir: string) => Promise<{ ok: boolean; files?: string[]; message?: string }>
    readFile: (projectDir: string, fileName: string) => Promise<{ ok: boolean; content?: string; message?: string }>
    writeFile: (projectDir: string, fileName: string, content: string) => Promise<{ ok: boolean; message?: string }>
    compile: (projectDir: string) => Promise<{ ok: boolean; result?: LatexCompileResult; message?: string }>
    createProject: (parentDir: string, name: string) => Promise<{ ok: boolean; projectDir?: string; message?: string }>
  }
  meetings: {
    generate: (request: MeetingGenerateRequest) => Promise<{ ok: boolean; deck?: MeetingDeckView; message?: string }>
    list: () => Promise<{ ok: boolean; decks?: MeetingDeckView[]; message?: string }>
    delete: (file: string) => Promise<{ ok: boolean; message?: string }>
    reveal: (file: string) => Promise<{ ok: boolean; message?: string }>
    config: () => Promise<{ ok: boolean; available: boolean; modelName?: string; message?: string }>
  }
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
  venues: {
    list: () => Promise<{
      ok: boolean
      venues?: VenueDeadlineView[]
      journals?: VenueJournalView[]
      watched?: string[]
      fetchedAt?: string | null
      message?: string
    }>
    refresh: () => Promise<{ ok: boolean; fetchedAt?: string; message?: string }>
    setWatch: (seriesKey: string, watched: boolean) => Promise<{ ok: boolean; message?: string }>
  }
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
}

declare global {
  interface MeetingGenerateRequest {
    readonly title: string
    readonly presenter?: string | undefined
    readonly date?: string | undefined
    readonly projectId?: string | undefined
    readonly paperIds: readonly string[]
    readonly experimentIds: readonly string[]
    readonly enhance: boolean
    readonly aiImages?: boolean | undefined
  }

  interface MeetingDeckView {
    readonly file: string
    readonly path: string
    readonly title: string
    readonly slides: number
    readonly sizeBytes: number
    readonly updatedAt: string
    readonly createdAt: string
  }

  interface FigureRecord {
    readonly id: string
    readonly name: string
    readonly fileName: string
    readonly sizeBytes: number
    readonly createdAt: string
  }

  interface WorkspaceRecord {
    readonly id: string
    readonly name: string
    readonly path: string
    readonly createdAt: string
    readonly updatedAt: string
  }

  interface VenueDeadlineView {
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

  interface VenueJournalView {
    readonly title: string
    readonly fullName: string
    readonly sub: string
    readonly publisher: string
  }

  interface LatexIssue {
    readonly severity: 'error' | 'warning'
    readonly file?: string
    readonly line?: number
    readonly message: string
  }

  interface LatexCompileResult {
    readonly success: boolean
    readonly engine: 'latexmk' | 'tectonic'
    readonly errors: LatexIssue[]
    readonly warnings: LatexIssue[]
    readonly logExcerpt: string
    readonly pdfPath: string | null
  }

  interface Window {
    electronAPI?: ElectronAPI
  }
}

export type { ElectronAPI }