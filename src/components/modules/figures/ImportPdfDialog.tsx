import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { FileDown, Loader2 } from 'lucide-react'
import { extractPdfFigures } from '@/lib/extractPdfFigures'
import { pdfUrlOf } from '@/components/modules/library/types'

interface PaperWithPdf {
  arxivId: string
  title: string
  hasPdf: boolean
}

interface ImportPdfDialogProps {
  onClose: () => void
  onDone: () => void
}

/** 从文献库论文 PDF 语义提取内嵌图片并导入图表库。 */
export function ImportPdfDialog({ onClose, onDone }: ImportPdfDialogProps) {
  const api = window.electronAPI
  const [papers, setPapers] = useState<PaperWithPdf[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      if (!api?.library) return
      try {
        const res = await api.library.listPapers()
        if (alive && res.ok && res.papers) {
          const list = (res.papers as Array<{ arxivId: string; title: string; pdfPath?: string }>)
            .map((p) => ({ arxivId: p.arxivId, title: p.title, hasPdf: typeof p.pdfPath === 'string' }))
            .sort((a, b) => b.title.localeCompare(a.title))
          setPapers(list)
          const first = list.find((p) => p.hasPdf)
          if (first !== undefined) setSelectedId(first.arxivId)
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

  const handleImport = useCallback(async () => {
    if (!api?.figures || selectedId === '') return
    setBusy(true)
    setError(null)
    setResult(null)
    setProgress('下载 PDF…')
    try {
      const response = await fetch(pdfUrlOf(selectedId))
      if (!response.ok) throw new Error('读取 PDF 失败')
      const bytes = new Uint8Array(await response.arrayBuffer())
      setProgress('解析内嵌图片…')
      const figures = await extractPdfFigures(bytes, selectedId)
      if (figures.length === 0) {
        setResult('未在 PDF 中找到可提取的内嵌光栅图')
        setProgress(null)
        return
      }
      let okCount = 0
      let failCount = 0
      for (let i = 0; i < figures.length; i += 1) {
        const figure = figures[i]
        if (figure === undefined) continue
        setProgress(`正在保存 ${String(i + 1)} / ${String(figures.length)}`)
        const res = await api.figures.add(figure.name, figure.dataUrl)
        if (res.ok) okCount += 1
        else failCount += 1
      }
      setResult(`提取并保存 ${String(okCount)} 张图${failCount > 0 ? `，${String(failCount)} 张失败` : ''}`)
      setProgress(null)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : '提取失败')
      setProgress(null)
    } finally {
      setBusy(false)
    }
  }, [api, selectedId, onDone])

  return (
    <Dialog open onOpenChange={(open) => !busy && !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>从 PDF 提取图表</DialogTitle>
          <DialogDescription>
            解析文献库中论文 PDF 的语义图片（内嵌光栅图），逐张导入图表管理。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-[11px]">论文（需已下载 PDF）</Label>
            <Select value={selectedId} onValueChange={setSelectedId}>
              <SelectTrigger className="h-8 text-[12px]">
                <SelectValue placeholder="选择论文" />
              </SelectTrigger>
              <SelectContent>
                {papers.length === 0 && <SelectItem value="__none" className="text-[12px]">暂无论文</SelectItem>}
                {papers.map((paper) => (
                  <SelectItem key={paper.arxivId} value={paper.arxivId} className="text-[12px]">
                    {paper.title} {paper.hasPdf ? '' : '（未下载 PDF）'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground">
              提取前请先在文献库为该论文下载 PDF；提取结果会进入图表库（可改名、可同步 LaTeX 引用）。
            </p>
          </div>

          {progress !== null && (
            <p className="flex items-center gap-1.5 text-[11px] text-primary">
              <Loader2 className="h-3 w-3 animate-spin" />
              {progress}
            </p>
          )}
          {error !== null && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">{error}</div>
          )}
          {result !== null && (
            <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-[11px] text-primary">{result}</div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" className="h-7" onClick={onClose} disabled={busy}>
            关闭
          </Button>
          <Button size="sm" className="h-7" onClick={handleImport} disabled={busy || selectedId === '' || papers.length === 0}>
            {busy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <FileDown className="h-3.5 w-3.5 mr-1" />}
            提取并导入
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
