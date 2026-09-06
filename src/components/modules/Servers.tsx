import { useState, useEffect, useCallback } from 'react'
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

  // Load servers from store
  useEffect(() => {
    const loadServers = async () => {
      try {
        if (window.electronAPI?.getStoreValue) {
          const data = await window.electronAPI.getStoreValue<GpuServer[]>('servers:list')
          if (data) setServers(data)
        } else {
          const cached = localStorage.getItem('mimir-servers')
          if (cached) setServers(JSON.parse(cached))
        }
      } catch {
        // ignore
      }
    }
    loadServers()
  }, [])

  // Persist servers
  const persistServers = useCallback(async (next: GpuServer[]) => {
    setServers(next)
    try {
      if (window.electronAPI?.setStoreValue) {
        await window.electronAPI.setStoreValue('servers:list', next)
      } else {
        localStorage.setItem('mimir-servers', JSON.stringify(next))
      }
    } catch {
      // ignore
    }
  }, [])

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

  const handleSave = useCallback(() => {
    if (!form.name || !form.host) return

    if (editingId) {
      const updatedServer: GpuServer = {
        ...servers.find((s) => s.id === editingId)!,
        name: form.name,
        host: form.host,
        port: form.port,
        user: form.user,
        password: form.password || undefined,
        keyPath: form.keyPath || undefined,
        gpuCount: form.gpuCount,
        gpuModel: form.gpuModel || '未知',
        notes: form.notes
      }
      const updated = servers.map((s) => (s.id === editingId ? updatedServer : s))
      setServers(updated)
      persistServers(updated)
    } else {
      const newServer: GpuServer = {
        id: `srv-${Date.now()}`,
        name: form.name,
        host: form.host,
        port: form.port,
        user: form.user,
        password: form.password || undefined,
        keyPath: form.keyPath || undefined,
        gpuCount: form.gpuCount,
        gpuModel: form.gpuModel || '未知',
        status: 'offline',
        gpus: [],
        notes: form.notes
      }
      const updated = [...servers, newServer]
      setServers(updated)
      persistServers(updated)
    }
    setDialogOpen(false)
    setForm(EMPTY_FORM)
    setEditingId(null)
    setTestResult(null)
  }, [editingId, form, servers, persistServers])

  // Probe connectivity before saving (used on add)
  const handleTestAndSave = useCallback(async () => {
    if (!form.name || !form.host) return
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
        // Online — save with detected GPU info
        const newServer: GpuServer = {
          id: `srv-${Date.now()}`,
          name: form.name,
          host: form.host,
          port: form.port,
          user: form.user,
          password: form.password || undefined,
          keyPath: form.keyPath || undefined,
          gpuCount: result.gpus.length > 0 ? result.gpus.length : form.gpuCount,
          gpuModel: result.gpus[0]?.name || form.gpuModel || '未知',
          status: 'online',
          gpus: result.gpus || [],
          notes: form.notes,
          lastChecked: new Date().toISOString()
        }
        const updated = [...servers, newServer]
        setServers(updated)
        persistServers(updated)
        setDialogOpen(false)
        setForm(EMPTY_FORM)
        setTestResult(null)
        setTestResult({ ok: true, message: '连接成功，服务器已添加' })
      } else {
        // Browser fallback: just save
        handleSave()
      }
    } catch (error) {
      setTestResult({ ok: false, message: error instanceof Error ? error.message : '连接失败' })
    } finally {
      setTesting(false)
    }
  }, [form, servers, persistServers, handleSave])

  const handleDelete = useCallback(
    (id: string) => {
      if (terminalId === id) setTerminalId(null)
      const updated = servers.filter((s) => s.id !== id)
      setServers(updated)
      persistServers(updated)
      setExpandedCards((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    },
    [terminalId, servers, persistServers]
  )

  const handleProbe = useCallback(
    async (server: GpuServer, e: React.MouseEvent) => {
      e.stopPropagation()
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
          }
          const updated = servers.map((s) => (s.id === server.id ? updatedServer : s))
          setServers(updated)
          persistServers(updated)
        }
      } catch {
        // If probe not available in browser, just toggle
        const updated = servers.map((s) =>
          s.id === server.id
            ? { ...s, status: s.status === 'online' ? 'offline' as const : 'online' as const }
            : s
        )
        setServers(updated)
        persistServers(updated)
      } finally {
        setProbing((prev) => ({ ...prev, [server.id]: false }))
      }
    },
    [servers, persistServers]
  )

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
                              server.status === 'online' ? 'bg-success' : 'bg-muted-foreground/30'
                            )}
                          />
                          <span className="text-[10px] text-muted-foreground shrink-0">
                            {server.status === 'online' ? '在线' : '离线'}
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
                          <div className="rounded-b-md border border-border overflow-hidden">
                            <Terminal
                              id={`terminal-${server.id}`}
                              className="h-[300px] bg-[#1e1e1e]"
                              ssh={{
                                host: selectedServer.host,
                                port: selectedServer.port,
                                user: selectedServer.user,
                                keyPath: selectedServer.keyPath || undefined
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
              <Button size="sm" className="h-7" onClick={handleSave} disabled={!form.name || !form.host}>
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
