import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { registerSettingsSession } from '@/lib/settingsGuard'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import {
  Save,
  Check,
  Globe,
  Bot,
  Loader2,
  Info,
  Plus,
  Trash2,
  KeyRound,
  Link,
  Image,
  Eye,
  EyeOff,
  Mic,
  Download,
  HardDrive,
  RotateCw,
  FolderKanban,
  FolderOpen,
  Code2,
  Palette,
  Pencil,
  Sparkles,
  Settings2,
  ListChecks
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Textarea } from '@/components/ui/textarea'
import { SettingsMemoryCard } from './SettingsMemory'
import { SettingsIdentityCard } from './SettingsIdentity'
import { SettingsSkillRoutingCard } from './SettingsSkillRouting'
import {
  COMMAND_ENTRIES,
  SKILL_ENTRIES,
  loadUserSkills,
  saveUserSkills,
  createUserSkill,
  validateUserSkillDraft,
  parseUserSkillPayload,
  userSkillToEntry,
  USER_SKILL_ARGS_PLACEHOLDER
} from '@/lib/slash'
import type { SlashEntry, UserSkill, UserSkillDraft } from '@/lib/slash'

interface ModelConfig {
  id: string
  baseUrl: string
  modelId: string
  apiKey: string
  supportsImages: boolean
}

const EMPTY_MODEL_FORM = {
  baseUrl: '',
  modelId: '',
  apiKey: '',
  supportsImages: false
}

/** 「导入技能」手动表单的空白草稿。 */
const EMPTY_SKILL_DRAFT: UserSkillDraft = {
  trigger: '',
  title: '',
  description: '',
  whenToUse: '',
  argsHint: '',
  usage: '',
  body: ''
}

