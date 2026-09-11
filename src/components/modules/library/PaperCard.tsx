import { useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Users,
  Calendar,
  FileDown,
  File,
  ExternalLink,
  Trash2,
  Loader2,
  Tag,
  Folder,
  BookOpen,
  Sparkles,
  FileText
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { PaperRecord, ProjectRecord } from './types'
import { formatDate, parseReadingNotes } from './types'

interface PaperCardProps {
  paper: PaperRecord
  projects: ProjectRecord[]
  selectedProjectId: string | null
  onUpdate: (request: {
    arxivId: string
    tags?: string[]
    projectIds?: string[]
    notes?: string
  }) => Promise<void>
  onRemove: (arxivId: string) => void
  onDownloadPdf: (arxivId: string) => Promise<void>
  onOpenPdf: (paper: PaperRecord) => void
  onOpenExternal: (url: string) => void
  onScoreRelevance: (paper: PaperRecord) => Promise<void>
  onExportBib: (paper: PaperRecord) => Promise<void>
  /** 把本篇文献作为上下文投递给 Agent（跳转对话）。 */
  onHandoffToAgent?: (paper: PaperRecord) => void
}

export function PaperCard({
  paper,
  projects,
  selectedProjectId,
  onUpdate,
  onRemove,
  onDownloadPdf,
  onOpenPdf,
  onOpenExternal,
  onScoreRelevance,
  onExportBib,
  onHandoffToAgent
}: PaperCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [editingTags, setEditingTags] = useState(false)
  const [tagText, setTagText] = useState(paper.tags.join(', '))
  const [editingNotes, setEditingNotes] = useState(false)
  const [noteText, setNoteText] = useState(paper.notes)
  const [downloading, setDownloading] = useState(false)
  const [scoring, setScoring] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [togglingProject, setTogglingProject] = useState(false)

  const relevance = selectedProjectId ? paper.relevance?.[selectedProjectId] : undefined
  const readingNotes = parseReadingNotes(paper.notes)

  const saveTags = async () => {
    const tags = tagText.split(',').map((t) => t.trim()).filter(Boolean)
    await onUpdate({ arxivId: paper.arxivId, tags })
    setEditingTags(false)
  }

  const saveNotes = async () => {
    await onUpdate({ arxivId: paper.arxivId, notes: noteText })
    setEditingNotes(false)
  }

  const toggleProject = async (projectId: string) => {
    setTogglingProject(true)
    try {
      const next = paper.projectIds.includes(projectId)
        ? paper.projectIds.filter((id) => id !== projectId)
        : [...paper.projectIds, projectId]
      await onUpdate({ arxivId: paper.arxivId, projectIds: next })
    } finally {
      setTogglingProject(false)
    }
  }

  const handleDownload = async () => {
    setDownloading(true)
    try {
      await onDownloadPdf(paper.arxivId)
    } finally {
      setDownloading(false)
    }
  }

  const handleScore = async () => {
    setScoring(true)
    try {
      await onScoreRelevance(paper)
    } finally {
      setScoring(false)
    }
  }

  const handleExport = async () => {
    setExporting(true)
    try {
      await onExportBib(paper)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div
      className={cn(
        'group rounded-lg border bg-card p-3 transition-all',
        expanded ? 'border-primary/30 shadow-sm' : 'border-border hover:border-primary/20 hover:shadow-sm'
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div
          className="flex items-start gap-2 flex-1 min-w-0 cursor-pointer"
          onClick={() => setExpanded(!expanded)}
        >
          <div className="mt-0.5 text-muted-foreground shrink-0">
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="font-medium text-[13px] leading-snug group-hover:text-primary transition-colors">
                {paper.title}
              </h3>
              {relevance && (
                <span
                  className={cn(
                    'shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold',
                    relevance.score >= 7
                      ? 'bg-green-500/15 text-green-600'
                      : relevance.score >= 4
                        ? 'bg-yellow-500/15 text-yellow-600'
                        : 'bg-muted text-muted-foreground'
                  )}
                  title={relevance.reason || 'AI 相关性评分'}
                >
                  {relevance.score}/10
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 mt-1.5 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1 truncate">
                <Users className="h-3 w-3 shrink-0" />
                <span className="truncate">{paper.authors.slice(0, 3).join(', ')}{paper.authors.length > 3 ? ' et al.' : ''}</span>
              </span>
              <span className="flex items-center gap-1 shrink-0">
                <Calendar className="h-3 w-3" />
                {formatDate(paper.addedAt)}
              </span>
            </div>
            {!expanded && (
              <p className="text-[11px] text-muted-foreground/70 mt-1.5 line-clamp-2 leading-relaxed">
                {paper.summary}
              </p>
            )}
            {(paper.tags.length > 0 || paper.projectIds.length > 0) && (
              <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                {paper.tags.map((tag) => (
                  <span key={tag} className="flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">
                    <Tag className="h-2.5 w-2.5" />
                    {tag}
                  </span>
                ))}
                {paper.projectIds.map((pid) => {
                  const project = projects.find((p) => p.id === pid)
                  if (!project) return null
                  return (
                    <span key={pid} className="flex items-center gap-0.5 rounded bg-primary/10 px-1.5 py-0.5 text-[9px] text-primary">
                      <Folder className="h-2.5 w-2.5" />
                      {project.title}
                    </span>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-col items-end gap-1 shrink-0">
          <div className="flex items-center gap-0.5">
            <button
              onClick={handleDownload}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground/50 hover:text-muted-foreground transition-colors"
              title={paper.pdfPath ? '重新下载 PDF' : '下载 PDF'}
              disabled={downloading}
            >
              {downloading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : paper.pdfPath ? (
                <File className="h-3.5 w-3.5 text-green-500" />
              ) : (
                <FileDown className="h-3.5 w-3.5" />
              )}
            </button>
            <button
              onClick={() => onOpenPdf(paper)}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground/50 hover:text-muted-foreground transition-colors"
              title="内嵌阅读 PDF"
              disabled={!paper.pdfPath}
            >
              <BookOpen className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => onOpenExternal(paper.url)}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground/50 hover:text-muted-foreground transition-colors"
              title="打开原文"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => onHandoffToAgent?.(paper)}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground/50 hover:text-primary transition-colors"
              title="交给 Agent（在对话中引用本篇文献）"
            >
              <Sparkles className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => onRemove(paper.arxivId)}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground/50 hover:text-destructive transition-colors"
              title="从文献库移除"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-primary"
              onClick={handleScore}
              disabled={scoring || !selectedProjectId}
              title={selectedProjectId ? 'AI 评估与当前项目的相关性' : '请先选择项目'}
            >
              {scoring ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Sparkles className="h-3 w-3 mr-1" />}
              AI 评分
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-primary"
              onClick={handleExport}
              disabled={exporting || !selectedProjectId}
              title={selectedProjectId ? '加入项目 references.bib' : '请先选择项目'}
            >
              {exporting ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <FileText className="h-3 w-3 mr-1" />}
              BibTeX
            </Button>
          </div>
        </div>
      </div>

      {expanded && (
        <div className="mt-3 pt-3 border-t border-border space-y-3">
          <p className="text-[12px] text-muted-foreground leading-relaxed">{paper.summary}</p>

          {relevance && (
            <div className="rounded-md bg-muted/50 p-2 text-[11px]">
              <span className="font-medium text-muted-foreground">AI 相关性：{relevance.score}/10</span>
              {relevance.reason && <p className="mt-0.5 text-muted-foreground/80 leading-relaxed">{relevance.reason}</p>}
            </div>
          )}

          {/* 标签编辑 */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-muted-foreground">标签</span>
              {!editingTags && (
                <button onClick={() => { setEditingTags(true); setTagText(paper.tags.join(', ')) }} className="text-[10px] text-primary hover:underline">
                  {paper.tags.length > 0 ? '编辑' : '添加标签'}
                </button>
              )}
            </div>
            {editingTags ? (
              <div className="flex gap-1.5">
                <Input
                  value={tagText}
                  onChange={(e) => setTagText(e.target.value)}
                  placeholder="逗号分隔，如 survey, llm"
                  className="h-7 text-[11px] flex-1"
                  autoFocus
                  onKeyDown={(e) => e.key === 'Enter' && saveTags()}
                />
                <Button size="sm" className="h-7 text-[10px]" onClick={saveTags}>保存</Button>
                <Button size="sm" variant="ghost" className="h-7 text-[10px]" onClick={() => setEditingTags(false)}>取消</Button>
              </div>
            ) : (
              paper.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {paper.tags.map((tag) => (
                    <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{tag}</span>
                  ))}
                </div>
              )
            )}
          </div>

          {/* 项目关联 */}
          <div className="space-y-1">
            <span className="text-[11px] font-medium text-muted-foreground">关联项目</span>
            <div className="flex flex-wrap gap-1">
              {projects.map((project) => (
                <button
                  key={project.id}
                  onClick={() => toggleProject(project.id)}
                  disabled={togglingProject}
                  className={cn(
                    'rounded px-1.5 py-0.5 text-[10px] transition-colors',
                    paper.projectIds.includes(project.id)
                      ? 'bg-primary/10 text-primary'
                      : 'bg-muted text-muted-foreground hover:bg-muted/70'
                  )}
                >
                  {project.title}
                </button>
              ))}
            </div>
          </div>

          {/* 阅读笔记 */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-muted-foreground">阅读笔记</span>
              {!editingNotes && (
                <button onClick={() => { setEditingNotes(true); setNoteText(paper.notes) }} className="text-[10px] text-primary hover:underline">
                  {paper.notes ? '编辑' : '添加笔记'}
                </button>
              )}
            </div>
            {editingNotes ? (
              <div className="space-y-1.5">
                <Textarea
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  placeholder="写下你的阅读笔记..."
                  className="min-h-[80px] text-[12px] resize-none"
                  autoFocus
                />
                <div className="flex gap-1.5">
                  <Button size="sm" className="h-6 text-[10px]" onClick={saveNotes}>保存</Button>
                  <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => setEditingNotes(false)}>取消</Button>
                </div>
              </div>
            ) : (
              readingNotes.length > 0 ? (
                <div className="space-y-2">
                  {readingNotes.map((note, index) => (
                    <div key={index} className="rounded-md bg-muted/40 p-2">
                      <span className="text-[9px] text-muted-foreground/60">{note.at}</span>
                      <p className="text-[11px] text-muted-foreground/90 leading-relaxed whitespace-pre-wrap mt-0.5">{note.text}</p>
                    </div>
                  ))}
                </div>
              ) : paper.notes ? (
                <p className="text-[11px] text-muted-foreground/80 leading-relaxed whitespace-pre-wrap">{paper.notes}</p>
              ) : null
            )}
          </div>

          {paper.pdfPath && (
            <div className="flex items-center gap-2 text-[11px] text-green-600">
              <File className="h-3 w-3" />
              <span className="truncate">{paper.pdfPath}</span>
              <button onClick={() => onOpenPdf(paper)} className="underline hover:text-green-700 shrink-0">内嵌阅读</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}