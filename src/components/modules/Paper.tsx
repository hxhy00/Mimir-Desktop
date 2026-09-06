/**
 * 论文编辑模块（LaTeX 项目管理）。
 *
 * 以文件夹为项目：打开/新建项目 → 列出目录内全部 .tex（main.tex + 章节
 * 文件）→ 多标签编辑（透明 textarea + 语法高亮覆盖层）→ 保存 →
 * latexmk/tectonic 真实编译 → 错误/警告诊断列表（点击跳转行）→
 * mimir-tex:// 协议内嵌 PDF 预览。
 *
 * 编译引擎与日志解析在 electron/latex.ts（移植自 Mimir monorepo），
 * 语法高亮 tokenizer 见 src/lib/latex-highlight.ts。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RightSidebar, RightSidebarExpandButton } from '@/components/layout/RightSidebar'
import { LatexEditor, type EditorFlashRequest } from '@/components/modules/paper/LatexEditor'
import { SnapshotsDialog } from '@/components/modules/paper/SnapshotsDialog'
import { BibDialog } from '@/components/modules/paper/BibDialog'
import { VenueTemplateDialog } from '@/components/modules/paper/VenueTemplateDialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  Check,
  CircleAlert,
  Code2,
  Eye,
  FileCode2,
  FilePlus2,
  FileText,
  FolderOpen,
  Loader2,
  PanelLeftOpen,
  Play,
  Plus,
  Save,
  TriangleAlert,
  X,
  History,
  BookText,
  LayoutTemplate
} from 'lucide-react'
import { cn } from '@/lib/utils'

/** store 中「最近项目」列表的键。 */
const RECENT_KEY = 'paper.recentProjects'

/** 新项目/新章节文件名称里会被替换的字符。 */
const INVALID_NAME_CHARS = /[\\/:*?"<>|]/

/** 最近项目保留条数。 */
const RECENT_MAX = 6

interface PaperProps {
  rightSidebarCollapsed: boolean
  onToggleRightSidebar: () => void
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
}

/** 一个打开的编辑标签。 */
interface PaperTab {
  /** 相对项目目录的 .tex 路径（正斜杠分隔）。 */
  readonly name: string
  readonly content: string
  /** 最近一次落盘的内容，用于脏标记。 */
  readonly saved: string
}

/** 最近打开过的项目。 */
interface RecentProject {
  readonly dir: string
  readonly at: number
}

/** 当前文档大纲条目（由打开文件内容解析）。 */
interface OutlineItem {
  readonly title: string
  readonly level: 1 | 2
  readonly line: number
}

type CompileState = 'idle' | 'compiling' | 'done' | 'error'

/** 去掉文件路径中的多余前缀，得到相对项目目录的正斜杠路径。 */
function normalizeTexPath(file: string): string {
  let p = file.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (p.startsWith('/')) p = p.slice(1)
  return p
}

/** 由全文本生成当前文件的大纲。 */
function outlineOf(source: string): OutlineItem[] {
  const items: OutlineItem[] = []
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^\\(sub)?section\*?\{/.exec(lines[i].trimStart())
    if (match === null) continue
    const after = lines[i].slice(lines[i].indexOf('{') + 1)
    let depth = 1
    let title = ''
    for (const ch of after) {
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) break
      }
      title += ch
    }
    items.push({ title: title.trim(), level: match[1] === undefined ? 1 : 2, line: i + 1 })
  }
  return items
}

/** 新建 .tex 章节文件的默认内容。 */
function chapterTemplate(name: string): string {
  const stem = name.replace(/\.tex$/i, '')
  const hint = stem.includes('/') ? `${name}` : `${name}（由 main.tex 通过 \\input 引用）`
  const title = stem.split('/').pop() ?? stem
  return [
    `% ${hint}`,
    '% 在此编写一个独立章节，标题命令层级与 main.tex 中的排版保持一致。',
    '',
    `\\section{${title}}`,
    '',
    '% 正文…',
    ''
  ].join('\n')
}

