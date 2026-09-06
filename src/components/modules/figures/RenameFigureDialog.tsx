import { useCallback, useEffect, useMemo, useState } from 'react'
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
import { Loader2, Search, Check } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Figure {
  id: string
  name: string
  fileName: string
  sizeBytes: number
  createdAt: string
}

interface RenameUsage {
  dir: string
  file: string
  count: number
}

interface RenameFigureDialogProps {
  figure: Figure
  onClose: () => void
  onDone: () => void
}

/** 带 LaTeX 引用同步预览/确认的图片改名对话框。 */
export function RenameFigureDialog({ figure, onClose, onDone }: RenameFigureDialogProps) {
  const api = window.electronAPI
  const [newName, setNewName] = useState(figure.fileName)
  const [projects, setProjects] = useState<{ dir: string; title: string }[]>([])
  const [checkedDirs, setCheckedDirs] = useState<Set<string>>(new Set())
  const [preview, setPreview] = useState<{ newFile: string; usages: RenameUsage[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [applied, setApplied] = useState(false)

  useEffect(() => {
    let alive = true
    const load = async () => {
      if (!api?.library) return
      try {
        const res = await api.library.listProjects()
        if (alive && res.ok && res.projects) {
          const withDir = (res.projects as { id: string; title: string; paperDir?: string }[])
            .filter((p) => typeof p.paperDir === 'string' && p.paperDir !== '')
            .map((p) => ({ dir: p.paperDir as string, title: p.title }))
          setProjects(withDir)
          setCheckedDirs(new Set(withDir.map((p) => p.dir)))
        }
      } catch {
        // ignore
      }
    }
    void load()
    return () => {
      alive = false
    }
  }, [api])

  const dirs = useMemo(() => [...checkedDirs], [checkedDirs])

  const toggleDir = useCallback((dir: string) => {
    setCheckedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(dir)) next.delete(dir)
      else next.add(dir)
      return next
    })
    setPreview(null)
  }, [])

  const handlePreview = useCallback(async () => {
    if (!api?.figures || !newName.trim()) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.figures.renamePreview(figure.fileName, newName.trim(), dirs)
      if (res.ok && res.newFile) {
        setPreview({ newFile: res.newFile, usages: res.usages ?? [] })
      } else {
        setError(res.message ?? '预览失败')
        setPreview(null)
      }
    } catch {
      setError('预览失败')
    } finally {
      setBusy(false)
    }
  }, [api, newName, figure.fileName, dirs])

  const handleApply = useCallback(async () => {
    if (!api?.figures || preview === null) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.figures.renameApply(figure.fileName, newName.trim(), dirs)
      if (res.ok) {
        setApplied(true)
        onDone()
        onClose()
      } else {
        setError(res.message ?? '改名失败')
      }
    } catch {
      setError('改名失败')
    } finally {
      setBusy(false)
    }
  }, [api, preview, newName, figure.fileName, dirs, onDone, onClose])

  const totalHits = preview?.usages.reduce((sum, u) => sum + u.count, 0) ?? 0

  return (
    <Dialog open onOpenChange={(open) => !busy && !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>重命名图片并同步引用</DialogTitle>
          <DialogDescription>
            原文件：{figure.fileName}
            {projects.length > 0
              ? '。可选同步以下 LaTeX 项目（仅替换 \includegraphics 等处的旧文件名）。'
              : '。未找到带 paperDir 的文献库项目，可只改名图片。'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-[11px]">新文件名（不含扩展名）</Label>
            <Input
              value={newName.replace(/\.[^.]+$/, '')}
              onChange={(e) => {
                setNewName(`${e.target.value}${figure.fileName.slice(figure.fileName.lastIndexOf('.'))}`)
                setPreview(null)
              }}
              className="h-7 text-[12px] font-mono"
              autoFocus
            />
            <p className="text-[10px] text-muted-foreground">将保留原扩展名 {figure.fileName.slice(figure.fileName.lastIndexOf('.'))}</p>
          </div>

          {projects.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-[11px]">同步到的 LaTeX 项目</Label>
              <div className="space-y-1 max-h-36 overflow-y-auto rounded-md border border-border p-1.5">
                {projects.map((project) => {
                  const checked = checkedDirs.has(project.dir)
                  return (
                    <label key={project.dir} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-muted/60">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleDir(project.dir)}
                        className="h-3 w-3 accent-primary"
                      />
                      <span className="min-w-0 flex-1 truncate text-[11px]">{project.title}</span>
                      <span className="max-w-[140px] truncate font-mono text-[9px] text-muted-foreground" title={project.dir}>
                        {project.dir}
                      </span>
                    </label>
                  )
                })}
              </div>
            </div>
          )}

          {error !== null && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">{error}</div>
          )}

          {preview !== null && (
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
              <p className="flex items-center gap-1.5 text-[11px] text-foreground">
                <Check className="h-3 w-3 text-success" />
                将改为 {preview.newFile}
                {totalHits > 0 ? `，同步更新 ${String(preview.usages.length)} 个文件共 ${String(totalHits)} 处引用` : '（无 LaTeX 引用命中）'}
              </p>
              {preview.usages.length > 0 && (
                <ul className="mt-1.5 space-y-0.5">
                  {preview.usages.slice(0, 12).map((usage) => (
                    <li key={`${usage.dir}:${usage.file}`} className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
                      <span className="truncate">{usage.file}</span>
                      <span className="shrink-0 text-success">{usage.count} 处</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" className="h-7" onClick={onClose} disabled={busy}>
            取消
          </Button>
          {preview === null ? (
            <Button size="sm" className="h-7" onClick={handlePreview} disabled={!newName.trim() || busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Search className="h-3.5 w-3.5 mr-1" />}
              预览影响
            </Button>
          ) : (
            <Button size="sm" className="h-7" onClick={handleApply} disabled={busy || applied}>
              {busy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
              确认改名
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