/** 技能管理弹窗中的一行（左：标题/触发词/说明；右：详情 + 可选删除）。 */
function SkillRow({
  title,
  trigger,
  description,
  onOpen,
  onDelete
}: {
  title: string
  trigger: string
  description: string
  onOpen: () => void
  onDelete?: () => void
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2.5">
      <button type="button" className="min-w-0 flex-1 cursor-pointer text-left" onClick={onOpen} title="查看详情">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-[12px] font-semibold text-foreground">{title}</span>
          <span className="shrink-0 rounded-full bg-emerald-500/10 px-1.5 py-px text-[9px] font-medium text-emerald-600">
            技能
          </span>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">/{trigger}</span>
        </div>
        {description !== '' && (
          <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{description}</p>
        )}
      </button>
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={onOpen}
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="查看详情"
        >
          <Eye className="h-3.5 w-3.5" />
        </button>
        {onDelete !== undefined && (
          <button
            type="button"
            onClick={onDelete}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            title="删除技能"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

interface SpaceItem {
  id: string
  name: string
  path: string
  createdAt: string
  updatedAt: string
}

/** 与主进程 SENSE_VOICE_MODEL.id 保持一致。 */
const SENSE_VOICE_RESOURCE_ID = 'sense-voice-int8'

/** 参与「未保存更改」比对的设置快照。语言等未提供修改入口的字段不纳入。 */
/** 工作台背景图配置。dim ∈ [0,1]：数值越大遮罩越浓、文字越易读（0 为背景全透出）。 */
export interface WallpaperConfig {
  path: string
  dim: number
}

interface SettingsSnapshot {
  models: ModelConfig[]
  selectedModelId: string
  theme: string
  speechEngine: 'local' | 'web'
  imageGen: { baseUrl: string; modelId: string; apiKey: string }
  wallpaper: WallpaperConfig
}

function imageGenSnapshotOf(s: Record<string, unknown> | undefined): { baseUrl: string; modelId: string; apiKey: string } {
  const raw = s?.imageGen
  if (typeof raw !== 'object' || raw === null) return { baseUrl: '', modelId: '', apiKey: '' }
  const config = raw as Record<string, unknown>
  return {
    baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl : '',
    modelId: typeof config.modelId === 'string' ? config.modelId : '',
    apiKey: typeof config.apiKey === 'string' ? config.apiKey : ''
  }
}

function wallpaperSnapshotOf(s: Record<string, unknown> | undefined): WallpaperConfig {
  const raw = s?.wallpaper
  if (typeof raw !== 'object' || raw === null) return { path: '', dim: 0.6 }
  const cfg = raw as Record<string, unknown>
  const dim = typeof cfg.dim === 'number' && Number.isFinite(cfg.dim) ? Math.min(Math.max(cfg.dim, 0), 1) : 0.6
  return { path: typeof cfg.path === 'string' ? cfg.path : '', dim }
}

function settingsSnapshotOf(s: Record<string, unknown> | undefined): SettingsSnapshot {
  return {
    models: Array.isArray(s?.models) ? (s.models as ModelConfig[]) : [],
    selectedModelId: typeof s?.selectedModelId === 'string' ? s.selectedModelId : '',
    theme: typeof s?.theme === 'string' ? s.theme : 'system',
    speechEngine: s?.speechEngine === 'local' ? 'local' : 'web',
    imageGen: imageGenSnapshotOf(s),
    wallpaper: wallpaperSnapshotOf(s)
  }
}

interface ResourceInfo {
  id: string
  name: string
  description: string
  sizeBytes: number
  installed: boolean
}

interface SettingsProps {
  /** 引导用：该值递增时自动打开「添加模型」弹窗（用于首次启动引导第二步）。 */
  autoOpenModelDialog?: number | undefined
  /** 引导用：当前处于首次引导第二步（添加模型）。 */
  guided?: boolean | undefined
  /** 引导用：用户关闭/完成添加模型弹窗后通知 App 进入第三步。 */
  onModelStepDone?: (() => void) | undefined
  /** 保存设置成功后通知 App 同步主题（App 顶层 state 与 Settings 本地各持有一份）。 */
  onThemeSaved?: ((theme: string) => void) | undefined
}

// ─── 设置分页 ────────────────────────────────────────────────────────────────
type SettingsTab = 'models' | 'appearance' | 'agent' | 'spaces' | 'resources' | 'about'
const SETTINGS_TABS: { id: SettingsTab; label: string; icon: React.ElementType; desc: string }[] = [
  { id: 'models', label: '模型', icon: Bot, desc: '管理可用的 LLM 模型配置与图像生成端点，点击选择当前使用的模型。' },
  { id: 'appearance', label: '外观', icon: Palette, desc: '选择应用主题与工作台背景。' },
  { id: 'agent', label: 'Agent', icon: Sparkles, desc: '技能路由、身份与默认值、长期记忆等 Agent 行为设置。' },
  { id: 'spaces', label: '科研空间', icon: FolderKanban, desc: '每个科研空间是一个独立目录，承载论文、实验、图表、组会与对话等数据。' },
  { id: 'resources', label: '语音与资源', icon: Mic, desc: '语音识别引擎与本地组件资源下载。' },
  { id: 'about', label: '关于', icon: Info, desc: '应用信息。' }
]

export function Settings({ autoOpenModelDialog = 0, guided = false, onModelStepDone, onThemeSaved }: SettingsProps) {
  const [tab, setTab] = useState<SettingsTab>('models')
  const [models, setModels] = useState<ModelConfig[]>([])
  const [selectedModelId, setSelectedModelId] = useState<string>('')
  const [theme, setTheme] = useState('system')
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  /** 已保存设置的快照（加载完成后写入）；null 表示尚未完成加载。 */
  const [baselineKey, setBaselineKey] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  /** 正在编辑的模型 id；null 表示「添加模型」（弹窗共用）。 */
  const [editingModelId, setEditingModelId] = useState<string | null>(null)
  const [form, setForm] = useState(EMPTY_MODEL_FORM)
  const [showApiKeyInList, setShowApiKeyInList] = useState<Record<string, boolean>>({})
  const [showApiKeyInForm, setShowApiKeyInForm] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  // 模型发现（Issue 2）：按 baseUrl + apiKey 拉取 /v1/models，结果展示为下拉。
  const [listingModels, setListingModels] = useState(false)
  const [modelList, setModelList] = useState<{ id: string; ownedBy?: string }[]>([])
  const [modelListEndpoint, setModelListEndpoint] = useState('')
  const [modelListMsg, setModelListMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  // ── Harness 选择（Issue 1）─────────────────────────────────────────
  const [harnessList, setHarnessList] = useState<{ id: string; name: string; kind: string; available: boolean }[]>([])
  const [activeHarnessId, setActiveHarnessId] = useState('mimir')
  const [harnessBusy, setHarnessBusy] = useState(false)
  const [harnessMsg, setHarnessMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  const [speechEngine, setSpeechEngine] = useState<'local' | 'web'>('web')
  const [imgGenBaseUrl, setImgGenBaseUrl] = useState('')
  const [imgGenModelId, setImgGenModelId] = useState('')
  const [imgGenApiKey, setImgGenApiKey] = useState('')
  const [imgKeyVisible, setImgKeyVisible] = useState(false)
  // ── 背景图（工作台主区域） ──────────────────────────────────────
  const [wallpaperPath, setWallpaperPath] = useState('')
  const [wallpaperDataUrl, setWallpaperDataUrl] = useState('')
  const [wallpaperDim, setWallpaperDim] = useState(0.6)
  const [wallpaperMsg, setWallpaperMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)
  const [voiceDialogOpen, setVoiceDialogOpen] = useState(false)
  const [resources, setResources] = useState<ResourceInfo[]>([])
  const [resourcesLoading, setResourcesLoading] = useState(false)
  const [resourceLoadError, setResourceLoadError] = useState<string | null>(null)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [downloadProgress, setDownloadProgress] = useState<Record<string, number>>({})
  const [downloadError, setDownloadError] = useState<Record<string, string>>({})

  // SenseVoice 模型资源（用于语音识别区块的快捷下载入口）
  const senseVoiceResource = resources.find((r) => r.id === 'sense-voice-int8')

  // ── 技能管理（内置 skills 只读；自定义技能来自「导入技能」）─────────
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [userSkills, setUserSkills] = useState<UserSkill[]>([])
  const [skillDetail, setSkillDetail] = useState<
    { source: 'builtin'; entry: SlashEntry } | { source: 'custom'; skill: UserSkill } | null
  >(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importTab, setImportTab] = useState<'form' | 'json'>('form')
  const [importForm, setImportForm] = useState<UserSkillDraft>(EMPTY_SKILL_DRAFT)
  const [importJson, setImportJson] = useState('')
  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  /** 详情弹窗所需：统一为 SlashEntry + 正文（仅自定义技能有可编辑正文）。 */
  const skillDetailEntry = skillDetail !== null
    ? skillDetail.source === 'builtin'
      ? skillDetail.entry
      : userSkillToEntry(skillDetail.skill)
    : null
  const skillDetailBody = skillDetail?.source === 'custom' ? skillDetail.skill.body : null

  const refreshUserSkills = useCallback(async () => {
    try {
      setUserSkills(await loadUserSkills())
    } catch {
      setUserSkills([])
    }
  }, [])

  const openSkillImport = useCallback(() => {
    setImportForm(EMPTY_SKILL_DRAFT)
    setImportJson('')
    setImportTab('form')
    setImportMsg(null)
    setImportOpen(true)
  }, [])

  /** 提交一批草稿：逐条校验（语法 + 与内置/已导入的触发词查重），通过则创建并落盘。 */
  const confirmImportSkills = useCallback(async () => {
    setImporting(true)
    setImportMsg(null)
    try {
      const drafts: UserSkillDraft[] = []
      let structuralErrors: string[] = []
      if (importTab === 'json') {
        let parsed: unknown
        try {
          parsed = JSON.parse(importJson.trim())
        } catch {
          setImportMsg({ type: 'error', text: 'JSON 格式不正确，请检查后重试。' })
          return
        }
        const result = parseUserSkillPayload(parsed)
        structuralErrors = result.errors
        drafts.push(...result.drafts)
        if (drafts.length === 0) {
          setImportMsg({
            type: 'error',
            text: structuralErrors.length > 0 ? structuralErrors.join('\n') : '没有可导入的技能（请提供含 trigger/title/body 的对象）。'
          })
          return
        }
      } else {
        drafts.push(importForm)
      }

      const taken = new Set<string>([
        ...COMMAND_ENTRIES.map((e) => e.trigger),
        ...SKILL_ENTRIES.map((e) => e.trigger),
        ...userSkills.map((s) => s.trigger)
      ])
      const added: UserSkill[] = []
      const errors: string[] = [...structuralErrors]
      for (const draft of drafts) {
        const triggerLabel = draft.trigger.trim() === '' ? '（触发词为空）' : `/${draft.trigger.trim()}`
        const issues = validateUserSkillDraft(draft, taken)
        if (issues.length > 0) {
          errors.push(`${triggerLabel}：${issues.join('；')}`)
          continue
        }
        const skill = createUserSkill(draft)
        added.push(skill)
        taken.add(skill.trigger)
      }

      if (added.length > 0) {
        const next = [...userSkills, ...added]
        setUserSkills(next)
        await saveUserSkills(next)
      }
      if (importTab === 'form') setImportForm(EMPTY_SKILL_DRAFT)
      else setImportJson('')

      const lines: string[] = []
      if (added.length > 0) lines.push(`已导入 ${added.length} 个技能，可在聊天输入框直接使用。`)
      if (errors.length > 0) lines.push(errors.join('\n'))
      if (lines.length === 0) lines.push('没有新增技能。')
      setImportMsg({ type: added.length > 0 && errors.length === 0 ? 'ok' : 'error', text: lines.join('\n') })
    } finally {
      setImporting(false)
    }
  }, [importTab, importJson, importForm, userSkills])

  /** 删除自定义技能（内置技能不可删）。 */
  const handleDeleteUserSkill = useCallback(
    async (skill: UserSkill) => {
      if (!window.confirm(`删除自定义技能「${skill.title}」？\n触发词 /${skill.trigger} 将从斜杠菜单移除。`)) return
      const next = userSkills.filter((s) => s.id !== skill.id)
      setUserSkills(next)
      if (skillDetail !== null && skillDetail.source === 'custom' && skillDetail.skill.id === skill.id) {
        setSkillDetail(null)
      }
      await saveUserSkills(next).catch(() => {})
    },
    [userSkills, skillDetail]
  )

  // 挂载时刷新一次自定义技能（供页内统计展示）
  useEffect(() => {
    void refreshUserSkills()
  }, [refreshUserSkills])

  // 背景路径变化时读取 dataUrl 用于预览（仅桌面端可用）
  useEffect(() => {
    let alive = true
    if (!wallpaperPath || !window.electronAPI?.readImageDataUrl) {
      setWallpaperDataUrl('')
      return
    }
    window.electronAPI
      .readImageDataUrl(wallpaperPath)
      .then((res) => {
        if (alive && res.ok && res.dataUrl) setWallpaperDataUrl(res.dataUrl)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [wallpaperPath])

  /** 选一张本地图片作为工作台背景（记忆路径，随「保存设置」落盘）。 */
  const handlePickWallpaper = useCallback(async () => {
    const api = window.electronAPI
    setWallpaperMsg(null)
    if (!api?.showOpenDialog) {
      setWallpaperMsg({ type: 'error', text: '选择本地背景图需要桌面端运行（当前环境未提供文件选择接口）。' })
      return
    }
    if (!api.readImageDataUrl) {
      setWallpaperMsg({ type: 'error', text: '当前运行的版本尚未启用背景图能力：请完全退出应用后重新启动（preload 已更新）。' })
      return
    }
    const res = await api.showOpenDialog({
      title: '选择背景图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
    })
    if (res.canceled || res.filePaths.length === 0) return
    const picked = res.filePaths[0] ?? ''
    if (picked !== '') {
      setWallpaperPath(picked)
      setWallpaperMsg(null)
    }
  }, [])

  const handleClearWallpaper = useCallback(() => {
    setWallpaperPath('')
    setWallpaperDataUrl('')
    setWallpaperMsg(null)
  }, [])

  useEffect(() => {
    const applySettings = (s: Record<string, unknown>) => {
      if (s.models) setModels(s.models as ModelConfig[])
      if (s.selectedModelId) setSelectedModelId(s.selectedModelId as string)
      if (s.theme) setTheme(s.theme as string)
      if (s.speechEngine) setSpeechEngine(s.speechEngine as 'local' | 'web')
      const img = imageGenSnapshotOf(s as Record<string, unknown>)
      setImgGenBaseUrl(img.baseUrl)
      setImgGenModelId(img.modelId)
      setImgGenApiKey(img.apiKey)
      const wp = wallpaperSnapshotOf(s as Record<string, unknown>)
      setWallpaperPath(wp.path)
      setWallpaperDim(wp.dim)
    }

    if (window.electronAPI) {
      window.electronAPI.getSettings().then((settings) => {
        applySettings(settings as Record<string, unknown>)
        setBaselineKey(JSON.stringify(settingsSnapshotOf(settings as Record<string, unknown>)))
      })
    } else {
      // 浏览器降级：从 localStorage 读取
      try {
        const cached = localStorage.getItem('mimir-settings')
        if (cached) {
          const parsed = JSON.parse(cached) as Record<string, unknown>
          applySettings(parsed)
          setBaselineKey(JSON.stringify(settingsSnapshotOf(parsed)))
        }
      } catch {
        // ignore
      }
    }
  }, [])

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'dark') root.classList.add('dark')
    else if (theme === 'light') root.classList.remove('dark')
    else {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      if (prefersDark) root.classList.add('dark')
      else root.classList.remove('dark')
    }
  }, [theme])

  // 加载资源下载状态（可重试）
  const loadResourceStatus = useCallback(async () => {
    const api = window.electronAPI
    if (!api?.getResourceStatus) {
      setResourceLoadError('当前环境未暴露资源接口（window.electronAPI 缺失）')
      return
    }
    setResourcesLoading(true)
    setResourceLoadError(null)
    try {
      const result = await api.getResourceStatus()
      const list = Array.isArray(result?.resources) ? result.resources : []
      setResources(list)
      if (list.length === 0) setResourceLoadError('主进程返回的资源列表为空')
    } catch (error) {
      setResourceLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setResourcesLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadResourceStatus()
  }, [loadResourceStatus])

  // 监听资源下载进度（退订由 preload 提供的 cleanup 完成，避免挂载叠加监听）
  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onResourceProgress) return
    const off = api.onResourceProgress((info) => {
      if (info.status === 'done') {
        setDownloadingId(null)
        setDownloadProgress((prev) => ({ ...prev, [info.resourceId]: 100 }))
        // 刷新资源状态
        void loadResourceStatus()
      } else if (info.status === 'error') {
        setDownloadingId(null)
        setDownloadError((prev) => ({ ...prev, [info.resourceId]: info.message || '下载失败' }))
      } else {
        setDownloadProgress((prev) => ({ ...prev, [info.resourceId]: info.percent }))
      }
    })
    return () => {
      off()
    }
  }, [loadResourceStatus])

  // ── Harness 加载与切换（Issue 1）──────────────────────────────────
  const loadHarnesses = useCallback(async () => {
    if (!window.electronAPI?.harness?.list) return
    try {
      const res = await window.electronAPI.harness.list()
      setHarnessList(res.harnesses)
      setActiveHarnessId(res.activeId)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { void loadHarnesses() }, [loadHarnesses])

  const handleSelectHarness = useCallback(async (id: string) => {
    if (!window.electronAPI?.harness?.setActive || id === activeHarnessId) return
    setHarnessBusy(true)
    setHarnessMsg(null)
    try {
      const res = await window.electronAPI.harness.setActive(id)
      if (res.ok) {
        setActiveHarnessId(id)
        setHarnessMsg({ type: 'ok', text: `已切换到「${id}」Harness` })
      } else {
        setHarnessMsg({ type: 'error', text: res.message ?? '切换失败' })
      }
    } catch {
      setHarnessMsg({ type: 'error', text: '切换失败' })
    } finally {
      setHarnessBusy(false)
    }
  }, [activeHarnessId])

  const handleDownloadResource = useCallback(async (resourceId: string) => {
    if (!window.electronAPI?.downloadResource) return
    setDownloadingId(resourceId)
    setDownloadError((prev) => ({ ...prev, [resourceId]: '' }))
    setDownloadProgress((prev) => ({ ...prev, [resourceId]: 0 }))
    const result = await window.electronAPI.downloadResource(resourceId)
    if (!result.ok) {
      setDownloadingId(null)
      setDownloadError((prev) => ({ ...prev, [resourceId]: result.message || '下载失败' }))
    }
  }, [])

  // 选择识别引擎：默认 Web；切本地时若模型未下载先弹确认，确认后自动下载
  const handleSelectSpeechEngine = useCallback(
    (engine: 'local' | 'web') => {
      if (engine === 'web') {
        setSpeechEngine('web')
        return
      }
      if (senseVoiceResource?.installed === true) {
        setSpeechEngine('local')
        return
      }
      setVoiceDialogOpen(true)
    },
    [senseVoiceResource]
  )

  // 确认弹窗：切到本地引擎并自动开始下载 SenseVoice 模型
  const confirmDownloadSenseVoice = useCallback(() => {
    setVoiceDialogOpen(false)
    setSpeechEngine('local')
    void handleDownloadResource(SENSE_VOICE_RESOURCE_ID)
  }, [handleDownloadResource])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      const imageGen = { baseUrl: imgGenBaseUrl.trim(), modelId: imgGenModelId.trim(), apiKey: imgGenApiKey.trim() }
      // 合并写回：仅覆盖本页管理的字段，保留 zotero 等其它模块写入 settings 的配置，
      // 避免「保存设置」把 Zotero 等配置悄悄抹掉。
      let stored: Record<string, unknown> = {}
      if (window.electronAPI) {
        stored = ((await window.electronAPI.getSettings()) ?? {}) as Record<string, unknown>
      } else {
        try {
          const cached = localStorage.getItem('mimir-settings')
          if (cached) stored = JSON.parse(cached) as Record<string, unknown>
        } catch {
          // ignore
        }
      }
      const wallpaper = { path: wallpaperPath, dim: wallpaperDim }
      const settings = { ...stored, models, selectedModelId, theme, speechEngine, imageGen, wallpaper }
      if (window.electronAPI) {
        await window.electronAPI.setSettings(settings)
      } else {
        // 浏览器降级：写入 localStorage
        localStorage.setItem('mimir-settings', JSON.stringify(settings))
      }
      setSaved(true)
      // 落盘成功后同步基线，避免保存完仍被判定为未保存
      setBaselineKey(JSON.stringify({ models, selectedModelId, theme, speechEngine, imageGen, wallpaper }))
      onThemeSaved?.(theme)
      // 通知 App 立即刷新工作台背景（无需切模块）
      window.dispatchEvent(new Event('mimir:settings-saved'))
      // 通知对话 Tab 模型下拉同步选中（保存设置同样会落盘 models/selectedModelId）
      window.dispatchEvent(new Event('mimir:models-config-changed'))
      setTimeout(() => setSaved(false), 2000)
    } catch (error) {
      console.error('handleSave failed:', error)
    } finally {
      setSaving(false)
    }
  }, [models, selectedModelId, theme, speechEngine, imgGenBaseUrl, imgGenModelId, imgGenApiKey, wallpaperPath, wallpaperDim, onThemeSaved])

  /**
   * 仅持久化「模型列表 + 当前选择」：合并到已存配置后整体写回，并把基线同步到
   * 落盘内容对应的快照。这样添加/删除/切换模型立即可用（主进程会据此初始化
   * Agent），无需等页面底部的「保存设置」；其它未保存字段不受影响。
   */
  const persistModelsNow = useCallback(async (list: ModelConfig[], selectedId: string) => {
    try {
      let stored: Record<string, unknown> = {}
      if (window.electronAPI) {
        stored = ((await window.electronAPI.getSettings()) ?? {}) as Record<string, unknown>
        const next = { ...stored, models: list, selectedModelId: selectedId }
        await window.electronAPI.setSettings(next)
        setBaselineKey(JSON.stringify(settingsSnapshotOf(next)))
      } else {
        try {
          const cached = localStorage.getItem('mimir-settings')
          if (cached) stored = JSON.parse(cached) as Record<string, unknown>
        } catch {
          // ignore
        }
        const next = { ...stored, models: list, selectedModelId: selectedId }
        localStorage.setItem('mimir-settings', JSON.stringify(next))
        setBaselineKey(JSON.stringify(settingsSnapshotOf(next)))
      }
      // 通知对话 Tab 等其它模型选择入口即时同步（增删改/切换都会落盘 models/selectedModelId）
      window.dispatchEvent(new Event('mimir:models-config-changed'))
    } catch {
      // 持久化失败忽略：下次点「保存设置」仍可兜底
    }
  }, [])

  // ── 未保存更改跟踪（切换模块时的离开守卫） ───────────────────
  const snapshotKey = useMemo(
    () =>
      JSON.stringify({
        models,
        selectedModelId,
        theme,
        speechEngine,
        imageGen: { baseUrl: imgGenBaseUrl.trim(), modelId: imgGenModelId.trim(), apiKey: imgGenApiKey.trim() },
        wallpaper: { path: wallpaperPath, dim: wallpaperDim }
      }),
    [models, selectedModelId, theme, speechEngine, imgGenBaseUrl, imgGenModelId, imgGenApiKey, wallpaperPath, wallpaperDim]
  )
  const dirty = baselineKey !== null && baselineKey !== snapshotKey
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const handleSaveRef = useRef(handleSave)
  handleSaveRef.current = handleSave

  // 注册离开守卫会话：App 切换模块前询问 isDirty / save
  useEffect(() => {
    registerSettingsSession({
      isDirty: () => dirtyRef.current,
      save: async () => {
        await handleSaveRef.current()
      }
    })
    return () => registerSettingsSession(null)
  }, [])

  // 与对话 Tab 的模型下拉保持双向一致：对话里切换模型后，刷新本页「当前模型」高亮。
  // 自身变更也广播同事件，此处按 settings 已落盘值同步，重复收到为幂等 no-op。
  useEffect(() => {
    const onModelsChanged = (): void => {
      void (async () => {
        try {
          const s = ((await window.electronAPI?.getSettings?.()) ?? {}) as Record<string, unknown>
          const sid = s.selectedModelId
          if (typeof sid === 'string' && sid !== '') {
            setSelectedModelId((prev) => (sid !== prev ? sid : prev))
          }
        } catch {
          // ignore
        }
      })()
    }
    window.addEventListener('mimir:models-config-changed', onModelsChanged)
    return () => window.removeEventListener('mimir:models-config-changed', onModelsChanged)
  }, [])

  // 首次引导第二步：外部请求自动打开「添加模型」弹窗
  useEffect(() => {
    if (autoOpenModelDialog > 0) {
      resetModelDialog()
      setDialogOpen(true)
    }
  }, [autoOpenModelDialog])

  // 引导中：模型弹窗关闭（保存成功或手动关闭）→ 通知 App 进入第三步
  const modelDialogPrevRef = useRef(false)
  useEffect(() => {
    const prev = modelDialogPrevRef.current
    modelDialogPrevRef.current = dialogOpen
    if (guided && prev && !dialogOpen) {
      onModelStepDone?.()
    }
  }, [dialogOpen, guided, onModelStepDone])

  /** 重置模型弹窗（新增/编辑共用；不影响 dialog 开关本身）。 */
  const resetModelDialog = useCallback(() => {
    setEditingModelId(null)
    setForm(EMPTY_MODEL_FORM)
    setTestResult(null)
    setModelList([])
    setModelListMsg(null)
    setModelListEndpoint('')
    setModelPickerOpen(false)
  }, [])

  /** 进入「编辑模型」：预填现有字段并保留 id，复用同一弹窗。 */
  const openEditModel = useCallback((model: ModelConfig) => {
    setEditingModelId(model.id)
    setForm({
      baseUrl: model.baseUrl,
      modelId: model.modelId,
      apiKey: model.apiKey,
      supportsImages: model.supportsImages === true
    })
    setTestResult(null)
    setDialogOpen(true)
  }, [])

  /** 拉取 /v1/models：供「获取模型列表」按钮使用，复用 issue 2 规范的 URL 归一化。
   *  baseUrl / apiKey 为空时直接给出错误提示，不会发送请求。 */
  const handleFetchModels = useCallback(async () => {
    if (!form.baseUrl || !form.apiKey) {
      setModelListMsg({ type: 'error', text: '请先填写请求地址和 API Key。' })
      setModelList([])
      setModelPickerOpen(false)
      return
    }
    if (!window.electronAPI?.listModels) {
      setModelListMsg({ type: 'error', text: '当前环境未暴露模型发现接口（preload 缺失）。' })
      return
    }
    setListingModels(true)
    setModelListMsg(null)
    setModelList([])
    setModelPickerOpen(false)
    try {
      const res = await window.electronAPI.listModels({ baseUrl: form.baseUrl, apiKey: form.apiKey })
      if (res.endpoint) setModelListEndpoint(res.endpoint)
      if (!res.ok || !res.models) {
        setModelListMsg({ type: 'error', text: res.message ?? '获取模型列表失败' })
        return
      }
      setModelList(res.models)
      setModelPickerOpen(res.models.length > 0)
      setModelListMsg({
        type: 'ok',
        text: res.endpoint
          ? `已发现 ${res.models.length} 个模型（来源：${res.endpoint}）`
          : `已发现 ${res.models.length} 个模型`
      })
    } catch (error) {
      setModelListMsg({ type: 'error', text: error instanceof Error ? error.message : '请求失败' })
    } finally {
      setListingModels(false)
    }
  }, [form.baseUrl, form.apiKey])

  /** 关闭「添加/编辑」弹窗或切换 baseUrl 时清空已拉取的模型列表，避免误导。 */
  useEffect(() => {
    setModelList([])
    setModelPickerOpen(false)
    setModelListMsg(null)
    setModelListEndpoint('')
  }, [form.baseUrl])

  /** 新增或编辑模型的统一保存：先连通测试，成功后按 id 覆盖（编辑）或追加（新增）并立即落盘。 */
  const handleSaveModel = useCallback(async () => {
    if (!form.baseUrl || !form.modelId || !form.apiKey) return
    setTesting(true)
    setTestResult(null)

    try {
      let result: { ok: boolean; message: string }
      if (window.electronAPI?.testModel) {
        result = await window.electronAPI.testModel({
          baseUrl: form.baseUrl,
          modelId: form.modelId,
          apiKey: form.apiKey
        })
      } else {
        // 浏览器降级：直接 fetch 测试
        const url = `${form.baseUrl.replace(/\/+$/, '')}/chat/completions`
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 15000)
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${form.apiKey}`
          },
          body: JSON.stringify({
            model: form.modelId,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 1,
            stream: false
          }),
          signal: controller.signal
        })
        clearTimeout(timeout)
        if (!response.ok) {
          const text = await response.text().catch(() => '')
          result = { ok: false, message: `HTTP ${response.status}: ${text.slice(0, 200)}` }
        } else {
          result = { ok: true, message: '连接成功' }
        }
      }

      setTestResult(result)
      if (!result.ok) return

      if (editingModelId !== null) {
        // 编辑：保留原 id 覆盖字段，当前选中不受影响
        const updated = models.map((m) =>
          m.id === editingModelId
            ? {
                ...m,
                baseUrl: form.baseUrl,
                modelId: form.modelId,
                apiKey: form.apiKey,
                supportsImages: form.supportsImages === true
              }
            : m
        )
        setModels(updated)
        setDialogOpen(false)
        resetModelDialog()
        // 立即落盘，让主进程 Agent 使用新配置（模型行重新初始化）
        await persistModelsNow(updated, selectedModelId)
        return
      }

      const newModel: ModelConfig = {
        id: `model-${Date.now()}`,
        baseUrl: form.baseUrl,
        modelId: form.modelId,
        apiKey: form.apiKey,
        supportsImages: form.supportsImages
      }

      const updated = [...models, newModel]
      const selectedAfter = selectedModelId === '' ? newModel.id : selectedModelId
      setModels(updated)
      setDialogOpen(false)
      resetModelDialog()

      if (selectedModelId === '') {
        setSelectedModelId(newModel.id)
      }
      // 立即落盘，让主进程 Agent 与对话模块能马上使用新模型
      await persistModelsNow(updated, selectedAfter)
    } catch (error) {
      setTestResult({
        ok: false,
        message: error instanceof Error ? error.message : '连接失败'
      })
    } finally {
      setTesting(false)
    }
  }, [form, models, selectedModelId, persistModelsNow, editingModelId, resetModelDialog])

  const handleDeleteModel = useCallback(
    (id: string) => {
      const updated = models.filter((m) => m.id !== id)
      const nextSelected = selectedModelId === id ? (updated[0]?.id ?? '') : selectedModelId
      setModels(updated)
      if (selectedModelId === id) {
        setSelectedModelId(nextSelected)
      }
      // 删除也立即落盘，避免退出设置后模型仍"残留在内存"
      void persistModelsNow(updated, nextSelected)
    },
    [models, selectedModelId, persistModelsNow]
  )

  /** 点击模型行选择为当前使用模型：即时持久化（否则要等「保存设置」才生效）。 */
  const handleSelectModel = useCallback(
    (id: string) => {
      if (id === selectedModelId) return
      setSelectedModelId(id)
      void persistModelsNow(models, id)
    },
    [models, selectedModelId, persistModelsNow]
  )

  const toggleApiKeyVisibility = useCallback((id: string) => {
    setShowApiKeyInList((prev) => ({ ...prev, [id]: !prev[id] }))
  }, [])

  // ── 科研空间 ──────────────────────────────────────────────────────
  const [spaces, setSpaces] = useState<SpaceItem[]>([])
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null)
  const [defaultSpaceId, setDefaultSpaceId] = useState<string | null>(null)
  const [spaceDialogOpen, setSpaceDialogOpen] = useState(false)
  const [spaceName, setSpaceName] = useState('')
  const [spaceDir, setSpaceDir] = useState('')
  const [spaceBusy, setSpaceBusy] = useState<string | null>(null)
  const [spaceMsg, setSpaceMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  const refreshSpaces = useCallback(async () => {
    const api = window.electronAPI?.workspaces
    if (!api) return
    try {
      const res = await api.list()
      if (res.ok && res.workspaces) {
        setSpaces(res.workspaces)
        setActiveSpaceId(res.activeId ?? null)
        setDefaultSpaceId(res.defaultId ?? null)
      }
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    void refreshSpaces()
  }, [refreshSpaces])

  const handleSwitchSpace = useCallback(
    async (id: string) => {
      const api = window.electronAPI?.workspaces
      if (!api) return
      setSpaceBusy(id)
      setSpaceMsg(null)
      try {
        const res = await api.switch(id)
        if (res.ok) {
          await refreshSpaces()
          setSpaceMsg({ type: 'ok', text: `已切换到「${res.workspace?.name ?? ''}」，切换后各模块将从该空间读取数据。` })
        } else {
          setSpaceMsg({ type: 'error', text: res.message ?? '切换失败' })
        }
      } catch {
        setSpaceMsg({ type: 'error', text: '切换失败' })
      } finally {
        setSpaceBusy(null)
      }
    },
    [refreshSpaces]
  )

  const handleSetDefaultSpace = useCallback(
    async (id: string) => {
      const api = window.electronAPI?.workspaces
      if (!api) return
      setSpaceBusy(id)
      setSpaceMsg(null)
      try {
        const res = await api.setDefault(id)
        if (res.ok) {
          await refreshSpaces()
          setSpaceMsg({ type: 'ok', text: '已设为默认科研空间' })
        } else {
          setSpaceMsg({ type: 'error', text: res.message ?? '设置失败' })
        }
      } finally {
        setSpaceBusy(null)
      }
    },
    [refreshSpaces]
  )

  const handleRemoveSpace = useCallback(
    async (space: SpaceItem) => {
      const api = window.electronAPI?.workspaces
      if (!api) return
      if (!window.confirm(`确定从列表移除「${space.name}」吗？\n磁盘上的文件不会被删除，仅移除注册。`)) return
      setSpaceBusy(space.id)
      setSpaceMsg(null)
      try {
        const res = await api.remove(space.id)
        if (res.ok) {
          await refreshSpaces()
          setSpaceMsg({ type: 'ok', text: '已移除该空间注册（文件保留在磁盘）' })
        } else {
          setSpaceMsg({ type: 'error', text: res.message ?? '移除失败' })
        }
      } finally {
        setSpaceBusy(null)
      }
    },
    [refreshSpaces]
  )

  const handleCreateSpace = useCallback(async () => {
    const api = window.electronAPI?.workspaces
    if (!api || !spaceName.trim()) return
    setSpaceBusy('create')
    setSpaceMsg(null)
    try {
      const res = await api.create(spaceName.trim(), spaceDir.trim() === '' ? undefined : spaceDir.trim())
      if (res.ok) {
        await refreshSpaces()
        setSpaceDialogOpen(false)
        setSpaceName('')
        setSpaceDir('')
        if (res.workspace) {
          setSpaceMsg({
            type: 'ok',
            text: `已创建科研空间「${res.workspace.name}」（${res.workspace.path}）`
          })
        }
      } else {
        setSpaceMsg({ type: 'error', text: res.message ?? '创建失败' })
      }
    } catch {
      setSpaceMsg({ type: 'error', text: '创建失败' })
    } finally {
      setSpaceBusy(null)
    }
  }, [spaceName, spaceDir, refreshSpaces])

  const handlePickSpaceDir = useCallback(async () => {
    if (!window.electronAPI?.showOpenDialog) return
    const res = await window.electronAPI.showOpenDialog({
      title: '选择科研空间目录',
      buttonLabel: '选择此目录',
      properties: ['openDirectory', 'createDirectory']
    })
    if (!res.canceled && res.filePaths.length > 0) {
      const picked = res.filePaths[0] ?? ''
      setSpaceDir(picked)
      // 空间名称自动对齐所选路径的最后一个文件夹名
      const folderName = picked.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
      if (folderName !== '') setSpaceName(folderName)
    }
  }, [])

  const spaceApiAvailable = window.electronAPI?.workspaces !== undefined

  return (
    <div className="flex h-full flex-col">
      <div className="drag-region flex h-12 shrink-0 items-center justify-between px-5">
        <span className="module-title">设置</span>
        <span className="text-[11px] text-muted-foreground">模型 · 外观 · Agent · 科研空间 · 语音与资源 · 关于</span>
      </div>
      <div className="no-drag flex flex-wrap items-center gap-1.5 border-b border-border px-5 py-2">
        {SETTINGS_TABS.map((t) => {
          const Icon = t.icon
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                'flex h-7 items-center gap-1.5 rounded-full px-3 text-[11px] font-medium transition-colors',
                tab === t.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          )
        })}
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="mx-auto max-w-3xl space-y-3">
          <p className="text-[10px] text-muted-foreground">{SETTINGS_TABS.find((t) => t.id === tab)?.desc}</p>

          {/* Model Management Section */}
          {tab === 'models' && (<div className="space-y-3">
          {/* Harness 选择（Issue 1）*/}
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <Settings2 className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold text-foreground">Harness</h2>
            </div>
            <p className="text-[11px] text-muted-foreground">
              选择 Agent 运行环境。Mimir 是当前唯一可用的 Harness；Codex、Claude Code、Pi 即将支持。
            </p>
            {harnessMsg !== null && (
              <div className={cn(
                'rounded-md border px-3 py-2 text-[11px]',
                harnessMsg.type === 'ok'
                  ? 'border-primary/20 bg-primary/5 text-primary'
                  : 'border-destructive/30 bg-destructive/5 text-destructive'
              )}>
                {harnessMsg.text}
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              {harnessList.map((h) => {
                const isActive = h.id === activeHarnessId
                return (
                  <button
                    key={h.id}
                    type="button"
                    onClick={() => void handleSelectHarness(h.id)}
                    disabled={!h.available || harnessBusy}
                    className={cn(
                      'rounded-lg border p-3 text-left transition-all',
                      isActive
                        ? 'border-primary bg-primary/5 shadow-sm'
                        : h.available
                          ? 'border-border bg-card hover:bg-muted/30'
                          : 'border-border bg-card opacity-50 cursor-not-allowed'
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className={cn('text-[12px] font-semibold', isActive ? 'text-primary' : 'text-foreground')}>
                        {h.name}
                      </span>
                      {isActive && (
                        <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">
                          当前
                        </span>
                      )}
                      {!h.available && (
                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">
                          即将支持
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[10px] text-muted-foreground">{h.kind}</p>
                  </button>
                )
              })}
            </div>
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Bot className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold text-foreground">模型管理</h2>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7"
                onClick={() => {
                  resetModelDialog()
                  setDialogOpen(true)
                }}
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                添加模型
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              管理可用的 LLM 模型配置。点击选择当前使用的模型。
            </p>

            {models.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-8 flex flex-col items-center justify-center text-muted-foreground">
                <Bot className="h-8 w-8 opacity-30 mb-2" />
                <p className="text-[12px] font-medium">暂无模型</p>
                <p className="text-[11px] mt-0.5 opacity-70">
                  点击「添加模型」配置你的第一个 LLM
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {models.map((model) => {
                  const isSelected = model.id === selectedModelId
                  const apiKeyVisible = showApiKeyInList[model.id]

                  return (
                    <div
                      key={model.id}
                      onClick={() => handleSelectModel(model.id)}
                      className={cn(
                        'rounded-lg border p-3 cursor-pointer transition-all',
                        isSelected
                          ? 'border-primary bg-primary/5 shadow-sm'
                          : 'border-border bg-card hover:border-border/80 hover:bg-muted/30'
                      )}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span
                              className={cn(
                                'text-[12px] font-semibold font-mono truncate',
                                isSelected ? 'text-primary' : 'text-foreground'
                              )}
                            >
                              {model.modelId}
                            </span>
                            {isSelected && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
                                当前
                              </span>
                            )}
                            {model.supportsImages && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-500 font-medium flex items-center gap-0.5">
                                <Image className="h-2.5 w-2.5" />
                                图片
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 mt-1.5 text-[10px] text-muted-foreground">
                            <Link className="h-3 w-3 shrink-0" />
                            <span className="font-mono truncate">{model.baseUrl}</span>
                          </div>
                          <div className="flex items-center gap-1.5 mt-1 text-[10px] text-muted-foreground">
                            <KeyRound className="h-3 w-3 shrink-0" />
                            <span className="font-mono">
                              {apiKeyVisible
                                ? model.apiKey
                                : model.apiKey.slice(0, 8) + '••••••••'}
                            </span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                toggleApiKeyVisibility(model.id)
                              }}
                              className="hover:text-foreground transition-colors"
                            >
                              {apiKeyVisible ? (
                                <EyeOff className="h-3 w-3" />
                              ) : (
                                <Eye className="h-3 w-3" />
                              )}
                            </button>
                          </div>
                        </div>
                        <div className="flex items-center gap-0.5 shrink-0">
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              openEditModel(model)
                            }}
                            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                            title="编辑模型"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              handleDeleteModel(model.id)
                            }}
                            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                            title="删除模型"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {/* 图像生成（AI 配图）——并入模型管理 */}
            <div className="rounded-lg border border-border bg-card p-4 space-y-3 pt-3">
              <div className="flex items-center gap-2">
                <Image className="h-4 w-4 text-primary" />
                <span className="text-[12px] font-medium text-foreground">图像生成</span>
              </div>
              <p className="text-[10px] text-muted-foreground">
                可选：配置 OpenAI 兼容的图片生成端点后，组会生成可开启「AI 配图」为封面与论文生成概念插图（图片存入图表目录可复用）。
              </p>
              <div className="space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">请求地址</Label>
                <Input
                  placeholder="https://api.deepseek.com/v1"
                  value={imgGenBaseUrl}
                  onChange={(e) => setImgGenBaseUrl(e.target.value)}
                  className="h-7 text-[12px] font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">模型 ID</Label>
                <Input
                  placeholder="如 sd-3 / flux-1.1-pro"
                  value={imgGenModelId}
                  onChange={(e) => setImgGenModelId(e.target.value)}
                  className="h-7 text-[12px] font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">API Key</Label>
                <div className="relative">
                  <Input
                    type={imgKeyVisible ? 'text' : 'password'}
                    placeholder="sk-..."
                    value={imgGenApiKey}
                    onChange={(e) => setImgGenApiKey(e.target.value)}
                    className="h-7 text-[12px] font-mono pr-7"
                  />
                  <button
                    type="button"
                    onClick={() => setImgKeyVisible((v) => !v)}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {imgKeyVisible ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                  </button>
                </div>
              </div>
            </div>
          </section>
          </div>)}

          {/* Appearance Section */}
          {tab === 'appearance' && (<section className="space-y-3">
            <div className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold text-foreground">外观</h2>
            </div>
            <p className="text-[11px] text-muted-foreground">选择应用主题。</p>

            <div className="rounded-lg border border-border bg-card p-4 space-y-4">
              {/* Theme */}
              <div className="space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">主题</Label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { value: 'light', label: '浅色' },
                    { value: 'dark', label: '深色' },
                    { value: 'system', label: '跟随系统' }
                  ].map((t) => (
                    <button
                      key={t.value}
                      onClick={() => setTheme(t.value)}
                      className={cn(
                        'rounded-md border p-2.5 text-[12px] transition-all duration-150',
                        theme === t.value
                          ? 'border-primary bg-primary/5 text-primary font-medium shadow-sm'
                          : 'border-border hover:bg-accent hover:border-border/80'
                      )}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

            </div>

            {/* 背景图片（工作台主区域） */}
            <div className="rounded-lg border border-border bg-card p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Image className="h-4 w-4 text-primary" />
                <span className="text-[12px] font-medium text-foreground">背景图片</span>
              </div>
              <p className="text-[10px] text-muted-foreground">
                选择一张本地图片，铺满聊天与各模块内容区后方。「背景浓度」控制在图片上的明暗遮罩强弱：数值越大背景越淡、文字越易读。
              </p>

              {wallpaperDataUrl !== '' ? (
                <div
                  className="relative h-24 w-full overflow-hidden rounded-md border border-border bg-muted/40"
                  style={{
                    backgroundImage: `linear-gradient(rgba(0,0,0,${wallpaperDim * 0.85}), rgba(0,0,0,${wallpaperDim * 0.85})), url("${wallpaperDataUrl}")`,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center'
                  }}
                />
              ) : (
                <div className="flex h-16 items-center justify-center rounded-md border border-dashed border-border text-[10px] text-muted-foreground">
                  未设置背景图（保持应用默认底色）
                </div>
              )}

              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" className="h-7" onClick={() => void handlePickWallpaper()}>
                  <FolderOpen className="h-3.5 w-3.5 mr-1" />
                  选择图片…
                </Button>
                {wallpaperPath !== '' && (
                  <Button size="sm" variant="ghost" className="h-7 text-muted-foreground" onClick={handleClearWallpaper}>
                    <Trash2 className="h-3.5 w-3.5 mr-1" />
                    清除
                  </Button>
                )}
              </div>
              {wallpaperMsg !== null && (
                <p
                  className={cn(
                    'rounded-md border px-2.5 py-1.5 text-[10px]',
                    wallpaperMsg.type === 'error'
                      ? 'border-destructive/30 bg-destructive/5 text-destructive'
                      : 'border-green-500/30 bg-green-500/5 text-green-600'
                  )}
                >
                  {wallpaperMsg.text}
                </p>
              )}
              {wallpaperPath !== '' && wallpaperPath.split('/').filter(Boolean).pop() !== undefined && (
                <p className="truncate font-mono text-[9px] text-muted-foreground" title={wallpaperPath}>
                  {wallpaperPath.split(/[\\/]/).filter(Boolean).pop()}
                </p>
              )}

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-[11px] text-muted-foreground">背景浓度</Label>
                  <span className="font-mono text-[10px] text-muted-foreground">{Math.round(wallpaperDim * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={Math.round(wallpaperDim * 100)}
                  onChange={(e) => setWallpaperDim(Number(e.target.value) / 100)}
                  className="h-1.5 w-full cursor-pointer accent-primary"
                />
                <div className="flex justify-between text-[9px] text-muted-foreground/70">
                  <span>透出背景</span>
                  <span>清晰文字</span>
                </div>
              </div>
            </div>
          </section>
          )}

          {/* Agent Section：技能路由 + 身份 + 长期记忆 */}
          {tab === 'agent' && (<>
            <SettingsSkillRoutingCard />
            <SettingsIdentityCard />
            <SettingsMemoryCard />
          </>)}

          {/* Research Space Section */}
          {tab === 'spaces' && (<section className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FolderKanban className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold text-foreground">科研空间</h2>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7"
                onClick={() => {
                  setSpaceMsg(null)
                  setSpaceDialogOpen(true)
                }}
                disabled={!spaceApiAvailable}
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                新建空间
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              每个科研空间是一个独立目录，承载论文、实验、图表、组会与对话等数据；基础设置（模型/主题/服务器）全局共享。
              切换空间后，各模块将从当前空间读写。
            </p>

            {spaceMsg !== null && (
              <div
                className={cn(
                  'rounded-md px-3 py-2 text-[11px]',
                  spaceMsg.type === 'ok'
                    ? 'border border-primary/20 bg-primary/5 text-primary'
                    : 'border border-destructive/30 bg-destructive/5 text-destructive'
                )}
              >
                {spaceMsg.text}
              </div>
            )}

            {!spaceApiAvailable ? (
              <p className="rounded-md bg-muted/50 px-3 py-2 text-[10px] text-muted-foreground">
                科研空间管理需要桌面端运行。
              </p>
            ) : spaces.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-8 flex flex-col items-center justify-center text-muted-foreground">
                <FolderKanban className="h-8 w-8 opacity-30 mb-2" />
                <p className="text-[12px] font-medium">还没有科研空间</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3 h-7"
                  onClick={() => {
                    setSpaceMsg(null)
                    setSpaceDialogOpen(true)
                  }}
                >
                  <Plus className="h-3 w-3 mr-1" />
                  新建第一个科研空间
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                {spaces.map((space) => {
                  const isActive = space.id === activeSpaceId
                  const isDefault = space.id === defaultSpaceId
                  const busy = spaceBusy === space.id
                  return (
                    <div
                      key={space.id}
                      className={cn(
                        'rounded-lg border p-3 transition-all',
                        isActive ? 'border-primary bg-primary/5 shadow-sm' : 'border-border bg-card hover:bg-muted/30'
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[12px] font-semibold text-foreground">{space.name}</span>
                            {isActive && (
                              <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">
                                当前
                              </span>
                            )}
                            {isDefault && (
                              <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium text-amber-600">
                                默认
                              </span>
                            )}
                          </div>
                          <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                            <FolderOpen className="h-3 w-3 shrink-0" />
                            <span className="font-mono truncate" title={space.path}>
                              {space.path}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {!isActive && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 text-[10px]"
                              disabled={busy}
                              onClick={() => handleSwitchSpace(space.id)}
                            >
                              {busy ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
                              切换
                            </Button>
                          )}
                          {!isDefault && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 text-[10px]"
                              disabled={busy}
                              onClick={() => handleSetDefaultSpace(space.id)}
                            >
                              设为默认
                            </Button>
                          )}
                          <button
                            onClick={() => handleRemoveSpace(space)}
                            disabled={isActive || busy}
                            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors disabled:opacity-40"
                            title={isActive ? '当前空间不可移除' : '移除（保留磁盘文件）'}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            <Dialog open={spaceDialogOpen} onOpenChange={setSpaceDialogOpen}>
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>新建科研空间</DialogTitle>
                  <DialogDescription>
                    空间是一个独立目录，用于承载该课题的全部研究数据。留空目录将使用默认位置（~/Mimir/空间名）。
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label className="text-[11px]">空间名称 *</Label>
                    <Input
                      placeholder="如：多模态科研助手"
                      value={spaceName}
                      onChange={(e) => setSpaceName(e.target.value)}
                      className="h-7 text-[12px]"
                      autoFocus
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-[11px]">存储目录（可选）</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        placeholder="默认：~/Mimir/空间名称"
                        value={spaceDir}
                        onChange={(e) => setSpaceDir(e.target.value)}
                        className="h-7 text-[11px] font-mono flex-1"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 text-[11px] shrink-0"
                        onClick={handlePickSpaceDir}
                      >
                        <FolderOpen className="h-3 w-3 mr-1" />
                        浏览
                      </Button>
                    </div>
                  </div>
                  {spaceMsg !== null && spaceMsg.type === 'error' && (
                    <p className="text-[11px] text-destructive">{spaceMsg.text}</p>
                  )}
                </div>
                <DialogFooter>
                  <Button variant="outline" size="sm" className="h-7" onClick={() => setSpaceDialogOpen(false)} disabled={spaceBusy === 'create'}>
                    取消
                  </Button>
                  <Button
                    size="sm"
                    className="h-7"
                    onClick={handleCreateSpace}
                    disabled={!spaceName.trim() || spaceBusy === 'create'}
                  >
                    {spaceBusy === 'create' ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Plus className="h-3.5 w-3.5 mr-1" />}
                    创建
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </section>
          )}

          {/* Speech Recognition Section（语音与资源 标签） */}
          {tab === 'resources' && (<section className="space-y-3">
            <div className="flex items-center gap-2">
              <Mic className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold text-foreground">语音识别</h2>
            </div>
            <p className="text-[11px] text-muted-foreground">
              选择语音转文本的识别引擎。本地引擎完全离线、保护隐私，需先下载模型。
            </p>

            <div className="rounded-lg border border-border bg-card p-4 space-y-3">
              <div className="space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">识别引擎</Label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => handleSelectSpeechEngine('local')}
                    className={cn(
                      'rounded-md border p-2.5 text-left transition-all duration-150',
                      speechEngine === 'local'
                        ? 'border-primary bg-primary/5 shadow-sm'
                        : 'border-border hover:bg-accent hover:border-border/80'
                    )}
                  >
                    <p
                      className={cn(
                        'text-[12px] font-medium',
                        speechEngine === 'local' ? 'text-primary' : 'text-foreground'
                      )}
                    >
                      本地 SenseVoice
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      离线识别，隐私安全，支持中/英/日/韩/粤
                    </p>
                  </button>
                  <button
                    onClick={() => handleSelectSpeechEngine('web')}
                    className={cn(
                      'rounded-md border p-2.5 text-left transition-all duration-150',
                      speechEngine === 'web'
                        ? 'border-primary bg-primary/5 shadow-sm'
                        : 'border-border hover:bg-accent hover:border-border/80'
                    )}
                  >
                    <p
                      className={cn(
                        'text-[12px] font-medium',
                        speechEngine === 'web' ? 'text-primary' : 'text-foreground'
                      )}
                    >
                      Web Speech API
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      浏览器内置识别，无需下载模型
                    </p>
                  </button>
                </div>
              </div>

              {/* 本地引擎未安装模型时，直接在此显示下载入口 */}
              {speechEngine === 'local' && senseVoiceResource && !senseVoiceResource.installed && (
                <div className="pt-1">
                  {(() => {
                    const isDownloading = downloadingId === senseVoiceResource.id
                    const progress = downloadProgress[senseVoiceResource.id] ?? 0
                    const error = downloadError[senseVoiceResource.id]
                    return (
                      <div className="rounded-md border border-border bg-muted/40 p-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <p className="text-[11px] font-medium text-foreground">
                              需要下载 SenseVoice 模型
                            </p>
                            <p className="text-[10px] text-muted-foreground mt-0.5">
                              {(senseVoiceResource.sizeBytes / 1024 / 1024).toFixed(0)} MB，下载完成后可完全离线使用
                            </p>
                          </div>
                          <Button
                            size="sm"
                            className="h-7 shrink-0"
                            disabled={isDownloading}
                            onClick={() => handleDownloadResource(senseVoiceResource.id)}
                          >
                            {isDownloading ? (
                              <>
                                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                                {progress}%
                              </>
                            ) : (
                              <>
                                <Download className="h-3.5 w-3.5 mr-1" />
                                下载模型
                              </>
                            )}
                          </Button>
                        </div>
                        {isDownloading && (
                          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full bg-primary transition-all duration-300"
                              style={{ width: `${progress}%` }}
                            />
                          </div>
                        )}
                        {error && (
                          <p className="mt-2 text-[10px] text-destructive">{error}</p>
                        )}
                      </div>
                    )
                  })()}
                </div>
              )}
            </div>
          </section>
          )}

          {/* Resource Download Section（同属「语音与资源」标签） */}
          {tab === 'resources' && (<section className="space-y-3">
            <div className="flex items-center gap-2">
              <HardDrive className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold text-foreground">资源下载</h2>
            </div>
            <p className="text-[11px] text-muted-foreground">
              应用按需运行的本地组件都会在这里等待下载，例如离线语音识别模型、论文编译所需的 LaTeX 引擎等。
            </p>

            <div className="space-y-2">
              {resourcesLoading ? (
                <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-4 text-[11px] text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  正在读取资源状态…
                </div>
              ) : resources.length === 0 ? (
                <div className="rounded-lg border border-border bg-card p-4">
                  {resourceLoadError !== null ? (
                    <p className="text-[11px] text-destructive">{resourceLoadError}</p>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">未发现可下载的资源</p>
                  )}
                  <div className="mt-2 flex justify-end">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 text-[10px]"
                      onClick={() => void loadResourceStatus()}
                    >
                      <RotateCw className="h-3 w-3 mr-1" />
                      重试
                    </Button>
                  </div>
                </div>
              ) : (
                resources.map((resource) => {
                const installed = resource.installed
                const isDownloading = downloadingId === resource.id
                // 进度条常驻：已安装恒为 100%，未安装从 0% 起步
                const progress = installed ? 100 : (downloadProgress[resource.id] ?? 0)
                const error = downloadError[resource.id]
                return (
                  <div key={resource.id} className="rounded-lg border border-border bg-card p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[12px] font-semibold text-foreground">
                            {resource.name}
                          </span>
                          {installed ? (
                            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-600 font-medium flex items-center gap-0.5">
                              <Check className="h-2.5 w-2.5" />
                              已安装
                            </span>
                          ) : isDownloading ? (
                            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
                              下载中
                            </span>
                          ) : (
                            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">
                              未安装
                            </span>
                          )}
                        </div>
                        <p className="text-[10px] text-muted-foreground mt-1">
                          {resource.description}
                        </p>
                        <p className="text-[10px] text-muted-foreground mt-0.5 font-mono">
                          {(resource.sizeBytes / 1024 / 1024).toFixed(0)} MB
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant={installed ? 'outline' : 'default'}
                        className="h-7 shrink-0"
                        disabled={isDownloading || installed}
                        onClick={() => handleDownloadResource(resource.id)}
                      >
                        {isDownloading ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                            {progress}%
                          </>
                        ) : installed ? (
                          <>
                            <Check className="h-3.5 w-3.5 mr-1" />
                            完成
                          </>
                        ) : (
                          <>
                            <Download className="h-3.5 w-3.5 mr-1" />
                            下载
                          </>
                        )}
                      </Button>
                    </div>
                    {/* 进度条常驻：下载中实时填充，完成后保持满格 */}
                    <div className="mt-3 flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                        <div
                          className={cn(
                            'h-full rounded-full transition-all duration-300',
                            installed || progress >= 100 ? 'bg-success' : 'bg-primary'
                          )}
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                      <span className="w-8 shrink-0 text-right text-[10px] text-muted-foreground tabular-nums">
                        {progress}%
                      </span>
                    </div>
                    {error && (
                      <p className="mt-2 text-[10px] text-destructive">{error}</p>
                    )}
                  </div>
                )
              })
              )}
            </div>
          </section>
          )}

          {/* About */}
          {tab === 'about' && (<section className="space-y-3">
            <div className="flex items-center gap-2">
              <Info className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold text-foreground">关于</h2>
            </div>
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[12px] font-medium text-foreground">Mimir Desktop</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">以 Agent 为核心的科研工作台</p>
                </div>
                <span className="text-[10px] text-muted-foreground font-mono">v0.1.0</span>
              </div>
            </div>
          </section>
          )}
        </div>
      </div>

      {/* 底部保存栏：与插件页一致的通栏布局 */}
      <div className="no-drag flex shrink-0 items-center justify-end gap-3 border-t border-border px-5 py-2.5">
        {saved && !saving && (
          <span className="flex items-center gap-1 text-[11px] text-green-600">
            <Check className="h-3.5 w-3.5" />
            已保存
          </span>
        )}
        <Button onClick={handleSave} disabled={saving} size="sm" className="h-8 px-4">
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5 mr-1.5" />
          )}
          {saving ? '保存中...' : '保存设置'}
        </Button>
      </div>

      {/* 技能管理（列表 + 导入 / 查看详情 / 删除） */}
      <Dialog open={skillsOpen} onOpenChange={setSkillsOpen}>
        <DialogContent className="sm:max-w-2xl">
          <div className="flex items-start justify-between gap-3 pr-6">
            <DialogHeader className="p-0">
              <DialogTitle>技能管理</DialogTitle>
              <DialogDescription>
                聊天输入框输入 <span className="font-mono text-primary">/</span> 会呼出「技能与指令」菜单。内置技能只读；自定义技能可导入与删除。
              </DialogDescription>
            </DialogHeader>
            <Button size="sm" className="mt-0.5 h-7 shrink-0" onClick={openSkillImport}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              导入技能
            </Button>
          </div>

          <div className="max-h-[58vh] space-y-4 overflow-y-auto pr-1">
            {/* 内置技能 */}
            <div className="space-y-1.5">
              <p className="text-[10px] font-medium text-muted-foreground">内置技能 · {SKILL_ENTRIES.length}</p>
              {SKILL_ENTRIES.map((entry) => (
                <SkillRow
                  key={`builtin-${entry.trigger}`}
                  title={entry.title.replace(/（.*）/, '')}
                  trigger={entry.trigger}
                  description={entry.description}
                  onOpen={() => setSkillDetail({ source: 'builtin', entry })}
                />
              ))}
            </div>

            {/* 自定义技能 */}
            <div className="space-y-1.5">
              <p className="text-[10px] font-medium text-muted-foreground">我的技能 · {userSkills.length}</p>
              {userSkills.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-6 text-muted-foreground">
                  <p className="text-[11px]">还没有自定义技能</p>
                  <Button variant="ghost" size="sm" className="mt-1 h-6 text-[10px]" onClick={openSkillImport}>
                    <Plus className="h-3 w-3 mr-1" />
                    导入第一个技能
                  </Button>
                </div>
              ) : (
                userSkills.map((skill) => (
                  <SkillRow
                    key={`custom-${skill.id}`}
                    title={skill.title}
                    trigger={skill.trigger}
                    description={skill.description}
                    onOpen={() => setSkillDetail({ source: 'custom', skill })}
                    onDelete={() => handleDeleteUserSkill(skill)}
                  />
                ))
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" className="h-7" onClick={() => setSkillsOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 技能详情 */}
      <Dialog open={skillDetail !== null} onOpenChange={(open) => { if (!open) setSkillDetail(null) }}>
        <DialogContent className="max-h-[85vh] sm:max-w-lg">
          {skillDetail !== null && skillDetailEntry !== null && (
            <>
              <DialogHeader className="pr-6">
                <DialogTitle className="flex items-center gap-2">
                  <span className="truncate">{skillDetailEntry.title}</span>
                  <span
                    className={cn(
                      'shrink-0 rounded-full px-1.5 py-px text-[9px] font-medium',
                      skillDetail.source === 'builtin' ? 'bg-primary/10 text-primary' : 'bg-emerald-500/10 text-emerald-600'
                    )}
                  >
                    {skillDetail.source === 'builtin' ? '内置' : '自定义'}
                  </span>
                </DialogTitle>
                <DialogDescription>斜杠技能详情与使用说明。</DialogDescription>
              </DialogHeader>

              <div className="space-y-3 overflow-y-auto text-[11px]">
                <div>
                  <p className="text-[10px] text-muted-foreground">触发方式</p>
                  <p className="mt-0.5 font-mono text-primary">/{skillDetailEntry.trigger}</p>
                </div>
                {skillDetailEntry.description !== '' && (
                  <div>
                    <p className="text-[10px] text-muted-foreground">说明</p>
                    <p className="mt-0.5 leading-relaxed text-foreground/90">{skillDetailEntry.description}</p>
                  </div>
                )}
                {skillDetailEntry.whenToUse !== '' && (
                  <div>
                    <p className="text-[10px] text-muted-foreground">适用场景</p>
                    <p className="mt-0.5 leading-relaxed text-foreground/90">{skillDetailEntry.whenToUse}</p>
                  </div>
                )}
                {skillDetailEntry.argsHint !== '' && (
                  <div>
                    <p className="text-[10px] text-muted-foreground">参数提示</p>
                    <p className="mt-0.5 font-mono text-foreground/90">{skillDetailEntry.argsHint}</p>
                  </div>
                )}
                {skillDetailEntry.usage !== '' && (
                  <div>
                    <p className="text-[10px] text-muted-foreground">用法示例</p>
                    <p className="mt-0.5 whitespace-pre-wrap rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-[10px] leading-relaxed text-foreground/90">
                      {skillDetailEntry.usage}
                    </p>
                  </div>
                )}
                {skillDetailBody !== null && (
                  <div>
                    <p className="text-[10px] text-muted-foreground">
                      任务正文{skillDetailBody.includes(USER_SKILL_ARGS_PLACEHOLDER) ? '（支持参数占位符）' : ''}
                    </p>
                    <pre className="mt-0.5 max-h-[36vh] overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-[10px] leading-relaxed text-foreground/90">
                      {skillDetailBody}
                    </pre>
                  </div>
                )}
                {skillDetailBody === null && (
                  <p className="rounded-md bg-muted/50 px-3 py-2 text-[10px] text-muted-foreground">
                    内置技能正文随版本提供，管理页不展示；在聊天输入框输入 /{skillDetailEntry.trigger} 后按回车即可调用。
                  </p>
                )}
              </div>

              <DialogFooter>
                <Button variant="outline" size="sm" className="h-7" onClick={() => setSkillDetail(null)}>
                  关闭
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* 导入技能 */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>导入技能</DialogTitle>
            <DialogDescription>
              新增一条自定义技能；导入后即可在聊天输入框用 <span className="font-mono text-primary">/触发词</span> 调用。
            </DialogDescription>
          </DialogHeader>

          {/* 导入方式切换 */}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => { setImportTab('form'); setImportMsg(null) }}
              className={cn(
                'flex items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-[12px] font-medium transition-colors',
                importTab === 'form' ? 'border-primary bg-primary/5 text-primary' : 'border-border text-muted-foreground hover:bg-accent'
              )}
            >
              <Plus className="h-3.5 w-3.5" />
              手动填写
            </button>
            <button
              type="button"
              onClick={() => { setImportTab('json'); setImportMsg(null) }}
              className={cn(
                'flex items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-[12px] font-medium transition-colors',
                importTab === 'json' ? 'border-primary bg-primary/5 text-primary' : 'border-border text-muted-foreground hover:bg-accent'
              )}
            >
              <Code2 className="h-3.5 w-3.5" />
              粘贴 JSON
            </button>
          </div>

          {importTab === 'form' ? (
            <div className="space-y-2.5">
              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1">
                  <Label className="text-[11px]">触发词 *</Label>
                  <Input
                    placeholder="my-skill"
                    value={importForm.trigger}
                    onChange={(e) => setImportForm({ ...importForm, trigger: e.target.value })}
                    className="h-7 text-[12px] font-mono"
                    autoFocus
                  />
                  <p className="text-[9px] text-muted-foreground">小写字母开头，可用 -</p>
                </div>
                <div className="col-span-2 space-y-1">
                  <Label className="text-[11px]">标题 *</Label>
                  <Input
                    placeholder="如：文献速读（my-skill）"
                    value={importForm.title}
                    onChange={(e) => setImportForm({ ...importForm, title: e.target.value })}
                    className="h-7 text-[12px]"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">一句话说明</Label>
                <Input
                  placeholder="在斜杠菜单里展示的一句话"
                  value={importForm.description}
                  onChange={(e) => setImportForm({ ...importForm, description: e.target.value })}
                  className="h-7 text-[12px]"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">适用场景</Label>
                <Input
                  placeholder="什么时候适合用这个技能？"
                  value={importForm.whenToUse}
                  onChange={(e) => setImportForm({ ...importForm, whenToUse: e.target.value })}
                  className="h-7 text-[12px]"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-[11px]">参数提示</Label>
                  <Input
                    placeholder="如 <研究方向>（可空）"
                    value={importForm.argsHint}
                    onChange={(e) => setImportForm({ ...importForm, argsHint: e.target.value })}
                    className="h-7 text-[12px] font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">用法示例</Label>
                  <Input
                    placeholder="如 /my-skill 多模态综述"
                    value={importForm.usage}
                    onChange={(e) => setImportForm({ ...importForm, usage: e.target.value })}
                    className="h-7 text-[12px] font-mono"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">任务正文（发给 Agent 的提示词）*</Label>
                <Textarea
                  rows={8}
                  placeholder="把你希望 Agent 执行的任务写清楚……正文里可用 {{args}} 占位本次调用参数。"
                  value={importForm.body}
                  onChange={(e) => setImportForm({ ...importForm, body: e.target.value })}
                  className="text-[11px] leading-relaxed"
                />
                <p className="text-[9px] text-muted-foreground">
                  调用时「/触发词 参数」中的参数会替换正文里的 {USER_SKILL_ARGS_PLACEHOLDER}；未提供参数时会给出提示语。
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label className="text-[11px]">技能 JSON（支持单个对象或数组）</Label>
              <Textarea
                rows={10}
                placeholder={JSON.stringify(
                  {
                    trigger: 'my-skill',
                    title: '我的技能（my-skill）',
                    description: '一句话说明',
                    whenToUse: '适用场景',
                    argsHint: '<方向>',
                    usage: '/my-skill 参数',
                    body: '请帮我…{{args}}…'
                  },
                  null,
                  2
                )}
                value={importJson}
                onChange={(e) => setImportJson(e.target.value)}
                className="font-mono text-[11px] leading-relaxed"
              />
              <p className="text-[9px] text-muted-foreground">
                字段：trigger（必填）、title（必填）、body（必填）、description / whenToUse / argsHint / usage（可选）。
              </p>
            </div>
          )}

          {importMsg !== null && (
            <div
              className={cn(
                'whitespace-pre-wrap rounded-md border px-3 py-2 text-[11px]',
                importMsg.type === 'ok'
                  ? 'border-green-500/30 bg-green-500/5 text-green-600'
                  : 'border-destructive/30 bg-destructive/5 text-destructive'
              )}
            >
              {importMsg.text}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" size="sm" className="h-7" onClick={() => setImportOpen(false)}>
              取消
            </Button>
            <Button size="sm" className="h-7" onClick={() => void confirmImportSkills()} disabled={importing}>
              {importing ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Plus className="h-3.5 w-3.5 mr-1" />}
              {importing ? '导入中...' : '导入'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Model Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingModelId !== null ? '编辑模型' : '添加模型'}</DialogTitle>
            <DialogDescription>
              填写 LLM 模型的连接信息和配置。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2.5">
            {/* Row 1: 请求地址 + 模型ID */}
            <div className="grid grid-cols-5 gap-2">
              <div className="col-span-3 space-y-1">
                <Label className="text-[11px]">请求地址 *</Label>
                <Input
                  placeholder="https://api.deepseek.com/v1"
                  value={form.baseUrl}
                  onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                  className="h-7 text-[12px] font-mono"
                  autoFocus
                />
              </div>
              <div className="col-span-2 space-y-1">
                <Label className="text-[11px]">模型ID *</Label>
                <Input
                  placeholder="deepseek-chat"
                  value={form.modelId}
                  onChange={(e) => setForm({ ...form, modelId: e.target.value })}
                  className="h-7 text-[12px] font-mono"
                />
              </div>
              <div className="col-span-5 -mt-1.5 flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => void handleFetchModels()}
                  disabled={listingModels || !form.baseUrl || !form.apiKey}
                  className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-card px-2 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  title="按当前请求地址 + API Key 拉取可用模型"
                >
                  {listingModels ? <Loader2 className="h-3 w-3 animate-spin" /> : <ListChecks className="h-3 w-3" />}
                  {listingModels ? '获取中...' : '获取模型列表'}
                </button>
                {modelListMsg !== null && (
                  <span
                    className={cn(
                      'truncate text-[10px]',
                      modelListMsg.type === 'error' ? 'text-destructive' : 'text-muted-foreground'
                    )}
                    title={modelListMsg.text}
                  >
                    {modelListMsg.text}
                  </span>
                )}
              </div>
              {modelPickerOpen && modelList.length > 0 && (
                <div className="col-span-5 rounded-md border border-border bg-muted/30 px-2 py-1.5">
                  <Label className="text-[10px] text-muted-foreground">选择已发现的模型</Label>
                  <div className="mt-1 flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
                    {modelList.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => setForm({ ...form, modelId: m.id })}
                        className={cn(
                          'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-mono transition-colors',
                          form.modelId === m.id
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border bg-card hover:bg-accent'
                        )}
                        title={m.ownedBy ? `${m.id} · owned_by: ${m.ownedBy}` : m.id}
                      >
                        <span className="truncate">{m.id}</span>
                        {m.ownedBy !== undefined && (
                          <span className="text-[8px] text-muted-foreground">· {m.ownedBy}</span>
                        )}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1 text-[9px] text-muted-foreground">
                    也可以继续手动输入自定义模型 ID；下方测试会按你当前填写的 ID 发起。
                  </p>
                </div>
              )}
            </div>

            {/* Row 2: API密钥 + 支持图片 */}
            <div className="grid grid-cols-4 gap-2">
              <div className="col-span-3 space-y-1">
                <Label className="text-[11px]">API密钥 *</Label>
                <div className="relative">
                  <Input
                    type={showApiKeyInForm ? 'text' : 'password'}
                    placeholder="sk-..."
                    value={form.apiKey}
                    onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                    className="h-7 text-[12px] font-mono pr-7"
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKeyInForm(!showApiKeyInForm)}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {showApiKeyInForm ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                  </button>
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">支持图片</Label>
                <div className="flex gap-3 h-7 items-center">
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="radio"
                      name="supportsImages"
                      checked={form.supportsImages === true}
                      onChange={() => setForm({ ...form, supportsImages: true })}
                      className="h-3 w-3 accent-primary"
                    />
                    <span className="text-[11px]">是</span>
                  </label>
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="radio"
                      name="supportsImages"
                      checked={form.supportsImages === false}
                      onChange={() => setForm({ ...form, supportsImages: false })}
                      className="h-3 w-3 accent-primary"
                    />
                    <span className="text-[11px]">否</span>
                  </label>
                </div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              onClick={() => {
                setDialogOpen(false)
                resetModelDialog()
              }}
              type="button"
              data-testid="model-dialog-cancel"
            >
              取消
            </Button>
            <Button
              size="sm"
              className="h-7"
              onClick={handleSaveModel}
              disabled={!form.baseUrl || !form.modelId || !form.apiKey || testing}
            >
              {testing ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : editingModelId !== null ? (
                <Check className="h-3.5 w-3.5 mr-1" />
              ) : (
                <Plus className="h-3.5 w-3.5 mr-1" />
              )}
              {testing ? '测试中...' : editingModelId !== null ? '测试并保存' : '测试并添加'}
            </Button>
          </DialogFooter>
          {testResult && (
            <div
              className={cn(
                'rounded-md border px-3 py-2 text-[11px] mt-1',
                testResult.ok
                  ? 'border-green-500/30 bg-green-500/5 text-green-600'
                  : 'border-destructive/30 bg-destructive/5 text-destructive'
              )}
            >
              {testResult.message}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* 切到本地语音识别前：模型未下载 → 确认后自动下载 */}
      <Dialog open={voiceDialogOpen} onOpenChange={setVoiceDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>使用本地 SenseVoice 需要先下载模型</DialogTitle>
            <DialogDescription>
              模型约{' '}
              {((senseVoiceResource?.sizeBytes ?? 228 * 1024 * 1024) / 1024 / 1024).toFixed(0)}{' '}
              MB，下载完成后可完全离线识别。确认后将自动开始下载；也可以之后在「资源下载」中随时手动下载。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              onClick={() => setVoiceDialogOpen(false)}
            >
              取消
            </Button>
            <Button size="sm" className="h-7" onClick={confirmDownloadSenseVoice}>
              <Download className="h-3.5 w-3.5 mr-1" />
              确认并下载
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
