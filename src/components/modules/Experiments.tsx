import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  Plus,
  ChevronDown,
  ChevronRight,
  Clock,
  BarChart3,
  Trash2,
  Pencil,
  Server,
  X,
  FlaskConical,
  Sparkles
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { handoffToAgent } from '@/lib/agentContext'
import {
  type ExperimentRecord,
  type ExperimentStatus,
  type MetricChartRow,
  type MetricRow,
  STATUS_STYLE,
  STATUSES,
  barWidthPercents,
  chartNameLines,
  formatMetricValue,
  metricChartRows,
  metricRowsFromMetrics,
  metricsFromRows,
  numericMetricKeys,
  relativeTime
} from '@/lib/experiments'

/** 服务器下拉选项（来自 Servers 模块的 `servers:list`）。 */
interface ServerOption {
  id: string
  name: string
}

/** 条形图几何：bar 横跨 viewBox 的 x 132–268（340 宽）。 */
const CHART_WIDTH = 340
const CHART_BAR_X = 132
const CHART_BAR_MAX_WIDTH = 136
const CHART_ROW_HEIGHT = 26

/** 一个指标对比图：每个携带该指标数值的运行一条横条，最旧在上，宽度按最大值归一化。 */
function MetricChart({ metricKey, rows }: { metricKey: string; rows: readonly MetricChartRow[] }) {
  const widths = barWidthPercents(rows.map((row) => row.value))
  const height = rows.length * CHART_ROW_HEIGHT + 4
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <h4 className="mb-2 truncate text-[11px] font-semibold text-muted-foreground" title={metricKey}>
        {metricKey}
      </h4>
      <svg
        viewBox={`0 0 ${String(CHART_WIDTH)} ${String(height)}`}
        role="img"
        aria-label={metricKey}
        className="w-full"
      >
        {rows.map((row, index) => {
          const y = 2 + index * CHART_ROW_HEIGHT
          const [nameFirst, nameSecond] = chartNameLines(row.name)
          return (
            <g key={row.id}>
              <text
                x={0}
                y={nameSecond === undefined ? y + 15 : y + 10}
                fontSize={11}
                className="fill-muted-foreground"
              >
                <title>{row.name}</title>
                {nameFirst}
              </text>
              {nameSecond !== undefined && (
                <text x={0} y={y + 21} fontSize={11} className="fill-muted-foreground">
                  {nameSecond}
                </text>
              )}
              <rect
                x={CHART_BAR_X}
                y={y + 4}
                width={(widths[index] ?? 0) / 100 * CHART_BAR_MAX_WIDTH}
                height={14}
                rx={4}
                className={cn(
                  row.status === 'success' && 'fill-success',
                  row.status === 'failed' && 'fill-destructive',
                  row.status === 'running' && 'fill-primary'
                )}
              />
              <text
                x={CHART_BAR_X + CHART_BAR_MAX_WIDTH + 6}
                y={y + 15}
                fontSize={11}
                className="fill-foreground"
              >
                {formatMetricValue(row.value)}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

export function Experiments() {
  const [experiments, setExperiments] = useState<ExperimentRecord[]>([])
  const [servers, setServers] = useState<ServerOption[]>([])
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<ExperimentRecord | null>(null)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

  // 表单状态
  const [formName, setFormName] = useState('')
  const [formStatus, setFormStatus] = useState<ExperimentStatus>('running')
  const [formRows, setFormRows] = useState<MetricRow[]>([])
  const [formServerId, setFormServerId] = useState('')

  // 加载实验与服务器列表
  useEffect(() => {
    const load = async () => {
      try {
        if (window.electronAPI?.getStoreValue) {
          const [expData, serverData] = await Promise.all([
            window.electronAPI.getStoreValue<ExperimentRecord[]>('experiments:list'),
            window.electronAPI.getStoreValue<ServerOption[]>('servers:list')
          ])
          if (expData) setExperiments(expData)
          if (serverData) setServers(serverData.map((s) => ({ id: s.id, name: s.name })))
        } else {
          const cached = localStorage.getItem('mimir-experiments')
          if (cached) setExperiments(JSON.parse(cached))
          const serverCached = localStorage.getItem('mimir-servers')
          if (serverCached) {
            const parsed = JSON.parse(serverCached)
            setServers(parsed.map((s: ServerOption) => ({ id: s.id, name: s.name })))
          }
        }
      } catch {
        // ignore
      }
    }
    load()
  }, [])

  // 持久化实验列表
  const persistExperiments = useCallback(
    async (next: ExperimentRecord[]) => {
      const prev = experiments
      setExperiments(next)
      try {
        if (window.electronAPI?.setStoreValue) {
          await window.electronAPI.setStoreValue('experiments:list', next)
        } else {
          localStorage.setItem('mimir-experiments', JSON.stringify(next))
        }
        // 自动沉淀：新建实验 / 状态由 running 转为终态 → 记入科研记录（幂等按 实验 id+状态）
        const prevById = new Map(prev.map((e) => [e.id, e]))
        for (const exp of next) {
          const before = prevById.get(exp.id)
          const isNew = before === undefined
          const justFinished =
            before !== undefined &&
            before.status !== exp.status &&
            (exp.status === 'success' || exp.status === 'failed')
          if (!isNew && !justFinished) continue
          await window.electronAPI?.ledgerAppend?.({
            title: isNew ? `新建实验：${exp.name}` : `实验${exp.status === 'success' ? '成功' : '失败'}：${exp.name}`,
            content: `状态：${STATUS_STYLE[exp.status].label}`,
            type: 'experiment'
          })
        }
      } catch {
        // ignore
      }
    },
    [experiments]
  )

  const openCreate = useCallback(() => {
    setEditing(null)
    setFormName('')
    setFormStatus('running')
    setFormRows([])
    setFormServerId('')
    setDialogOpen(true)
  }, [])

  const openEdit = useCallback((record: ExperimentRecord) => {
    setEditing(record)
    setFormName(record.name)
    setFormStatus(record.status)
    setFormRows(metricRowsFromMetrics(record.metrics))
    setFormServerId(record.serverId ?? '')
    setDialogOpen(true)
  }, [])

  const patchRow = useCallback((index: number, patch: Partial<MetricRow>) => {
    setFormRows((prev) => prev.map((row, at) => (at === index ? { ...row, ...patch } : row)))
  }, [])

  const handleSave = useCallback(() => {
    const name = formName.trim()
    if (name === '') return
    const now = new Date().toISOString()
    if (editing) {
      const updated: ExperimentRecord = {
        ...editing,
        name,
        status: formStatus,
        metrics: metricsFromRows(formRows),
        serverId: formServerId === '' ? undefined : formServerId,
        updatedAt: now
      }
      persistExperiments(experiments.map((e) => (e.id === editing.id ? updated : e)))
    } else {
      const created: ExperimentRecord = {
        id: `exp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name,
        status: formStatus,
        metrics: metricsFromRows(formRows),
        serverId: formServerId === '' ? undefined : formServerId,
        updatedAt: now
      }
      persistExperiments([created, ...experiments])
    }
    setDialogOpen(false)
    setEditing(null)
  }, [editing, experiments, formName, formRows, formServerId, formStatus, persistExperiments])

  const handleDelete = useCallback(
    (id: string) => {
      if (!window.confirm('确定删除该实验吗？此操作不可撤销。')) return
      persistExperiments(experiments.filter((e) => e.id !== id))
      setExpandedIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    },
    [experiments, persistExperiments]
  )

  const handleRelink = useCallback(
    (id: string, serverId: string) => {
      const updated = experiments.map((e) =>
        e.id === id ? { ...e, serverId: serverId === '' ? undefined : serverId, updatedAt: new Date().toISOString() } : e
      )
      persistExperiments(updated)
    },
    [experiments, persistExperiments]
  )

  const toggleCard = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const serverNameOf = useCallback(
    (id: string): string => servers.find((s) => s.id === id)?.name ?? id,
    [servers]
  )

  /** 把实验记录作为上下文交给 Agent：名称/状态/指标/关联服务器。 */
  const handleHandoffToAgent = useCallback(
    (exp: ExperimentRecord) => {
      const metricLines = Object.entries(exp.metrics)
        .map(([k, v]) => `- ${k}: ${formatMetricValue(v)}`)
        .join('\n')
      const excerpt = [
        `实验名称：${exp.name}`,
        `状态：${STATUS_STYLE[exp.status].label}`,
        exp.serverId !== undefined ? `服务器：${serverNameOf(exp.serverId)}` : '',
        metricLines !== '' ? `指标：\n${metricLines}` : '',
        `最近更新：${exp.updatedAt}`
      ]
        .filter((line) => line !== '')
        .join('\n')
      handoffToAgent({
        kind: 'experiment',
        refId: exp.id,
        title: exp.name,
        excerpt,
        meta: { status: exp.status, metrics: exp.metrics }
      })
    },
    [serverNameOf]
  )


  const chartKeys = numericMetricKeys(experiments)
  const runningCount = experiments.filter((e) => e.status === 'running').length

  return (
    <div className="flex h-full flex-col">
      <div className="module-header">
        <div className="flex items-center gap-3">
          <span className="module-title">实验管理</span>
          <span className="text-[11px] text-muted-foreground">
            {experiments.length} 个实验 · {runningCount} 训练中
          </span>
        </div>
        <Button size="sm" variant="outline" className="h-7" onClick={openCreate}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          新建实验
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-3 space-y-3">
        {/* 指标对比图 */}
        {chartKeys.length > 0 && (
          <div>
            <h3 className="mb-2 text-[11px] font-semibold text-muted-foreground">指标对比</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2.5">
              {chartKeys.map((key) => (
                <MetricChart key={key} metricKey={key} rows={metricChartRows(experiments, key)} />
              ))}
            </div>
          </div>
        )}

        {/* 实验列表 */}
        {experiments.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <FlaskConical className="h-8 w-8 opacity-30 mb-2" />
            <p className="text-[12px] font-medium">暂无实验</p>
            <p className="text-[11px] mt-0.5 opacity-70">点击右上角新建实验，记录训练指标与结果</p>
          </div>
        ) : (
          experiments.map((exp) => {
            const config = STATUS_STYLE[exp.status]
            const isExpanded = expandedIds.has(exp.id)
            const entries = Object.entries(exp.metrics)
            return (
              <div
                key={exp.id}
                className="rounded-lg border border-border bg-card hover:shadow-sm transition-shadow"
              >
                <div className="p-3">
                  <div className="flex items-start justify-between">
                    <div
                      className="flex items-center gap-3 cursor-pointer flex-1 min-w-0"
                      onClick={() => toggleCard(exp.id)}
                    >
                      <div className="text-muted-foreground">
                        {isExpanded ? (
                          <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" />
                        )}
                      </div>
                      <div className="flex h-8 w-8 items-center justify-center rounded-md bg-muted shrink-0">
                        <FlaskConical className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className="font-medium text-[13px] truncate">{exp.name}</h3>
                          <span className={cn('status-dot', config.color)} />
                          <span className={cn('text-[10px] font-medium shrink-0', config.textColor)}>
                            {config.label}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-muted-foreground">
                          <span className="flex items-center gap-0.5">
                            <Clock className="h-2.5 w-2.5" />
                            {relativeTime(exp.updatedAt)}
                          </span>
                          {exp.serverId !== undefined && (
                            <span className="flex items-center gap-0.5">
                              <Server className="h-2.5 w-2.5" />
                              {serverNameOf(exp.serverId)}
                            </span>
                          )}
                          {entries.length > 0 && (
                            <span className="flex items-center gap-0.5">
                              <BarChart3 className="h-2.5 w-2.5" />
                              {entries.length} 项指标
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-0.5 shrink-0 ml-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleHandoffToAgent(exp)
                        }}
                        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-primary transition-colors"
                        title="交给 Agent（在对话中引用本次实验）"
                      >
                        <Sparkles className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          openEdit(exp)
                        }}
                        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted transition-colors"
                        title="编辑"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDelete(exp.id)
                        }}
                        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                        title="删除"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* 展开内容 */}
                  {isExpanded && (
                    <div className="mt-3 space-y-2.5 border-t border-border pt-2.5">
                      {entries.length > 0 ? (
                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                          {entries.map(([key, value]) => (
                            <div key={key} className="rounded-md bg-muted/50 p-2">
                              <div className="metric-label">{key}</div>
                              <div className="text-[14px] font-semibold mt-0.5 tabular-nums">
                                {formatMetricValue(value)}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-[11px] text-muted-foreground">暂无指标数据</p>
                      )}

                      {/* 服务器关联 */}
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-muted-foreground shrink-0">关联服务器</span>
                        <Select
                          value={exp.serverId ?? ''}
                          onValueChange={(value) => handleRelink(exp.id, value)}
                        >
                          <SelectTrigger className="h-7 w-44 text-[11px]">
                            <SelectValue placeholder="未关联" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="" className="text-[11px]">
                              未关联
                            </SelectItem>
                            {servers.map((server) => (
                              <SelectItem key={server.id} value={server.id} className="text-[11px]">
                                {server.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* 新建 / 编辑实验 Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? '编辑实验' : '新建实验'}</DialogTitle>
            <DialogDescription>
              {editing ? '修改实验名称、状态、指标与关联服务器。' : '创建一条实验记录，跟踪训练指标与结果。'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {/* 名称 + 状态 */}
            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-2 space-y-1">
                <Label className="text-[11px]">实验名称 *</Label>
                <Input
                  placeholder="如：ResNet-50 Fine-tuning"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  className="h-7 text-[12px]"
                  autoFocus
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">状态</Label>
                <Select value={formStatus} onValueChange={(v) => setFormStatus(v as ExperimentStatus)}>
                  <SelectTrigger className="h-7 text-[12px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUSES.map((status) => (
                      <SelectItem key={status} value={status} className="text-[12px]">
                        {STATUS_STYLE[status].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* 指标动态行 */}
            <div className="space-y-1">
              <Label className="text-[11px]">指标（key / value）</Label>
              <div className="space-y-1.5">
                {formRows.map((row, index) => (
                  <div key={index} className="flex items-center gap-1.5">
                    <Input
                      placeholder="指标名，如 accuracy"
                      value={row.key}
                      onChange={(e) => patchRow(index, { key: e.target.value })}
                      className="h-7 flex-1 text-[12px] font-mono"
                    />
                    <Input
                      placeholder="数值，如 92.1"
                      value={row.value}
                      onChange={(e) => patchRow(index, { value: e.target.value })}
                      className="h-7 flex-1 text-[12px] font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setFormRows((prev) => prev.filter((_, at) => at !== index))}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                      title="删除该指标"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-[11px]"
                  onClick={() => setFormRows((prev) => [...prev, { key: '', value: '' }])}
                >
                  <Plus className="h-3 w-3 mr-1" />
                  添加指标
                </Button>
              </div>
            </div>

            {/* 服务器关联 */}
            <div className="space-y-1">
              <Label className="text-[11px]">关联服务器（可选）</Label>
              <Select value={formServerId} onValueChange={setFormServerId}>
                <SelectTrigger className="h-7 text-[12px]">
                  <SelectValue placeholder="未关联" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="" className="text-[12px]">
                    未关联
                  </SelectItem>
                  {servers.map((server) => (
                    <SelectItem key={server.id} value={server.id} className="text-[12px]">
                      {server.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              onClick={() => {
                setDialogOpen(false)
                setEditing(null)
              }}
            >
              取消
            </Button>
            <Button size="sm" className="h-7" onClick={handleSave} disabled={!formName.trim()}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}