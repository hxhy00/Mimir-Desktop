import { useState, useEffect, useCallback, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { Terminal } from '@/components/chat/Terminal'
import {
  Server,
  Plus,
  Cpu,
  Trash2,
  Pencil,
  TerminalSquare,
  X,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  Zap,
  Clock,
  Eye,
  EyeOff
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface GpuInfo {
  name: string
  utilizationPct: number
  memoryUsedMb: number
  memoryTotalMb: number
}

interface GpuServer {
  id: string
  name: string
  host: string
  port: number
  user: string
  password?: string
  keyPath?: string
  gpuCount: number
  gpuModel: string
  status: 'online' | 'offline'
  gpus: GpuInfo[]
  notes?: string
  lastChecked?: string
}

interface ServerForm {
  name: string
  host: string
  port: number
  user: string
  password: string
  keyPath: string
  gpuCount: number
  gpuModel: string
  notes: string
}

const EMPTY_FORM: ServerForm = {
  name: '',
  host: '',
  port: 22,
  user: 'root',
  password: '',
  keyPath: '',
  gpuCount: 1,
  gpuModel: '',
  notes: ''
}

/** 密钥路径长度上限：防止超长输入把 ssh 命令行撑爆（也挡住手工改配置塞进来的异常值）。 */
const KEY_PATH_MAX_LENGTH = 1024
/**
 * 密钥路径白名单：家目录相对（`~/…`）、绝对 / 相对路径、字母数字与常见路径符号。
 * 不含空白，也不含任何 shell / ssh 元字符。
 */
const KEY_PATH_PATTERN = /^[A-Za-z0-9._~@/+-]+$/

/**
 * SSH 私钥路径校验：合法返回 `null`，不合法返回给用户看的错误文案。
 *
 * ── 为什么必须校验 ──────────────────────────────────────────────────────
 * keyPath 会作为 `-i <路径>` 参数进入**真实的 ssh 命令行**（见 electron/servers/probe.ts：
 * `sshArgs.push('-i', keyPath)`，渲染层 Terminal 同理）。那里用的是 execFile 的**参数数组**
 * （不经 shell，所以 `;` `|` `&` 之类不构成 shell 注入），但 **ssh 选项注入** 依然成立：
 *   - 以 `-` 开头的值会被 ssh 当成**新选项**解析（例如 `-oProxyCommand=…` 可以让 ssh
 *     连去别的地方、甚至拉起任意命令）。一个「填路径」的输入框就此变成「改一条 ssh 命令」；
 *   - 含空白的值会被拆成多个参数，同样改变命令结构。
 * 因此在**源头**（表单保存 / 探测前 / 终端连接前）用白名单拒绝，
 * 并且必须**显式报错**，不能静默丢掉——否则用户只会看到「连不上」却找不到原因。
 *
 * 传参方式本身已经是安全的：始终以 `-i` + 独立参数传递（ssh 真实语法），
 * 绝不把用户可控字符串拼进一条命令行文本。
 */
function validateKeyPath(raw: string): string | null {
  const value = raw.trim()
  // 留空合法：表示使用默认密钥 / ssh-agent。
  if (value === '') return null
  if (value.length > KEY_PATH_MAX_LENGTH) return `长度超过上限（${String(KEY_PATH_MAX_LENGTH)} 个字符）`
  if (value.startsWith('-')) return '不能以 "-" 开头（会被 ssh 当成选项解析）'
  if (!KEY_PATH_PATTERN.test(value)) return '不能包含空白或 ; | & $ ` \' " \\ 等特殊字符'
  return null
}

export function Servers() {
  const [servers, setServers] = useState<GpuServer[]>([])
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<ServerForm>(EMPTY_FORM)
  const [terminalId, setTerminalId] = useState<string | null>(null)
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set())
  const [probing, setProbing] = useState<Record<string, boolean>>({})
  const [showPassword, setShowPassword] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  /**
   * 最近一次探测的失败原因（按服务器 id）。
   * `status` 是运行时字段不落盘，探测失败的原因同样只活在内存里；
   * 展开区用它把「为什么离线/为什么没 GPU」讲清楚，而不是让用户只看到一个点。
   */
  const [probeMsg, setProbeMsg] = useState<Record<string, string | null>>({})

  // Load servers（经 service 读，不再直接读裸 store key）
  const reload = useCallback(async () => {
    try {
      if (window.electronAPI?.listServers) {
        const data = await window.electronAPI.listServers()
        if (data) setServers(data as unknown as GpuServer[])
      } else {
        const cached = localStorage.getItem('mimir-servers')
        if (cached) setServers(JSON.parse(cached))
      }
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const openAddDialog = useCallback(() => {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setTestResult(null)
    setShowPassword(false)
    setDialogOpen(true)
  }, [])

  const openEditDialog = useCallback((server: GpuServer) => {
    setEditingId(server.id)
    setForm({
      name: server.name,
      host: server.host,
      port: server.port,
      user: server.user,
      password: server.password || '',
      keyPath: server.keyPath || '',
      gpuCount: server.gpuCount,
      gpuModel: server.gpuModel,
      notes: server.notes || ''
    })
    setTestResult(null)
    setShowPassword(false)
    setDialogOpen(true)
  }, [])

  const handleSave = useCallback(async (overrides?: Partial<ServerForm>) => {
    const values = { ...form, ...overrides }
    if (!values.name || !values.host) return
    // 密钥路径不合法则**拒绝保存**：存进去只会得到一条连不上、且带注入风险的记录。
    // 报错走对话框里的检测结果区（setTestResult），保存失败因此是可见的。
    const keyPathError = validateKeyPath(values.keyPath)
    if (keyPathError !== null) {
      setTestResult({ ok: false, message: `SSH 密钥路径不合法：${keyPathError}` })
      return
    }

    // 只把「连接配置」交给 service；status/gpus/lastChecked 是运行时状态，不落盘。
    const draft = {
      name: values.name,
      host: values.host,
      port: values.port,
      user: values.user,
      password: values.password,
      keyPath: values.keyPath,
      gpuCount: values.gpuCount,
      gpuModel: values.gpuModel || '未知',
      notes: values.notes
    }

    try {
      if (window.electronAPI?.createServer) {
        // 经主进程 service 原子读-改-写：不做整表覆盖，因此与 agent 工具并发写不会互相覆盖。
        if (editingId) await window.electronAPI.updateServer(editingId, draft)
        else await window.electronAPI.createServer(draft)
      } else {
        // 浏览器降级：维持旧行为（localStorage 中不存在多写入方，无竞态）
        const stored = JSON.parse(localStorage.getItem('mimir-servers') || '[]') as GpuServer[]
        const next = editingId
          ? stored.map((s) => (s.id === editingId ? { ...s, ...draft } : s))
          : [...stored, { id: `srv-${Date.now()}`, status: 'offline' as const, gpus: [], ...draft }]
        localStorage.setItem('mimir-servers', JSON.stringify(next))
      }
    } catch {
      // ignore
    }
    // 写成功后统一从 service 重载，避免界面内存态与 store 脱节
    await reload()
    setDialogOpen(false)
    setForm(EMPTY_FORM)
    setEditingId(null)
    setTestResult(null)
  }, [editingId, form, reload])

  // Probe connectivity before saving (used on add)
  const handleTestAndSave = useCallback(async () => {
    if (!form.name || !form.host) return
    // 探测会把 keyPath 送进 ssh 命令行，先校验再用（见 validateKeyPath 注释）。
    const keyPathError = validateKeyPath(form.keyPath)
    if (keyPathError !== null) {
      setTestResult({ ok: false, message: `SSH 密钥路径不合法：${keyPathError}` })
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      if (window.electronAPI?.probeServer) {
        const result = await window.electronAPI.probeServer({
          host: form.host,
          port: form.port,
          user: form.user,
          gpuCount: form.gpuCount,
          keyPath: form.keyPath || undefined
        })
        if (result.status === 'offline') {
          setTestResult({ ok: false, message: result.message || '无法连接到服务器' })
          return
        }
        // Online — 探测到的 GPU 型号/数量是有价值的配置信息，落盘；实时 gpus/status 不落盘
        await handleSave({
          gpuCount: result.gpus.length > 0 ? result.gpus.length : form.gpuCount,
          gpuModel: result.gpus[0]?.name || form.gpuModel || '未知'
        })
        setTestResult({ ok: true, message: '连接成功，服务器已添加' })
      } else {
        // Browser fallback: just save
        void handleSave()
      }
    } catch (error) {
      setTestResult({ ok: false, message: error instanceof Error ? error.message : '连接失败' })
    } finally {
      setTesting(false)
    }
  }, [form, handleSave])

  const handleDelete = useCallback(
    async (id: string) => {
      if (terminalId === id) setTerminalId(null)
      try {
        if (window.electronAPI?.deleteServer) {
          // 交给 service 原子删除，避免用界面旧快照整表覆盖
          await window.electronAPI.deleteServer(id)
        } else {
          const next = servers.filter((s) => s.id !== id)
          localStorage.setItem('mimir-servers', JSON.stringify(next))
        }
      } catch {
        // ignore
      }
      await reload()
      setExpandedCards((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    },
    [terminalId, servers, reload]
  )

  /**
   * 探测一台服务器（不依赖事件对象，便于挂载后自动探测复用）。
   *
   * `quiet`：自动探测模式 —— 不弹 alert（密钥路径不合法时静默记录到 probeMsg，
   * 否则一进页面就可能连弹多个对话框）；用户手点探测仍用非 quiet 模式明确告知。
   */
  const probeOne = useCallback(async (server: GpuServer, opts?: { quiet?: boolean }) => {
    // 库里已存了一个不合法的密钥路径（旧数据或手工改过配置）：明确告知并**不发起探测**——
    // 既不静默忽略配置问题，也不会把危险值送进 ssh 命令行。
    const keyPathError = validateKeyPath(server.keyPath ?? '')
    if (keyPathError !== null) {
      const msg = `SSH 密钥路径不合法：${keyPathError}`
      setProbeMsg((prev) => ({ ...prev, [server.id]: msg }))
      if (opts?.quiet !== true) {
        window.alert(`服务器「${server.name}」的 ${msg}\n请编辑该服务器修正后再探测。`)
      }
      return
    }
    setProbing((prev) => ({ ...prev, [server.id]: true }))
    try {
      if (window.electronAPI?.probeServer) {
        const result = await window.electronAPI.probeServer({
          host: server.host,
          port: server.port,
          user: server.user,
          gpuCount: server.gpuCount,
          keyPath: server.keyPath || undefined
        })
        const updatedServer: GpuServer = {
          ...server,
          status: result.status,
          gpus: result.gpus || [],
          lastChecked: new Date().toISOString()
        }
        // Auto-detect GPU model from nvidia-smi output if available
        if (result.gpus && result.gpus.length > 0 && result.gpus[0].name) {
          updatedServer.gpuModel = result.gpus[0].name
          updatedServer.gpuCount = result.gpus.length
          // 探测到的型号/数量是配置信息 → 经 service 原子写回（运行时 status/gpus 不落盘）
          try {
            await window.electronAPI.updateServer(server.id, {
              gpuCount: result.gpus.length,
              gpuModel: result.gpus[0].name
            })
          } catch {
            // 写回失败不影响本次展示
          }
        }
        setServers((prev) => prev.map((s) => (s.id === server.id ? updatedServer : s)))
        // 在线但 GPU 探测失败（如 BatchMode 下密钥不可用）也要把原因摆出来
        setProbeMsg((prev) => ({ ...prev, [server.id]: result.message ?? null }))
      }
    } catch {
      // If probe not available in browser, just toggle in-memory only
      setServers((prev) =>
        prev.map((s) =>
          s.id === server.id
            ? { ...s, status: s.status === 'online' ? 'offline' as const : 'online' as const }
            : s
        )
      )
    } finally {
      setProbing((prev) => ({ ...prev, [server.id]: false }))
    }
  }, [])

  const handleProbe = useCallback(
    (server: GpuServer, e: React.MouseEvent) => {
      e.stopPropagation()
      void probeOne(server)
    },
    [probeOne]
  )

  /**
   * 挂载后自动逐台探测。
   *
   * 为什么必须有这一步：`status` 是运行时字段、**不落盘**（见 serversService 的收敛规则），
   * 重启/切页回来后列表里全是 `undefined`——界面若直接当「离线」显示就是误导
   * （2026-09-16 用户反馈「服务器显示离线」即此）。这里进入模块后自动补探测，
   * 逐台错峰 300ms 发起，避免同时打出 N 条 ssh 连接。
   *
   * 位置注意：必须放在 `probeOne` 声明之后——`useCallback` 是 `const`，
   * 声明前引用会在渲染期触发暂时性死区（TDZ）直接崩溃白屏（2026-09-16 实测踩坑）。
   */
  const autoProbedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!window.electronAPI?.probeServer) return
    const pending = servers.filter((s) => !autoProbedRef.current.has(s.id))
    if (pending.length === 0) return
    let canceled = false
    void (async () => {
      for (const s of pending) {
        if (canceled) return
        autoProbedRef.current.add(s.id)
        await probeOne(s, { quiet: true })
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
    })()
    return () => {
      canceled = true
    }
  }, [servers, probeOne])

  const openTerminal = useCallback(
    (id: string) => {
      if (terminalId === id) {
        setTerminalId(null)
      } else {
        setExpandedCards((prev) => new Set(prev).add(id))
        setTerminalId(id)
      }
    },
    [terminalId]
  )

  const toggleCard = useCallback((id: string) => {
    setExpandedCards((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const onlineCount = servers.filter((s) => s.status === 'online').length
  const selectedServer = servers.find((s) => s.id === terminalId)

  /**
   * 终端的 SSH 配置：密钥路径**校验通过才下传**（`-i <路径>` 独立参数，遵循 ssh 语法）。
   * 校验不通过时不静默丢弃 —— 下方终端标题栏会显式显示被拒原因与后果。
   */
  const terminalKeyPath = selectedServer?.keyPath || undefined
  const terminalKeyPathError = validateKeyPath(terminalKeyPath ?? '')

  return (
    <div className="flex h-full flex-col">
      <div className="module-header">
        <div className="flex items-center gap-3">
          <span className="module-title">GPU 服务器</span>
          <span className="text-[11px] text-muted-foreground">
            {servers.length} 台 · {onlineCount} 在线
          </span>
        </div>
        <Button size="sm" variant="outline" className="h-7" onClick={openAddDialog}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          添加服务器
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2">
        {servers.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <Server className="h-8 w-8 opacity-30 mb-2" />
            <p className="text-[12px] font-medium">暂无服务器</p>
            <p className="text-[11px] mt-0.5 opacity-70">点击右上角添加 GPU 服务器</p>
          </div>
        ) : (
          servers.map((server) => {
            const isExpanded = expandedCards.has(server.id)
            const hasTerminal = terminalId === server.id
            const isProbing = probing[server.id]

            return (
              <div
                key={server.id}
                className="rounded-lg border border-border bg-card hover:shadow-sm transition-shadow"
              >
                <div className="p-3">
                  <div className="flex items-start justify-between">
                    <div
                      className="flex items-center gap-3 cursor-pointer flex-1 min-w-0"
                      onClick={() => toggleCard(server.id)}
                    >
                      <div className="text-muted-foreground">
                        {isExpanded ? (
                          <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" />
                        )}
                      </div>
                      <div className="flex h-8 w-8 items-center justify-center rounded-md bg-muted shrink-0">
                        <Server className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className="font-medium text-[13px] truncate">{server.name}</h3>
                          <span
                            className={cn(
                              'status-dot',
                              server.status === 'online'
                                ? 'bg-success'
                                : server.status === 'offline'
                                  ? 'bg-rose-400/80'
                                  : 'bg-amber-400/80'
                            )}
                          />
                          <span className="text-[10px] text-muted-foreground shrink-0">
                            {server.status === 'online'
                              ? '在线'
                              : server.status === 'offline'
                                ? '离线'
                                : '未探测'}
                          </span>
                          {server.lastChecked && (
                            <span className="text-[9px] text-muted-foreground/50 flex items-center gap-0.5">
                              <Clock className="h-2.5 w-2.5" />
                              {formatTime(server.lastChecked)}
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-muted-foreground mt-0.5 font-mono truncate">
                          {server.user}@{server.host}:{server.port}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-0.5 shrink-0 ml-2">
                      <button
                        onClick={(e) => handleProbe(server, e)}
                        disabled={isProbing}
                        className={cn(
                          'flex h-6 w-6 items-center justify-center rounded transition-colors',
                          isProbing
                            ? 'text-primary animate-spin'
                            : 'text-muted-foreground hover:bg-muted'
                        )}
                        title="探测连接"
                      >
                        {isProbing ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          openTerminal(server.id)
                        }}
                        className={cn(
                          'flex h-6 w-6 items-center justify-center rounded transition-colors',
                          hasTerminal
                            ? 'text-primary bg-primary/10'
                            : 'text-muted-foreground hover:bg-muted'
                        )}
                        title="终端"
                      >
                        <TerminalSquare className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          openEditDialog(server)
                        }}
                        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted transition-colors"
                        title="编辑"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDelete(server.id)
                        }}
                        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                        title="删除"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Expanded content */}
                  {isExpanded && (
                    <div className="mt-3 space-y-2">
                      {/* GPU stats from nvidia-smi */}
                      {server.status === 'online' && server.gpus.length > 0 && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                          {server.gpus.map((gpu, idx) => (
                            <div key={idx} className="rounded-md bg-muted/50 p-2">
                              <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-1">
                                <Zap className="h-3 w-3" />
                                GPU {idx}
                              </div>
                              <p className="text-[11px] font-medium truncate">{gpu.name}</p>
                              <div className="mt-1.5 space-y-1">
                                <div>
                                  <div className="flex justify-between text-[10px] text-muted-foreground">
                                    <span>利用率</span>
                                    <span>{gpu.utilizationPct}%</span>
                                  </div>
                                  <div className="h-1 rounded-full bg-border overflow-hidden">
                                    <div
                                      className="h-full rounded-full bg-primary transition-all"
                                      style={{ width: `${gpu.utilizationPct}%` }}
                                    />
                                  </div>
                                </div>
                                <div>
                                  <div className="flex justify-between text-[10px] text-muted-foreground">
                                    <span>显存</span>
                                    <span>
                                      {gpu.memoryUsedMb}M / {gpu.memoryTotalMb}M
                                    </span>
                                  </div>
                                  <div className="h-1 rounded-full bg-border overflow-hidden">
                                    <div
                                      className="h-full rounded-full bg-blue-500 transition-all"
                                      style={{
                                        width: `${gpu.memoryTotalMb > 0 ? (gpu.memoryUsedMb / gpu.memoryTotalMb) * 100 : 0}%`
                                      }}
                                    />
                                  </div>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Fallback stats when online but no GPU data */}
                      {server.status === 'online' && server.gpus.length === 0 && (
                        <div className="rounded-md bg-muted/50 p-2 text-[11px] text-muted-foreground text-center">
                          <Cpu className="h-4 w-4 mx-auto mb-1 opacity-50" />
                          <p>服务器在线，但无法获取 GPU 信息</p>
                          <p className="text-[10px] mt-0.5 opacity-70">请确认 nvidia-smi 可正常运行</p>
                        </div>
                      )}

                      {/* 未在线：展开区不再一片空白——把「未探测 / 离线原因」讲清楚 */}
                      {server.status !== 'online' && (
                        <div className="rounded-md bg-muted/50 p-2 text-[11px] text-muted-foreground text-center">
                          <Cpu className="h-4 w-4 mx-auto mb-1 opacity-50" />
                          {server.status === 'offline' ? (
                            <>
                              <p>服务器离线或探测失败</p>
                              {probeMsg[server.id] ? (
                                <p className="mt-0.5 break-all text-[10px] opacity-70">{probeMsg[server.id]}</p>
                              ) : (
                                <p className="text-[10px] mt-0.5 opacity-70">点击右上角刷新图标重新探测</p>
                              )}
                            </>
                          ) : (
                            <>
                              <p>尚未探测连接</p>
                              <p className="text-[10px] mt-0.5 opacity-70">
                                {probing[server.id] ? '探测中…' : '点击右上角刷新图标探测连接与 GPU 状态'}
                              </p>
                            </>
                          )}
                        </div>
                      )}

                      {/* Notes */}
                      {server.notes && (
                        <p className="text-[11px] text-muted-foreground italic">{server.notes}</p>
                      )}

                      {/* Server info bar */}
                      <div className="flex items-center gap-3 text-[10px] text-muted-foreground font-mono">
                        <span>
                          GPU: {server.gpus.length || server.gpuCount}x {server.gpuModel || '未知'}
                        </span>
                        <span className="text-border">|</span>
                        <span>Port: {server.port}</span>
                        {server.notes && (
                          <>
                            <span className="text-border">|</span>
                            <span className="truncate max-w-[200px]">{server.notes}</span>
                          </>
                        )}
                      </div>

                      {/* SSH Terminal */}
                      {hasTerminal && selectedServer && (
                        <div className="relative">
                          <div className="flex items-center justify-between bg-[#1e1e1e] rounded-t-md px-3 py-1.5 border border-b-0 border-border">
                            <div className="flex items-center gap-2">
                              <TerminalSquare className="h-3 w-3 text-green-400" />
                              <span className="text-[11px] text-gray-400 font-mono">
                                ssh {selectedServer.user}@{selectedServer.host} -p {selectedServer.port}
                              </span>
                            </div>
                            <button
                              onClick={() => setTerminalId(null)}
                              className="text-gray-500 hover:text-gray-300 transition-colors"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                          {/* 密钥路径被拒：显式说明「为什么不用它」，而不是让用户在「连不上」里猜 */}
                          {terminalKeyPathError !== null && (
                            <p className="border border-b-0 border-destructive/30 bg-destructive/5 px-3 py-1 text-[10px] text-destructive">
                              已保存的 SSH 密钥路径不合法（{terminalKeyPathError}），本次连接未使用该密钥。请编辑服务器修正。
                            </p>
                          )}
                          <div className="rounded-b-md border border-border overflow-hidden">
                            <Terminal
                              id={`terminal-${server.id}`}
                              className="h-[300px] bg-[#1e1e1e]"
                              ssh={{
                                host: selectedServer.host,
                                port: selectedServer.port,
                                user: selectedServer.user,
                                keyPath: terminalKeyPathError === null ? terminalKeyPath : undefined
                              }}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* Add / Edit Server Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId ? '编辑服务器' : '添加 GPU 服务器'}</DialogTitle>
            <DialogDescription>
              {editingId ? '修改服务器连接信息和配置。' : '填写服务器连接信息，保存时会自动检测连通性。'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2.5">
            {/* Row 1: 名称 + 主机:端口 */}
            <div className="grid grid-cols-5 gap-2">
              <div className="col-span-2 space-y-1">
                <Label className="text-[11px]">名称 *</Label>
                <Input
                  placeholder="实验室服务器"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="h-7 text-[12px]"
                  autoFocus
                />
              </div>
              <div className="col-span-2 space-y-1">
                <Label className="text-[11px]">主机地址 *</Label>
                <Input
                  placeholder="192.168.1.100"
                  value={form.host}
                  onChange={(e) => setForm({ ...form, host: e.target.value })}
                  className="h-7 text-[12px] font-mono"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">端口</Label>
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  value={form.port}
                  onChange={(e) => setForm({ ...form, port: parseInt(e.target.value) || 22 })}
                  className="h-7 text-[12px]"
                />
              </div>
            </div>
            {/* Row 2: 用户名 + 密码 + SSH 密钥 */}
            <div className="grid grid-cols-6 gap-2">
              <div className="space-y-1">
                <Label className="text-[11px]">用户名</Label>
                <Input
                  placeholder="root"
                  value={form.user}
                  onChange={(e) => setForm({ ...form, user: e.target.value })}
                  className="h-7 text-[12px]"
                />
              </div>
              <div className="col-span-2 space-y-1">
                <Label className="text-[11px]">SSH 密码</Label>
                <div className="relative">
                  <Input
                    type={showPassword ? 'text' : 'password'}
                    placeholder="留空则使用密钥"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    className="h-7 text-[12px] font-mono pr-7"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {showPassword ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                  </button>
                </div>
              </div>
              <div className="col-span-3 space-y-1">
                <Label className="text-[11px]">SSH 密钥路径</Label>
                <Input
                  placeholder="~/.ssh/id_rsa（可选）"
                  value={form.keyPath}
                  onChange={(e) => setForm({ ...form, keyPath: e.target.value })}
                  className="h-7 text-[12px] font-mono"
                />
              </div>
            </div>
            {/* Row 3: GPU 数量 + GPU 型号 */}
            <div className="grid grid-cols-4 gap-2">
              <div className="space-y-1">
                <Label className="text-[11px]">GPU 数量</Label>
                <Input
                  type="number"
                  min={0}
                  value={form.gpuCount}
                  onChange={(e) => setForm({ ...form, gpuCount: parseInt(e.target.value) || 0 })}
                  className="h-7 text-[12px]"
                />
              </div>
              <div className="col-span-3 space-y-1">
                <Label className="text-[11px]">GPU 型号（探测时自动获取）</Label>
                <Input
                  placeholder="RTX 4090 / A100 80G"
                  value={form.gpuModel}
                  onChange={(e) => setForm({ ...form, gpuModel: e.target.value })}
                  className="h-7 text-[12px]"
                />
              </div>
            </div>
            {/* Row 4: 备注 */}
            <div className="space-y-1">
              <Label className="text-[11px]">备注</Label>
              <Input
                placeholder="用于训练大模型，需提前预约使用"
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                className="h-7 text-[12px]"
              />
            </div>
          </div>
          {/* Test result */}
          {testResult && (
            <div
              className={cn(
                'rounded-md border px-3 py-2 text-[11px]',
                testResult.ok
                  ? 'border-green-500/30 bg-green-500/5 text-green-600'
                  : 'border-destructive/30 bg-destructive/5 text-destructive'
              )}
            >
              {testResult.message}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" className="h-7" onClick={() => { setDialogOpen(false); setTestResult(null) }}>
              取消
            </Button>
            {editingId ? (
              <Button size="sm" className="h-7" onClick={() => void handleSave()} disabled={!form.name || !form.host}>
                保存
              </Button>
            ) : (
              <Button
                size="sm"
                className="h-7"
                onClick={handleTestAndSave}
                disabled={!form.name || !form.host || testing}
              >
                {testing ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Zap className="h-3.5 w-3.5 mr-1" />}
                {testing ? '检测中...' : '检测并添加'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function formatTime(isoStr: string): string {
  try {
    const d = new Date(isoStr)
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}
