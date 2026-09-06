import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { History, Loader2, RotateCcw, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface SnapshotFile {
  path: string
  sizeBytes: number
}

interface SnapshotMeta {
  id: string
  createdAt: string
  files: SnapshotFile[]
}

type DiffRow = { type: 'same' | 'del' | 'add'; text: string }

/** 简化行 diff：修剪公共前后缀，中间段做粗粒度对齐。 */
function diffLines(before: string, after: string): DiffRow[] {
  const a = before.split('\n')
  const b = after.split('\n')
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1
  }
  const rows: DiffRow[] = []
  for (let i = 0; i < head; i += 1) rows.push({ type: 'same', text: a[i] ?? '' })
  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)
  const n = Math.min(midA.length, midB.length)
  // 尽力对齐相同行，其余视为删除/新增
  for (let i = 0; i < n; i += 1) {
    const left = midA[i]
    const right = midB[i]
    if (left === right) rows.push({ type: 'same', text: left ?? '' })
    else {
      rows.push({ type: 'del', text: left ?? '' })
      rows.push({ type: 'add', text: right ?? '' })
    }
  }
  if (midA.length > midB.length) {
    for (let i = midB.length; i < midA.length; i += 1) rows.push({ type: 'del', text: midA[i] ?? '' })
  } else {
    for (let i = midA.length; i < midB.length; i += 1) rows.push({ type: 'add', text: midB[i] ?? '' })
  }
  for (let i = a.length - tail; i < a.length; i += 1) rows.push({ type: 'same', text: a[i] ?? '' })
  return rows
}

interface SnapshotsDialogProps {
  projectDir: string
  onClose: () => void
  /** 回退成功后通知父级从磁盘重载打开文件。 */
  onReverted: () => void
}

