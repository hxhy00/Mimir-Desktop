import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { Loader2, Plus, Trash2, X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface BibEntry {
  key: string
  type: string
  fields: Record<string, string>
}

interface BibDialogProps {
  projectDir: string
  onClose: () => void
  onChanged: () => void
}

export function BibDialog({ projectDir, onClose, onChanged }: BibDialogProps) {
  const api = window.electronAPI
  const [entries, setEntries] = useState<BibEntry[]>([])
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [rows, setRows] = useState<{ k: string; v: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const active = entries.find((e) => e.key === activeKey) ?? null

  useEffect(() => {
    let alive = true
    const load = async () => {
      if (!api?.paper) return
      setLoading(true)
      try {
        const res = await api.paper.bibRead(projectDir)
        if (alive) {
          if (res.ok && res.entries) {
            setEntries(res.entries)
            if (res.entries.length > 0) setActiveKey(res.entries[0]!.key)
          } else {
            setError(res.message ?? '读取失败')
          }
        }
      } finally {
        if (alive) setLoading(false)
      }
    }
    void load()
    return () => {
      alive = false
    }
  }, [api, projectDir])

  const selectEntry = useCallback((key: string) => {
    const entry = entries.find((e) => e.key === key)
    if (entry === undefined) return
    setActiveKey(key)
    setRows(Object.entries(entry.fields).map(([k, v]) => ({ k, v })))
  }, [entries])

  useEffect(() => {
    if (active !== null && rows.length === 0) {
      setRows(Object.entries(active.fields).map(([k, v]) => ({ k, v })))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey])

  const applyRowsToActive = useCallback((): void => {
    if (active === null) return
    const fields: Record<string, string> = {}
    for (const row of rows) {
      if (row.k.trim() !== '') fields[row.k.trim()] = row.v
    }
    setEntries((prev) => prev.map((e) => (e.key === active.key ? { ...e, fields } : e)))
  }, [active, rows])

  const handleAdd = useCallback(() => {
    applyRowsToActive()
    const count = entries.filter((e) => e.key.startsWith('new')).length + 1
    const key = `new-key-${count}`
    const entry: BibEntry = { key, type: 'article', fields: {} }
    setEntries((prev) => [...prev, entry])
    setActiveKey(key)
    setRows([])
  }, [entries, applyRowsToActive])

  const handleRemove = useCallback(
    (key: string) => {
      if (!window.confirm(`删除条目 ${key} 吗？`)) return
      const next = entries.filter((e) => e.key !== key)
      setEntries(next)
      setActiveKey(next[0]?.key ?? null)
      setRows([])
    },
    [entries]
  )

  const handleSave = useCallback(async () => {
    if (!api?.paper) return
    applyRowsToActive()
    setSaving(true)
    setError(null)
    setNotice(null)
    const keys = new Set<string>()
    let dup = ''
    for (const entry of entries) {
      if (keys.has(entry.key)) dup = entry.key
      keys.add(entry.key)
    }
    if (dup !== '') {
      setError(`存在重复的引用键：${dup}`)
      setSaving(false)
      return
    }
    try {
      const res = await api.paper.bibWrite(projectDir, entries)
      if (res.ok) {
        setNotice('已保存到 references.bib')
        onChanged()
      } else {
        setError(res.message ?? '保存失败')
      }
    } finally {
      setSaving(false)
    }
  }, [api, projectDir, entries, applyRowsToActive, onChanged])

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>参考文献（references.bib）</DialogTitle>
          <DialogDescription>
            结构化编辑项目目录下的 references.bib 条目（解析 / 序列化均为本地实现）。
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-3 min-h-0">
          {/* 条目列表 */}
          <div className="overflow-y-auto max-h-72 rounded-md border border-border p-1.5 space-y-1">
            {loading ? (
              <div className="flex items-center justify-center py-8"><Loader2 className="h-4 w-4 animate-spin" /></div>
            ) : entries.length === 0 ? (
              <p className="px-2 py-6 text-center text-[11px] text-muted-foreground">暂无条目</p>
            ) : (
              entries.map((entry) => (
                <div key={entry.key} className={cn('group rounded border px-2 py-1', activeKey === entry.key ? 'border-primary bg-primary/5' : 'border-border')}>
                  <button className="w-full text-left" onClick={() => selectEntry(entry.key)}>
                    <p className="font-mono text-[10px] text-foreground truncate">{entry.key}</p>
                    <p className="text-[9px] text-muted-foreground">{entry.type}</p>
                  </button>
                  <button
                    onClick={() => handleRemove(entry.key)}
                    className="mt-0.5 flex items-center gap-0.5 text-[9px] text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-2.5 w-2.5" /> 删除
                  </button>
                </div>
              ))
            )}
            <button
              onClick={handleAdd}
              disabled={loading}
              className="flex w-full items-center justify-center gap-1 rounded border border-dashed border-border py-1 text-[10px] text-muted-foreground hover:bg-accent"
            >
              <Plus className="h-3 w-3" /> 新增条目
            </button>
          </div>

          {/* 编辑器 */}
          <div className="flex flex-col rounded-md border border-border p-2 space-y-2 overflow-y-auto max-h-72">
            {active === null ? (
              <p className="py-6 text-center text-[11px] text-muted-foreground">选择或新增条目进行编辑</p>
            ) : (
              <>
                <div className="grid grid-cols-[1fr_120px] gap-1.5">
                  <Input
                    value={active.key}
                    onChange={(e) => setEntries((prev) => prev.map((item) => (item.key === active.key ? { ...item, key: e.target.value } : item)))}
                    className="h-7 font-mono text-[11px]"
                    placeholder="引用键"
                  />
                  <Input
                    value={active.type}
                    onChange={(e) => setEntries((prev) => prev.map((item) => (item.key === active.key ? { ...item, type: e.target.value } : item)))}
                    className="h-7 font-mono text-[11px]"
                    placeholder="类型（article…）"
                  />
                </div>
                <div className="space-y-1">
                  {rows.map((row, index) => (
                    <div key={index} className="flex items-center gap-1.5">
                      <Input
                        value={row.k}
                        onChange={(e) => setRows((prev) => prev.map((r, i) => (i === index ? { ...r, k: e.target.value } : r)))}
                        className="h-6 w-28 shrink-0 font-mono text-[10px]"
                        placeholder="字段"
                      />
                      <Input
                        value={row.v}
                        onChange={(e) => setRows((prev) => prev.map((r, i) => (i === index ? { ...r, v: e.target.value } : r)))}
                        className="h-6 flex-1 font-mono text-[10px]"
                        placeholder="值（{} 内可含 LaTeX）"
                      />
                      <button
                        onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))}
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() => setRows((prev) => [...prev, { k: '', v: '' }])}
                    className="flex items-center gap-1 rounded border border-dashed border-border px-2 py-1 text-[10px] text-muted-foreground hover:bg-accent"
                  >
                    <Plus className="h-3 w-3" /> 添加字段
                  </button>
                </div>
              </>
            )}
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
          <Button size="sm" className="h-7" onClick={handleSave} disabled={loading || saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
