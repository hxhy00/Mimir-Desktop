import { useCallback, useEffect, useState } from 'react'
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
  Presentation,
  Wand2,
  Loader2,
  FolderOpen,
  Trash2,
  Calendar,
  Sparkles,
  Check,
  Layers,
  BookOpen,
  FlaskConical
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { relativeTime } from '@/lib/experiments'
import {
  formatDeckSize,
  relevanceScoreOf,
  type ExperimentRecord,
  type MeetingDeckView,
  type PaperRecord,
  type ProjectRecord
} from './meetingsTypes'

/** 一份 deck 的论文数量上限（服务端同样限制）。 */
const DECK_PAPER_CAP = 12

/** 本地 YYYY-MM-DD（今天）。 */
function todayYmd(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function formatDate(dateStr: string): string {
  if (dateStr === '') return ''
  return dateStr.slice(0, 10)
}

/** 供展示的排序：项目相关论文按 AI 相关度降序，其次按加入时间。 */
function sortPapers(papers: PaperRecord[], projectId: string | undefined): PaperRecord[] {
  return [...papers].sort((a, b) => {
    if (projectId !== undefined) {
      const sa = relevanceScoreOf(a, projectId) ?? -1
      const sb = relevanceScoreOf(b, projectId) ?? -1
      if (sa !== sb) return sb - sa
    }
    return b.addedAt.localeCompare(a.addedAt)
  })
}

export function Meetings() {
  const api = window.electronAPI

  // 素材与状态
  const [decks, setDecks] = useState<MeetingDeckView[]>([])
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [papers, setPapers] = useState<PaperRecord[]>([])
  const [experiments, setExperiments] = useState<ExperimentRecord[]>([])
  const [enhanceAvailable, setEnhanceAvailable] = useState(false)
  const [configLoaded, setConfigLoaded] = useState(false)
  const [unavailable, setUnavailable] = useState(false)

  // 生成对话框
  const [dialogOpen, setDialogOpen] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const [formTitle, setFormTitle] = useState('')
  const [presenter, setPresenter] = useState('')
  const [date, setDate] = useState(todayYmd())
  const [projectId, setProjectId] = useState('')
  const [selectedPapers, setSelectedPapers] = useState<Set<string>>(new Set())
  const [selectedExperiments, setSelectedExperiments] = useState<Set<string>>(new Set())
  const [enhance, setEnhance] = useState(true)
  const [aiImages, setAiImages] = useState(false)
  const [imageGenConfigured, setImageGenConfigured] = useState(false)

  const project = projects.find((p) => p.id === projectId)
  const sortedPapers = sortPapers(papers, projectId)
  const shownPapers = sortedPapers.slice(0, DECK_PAPER_CAP * 2)

  // 初次加载：项目、论文、实验、既有 deck、模型可用性
  useEffect(() => {
    const load = async () => {
      if (!api?.meetings || !api.library) {
        setUnavailable(true)
        return
      }
      try {
        const [projectRes, paperRes, expData, deckRes, configRes] = await Promise.all([
          api.library.listProjects(),
          api.library.listPapers(),
          api.getStoreValue<ExperimentRecord[]>('experiments:list'),
          api.meetings.list(),
          api.meetings.config()
        ])
        if (projectRes.ok && projectRes.projects) {
          setProjects((projectRes.projects as ProjectRecord[]).map((p) => ({ ...p })))
        }
        if (paperRes.ok && paperRes.papers) {
          setPapers(paperRes.papers as PaperRecord[])
        }
        setExperiments(expData ?? [])
        if (deckRes.ok && deckRes.decks) setDecks(deckRes.decks)
        if (configRes.ok) {
          setEnhanceAvailable(configRes.available)
          setConfigLoaded(true)
          setEnhance(configRes.available)
        }
        const settings = (await api.getSettings()) as Record<string, unknown>
        const imageGen = settings.imageGen
        const configured =
          typeof imageGen === 'object' &&
          imageGen !== null &&
          typeof (imageGen as { apiKey?: unknown }).apiKey === 'string' &&
          (imageGen as { apiKey?: string }).apiKey !== ''
        setImageGenConfigured(configured)
      } catch {
        // ignore
      }
    }
    load()
  }, [api])

  const refreshDecks = useCallback(async () => {
    if (!api?.meetings) return
    try {
      const res = await api.meetings.list()
      if (res.ok && res.decks) setDecks(res.decks)
    } catch {
      // ignore
    }
  }, [api])

  const togglePaper = useCallback((arxivId: string) => {
    setSelectedPapers((prev) => {
      const next = new Set(prev)
      if (next.has(arxivId)) next.delete(arxivId)
      else next.add(arxivId)
      return next
    })
  }, [])

  const toggleExperiment = useCallback((id: string) => {
    setSelectedExperiments((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // 选择项目时，自动预填该项目论文（前 DECK_PAPER_CAP 篇）
  const handleProjectChange = useCallback(
    (value: string) => {
      setProjectId(value)
      if (value === '') {
        setSelectedPapers(new Set())
        return
      }
      const related = sortPapers(
        papers.filter((p) => p.projectIds.includes(value)),
        value
      )
      setSelectedPapers(new Set(related.slice(0, DECK_PAPER_CAP).map((p) => p.arxivId)))
    },
    [papers]
  )

  const handleFillProject = useCallback(() => {
    if (projectId === '') return
    const related = sortPapers(
      papers.filter((p) => p.projectIds.includes(projectId)),
      projectId
    )
    setSelectedPapers(new Set(related.slice(0, DECK_PAPER_CAP).map((p) => p.arxivId)))
  }, [papers, projectId])

  const openCreate = useCallback(() => {
    setFormTitle('')
    setPresenter('')
    setDate(todayYmd())
    setProjectId('')
    setSelectedPapers(new Set())
    setSelectedExperiments(new Set())
    setErrorMsg(null)
    setDialogOpen(true)
  }, [])

  const handleGenerate = useCallback(async () => {
    const title = formTitle.trim()
    if (title === '') return
    if (!api?.meetings) return
    setGenerating(true)
    setErrorMsg(null)
    try {
      const res = await api.meetings.generate({
        title,
        presenter: presenter.trim() === '' ? undefined : presenter.trim(),
        date: date.trim() === '' ? undefined : date.trim(),
        projectId: projectId === '' ? undefined : projectId,
        paperIds: [...selectedPapers],
        experimentIds: [...selectedExperiments],
        enhance,
        aiImages
      })
      if (!res.ok || !res.deck) {
        setErrorMsg(res.message ?? '生成失败，请重试')
        return
      }
      await refreshDecks()
      setDialogOpen(false)
      setSuccessMsg(`已生成《${res.deck.title}》（${String(res.deck.slides)} 页）`)
      window.setTimeout(() => setSuccessMsg(null), 5000)
    } catch {
      setErrorMsg('生成失败，请检查模型连接或重试')
    } finally {
      setGenerating(false)
    }
  }, [api, formTitle, presenter, date, projectId, selectedPapers, selectedExperiments, enhance, refreshDecks])

  const handleDelete = useCallback(
    async (deck: MeetingDeckView) => {
      if (!api?.meetings) return
      if (!window.confirm(`确定删除「${deck.title}」这份演示文稿吗？此操作不可恢复。`)) return
      try {
        const res = await api.meetings.delete(deck.file)
        if (res.ok) await refreshDecks()
      } catch {
        // ignore
      }
    },
    [api, refreshDecks]
  )

  const handleReveal = useCallback(
    (deck: MeetingDeckView) => {
      api?.meetings?.reveal(deck.file).catch(() => {})
    },
    [api]
  )

  const hasSelectedExperiments = selectedExperiments.size > 0

  return (
    <div className="flex h-full flex-col">
      <div className="module-header">
        <div className="flex items-center gap-3">
          <span className="module-title">组会管理</span>
          <span className="text-[11px] text-muted-foreground">{decks.length} 份演示文稿</span>
          {configLoaded && (
            <span
              className={cn(
                'flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-medium',
                enhanceAvailable ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
              )}
              title={
                enhanceAvailable
                  ? '已配置模型，生成时可自动提炼分享要点'
                  : '未配置模型，生成将使用确定性内容'
              }
            >
              <Sparkles className="h-2.5 w-2.5" />
              AI 要点
            </span>
          )}
        </div>
        <Button size="sm" variant="outline" className="h-7" onClick={openCreate} disabled={unavailable}>
          <Wand2 className="h-3.5 w-3.5 mr-1" />
          生成 PPT
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-3">
        {successMsg !== null && (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-[11px] text-primary">
            <Check className="h-3.5 w-3.5" />
            {successMsg}
          </div>
        )}

        {unavailable ? (
          <div className="flex flex-col items-center justify-center py-24 text-muted-foreground">
            <Presentation className="h-8 w-8 opacity-30 mb-2" />
            <p className="text-[12px] font-medium">组会演示文稿需要桌面端运行</p>
            <p className="text-[11px] mt-0.5 opacity-70">请通过 Electron 启动应用后使用</p>
          </div>
        ) : decks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-muted-foreground">
            <Presentation className="h-8 w-8 opacity-30 mb-2" />
            <p className="text-[12px] font-medium">暂无演示文稿</p>
            <p className="text-[11px] mt-0.5 opacity-70 max-w-sm text-center leading-relaxed">
              从文献库的项目论文与实验记录生成专业 16:9 PPT（封面 / 目录 / 文献分享 /
              实验结果 / 下一步计划）。可在文献库添加论文并关联项目后再生成。
            </p>
            <Button variant="outline" size="sm" className="mt-3 h-7" onClick={openCreate}>
              <Wand2 className="h-3 w-3 mr-1" />
              生成 PPT
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {decks.map((deck) => (
              <div
                key={deck.file}
                className="rounded-lg border border-border bg-card p-3 hover:shadow-sm transition-shadow"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2.5 min-w-0">
                    <div className="flex h-8 w-8 items-center justify-center rounded-md bg-muted shrink-0 mt-0.5">
                      <Presentation className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-medium text-[13px] truncate max-w-[46vw]">{deck.title}</h3>
                        {deck.slides > 0 && (
                          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary shrink-0">
                            {deck.slides} 页
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground flex-wrap">
                        <span className="flex items-center gap-1">
                          <Calendar className="h-2.5 w-2.5" />
                          {relativeTime(deck.updatedAt)}
                        </span>
                        <span className="flex items-center gap-1">
                          <Layers className="h-2.5 w-2.5" />
                          {formatDeckSize(deck.sizeBytes)}
                        </span>
                        <span className="text-muted-foreground/70 font-mono">{deck.file}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0 ml-2">
                    <button
                      onClick={() => handleReveal(deck)}
                      className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted transition-colors"
                      title="打开所在文件夹"
                    >
                      <FolderOpen className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => handleDelete(deck)}
                      className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                      title="删除"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 生成 PPT Dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => !generating && setDialogOpen(open)}>
        <DialogContent className="sm:max-w-2xl max-h-[88vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>生成组会 PPT</DialogTitle>
            <DialogDescription>
              从文献库论文与实验记录确定性排版，输出 16:9 .pptx 文件。
              {enhanceAvailable
                ? '已配置模型，开启「AI 要点」会自动提炼每篇论文的分享要点与导语。'
                : '未配置模型：可先在「设置」中添加模型，开启 AI 要点提炼；否则使用论文摘要与阅读笔记。'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* 基本信息 */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <div className="space-y-1.5 sm:col-span-1">
                <Label className="text-[11px]">汇报主题 *</Label>
                <Input
                  placeholder="如：VLM 研究进展汇报"
                  value={formTitle}
                  onChange={(e) => setFormTitle(e.target.value)}
                  className="h-7 text-[12px]"
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[11px]">汇报人</Label>
                <Input
                  placeholder="你的名字"
                  value={presenter}
                  onChange={(e) => setPresenter(e.target.value)}
                  className="h-7 text-[12px]"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[11px]">日期</Label>
                <Input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="h-7 text-[12px]"
                />
              </div>
            </div>

            {/* 关联项目 */}
            <div className="space-y-1.5">
              <Label className="text-[11px]">关联项目（可选，用于预选论文与相关度展示）</Label>
              <div className="flex items-center gap-2">
                <Select value={projectId} onValueChange={handleProjectChange}>
                  <SelectTrigger className="h-7 w-full text-[12px]">
                    <SelectValue placeholder="未关联项目" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="" className="text-[12px]">
                      未关联项目
                    </SelectItem>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id} className="text-[12px]">
                        {p.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {projectId !== '' && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-[11px] shrink-0"
                    onClick={handleFillProject}
                  >
                    <BookOpen className="h-3 w-3 mr-1" />
                    重新选择项目论文
                  </Button>
                )}
              </div>
            </div>

            {/* 论文选择 */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-[11px]">
                  文献分享
                  <span className="text-muted-foreground/70 ml-1.5">
                    {selectedPapers.size > 0 ? `已选 ${String(selectedPapers.size)} 篇` : '未选择'}
                  </span>
                </Label>
                {papers.length > 0 && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedPapers(new Set(sortedPapers.slice(0, DECK_PAPER_CAP).map((p) => p.arxivId)))
                      }
                      className="text-[10px] text-primary hover:underline"
                    >
                      全部
                    </button>
                    <span className="text-[10px] text-muted-foreground/40">·</span>
                    <button
                      type="button"
                      onClick={() => setSelectedPapers(new Set())}
                      className="text-[10px] text-muted-foreground hover:underline"
                    >
                      清空
                    </button>
                  </div>
                )}
              </div>

              {papers.length === 0 ? (
                <p className="rounded-md bg-muted/50 px-3 py-2 text-[10px] text-muted-foreground">
                  文献库还没有论文。请先到「文献库」导入论文（可通过 Agent 对话让 Mimir 搜索并保存）。
                </p>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-1.5 max-h-56 overflow-y-auto rounded-lg border border-border p-2">
                  {shownPapers.map((paper) => {
                    const checked = selectedPapers.has(paper.arxivId)
                    const score = relevanceScoreOf(paper, projectId)
                    return (
                      <button
                        key={paper.arxivId}
                        type="button"
                        onClick={() => togglePaper(paper.arxivId)}
                        className={cn(
                          'flex items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                          checked ? 'bg-primary/10' : 'hover:bg-muted/60'
                        )}
                      >
                        <span
                          className={cn(
                            'mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border',
                            checked ? 'border-primary bg-primary text-white' : 'border-input bg-background'
                          )}
                        >
                          {checked && <Check className="h-2.5 w-2.5" />}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-[11px] leading-snug text-foreground">
                            {paper.title}
                          </span>
                          <span className="mt-0.5 flex items-center gap-2 text-[9px] text-muted-foreground">
                            {paper.authors[0] ?? ''}
                            {score !== undefined && (
                              <span className={cn('font-medium', score >= 7 ? 'text-success' : score >= 4 ? 'text-warning' : 'text-muted-foreground')}>
                                相关 {score}/10
                              </span>
                            )}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {/* 实验选择 */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-[11px]">
                  实验小节
                  <span className="text-muted-foreground/70 ml-1.5">
                    {hasSelectedExperiments ? `已选 ${String(selectedExperiments.size)} 项` : '可选，不勾选则跳过'}
                  </span>
                </Label>
                {experiments.length > 0 && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedExperiments(new Set(experiments.slice(0, 8).map((e) => e.id)))
                      }
                      className="text-[10px] text-primary hover:underline"
                    >
                      最近 8 项
                    </button>
                    <span className="text-[10px] text-muted-foreground/40">·</span>
                    <button
                      type="button"
                      onClick={() => setSelectedExperiments(new Set())}
                      className="text-[10px] text-muted-foreground hover:underline"
                    >
                      清空
                    </button>
                  </div>
                )}
              </div>
              {experiments.length === 0 ? (
                <p className="rounded-md bg-muted/50 px-3 py-2 text-[10px] text-muted-foreground">
                  实验管理里还没有记录。可先在「实验管理」新建实验后再回来生成汇报。
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {experiments.slice(0, 20).map((exp) => {
                    const checked = selectedExperiments.has(exp.id)
                    return (
                      <button
                        key={exp.id}
                        type="button"
                        onClick={() => toggleExperiment(exp.id)}
                        className={cn(
                          'flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] transition-colors',
                          checked
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border text-muted-foreground hover:bg-muted/60'
                        )}
                      >
                        <FlaskConical className="h-2.5 w-2.5" />
                        <span className="max-w-[180px] truncate">{exp.name}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {/* AI 增强开关 */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  role="switch"
                  aria-checked={enhance}
                  onClick={() => setEnhance((prev) => !prev)}
                  className={cn(
                    'relative inline-flex h-4.5 w-8 items-center rounded-full transition-colors',
                    enhance ? 'bg-primary' : 'bg-muted'
                  )}
                  style={{ height: 18 }}
                >
                  <span
                    className={cn(
                      'inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform',
                      enhance ? 'translate-x-4' : 'translate-x-0.5'
                    )}
                  />
                </button>
                <span className="text-[11px] font-medium text-foreground">AI 要点</span>
                <span
                  className={cn(
                    'text-[10px]',
                    enhanceAvailable ? 'text-muted-foreground' : 'text-warning'
                  )}
                >
                  {enhanceAvailable
                    ? '生成前用已配置模型提炼开场导语、分享要点与实验小结'
                    : '未配置可用模型（设置 → 模型管理）；生成将使用论文摘要与阅读笔记'}
                </span>
              </div>
            </div>

            {/* AI 配图开关 */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  role="switch"
                  aria-checked={aiImages}
                  onClick={() => setAiImages((prev) => !prev)}
                  className={cn(
                    'relative inline-flex w-8 items-center rounded-full transition-colors',
                    aiImages ? 'bg-primary' : 'bg-muted'
                  )}
                  style={{ height: 18 }}
                >
                  <span
                    className={cn(
                      'inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform',
                      aiImages ? 'translate-x-4' : 'translate-x-0.5'
                    )}
                  />
                </button>
                <span className="text-[11px] font-medium text-foreground">AI 配图</span>
                <span className={cn('text-[10px]', imageGenConfigured ? 'text-muted-foreground' : 'text-warning')}>
                  {imageGenConfigured
                    ? '自动生成封面与至多 4 篇论文概念插图（图片存入图表目录可复用）'
                    : '未配置图像生成服务（设置 → 外观下方「图像生成」）；不会生成图片'}
                </span>
              </div>
            </div>
          </div>

          {errorMsg !== null && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
              {errorMsg}
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              onClick={() => setDialogOpen(false)}
              disabled={generating}
            >
              取消
            </Button>
            <Button
              size="sm"
              className="h-7"
              onClick={handleGenerate}
              disabled={!formTitle.trim() || generating || unavailable}
            >
              {generating ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Wand2 className="h-3.5 w-3.5 mr-1" />}
              {generating ? '生成中...' : '生成'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