export function SnapshotsDialog({ projectDir, onClose, onReverted }: SnapshotsDialogProps) {
  const api = window.electronAPI
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [diffRows, setDiffRows] = useState<DiffRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const loadList = useCallback(async () => {
    if (!api?.snapshots) return
    setLoading(true)
    try {
      const res = await api.snapshots.list(projectDir)
      if (res.ok && res.snapshots) setSnapshots(res.snapshots)
      else setError(res.message ?? '读取快照失败')
    } catch {
      setError('读取快照失败')
    } finally {
      setLoading(false)
    }
  }, [api, projectDir])

  useEffect(() => {
    void loadList()
  }, [loadList])

  const showDiff = useCallback(
    async (id: string) => {
      if (!api?.snapshots) return
      setError(null)
      setNotice(null)
      setSelectedId(id)
      try {
        // 对比 main.tex：快照内容 vs 当前磁盘内容
        const [snapRes, currentRes] = await Promise.all([
          api.snapshots.read(projectDir, id, 'main.tex'),
          api.latex.readFile(projectDir, 'main.tex')
        ])
        if (!snapRes.ok) {
          setDiffRows([])
          setError(snapRes.message ?? '读取快照内容失败')
          return
        }
        const before = snapRes.content ?? ''
        const after = currentRes.ok && currentRes.content !== undefined ? currentRes.content : ''
        setDiffRows(diffLines(before, after))
      } catch {
        setError('读取差异失败')
      }
    },
    [api, projectDir]
  )

  const handleRevert = useCallback(
    async (id: string) => {
      if (!api?.snapshots) return
      if (!window.confirm('确定回退到该快照吗？当前项目中的 .tex/.bib 将被覆盖。')) return
      setBusyId(id)
      setError(null)
      setNotice(null)
      try {
        const res = await api.snapshots.revert(projectDir, id)
        if (res.ok) {
          setNotice(`已回退 ${String(res.restored ?? 0)} 个文件，请从磁盘重新载入编辑区查看`)
          onReverted()
        } else {
          setError(res.message ?? '回退失败')
        }
      } catch {
        setError('回退失败')
      } finally {
        setBusyId(null)
      }
    },
    [api, projectDir, onReverted]
  )

  const handleDelete = useCallback(
    async (id: string) => {
      if (!api?.snapshots) return
      if (!window.confirm('确定删除这份快照吗？')) return
      setBusyId(id)
      setError(null)
      try {
        const res = await api.snapshots.remove(projectDir, id)
        if (res.ok) {
          if (selectedId === id) {
            setSelectedId(null)
            setDiffRows([])
          }
          await loadList()
        } else {
          setError(res.message ?? '删除失败')
        }
      } catch {
        setError('删除失败')
      } finally {
        setBusyId(null)
      }
    },
    [api, projectDir, selectedId, loadList]
  )

  const formatDate = (iso: string): string => {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString('zh-CN', { hour12: false })
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>编译快照</DialogTitle>
          <DialogDescription>
            每次编译成功后自动拍摄当前论文目录的全部 .tex/.bib（内容无变化时跳过）。可对比 main.tex 并回退。
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-3 min-h-0 flex-1">
          {/* 快照列表 */}
          <div className="space-y-1 overflow-y-auto max-h-80 border rounded-md border-border p-1.5">
            {loading ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : snapshots.length === 0 ? (
              <p className="px-2 py-6 text-center text-[11px] text-muted-foreground">暂无快照（编译成功后自动生成）</p>
            ) : (
              snapshots.map((snapshot) => (
                <div
                  key={snapshot.id}
                  className={cn(
                    'group rounded-md border px-2 py-1.5 transition-colors',
                    selectedId === snapshot.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
                  )}
                >
                  <button className="w-full text-left" onClick={() => showDiff(snapshot.id)}>
                    <p className="flex items-center gap-1 text-[11px] text-foreground">
                      <History className="h-3 w-3 shrink-0 text-muted-foreground" />
                      {formatDate(snapshot.createdAt)}
                    </p>
                    <p className="text-[10px] text-muted-foreground">{snapshot.files.length} 个文件</p>
                  </button>
                  <div className="mt-1 flex gap-1">
                    <button
                      onClick={() => handleRevert(snapshot.id)}
                      disabled={busyId === snapshot.id}
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
                      title="回退到该快照"
                    >
                      <RotateCcw className="h-3 w-3" />
                      回退
                    </button>
                    <button
                      onClick={() => handleDelete(snapshot.id)}
                      disabled={busyId === snapshot.id}
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      title="删除快照"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* 差异区 */}
          <div className="flex min-h-0 flex-col overflow-hidden rounded-md border border-border">
            <div className="border-b border-border bg-muted/40 px-2 py-1 text-[10px] font-medium text-muted-foreground">
              main.tex · 当前 vs {selectedId === null ? '—' : formatDate(snapshots.find((s) => s.id === selectedId)?.createdAt ?? '')}
            </div>
            <div className="flex-1 overflow-y-auto font-mono text-[10px] leading-4 p-1.5 space-y-0 max-h-80">
              {selectedId === null ? (
                <p className="px-2 py-6 text-center text-muted-foreground">选择左侧快照查看差异</p>
              ) : diffRows.length === 0 ? (
                <p className="px-2 py-6 text-center text-muted-foreground">两版内容一致，无差异</p>
              ) : (
                diffRows.map((row, index) => (
                  <div
                    key={index}
                    className={cn(
                      'whitespace-pre-wrap break-all',
                      row.type === 'del' && 'bg-destructive/10 text-destructive',
                      row.type === 'add' && 'bg-success/10 text-success',
                      row.type === 'same' && 'text-muted-foreground/70'
                    )}
                  >
                    <span className="select-none pr-1 text-muted-foreground/50">{row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '}</span>
                    {row.text}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {error !== null && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">{error}</div>
        )}
        {notice !== null && (
          <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-[11px] text-primary">{notice}</div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" className="h-7" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
