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
import { Loader2, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'

interface VenueTemplate {
  id: string
  name: string
  series: string
  url: string
  checklist: string
}

interface VenueTemplateDialogProps {
  projectDir: string
  onClose: () => void
  onChanged: () => void
}

export function VenueTemplateDialog({ projectDir, onClose, onChanged }: VenueTemplateDialogProps) {
  const api = window.electronAPI
  const [templates, setTemplates] = useState<VenueTemplate[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      if (!api?.paper) return
      try {
        const res = await api.paper.venueTemplates()
        if (alive && res.ok && res.templates) {
          setTemplates(res.templates)
          if (res.templates.length > 0) setSelectedId(res.templates[0]!.id)
        } else if (alive) {
          setError(res.message ?? '读取模板失败')
        }
      } finally {
        if (alive) setLoading(false)
      }
    }
    void load()
    return () => {
      alive = false
    }
  }, [api])

  const selected = templates.find((t) => t.id === selectedId) ?? null

  const handleApply = useCallback(async () => {
    if (!api?.paper || selected === null) return
    if (!window.confirm('将在项目目录写入 template/TEMPLATE.md（如已存在会被覆盖），确定继续？')) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const res = await api.paper.applyVenueTemplate(projectDir, selected.id)
      if (res.ok) {
        setNotice(`已写入 ${res.path ?? 'template/TEMPLATE.md'}`)
        onChanged()
      } else {
        setError(res.message ?? '应用失败')
      }
    } finally {
      setBusy(false)
    }
  }, [api, projectDir, selected, onChanged])

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>会议排版模板</DialogTitle>
          <DialogDescription>
            把所选会议/期刊的官方排版要点写入 <span className="font-mono text-[11px]">template/TEMPLATE.md</span>，
            写作与提交前对照核对。
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-[180px_1fr] gap-3 min-h-0">
          <div className="space-y-1 overflow-y-auto max-h-72 rounded-md border border-border p-1.5">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : (
              templates.map((template) => (
                <button
                  key={template.id}
                  onClick={() => setSelectedId(template.id)}
                  className={cn(
                    'w-full rounded border px-2 py-1.5 text-left transition-colors',
                    selectedId === template.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
                  )}
                >
                  <p className="text-[11px] font-medium text-foreground">{template.name}</p>
                  <p className="text-[9px] text-muted-foreground">{template.series}</p>
                </button>
              ))
            )}
          </div>

          <div className="flex flex-col gap-2 overflow-y-auto max-h-72 rounded-md border border-border p-2.5">
            {selected === null ? (
              <p className="py-6 text-center text-[11px] text-muted-foreground">选择左侧模板</p>
            ) : (
              <>
                <div className="flex items-center gap-1.5">
                  <FileText className="h-3.5 w-3.5 text-primary" />
                  <span className="text-[12px] font-semibold">{selected.name}</span>
                </div>
                <a href={selected.url} target="_blank" rel="noreferrer" className="break-all text-[10px] text-primary hover:underline">
                  {selected.url}
                </a>
                <ul className="space-y-1">
                  {selected.checklist.split('\n').map((item, index) => (
                    <li key={index} className="flex gap-1.5 text-[11px] text-muted-foreground">
                      <span className="text-primary">-</span>
                      {item}
                    </li>
                  ))}
                </ul>
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
          <Button size="sm" className="h-7" onClick={handleApply} disabled={selected === null || busy || loading}>
            {busy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
            应用模板
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