export function Paper({ rightSidebarCollapsed, onToggleRightSidebar, sidebarCollapsed, onToggleSidebar }: PaperProps) {
  const api = window.electronAPI

  // ── 项目与会话 ──────────────────────────────────────────────
  const [projectDir, setProjectDir] = useState<string | null>(null)
  const [files, setFiles] = useState<string[]>([])
  const [tabs, setTabs] = useState<PaperTab[]>([])
  const [activeName, setActiveName] = useState<string | null>(null)
  const [recents, setRecents] = useState<RecentProject[]>([])

  // ── 编辑器状态 ──────────────────────────────────────────────
  const [cursor, setCursor] = useState<{ line: number; column: number }>({ line: 1, column: 1 })
  const [flash, setFlash] = useState<EditorFlashRequest | null>(null)
  const flashNonceRef = useRef(0)

  // ── 视图与编译 ──────────────────────────────────────────────
  const [view, setView] = useState<'editor' | 'pdf'>('editor')
  const [engine, setEngine] = useState<string | null>(null)
  const [compileState, setCompileState] = useState<CompileState>('idle')
  const [issues, setIssues] = useState<{ errors: LatexIssue[]; warnings: LatexIssue[] } | null>(null)
  const [compileError, setCompileError] = useState<string | null>(null)
  const [pdfSrc, setPdfSrc] = useState<string | null>(null)
  const pdfVersionRef = useRef(0)

  // ── 对话框 ──────────────────────────────────────────────────
  const [snapshotsOpen, setSnapshotsOpen] = useState(false)
  const [bibOpen, setBibOpen] = useState(false)
  const [venueOpen, setVenueOpen] = useState(false)
  const [fixNote, setFixNote] = useState<string | null>(null)
  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  const [projectName, setProjectName] = useState('my-paper')
  const [projectParent, setProjectParent] = useState<string | null>(null)
  const [projectBusy, setProjectBusy] = useState(false)
  const [fileDialogOpen, setFileDialogOpen] = useState(false)
  const [fileName, setFileName] = useState('chapter.tex')

  const activeTab = useMemo(() => tabs.find((t) => t.name === activeName) ?? null, [tabs, activeName])
  const dirtyCount = useMemo(() => tabs.filter((t) => t.content !== t.saved).length, [tabs])
  const lineCount = useMemo(() => (activeTab === null ? 0 : activeTab.content.split('\n').length), [activeTab])
  const outline = useMemo(() => (activeTab === null ? [] : outlineOf(activeTab.content)), [activeTab])
  const activeDirty = activeTab !== null && activeTab.content !== activeTab.saved
  const projectBasename = projectDir === null ? '' : projectDir.split('/').pop() ?? projectDir
  const errorCount = issues?.errors.length ?? 0
  const warningCount = issues?.warnings.length ?? 0

  // ── 最近项目 ────────────────────────────────────────────────
  const pushRecent = (list: RecentProject[], dir: string): RecentProject[] =>
    [{ dir, at: Date.now() }, ...list.filter((r) => r.dir !== dir)].slice(0, RECENT_MAX)

  const touchRecent = useCallback(async (dir: string) => {
    setRecents((prev) => {
      const next = pushRecent(prev, dir)
      if (window.electronAPI) void window.electronAPI.setStoreValue(RECENT_KEY, next)
      return next
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    if (window.electronAPI) {
      window.electronAPI.getStoreValue<RecentProject[]>(RECENT_KEY).then((value) => {
        if (!cancelled && Array.isArray(value)) setRecents(value)
      })
    }
    return () => {
      cancelled = true
    }
  }, [])

  // ── 标签管理 ────────────────────────────────────────────────
  const openTab = useCallback(
    async (name: string): Promise<boolean> => {
      if (!api || projectDir === null) return false
      if (tabs.some((t) => t.name === name)) {
        setActiveName(name)
        return true
      }
      const res = await api.latex.readFile(projectDir, name)
      if (!res.ok || res.content === undefined) return false
      const content = res.content
      setTabs((prev) => [...prev, { name, content, saved: content }])
      setActiveName(name)
      return true
    },
    [api, projectDir, tabs]
  )

  const closeTab = useCallback(
    (name: string) => {
      const target = tabs.find((t) => t.name === name)
      if (target !== undefined && target.content !== target.saved) {
        if (!window.confirm(`「${name}」有未保存的修改，确定关闭吗？`)) return
      }
      const next = tabs.filter((t) => t.name !== name)
      setTabs(next)
      if (activeName === name) setActiveName(next.length === 0 ? null : next[next.length - 1].name)
    },
    [tabs, activeName]
  )

  const updateActiveContent = useCallback(
    (content: string) => {
      if (activeName === null) return
      // 仅更新当前标签内容；诊断/PDF 代表最近一次编译的磁盘快照，编辑不主动清空，
      // 避免修复错误的过程中每敲一键就闪没问题列表。
      setTabs((prev) => prev.map((t) => (t.name === activeName ? { ...t, content } : t)))
    },
    [activeName]
  )

  // ── 项目打开/刷新 ───────────────────────────────────────────
  const loadProject = useCallback(
    async (dir: string, prefer: string | null) => {
      if (!api) return
      const list = await api.latex.listFiles(dir)
      if (!list.ok) {
        setCompileError(`无法读取项目目录：${list.message ?? ''}`)
        return
      }
      const nextFiles = list.files ?? []
      setFiles(nextFiles)
      setTabs([])
      setActiveName(null)
      setIssues(null)
      setCompileState('idle')
      setCompileError(null)
      setPdfSrc(null)
      setView('editor')
      const initial = prefer !== null && nextFiles.includes(prefer)
        ? prefer
        : nextFiles.find((f) => f === 'main.tex') ?? nextFiles[0] ?? null
      if (initial !== null) await openTab(initial)
      const det = await api.latex.detectEngine()
      setEngine(det.ok ? (det.engine ?? null) : null)
      if (!det.ok && det.message) setCompileError(`未检测到 LaTeX 引擎：${det.message}`)
    },
    [api, openTab]
  )

  const chooseProjectDir = useCallback(async () => {
    if (!api) return
    const result = await api.showOpenDialog({
      title: '打开 LaTeX 论文项目（需包含 main.tex）',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return
    const dir = result.filePaths[0]
    setProjectDir(dir)
    await loadProject(dir, 'main.tex')
    await touchRecent(dir)
  }, [api, loadProject, touchRecent])

  const openRecent = useCallback(
    async (dir: string) => {
      setProjectDir(dir)
      await loadProject(dir, 'main.tex')
      await touchRecent(dir)
    },
    [loadProject, touchRecent]
  )

  // ── 保存 ────────────────────────────────────────────────────
  const saveTab = useCallback(
    async (name: string): Promise<boolean> => {
      if (!api || projectDir === null) return false
      const tab = tabs.find((t) => t.name === name)
      if (tab === undefined) return false
      const res = await api.latex.writeFile(projectDir, name, tab.content)
      if (res.ok) {
        setTabs((prev) => prev.map((t) => (t.name === name ? { ...t, saved: t.content } : t)))
        return true
      }
      return false
    },
    [api, projectDir, tabs]
  )

  const saveActive = useCallback(async () => {
    if (activeName !== null) await saveTab(activeName)
  }, [activeName, saveTab])

  const saveAll = useCallback(async () => {
    await Promise.all(tabs.map((t) => saveTab(t.name)))
  }, [tabs, saveTab])

  // ── 编译 ────────────────────────────────────────────────────
  const handleCompile = useCallback(async () => {
    if (!api || projectDir === null) return
    // 编译前自动保存所有脏标签，保证日志行号对应当前磁盘内容。
    await saveAll()
    setCompileState('compiling')
    setCompileError(null)
    setIssues(null)
    const res = await api.latex.compile(projectDir)
    if (!res.ok || res.result === undefined) {
      setCompileState('error')
      setCompileError(res.message ?? '编译失败')
      setIssues({ errors: [], warnings: [] })
      return
    }
    const result = res.result
    setIssues({ errors: result.errors, warnings: result.warnings })
    setCompileState(result.success ? 'done' : 'error')
    // 编译成功后自动拍摄快照（内容无变化则自动跳过，供快照面板回退使用）
    if (result.success && api.snapshots) {
      void api.snapshots.capture(projectDir).catch(() => {})
    }
    if (result.pdfPath !== null) {
      pdfVersionRef.current += 1
      setPdfSrc(`mimir-tex://pdf/?p=${encodeURIComponent(result.pdfPath)}&v=${pdfVersionRef.current}`)
    } else {
      setPdfSrc(null)
    }
  }, [api, projectDir, saveAll])

  // 回退快照后：从磁盘重新加载所有已打开标签
  const reloadTabsFromDisk = useCallback(async () => {
    if (!api || projectDir === null) return
    const next: PaperTab[] = []
    for (const tab of tabs) {
      try {
        const res = await api.latex.readFile(projectDir, tab.name)
        if (res.ok && res.content !== undefined) next.push({ name: tab.name, content: res.content, saved: res.content })
        else next.push(tab)
      } catch {
        next.push(tab)
      }
    }
    setTabs(next)
    setIssues(null)
  }, [api, projectDir, tabs])

  // AI 修复编译错误：应用补丁后重载文件并自动重编译。
  const handleAiFix = useCallback(
    async (issue: LatexIssue) => {
      if (!api?.paper || projectDir === null) return
      setFixNote('AI 修复中…')
      try {
        const res = await api.paper.aiFix({
          projectDir,
          fileName: normalizeTexPath(issue.file ?? 'main.tex'),
          line: issue.line ?? 1,
          message: issue.message,
        })
        if (!res.ok) {
          setFixNote(res.message ?? 'AI 修复失败')
          return
        }
        if (res.applied) {
          await reloadTabsFromDisk()
          setFixNote('已应用 AI 修复，正在重新编译…')
          void handleCompile()
        } else {
          setFixNote(res.suggestion ?? '未自动应用：模型未给出可校验的补丁。')
        }
      } catch {
        setFixNote('AI 修复失败，请重试。')
      }
    },
    [api, projectDir, reloadTabsFromDisk, handleCompile]
  )

  // 诊断行跳转：打开/激活对应文件后滚动到目标行。
  const handleIssueClick = useCallback(
    async (issue: LatexIssue) => {
      if (!projectDir) return
      const raw = normalizeTexPath(issue.file ?? 'main.tex')
      const target = tabs.some((t) => t.name === raw)
        ? raw
        : files.includes(raw)
          ? raw
          : activeName ?? 'main.tex'
      if (!tabs.some((t) => t.name === target)) {
        const opened = await openTab(target)
        if (!opened) return
      } else {
        setActiveName(target)
      }
      if (issue.line !== undefined) {
        setFlash({ line: issue.line, nonce: ++flashNonceRef.current })
      }
    },
    [projectDir, tabs, files, activeName, openTab]
  )

  // 大纲跳转：目标行一定在当前激活文件中。
  const handleOutlineJump = useCallback((line: number) => {
    setView('editor')
    setFlash({ line, nonce: ++flashNonceRef.current })
  }, [])

  // ── 新建项目 ────────────────────────────────────────────────
  const startCreateProject = useCallback(async () => {
    if (!api) return
    const result = await api.showOpenDialog({
      title: '选择论文项目的存放位置',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return
    setProjectParent(result.filePaths[0])
    setProjectName('my-paper')
    setProjectDialogOpen(true)
  }, [api])

  const confirmCreateProject = useCallback(async () => {
    if (!api || projectParent === null) return
    const name = projectName.trim().replace(INVALID_NAME_CHARS, '_')
    if (name === '') return
    setProjectBusy(true)
    const res = await api.latex.createProject(projectParent, name)
    setProjectBusy(false)
    if (res.ok && res.projectDir) {
      setProjectDialogOpen(false)
      setProjectDir(res.projectDir)
      await loadProject(res.projectDir, 'main.tex')
      await touchRecent(res.projectDir)
    } else {
      setCompileError(res.message ?? '创建项目失败')
    }
  }, [api, projectParent, projectName, loadProject, touchRecent])

  // ── 新建章节文件 ────────────────────────────────────────────
  const confirmCreateFile = useCallback(async () => {
    if (!api || projectDir === null) return
    let name = fileName.trim().replace(/\\/g, '/')
    if (name === '' || name.startsWith('/') || INVALID_NAME_CHARS.test(name)) return
    if (!name.endsWith('.tex')) name = `${name}.tex`
    if (name.split('/').some((p) => p === '..' || p === '')) return
    const res = await api.latex.writeFile(projectDir, name, chapterTemplate(name))
    if (res.ok) {
      setFileDialogOpen(false)
      const next = Array.from(new Set([...files, name]))
      next.sort((a, b) => {
        const ma = a === 'main.tex' ? 0 : 1
        const mb = b === 'main.tex' ? 0 : 1
        return ma !== mb ? ma - mb : a.localeCompare(b)
      })
      setFiles(next)
      await openTab(name)
    } else {
      setCompileError(res.message ?? '创建文件失败')
    }
  }, [api, projectDir, fileName, files, openTab])

  // ── 快捷键：保存 ────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return
      event.preventDefault()
      if (event.shiftKey) void saveAll()
      else void saveActive()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [saveActive, saveAll])

  // ── 无项目时的欢迎/引导界面 ────────────────────────────────
  const renderWelcome = () => (
    <div className="flex min-h-full items-center justify-center">
      <div className="max-w-md py-12 text-center">
        <div className="brand-gradient mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl shadow-lg">
          <FileText className="h-7 w-7 text-white" />
        </div>
        <h2 className="text-[15px] font-semibold">LaTeX 论文工作区</h2>
        <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
          打开一个包含 <span className="font-mono">main.tex</span> 的论文文件夹，管理章节文件、
          编译生成 PDF 并定位编译诊断。编译依赖本机 latexmk（TeX Live / MacTeX）或 Tectonic。
        </p>
        <div className="mt-6 flex items-center justify-center gap-2.5">
          <Button size="sm" className="h-8 text-[12px]" onClick={chooseProjectDir}>
            <FolderOpen className="h-3.5 w-3.5" />
            打开论文文件夹
          </Button>
          <Button variant="outline" size="sm" className="h-8 text-[12px]" onClick={startCreateProject}>
            <Plus className="h-3.5 w-3.5" />
            新建论文项目
          </Button>
        </div>
        {compileError !== null && (
          <p className="mt-4 flex items-center justify-center gap-1.5 text-[11px] text-destructive">
            <CircleAlert className="h-3 w-3" />
            {compileError}
          </p>
        )}
        {recents.length > 0 && (
          <div className="mt-8 text-left">
            <p className="metric-label mb-1.5 px-1">最近打开</p>
            <div className="space-y-1">
              {recents.map((r) => (
                <button
                  key={r.dir}
                  onClick={() => void openRecent(r.dir)}
                  className="flex w-full items-center gap-2 rounded-md border border-border/70 bg-background px-3 py-2 text-left text-[12px] transition-colors hover:bg-accent"
                  title={r.dir}
                >
                  <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{r.dir.split('/').pop()}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground tabular-nums">
                    {new Date(r.at).toLocaleDateString()}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )

  const renderFileRow = (name: string) => {
    const dirty = tabs.some((t) => t.name === name && t.content !== t.saved)
    return (
      <button
        key={name}
        onClick={() => void openTab(name)}
        title={name}
        className={cn(
          'flex w-full items-center gap-1.5 rounded px-1.5 py-[3px] text-[12px] transition-colors hover:bg-accent',
          activeName === name
            ? 'bg-primary/10 font-medium text-primary hover:bg-primary/10'
            : 'text-foreground/90'
        )}
      >
        {name === 'main.tex' ? (
          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <FileCode2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate">{name.split('/').pop()}</span>
        {dirty && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />}
      </button>
    )
  }

  /** 文件资源树：根文件 + 子目录分组。 */
  const renderFileTree = () => {
    const groups = new Map<string, string[]>()
    const roots: string[] = []
    for (const f of files) {
      const parts = f.split('/')
      if (parts.length <= 1) roots.push(f)
      else {
        const group = parts.slice(0, -1).join('/')
        const names = groups.get(group) ?? []
        names.push(parts[parts.length - 1])
        groups.set(group, names)
      }
    }
    return (
      <div className="space-y-2 px-2 pb-3">
        {roots.length > 0 && (
          <div>
            <p className="metric-label px-1 pb-1">根目录</p>
            {roots.map((f) => renderFileRow(f))}
          </div>
        )}
        {[...groups.entries()].map(([group, names]) => (
          <div key={group}>
            <p className="metric-label flex items-center gap-1 px-1 pb-1" title={group}>
              <span className="truncate">{group}</span>
            </p>
            {names.map((n) => renderFileRow(`${group}/${n}`))}
          </div>
        ))}
        {files.length === 0 && (
          <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">
            该目录下暂无 .tex 文件，点击右上角「新章节」创建一个。
          </p>
        )}
      </div>
    )
  }

  /** 编辑器下方的诊断条。 */
  const renderIssuePanel = () => {
    const noneShown = issues === null || (errorCount === 0 && warningCount === 0)
    const emptyText = compileState === 'idle'
      ? '点击「编译」检查语法并生成 PDF'
      : compileState === 'done'
        ? '编译通过'
        : (compileError ?? '编译失败')
    return (
      <div className="shrink-0 border-t border-border bg-background">
        <div className="flex h-7 items-center justify-between border-b border-border/60 px-2.5">
          <div className="flex min-w-0 items-center gap-2 text-[11px]">
            {errorCount > 0 && (
              <span className="flex items-center gap-1 font-medium text-destructive">
                <CircleAlert className="h-3 w-3" />
                {errorCount} 错误
              </span>
            )}
            {warningCount > 0 && (
              <span className="flex items-center gap-1 text-warning">
                <TriangleAlert className="h-3 w-3" />
                {warningCount} 警告
              </span>
            )}
            {noneShown && (
              <span
                className={cn(
                  'flex items-center gap-1',
                  compileState === 'error' ? 'text-destructive' : 'text-muted-foreground'
                )}
              >
                {compileState === 'done' ? (
                  <Check className="h-3 w-3 text-success" />
                ) : compileState === 'error' ? (
                  <CircleAlert className="h-3 w-3 text-destructive" />
                ) : (
                  <FileText className="h-3 w-3" />
                )}
                <span className="truncate">{emptyText}</span>
              </span>
            )}
          </div>
          {compileState === 'done' && pdfSrc !== null && (
            <Button
              variant="ghost"
              size="sm"
              className="h-5 shrink-0 px-1.5 text-[10px] text-muted-foreground"
              onClick={() => setView('pdf')}
            >
              <Eye className="h-3 w-3" />
              查看 PDF
            </Button>
          )}
        </div>
        {!noneShown ? (
          <div className="max-h-32 overflow-y-auto px-1 py-0.5">
            {fixNote !== null && (
              <p className="whitespace-pre-wrap rounded bg-muted/40 px-2 py-1 text-[10px] leading-relaxed text-foreground">
                {fixNote}
              </p>
            )}
            {issues?.errors.map((issue, i) => (
              <IssueRow key={`e-${i}`} issue={issue} onJump={() => void handleIssueClick(issue)} onFix={() => void handleAiFix(issue)} />
            ))}
            {issues?.warnings.map((issue, i) => (
              <IssueRow key={`w-${i}`} issue={issue} onJump={() => void handleIssueClick(issue)} />
            ))}
          </div>
        ) : (
          compileError !== null && (
            <p className="px-2.5 py-1.5 text-[11px] leading-relaxed text-destructive">{compileError}</p>
          )
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* ── 顶栏（drag region） ─────────────────────────────── */}
      <div
        className={cn(
          'drag-region flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border',
          sidebarCollapsed ? 'pl-[76px] pr-3' : 'px-4'
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          {sidebarCollapsed && (
            <button
              onClick={onToggleSidebar}
              title="展开侧边栏"
              className="no-drag flex items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
          )}
          <span className="module-title">论文编辑</span>
          {projectDir !== null && (
            <>
              <span className="text-muted-foreground/40">/</span>
              <span className="max-w-40 truncate text-[12px] text-muted-foreground" title={projectDir}>
                {projectBasename}
              </span>
            </>
          )}
          {activeTab !== null && view === 'editor' && (
            <span className="hidden text-[10px] text-muted-foreground tabular-nums lg:inline">
              {lineCount} 行 · {cursor.line}:{cursor.column}
              {dirtyCount > 0 && <span className="ml-2 text-warning">{dirtyCount} 个未保存</span>}
            </span>
          )}
        </div>
        <div className="no-drag flex shrink-0 items-center gap-1.5">
          {engine !== null && (
            <span
              className="hidden items-center gap-1 rounded border border-border/70 bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground md:flex"
              title={`LaTeX 引擎：${engine}`}
            >
              <Check className="h-3 w-3 text-success" />
              {engine}
            </span>
          )}
          {view === 'pdf' ? (
            <Button variant="ghost" size="sm" className="h-7 text-[11px]" onClick={() => setView('editor')}>
              <Code2 className="h-3.5 w-3.5" />
              编辑器
            </Button>
          ) : (
            pdfSrc !== null && (
              <Button variant="ghost" size="sm" className="h-7 text-[11px]" onClick={() => setView('pdf')}>
                <Eye className="h-3.5 w-3.5" />
                PDF
              </Button>
            )
          )}
          <Button variant="ghost" size="sm" className="h-7 text-[11px]" onClick={chooseProjectDir} title="打开论文文件夹">
            <FolderOpen className="h-3.5 w-3.5" />
            打开
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-[11px]"
            onClick={() => (projectDir === null ? void startCreateProject() : setFileDialogOpen(true))}
            title={projectDir === null ? '新建论文项目' : '在项目中新建章节文件'}
          >
            {projectDir === null ? <Plus className="h-3.5 w-3.5" /> : <FilePlus2 className="h-3.5 w-3.5" />}
            {projectDir === null ? '新建' : '新章节'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-[11px]"
            onClick={() => void saveActive()}
            disabled={!activeDirty}
            title="保存当前文件（⌘S）"
          >
            {activeDirty ? <Save className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5 text-success" />}
            {activeDirty ? '保存' : '已保存'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-[11px]"
            onClick={() => setBibOpen(true)}
            disabled={projectDir === null}
            title="编辑 references.bib 参考文献"
          >
            <BookText className="h-3.5 w-3.5" />
            Bib
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-[11px]"
            onClick={() => setVenueOpen(true)}
            disabled={projectDir === null}
            title="写入会议排版模板要点"
          >
            <LayoutTemplate className="h-3.5 w-3.5" />
            模板
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-[11px]"
            onClick={() => setSnapshotsOpen(true)}
            disabled={projectDir === null}
            title="编译快照与回退"
          >
            <History className="h-3.5 w-3.5" />
            快照
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[11px]"
            onClick={() => void handleCompile()}
            disabled={compileState === 'compiling' || projectDir === null}
            title="用 latexmk / Tectonic 编译 main.tex（会自动先保存所有修改）"
          >
            {compileState === 'compiling' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : compileState === 'done' ? (
              <Check className="h-3.5 w-3.5 text-success" />
            ) : compileState === 'error' ? (
              <CircleAlert className="h-3.5 w-3.5 text-destructive" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            {compileState === 'compiling' ? '编译中' : compileState === 'done' ? '完成' : '编译'}
          </Button>
          {rightSidebarCollapsed && <RightSidebarExpandButton onClick={onToggleRightSidebar} className="h-7 w-7" />}
        </div>
      </div>

      {/* ── 主体 ────────────────────────────────────────────── */}
      {projectDir === null ? (
        <div className="min-h-0 flex-1 overflow-y-auto">{renderWelcome()}</div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* 左侧：项目文件树 */}
          <aside className="flex w-52 shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar">
            <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border/70 px-2">
              <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                <FolderOpen className="h-3 w-3 shrink-0" />
                <span className="truncate" title={projectDir}>{projectBasename}</span>
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => setFileDialogOpen(true)}
                title="新建章节文件"
              >
                <FilePlus2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto pt-2">{renderFileTree()}</div>
          </aside>

          {/* 中列：标签栏 + 编辑/预览 */}
          <div className="flex min-w-0 flex-1 flex-col">
            {/* 打开文件标签 */}
            <div className="flex h-9 shrink-0 items-center gap-px overflow-x-auto border-b border-border bg-muted/25 px-1">
              {tabs.length === 0 && (
                <span className="px-2 text-[11px] text-muted-foreground">从左侧打开一个 .tex 文件</span>
              )}
              {tabs.map((tab) => {
                const dirty = tab.content !== tab.saved
                const active = tab.name === activeName
                return (
                  <div
                    key={tab.name}
                    className={cn(
                      'group flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-t border border-b-0 px-2.5 text-[11px] transition-colors',
                      active
                        ? 'border-border bg-background font-medium text-foreground'
                        : 'border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                    )}
                    onClick={() => setActiveName(tab.name)}
                    onAuxClick={(event) => {
                      if (event.button === 1) closeTab(tab.name)
                    }}
                    title={tab.name}
                  >
                    <span className="max-w-28 truncate">{tab.name.split('/').pop()}</span>
                    {dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" title="未保存" />}
                    <button
                      className={cn(
                        'shrink-0 rounded text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground',
                        !active && 'hidden group-hover:block'
                      )}
                      onClick={(event) => {
                        event.stopPropagation()
                        closeTab(tab.name)
                      }}
                      title="关闭"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                )
              })}
            </div>

            {view === 'editor' ? (
              <div className="flex min-h-0 flex-1 flex-col">
                {activeTab === null ? (
                  <div className="flex flex-1 items-center justify-center">
                    <p className="text-[12px] text-muted-foreground">从左侧选择或点击「新章节」创建一个 .tex 文件</p>
                  </div>
                ) : (
                  <>
                    <div className="min-h-0 flex-1">
                      <LatexEditor
                        value={activeTab.content}
                        onChange={updateActiveContent}
                        flash={flash}
                        onCursorChange={setCursor}
                        className="h-full"
                      />
                    </div>
                    {renderIssuePanel()}
                  </>
                )}
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col bg-muted/10">
                <div className="flex h-8 shrink-0 items-center justify-between border-b border-border bg-background px-3">
                  <span className="text-[11px] text-muted-foreground">
                    {pdfSrc !== null ? 'PDF 预览' : '编译输出'}
                  </span>
                  <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={() => setView('editor')}>
                    <Code2 className="h-3 w-3" />
                    返回编辑器
                  </Button>
                </div>
                {pdfSrc === null ? (
                  <div className="flex flex-1 items-center justify-center">
                    <div className="text-center text-muted-foreground">
                      <FileText className="mx-auto mb-2 h-8 w-8 opacity-30" />
                      <p className="text-[12px]">暂无 PDF</p>
                      <p className="mt-0.5 text-[11px]">编译成功后会在此内嵌预览 main.pdf</p>
                    </div>
                  </div>
                ) : (
                  <iframe key={pdfSrc} src={pdfSrc} title="PDF 预览" className="min-h-0 flex-1 border-0 bg-white" />
                )}
              </div>
            )}
          </div>

          {/* 右侧：文档大纲 */}
          <RightSidebar collapsed={rightSidebarCollapsed} onToggle={onToggleRightSidebar}>
            <div className="p-3">
              <h3 className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold">
                <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                文档大纲
                {activeTab !== null && (
                  <span className="ml-auto truncate text-[10px] font-normal text-muted-foreground" title={activeTab.name}>
                    {activeTab.name}
                  </span>
                )}
              </h3>
              {outline.length === 0 ? (
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  打开文件后，使用 <code className="font-mono">\section</code> /{' '}
                  <code className="font-mono">\subsection</code> 创建章节，将在此列出可点击跳转的大纲。
                </p>
              ) : (
                <div className="space-y-0.5">
                  {outline.map((item, i) => (
                    <button
                      key={i}
                      onClick={() => handleOutlineJump(item.line)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] transition-colors hover:bg-muted',
                        item.level === 2 && 'pl-5 text-muted-foreground'
                      )}
                    >
                      <span className="h-1 w-1 shrink-0 rounded-full bg-primary/40" />
                      <span className="truncate">{item.title || `(第 ${item.line} 行)`}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </RightSidebar>
        </div>
      )}

      {/* ── 新建论文项目对话框 ─────────────────────────────── */}
      <Dialog open={projectDialogOpen} onOpenChange={setProjectDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>新建论文项目</DialogTitle>
            <DialogDescription>
              将在 <span className="break-all font-mono text-[11px]">{projectParent ?? ''}</span>{' '}
              下创建同名文件夹并生成 main.tex 模板。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <label className="text-[11px] text-muted-foreground">项目名称</label>
            <Input
              autoFocus
              value={projectName}
              onChange={(e) => setProjectName(e.target.value.replace(INVALID_NAME_CHARS, '_'))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void confirmCreateProject()
              }}
              placeholder="my-paper"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setProjectDialogOpen(false)}>
              取消
            </Button>
            <Button
              size="sm"
              onClick={() => void confirmCreateProject()}
              disabled={projectBusy || projectName.trim() === ''}
            >
              {projectBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── 新建章节文件对话框 ─────────────────────────────── */}
      <Dialog open={fileDialogOpen} onOpenChange={setFileDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>新建章节文件</DialogTitle>
            <DialogDescription>
              输入相对路径（可含子目录，例如 <span className="font-mono text-[11px]">chapters/intro.tex</span>），
              创建后需在 main.tex 中通过 <span className="font-mono text-[11px]">\input</span> 引用。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <label className="text-[11px] text-muted-foreground">文件名</label>
            <Input
              autoFocus
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void confirmCreateFile()
              }}
              placeholder="chapters/intro.tex"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setFileDialogOpen(false)}>
              取消
            </Button>
            <Button
              size="sm"
              onClick={() => void confirmCreateFile()}
              disabled={
                fileName.trim() === '' ||
                fileName.startsWith('/') ||
                INVALID_NAME_CHARS.test(fileName) ||
                fileName.split('/').some((p) => p === '..' || p === '')
              }
            >
              <FilePlus2 className="h-3.5 w-3.5" />
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── 编译快照对话框 ────────────────────────────────────── */}
      {snapshotsOpen && projectDir !== null && (
        <SnapshotsDialog
          projectDir={projectDir}
          onClose={() => setSnapshotsOpen(false)}
          onReverted={() => void reloadTabsFromDisk()}
        />
      )}

      {/* ── Bib / 模板 对话框 ─────────────────────────────────── */}
      {bibOpen && projectDir !== null && (
        <BibDialog projectDir={projectDir} onClose={() => setBibOpen(false)} onChanged={() => {}} />
      )}
      {venueOpen && projectDir !== null && (
        <VenueTemplateDialog projectDir={projectDir} onClose={() => setVenueOpen(false)} onChanged={() => {}} />
      )}
    </div>
  )
}

/** 诊断列表的单行（错误/警告）。 */
function IssueRow({
  issue,
  onJump,
  onFix
}: {
  issue: LatexIssue
  onJump: () => void
  onFix?: ((issue: LatexIssue) => void) | undefined
}): JSX.Element {
  const isError = issue.severity === 'error'
  const location = [normalizeTexPath(issue.file ?? ''), issue.line !== undefined ? `:${issue.line}` : ''].join('')
  return (
    <div
      className={cn(
        'group/issue flex w-full items-start gap-1 rounded px-1.5 py-1 transition-colors hover:bg-accent',
        isError ? 'text-destructive' : 'text-foreground/80'
      )}
    >
      <button
        onClick={onJump}
        className="min-w-0 flex-1 text-left"
        title="点击跳转到出错位置"
      >
      {isError ? (
        <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
      ) : (
        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
      )}
      <span className="min-w-0">
        {location !== ':' && (
          <span className={cn('font-mono', isError ? 'text-destructive' : 'text-muted-foreground')}>
            {location}{' '}
          </span>
        )}
        {issue.message}
      </span>
      </button>
      {onFix !== undefined && isError && (
        <button
          onClick={() => onFix(issue)}
          className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium text-primary opacity-0 transition-opacity hover:bg-primary/10 group-hover/issue:opacity-100"
          title="用 AI 修复该错误（自动应用后重新编译）"
        >
          AI 修复
        </button>
      )}
    </div>
  )
}
