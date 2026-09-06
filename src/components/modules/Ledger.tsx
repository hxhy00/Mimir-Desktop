import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Plus, FileText, Milestone, BookOpen, Beaker, Clock, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface LedgerEntry {
  id: string
  title: string
  content: string
  type: 'milestone' | 'progress' | 'paper' | 'experiment'
  date: string
}

const TYPE_CONFIG = {
  milestone: { label: '里程碑', icon: Milestone, dotColor: 'bg-amber-500' },
  progress: { label: '进展', icon: FileText, dotColor: 'bg-blue-500' },
  paper: { label: '论文', icon: BookOpen, dotColor: 'bg-success' },
  experiment: { label: '实验', icon: Beaker, dotColor: 'bg-purple-500' }
}

const STORAGE_KEY = 'ledger:entries'

function todayYmd(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

async function readEntries(): Promise<LedgerEntry[] | null> {
  try {
    if (window.electronAPI?.getStoreValue) {
      const data = await window.electronAPI.getStoreValue<LedgerEntry[]>(STORAGE_KEY)
      return Array.isArray(data) ? data : null
    }
    const cached = localStorage.getItem('mimir-ledger')
    if (cached) {
      const parsed: unknown = JSON.parse(cached)
      return Array.isArray(parsed) ? (parsed as LedgerEntry[]) : null
    }
    return null
  } catch {
    return null
  }
}

async function persistEntries(entries: LedgerEntry[]): Promise<void> {
  try {
    if (window.electronAPI?.setStoreValue) {
      await window.electronAPI.setStoreValue(STORAGE_KEY, entries)
    } else {
      localStorage.setItem('mimir-ledger', JSON.stringify(entries))
    }
  } catch {
    // ignore
  }
}

export function Ledger() {
  const [entries, setEntries] = useState<LedgerEntry[]>([])
  const [hydrated, setHydrated] = useState(false)
  const [showDialog, setShowDialog] = useState(false)
  const [newEntry, setNewEntry] = useState({ title: '', content: '', type: 'progress' as keyof typeof TYPE_CONFIG })

  // 启动时加载已有记录
  useEffect(() => {
    let alive = true
    readEntries()
      .then((list) => {
        if (alive && list !== null) setEntries(list)
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setHydrated(true)
      })
    return () => {
      alive = false
    }
  }, [])

  // 变化即持久化
  useEffect(() => {
    if (!hydrated) return
    void persistEntries(entries)
  }, [entries, hydrated])

  const handleAdd = () => {
    if (!newEntry.title.trim()) return
    setEntries((prev) => [
      {
        id: `entry-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        title: newEntry.title.trim(),
        content: newEntry.content.trim(),
        type: newEntry.type,
        date: todayYmd()
      },
      ...prev
    ])
    setNewEntry({ title: '', content: '', type: 'progress' })
    setShowDialog(false)
  }

  const handleDelete = useCallback((id: string) => {
    if (!window.confirm('确定删除这条记录吗？此操作不可恢复。')) return
    setEntries((prev) => prev.filter((e) => e.id !== id))
  }, [])

  return (
    <div className="flex h-full flex-col">
      <div className="module-header">
        <span className="module-title">成长记录</span>
        <Button size="sm" variant="outline" className="h-7" onClick={() => setShowDialog(true)}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          添加
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-3">
        <div className="relative">
          <div className="absolute left-[7px] top-0 bottom-0 w-px bg-border" />

          <div className="space-y-2">
            {entries.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
                <Clock className="h-8 w-8 opacity-30 mb-2" />
                <p className="text-[12px] font-medium">暂无记录</p>
                <p className="text-[11px] mt-0.5 opacity-70">记录你的研究进展和重要里程碑</p>
                <Button variant="outline" size="sm" className="mt-3 h-7" onClick={() => setShowDialog(true)}>
                  <Plus className="h-3 w-3 mr-1" />
                  添加第一条记录
                </Button>
              </div>
            ) : (
              entries.map((entry) => {
                const config = TYPE_CONFIG[entry.type]
                return (
                  <div key={entry.id} className="ml-5 relative">
                    <div className={cn('absolute -left-[18px] top-3 h-2.5 w-2.5 rounded-full border-2 border-background z-10', config.dotColor)} />
                    <div className="group rounded-lg border border-border bg-card p-3 hover:shadow-sm transition-shadow">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="font-medium text-[13px]">{entry.title}</h3>
                            <span className="text-[10px] text-muted-foreground">{entry.date}</span>
                          </div>
                          {entry.content && (
                            <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">{entry.content}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <span className="text-[10px] text-muted-foreground">{config.label}</span>
                          <button
                            onClick={() => handleDelete(entry.id)}
                            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                            title="删除"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      </div>

      {/* Add Entry Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>添加记录</DialogTitle>
            <DialogDescription>记录研究进展或重要里程碑。</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-[11px]">标题</Label>
              <Input
                placeholder="如：完成文献调研"
                value={newEntry.title}
                onChange={(e) => setNewEntry({ ...newEntry, title: e.target.value })}
                className="h-8 text-[13px]"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px]">类型</Label>
              <div className="flex gap-1.5 flex-wrap">
                {(Object.keys(TYPE_CONFIG) as Array<keyof typeof TYPE_CONFIG>).map((type) => {
                  const cfg = TYPE_CONFIG[type]
                  return (
                    <button
                      key={type}
                      onClick={() => setNewEntry({ ...newEntry, type })}
                      className={cn(
                        'flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] transition-colors',
                        newEntry.type === type
                          ? 'border-primary/30 bg-primary/5 text-primary font-medium'
                          : 'border-border text-muted-foreground hover:bg-accent'
                      )}
                    >
                      <cfg.icon className="h-3 w-3" />
                      {cfg.label}
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px]">详细内容</Label>
              <Textarea
                placeholder="记录具体内容..."
                value={newEntry.content}
                onChange={(e) => setNewEntry({ ...newEntry, content: e.target.value })}
                rows={3}
                className="text-[12px]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" className="h-7" onClick={() => setShowDialog(false)}>
              取消
            </Button>
            <Button size="sm" className="h-7" onClick={handleAdd} disabled={!newEntry.title.trim()}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
