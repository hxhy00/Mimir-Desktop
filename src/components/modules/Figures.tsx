import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Upload, Trash2, Copy, Check, Image, Pencil, FileDown } from 'lucide-react'
import { RenameFigureDialog } from './figures/RenameFigureDialog'
import { ImportPdfDialog } from './figures/ImportPdfDialog'

interface Figure {
  id: string
  name: string
  fileName: string
  sizeBytes: number
  createdAt: string
}

/** 通过 mimir-img:// 自定义协议内联展示本地图片。 */
function figureImageUrl(fileName: string): string {
  return `mimir-img://figures/${encodeURIComponent(fileName)}`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function Figures() {
  const api = window.electronAPI
  const [figures, setFigures] = useState<Figure[]>([])
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [renameTarget, setRenameTarget] = useState<Figure | null>(null)
  const [importPdfOpen, setImportPdfOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const refreshFigures = useCallback(async () => {
    if (!api?.figures) return
    try {
      const res = await api.figures.list()
      if (res.ok && res.figures) setFigures(res.figures)
    } catch {
      // ignore
    }
  }, [api])

  useEffect(() => {
    if (!api?.figures) {
      setUnavailable(true)
      return
    }
    void refreshFigures()
  }, [api, refreshFigures])

  const handleUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? [])
      const apiFigures = api?.figures
      if (!apiFigures || files.length === 0) return
      const tasks: Promise<void>[] = []
      for (const file of files) {
        if (!file.type.startsWith('image/')) continue
        tasks.push(
          new Promise<void>((resolve) => {
            const reader = new FileReader()
            reader.onload = () => {
              const dataUrl = reader.result as string
              apiFigures
                .add(file.name, dataUrl)
                .then(() => {})
                .catch(() => {})
                .finally(() => resolve())
            }
            reader.onerror = () => resolve()
            reader.readAsDataURL(file)
          })
        )
      }
      await Promise.all(tasks)
      await refreshFigures()
      if (fileInputRef.current) fileInputRef.current.value = ''
    },
    [api, refreshFigures]
  )

  const handleDelete = useCallback(
    async (figure: Figure) => {
      if (!api?.figures) return
      if (!window.confirm(`确定删除「${figure.name}」这张图片吗？此操作不可恢复。`)) return
      try {
        const res = await api.figures.remove(figure.fileName)
        if (res.ok) await refreshFigures()
      } catch {
        // ignore
      }
    },
    [api, refreshFigures]
  )

  const handleCopyLatex = useCallback(
    async (figure: Figure) => {
      const stem = figure.fileName.replace(/\.[^.]+$/, '')
      const safeName = stem.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff_-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
      const latex = `\\begin{figure}[htbp]
  \\centering
  \\includegraphics[width=0.8\\textwidth]{${figure.fileName}}
  \\caption{${stem}}
  \\label{fig:${safeName || 'figure'}}
\\end{figure}`
      try {
        await navigator.clipboard.writeText(latex)
        setCopiedId(figure.id)
        window.setTimeout(() => setCopiedId(null), 1500)
      } catch {
        // ignore
      }
    },
    []
  )

  return (
    <div className="flex h-full flex-col">
      <div className="module-header">
        <div className="flex items-center gap-3">
          <span className="module-title">图表管理</span>
          <span className="text-[11px] text-muted-foreground">{figures.length} 张图片</span>
        </div>
        <Button size="sm" variant="outline" className="h-7" onClick={() => fileInputRef.current?.click()} disabled={unavailable}>
          <Upload className="h-3.5 w-3.5 mr-1" />
          上传图片
        </Button>
        <Button size="sm" variant="outline" className="h-7" onClick={() => setImportPdfOpen(true)} disabled={unavailable}>
          <FileDown className="h-3.5 w-3.5 mr-1" />
          从 PDF 导入
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          className="hidden"
          onChange={handleUpload}
        />
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-3">
        {unavailable ? (
          <div className="flex flex-col items-center justify-center py-24 text-muted-foreground">
            <Image className="h-8 w-8 opacity-30 mb-2" />
            <p className="text-[12px] font-medium">图表持久化需要桌面端</p>
            <p className="text-[11px] mt-0.5 opacity-70">请通过 Electron 启动应用后上传图片</p>
          </div>
        ) : figures.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-muted-foreground">
            <Image className="h-8 w-8 opacity-30 mb-2" />
            <p className="text-[12px] font-medium">暂无图表</p>
            <p className="text-[11px] mt-0.5 opacity-70">上传图片，管理你的论文图表；图片将保存到本地</p>
            <Button variant="outline" size="sm" className="mt-3 h-7" onClick={() => fileInputRef.current?.click()}>
              <Upload className="h-3 w-3 mr-1" />
              选择图片
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-3 lg:grid-cols-4 gap-2.5">
            {figures.map((figure) => (
              <div key={figure.id} className="group rounded-lg border border-border bg-card overflow-hidden hover:shadow-sm transition-shadow">
                <div className="relative aspect-square bg-muted/30">
                  <img
                    src={figureImageUrl(figure.fileName)}
                    alt={figure.name}
                    className="h-full w-full object-contain p-1.5"
                  />
                  <div className="absolute inset-0 flex items-center justify-center gap-1.5 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => setRenameTarget(figure)}
                      className="flex h-7 w-7 items-center justify-center rounded-md bg-white/90 text-black hover:bg-white transition-colors"
                      title="重命名并同步引用"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => handleCopyLatex(figure)}
                      className="flex h-7 w-7 items-center justify-center rounded-md bg-white/90 text-black hover:bg-white transition-colors"
                      title="复制 LaTeX"
                    >
                      {copiedId === figure.id ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
                    </button>
                    <button
                      onClick={() => handleDelete(figure)}
                      className="flex h-7 w-7 items-center justify-center rounded-md bg-white/90 text-black hover:bg-red-500 hover:text-white transition-colors"
                      title="删除"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                <div className="p-2">
                  <p className="text-[11px] font-medium truncate" title={figure.fileName}>
                    {figure.name}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{formatSize(figure.sizeBytes)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {importPdfOpen && (
        <ImportPdfDialog
          onClose={() => setImportPdfOpen(false)}
          onDone={() => void refreshFigures()}
        />
      )}

      {renameTarget !== null && (
        <RenameFigureDialog
          figure={renameTarget}
          onClose={() => setRenameTarget(null)}
          onDone={() => void refreshFigures()}
        />
      )}
    </div>
  )
}
