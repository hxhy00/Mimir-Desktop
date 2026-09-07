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
import { FolderOpen, Loader2, Plus, Monitor, Moon, Sun, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Sidebar, type ModuleId } from '@/components/layout/Sidebar'
import { getSettingsSession } from '@/lib/settingsGuard'
import { ChatView } from '@/components/chat/ChatView'
import { Overview } from '@/components/modules/Overview'
import { Paper } from '@/components/modules/Paper'
import { Library } from '@/components/modules/library/Library'
import { Experiments } from '@/components/modules/Experiments'
import { Figures } from '@/components/modules/Figures'
import { Meetings } from '@/components/modules/Meetings'
import { Venues } from '@/components/modules/Venues'
import { Servers } from '@/components/modules/Servers'
import { Ledger } from '@/components/modules/Ledger'
import { Settings } from '@/components/modules/Settings'
import { Plugins } from '@/components/modules/Plugins'

interface SpaceView {
  id: string
  name: string
  path: string
  createdAt: string
  updatedAt: string
}

export default function App() {
  const [activeModule, setActiveModule] = useState<ModuleId>('chat')
  const [theme, setTheme] = useState('system')
  /** 本机基础信息里已有的模型摘要（引导里用于「已导入」提示与预填）。 */
  const [basicModels, setBasicModels] = useState<{ count: number; name: string }>({ count: 0, name: '' })
  // 工作台背景图（dataURL + 明暗遮罩浓度 0~1）
  const [wallpaper, setWallpaper] = useState<{ url: string; dim: number } | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('sidebar-collapsed') === 'true'
    } catch {
      return false
    }
  })
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('right-sidebar-collapsed') === 'true'
    } catch {
      return true
    }
  })

  // ── 科研空间 ──────────────────────────────────────────────────────
  const [spaces, setSpaces] = useState<SpaceView[]>([])
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null)
  const [spaceVersion, setSpaceVersion] = useState(0)
  const [spaceLoading, setSpaceLoading] = useState(true)
  const [gateOpen, setGateOpen] = useState(false)
  const [gateName, setGateName] = useState('我的科研空间')
  const [gateDir, setGateDir] = useState('')
  const [gateBusy, setGateBusy] = useState(false)
  const [gateError, setGateError] = useState<string | null>(null)
  /** 首次引导：触发「添加模型」弹窗的计数。 */
  const [modelGuideStep, setModelGuideStep] = useState(0)
  /** 首次引导第三步：选择外观。 */
  const [showAppearanceStep, setShowAppearanceStep] = useState(false)

  const syncSpaces = useCallback(async () => {
    const api = window.electronAPI?.workspaces
    if (!api) return
    try {
      const res = await api.list()
      if (!res.ok) return
      setSpaces(res.workspaces ?? [])
      const activeId = res.activeId ?? null
      setActiveSpaceId(activeId)
      if ((res.workspaces?.length ?? 0) === 0 && activeId === null) {
        setGateOpen(true)
      } else {
        setGateOpen(false)
      }
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    const boot = async () => {
      await syncSpaces()
      setSpaceLoading(false)
    }
    void boot()
  }, [syncSpaces])

  const handleSwitchSpace = useCallback(
    async (id: string) => {
      const api = window.electronAPI?.workspaces
      if (!api || id === activeSpaceId) return
      // 与「切换模块」的离开守卫一致：在设置页且存在未保存更改时先询问保存，
      // 否则空间切换会重挂载主内容并静默丢弃设置编辑。
      const session = getSettingsSession()
      if (session !== null && session.isDirty()) {
        const proceed = window.confirm('设置存在尚未保存的更改，是否保存后再切换科研空间？\n\n「确定」= 保存并切换；「取消」= 留在当前空间')
        if (!proceed) return
        await session.save()
      }
      const res = await api.switch(id)
      if (res.ok) {
        setActiveSpaceId(id)
        // 强制主内容重挂载，使各模块从新空间重新读取数据
        setSpaceVersion((v) => v + 1)
        setRightSidebarCollapsed(true)
      }
    },
    [activeSpaceId]
  )

  const handlePickGateDir = useCallback(async () => {
    if (!window.electronAPI?.showOpenDialog) return
    const res = await window.electronAPI.showOpenDialog({
      title: '选择科研空间目录',
      buttonLabel: '选择此目录',
      properties: ['openDirectory', 'createDirectory']
    })
    if (!res.canceled && res.filePaths.length > 0) {
      const picked = res.filePaths[0] ?? ''
      setGateDir(picked)
      // 空间名称自动对齐所选路径的最后一个文件夹名
      const folderName = picked.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
      if (folderName !== '') setGateName(folderName)
    }
  }, [])

  /** 读取本机基础信息（全局 settings）中的模型摘要，供引导页「已导入」提示使用。 */
  const loadBasicModels = useCallback(async () => {
    try {
      const settings = (await window.electronAPI?.getSettings()) as Record<string, unknown> | undefined
      const models = (settings?.models as Array<Record<string, unknown>> | undefined) ?? []
      const selectedId = settings?.selectedModelId as string | undefined
      const selected = models.find((m) => m.id === selectedId) ?? models[0]
      setBasicModels({ count: models.length, name: (selected?.modelId as string | undefined) ?? '' })
    } catch {
      // ignore
    }
  }, [])

  /**
   * 创建首个科研空间后的引导推进：
   * - 若本机基础信息已含模型/apiKey → 直接进入「外观」步骤（模型已导入，无需重复填写）；
   * - 否则进入设置页打开「添加模型」弹窗（引导第二步）。
   */
  const guideAfterFirstSpace = useCallback(async () => {
    await loadBasicModels()
    try {
      const settings = (await window.electronAPI?.getSettings()) as Record<string, unknown> | undefined
      const models = settings?.models
      const hasModel = Array.isArray(models) && models.length > 0
      if (hasModel) {
        setShowAppearanceStep(true)
      } else {
        setActiveModule('settings')
        setModelGuideStep((v) => v + 1)
      }
    } catch {
      // ignore
    }
  }, [loadBasicModels])

  const handleCreateFirstSpace = useCallback(async () => {
    const api = window.electronAPI?.workspaces
    const name = gateName.trim()
    if (!api || name === '') return
    setGateBusy(true)
    setGateError(null)
    try {
      const res = await api.create(name, gateDir.trim() === '' ? undefined : gateDir.trim())
      if (res.ok) {
        await syncSpaces()
        if (res.workspace) setActiveSpaceId(res.workspace.id)
        setGateOpen(false)
        setGateName('我的科研空间')
        setGateDir('')
        // 引导推进：基础信息已有模型 → 外观步骤；否则进入设置页添加模型
        await guideAfterFirstSpace()
      } else {
        setGateError(res.message ?? '创建失败')
      }
    } catch {
      setGateError('创建失败，请重试')
    } finally {
      setGateBusy(false)
    }
  }, [gateName, gateDir, syncSpaces, guideAfterFirstSpace])

  const activeSpace = spaces.find((s) => s.id === activeSpaceId) ?? null

  // 离开设置页前询问未保存更改（注册于 Settings 的离开守卫会话）
  const handleNavigate = useCallback(
    async (id: ModuleId) => {
      if (id === activeModule) return
      const session = getSettingsSession()
      if (session !== null && session.isDirty()) {
        const proceed = window.confirm('设置存在尚未保存的更改，是否保存后再切换？\n\n「确定」= 保存并切换；「取消」= 留在设置页')
        if (!proceed) return
        await session.save()
      }
      setActiveModule(id)
    },
    [activeModule]
  )

  // Load theme from settings
  useEffect(() => {
    window.electronAPI?.getSettings().then((settings) => {
      const s = settings as Record<string, unknown>
      if (s.theme) setTheme(s.theme as string)
    })
  }, [])

  // Apply theme
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

  // ── 工作台背景图：从设置读取（保存设置后自动刷新，无需切模块） ──
  const applyWallpaperFromSettings = useCallback(async () => {
    let raw: Record<string, unknown> | undefined
    if (window.electronAPI?.getSettings) {
      try {
        raw = (await window.electronAPI.getSettings()) as Record<string, unknown>
      } catch {
        raw = undefined
      }
    } else {
      try {
        const cached = localStorage.getItem('mimir-settings')
        if (cached) raw = JSON.parse(cached) as Record<string, unknown>
      } catch {
        raw = undefined
      }
    }
    const wp = raw?.wallpaper
    const path = wp && typeof wp === 'object' && typeof (wp as { path?: unknown }).path === 'string' ? (wp as { path: string }).path : ''
    const dimRaw = wp && typeof wp === 'object' && typeof (wp as { dim?: unknown }).dim === 'number' ? (wp as { dim: number }).dim : 0.6
    const dim = Math.min(Math.max(dimRaw, 0), 1)
    if (path === '' || !window.electronAPI?.readImageDataUrl) {
      setWallpaper(null)
      return
    }
    try {
      const res = await window.electronAPI.readImageDataUrl(path)
      if (res.ok && res.dataUrl) setWallpaper({ url: res.dataUrl, dim })
      else setWallpaper(null)
    } catch {
      setWallpaper(null)
    }
  }, [])

  useEffect(() => {
    void applyWallpaperFromSettings()
    const onSaved = (): void => {
      void applyWallpaperFromSettings()
    }
    window.addEventListener('mimir:settings-saved', onSaved)
    return () => window.removeEventListener('mimir:settings-saved', onSaved)
  }, [applyWallpaperFromSettings])

  // 引导第三步：选择外观（立即应用到本地并持久化 theme）
  const applyGuidedTheme = useCallback(async (nextTheme: string) => {
    setTheme(nextTheme)
    try {
      const api = window.electronAPI
      if (!api) return
      const settings = (await api.getSettings()) as Record<string, unknown>
      settings.theme = nextTheme
      await api.setSettings(settings)
    } catch {
      // ignore
    }
  }, [])

  // 完成引导：进入工作台（总览页），并清空引导计数，避免重进设置时再次自动弹「添加模型」
  const handleFinishOnboarding = useCallback(() => {
    setShowAppearanceStep(false)
    setModelGuideStep(0)
    setActiveModule('overview')
  }, [])

  // 引导第二步（添加模型）弹窗关闭后：进入第三步外观，同时清空引导计数
  const handleModelStepDone = useCallback(() => {
    setModelGuideStep(0)
    setShowAppearanceStep(true)
  }, [])

  const toggleRightSidebar = () => {
    setRightSidebarCollapsed((prev) => {
      const next = !prev
      try {
        localStorage.setItem('right-sidebar-collapsed', String(next))
      } catch {
        // ignore
      }
      return next
    })
  }

  const toggleSidebar = () => {
    setSidebarCollapsed((c) => {
      const next = !c
      try {
        localStorage.setItem('sidebar-collapsed', String(next))
      } catch {
        // ignore
      }
      return next
    })
  }

  const effectiveDark =
    theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const wallpaperOverlay = wallpaper ? `rgba(${effectiveDark ? '10,12,16' : '250,250,252'}, ${wallpaper.dim})` : 'transparent'

  const renderModule = () => {
    switch (activeModule) {
      case 'chat':
        return <ChatView rightSidebarCollapsed={rightSidebarCollapsed} onToggleRightSidebar={toggleRightSidebar} sidebarCollapsed={sidebarCollapsed} onToggleSidebar={toggleSidebar} />
      case 'overview':
        return <Overview onNavigate={handleNavigate} />
      case 'paper':
        return <Paper rightSidebarCollapsed={rightSidebarCollapsed} onToggleRightSidebar={toggleRightSidebar} sidebarCollapsed={sidebarCollapsed} onToggleSidebar={toggleSidebar} />
      case 'library':
        return <Library />
      case 'experiments':
        return <Experiments />
      case 'figures':
        return <Figures />
      case 'meetings':
        return <Meetings />
      case 'venues':
        return <Venues />
      case 'servers':
        return <Servers />
      case 'ledger':
        return <Ledger />
      case 'plugins':
        return <Plugins />
      case 'settings':
        return (
          <Settings
            autoOpenModelDialog={modelGuideStep}
            guided={modelGuideStep > 0}
            onModelStepDone={handleModelStepDone}
            onThemeSaved={setTheme}
          />
        )
      default:
        return <ChatView rightSidebarCollapsed={rightSidebarCollapsed} onToggleRightSidebar={toggleRightSidebar} sidebarCollapsed={sidebarCollapsed} onToggleSidebar={toggleSidebar} />
    }
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background">
      <Sidebar
        activeModule={activeModule}
        onNavigate={handleNavigate}
        collapsed={sidebarCollapsed}
        onToggle={toggleSidebar}
        spaces={spaces}
        activeSpaceId={activeSpaceId}
        onSelectSpace={handleSwitchSpace}
        onManageSpaces={() => handleNavigate('settings')}
      />
      <main className="relative flex-1 overflow-hidden">
        {/* 背景图 + 明暗遮罩（可读性），位于各模块内容之后 */}
        {wallpaper !== null && (
          <>
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-cover bg-center"
              style={{ backgroundImage: `url("${wallpaper.url}")` }}
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{ backgroundColor: wallpaperOverlay }}
            />
          </>
        )}
        <div key={`${activeModule}-${spaceVersion}`} className="relative h-full message-appear">
          {spaceLoading ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              <span className="text-[12px]">正在打开科研空间…</span>
            </div>
          ) : (
            renderModule()
          )}
        </div>
      </main>

      {/* 首次启动：选择/创建科研空间（无空间前不可关闭） */}
      <Dialog open={gateOpen} onOpenChange={() => {}}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>选择科研空间</DialogTitle>
            <DialogDescription>
              科研空间是一个独立目录，用于承载论文、实验、图表、组会与对话等研究数据。
              {spaces.length > 0 && activeSpace === null
                ? '你还没有选择使用的空间，选择一个开始工作吧。'
                : '首次使用，请先创建你的第一个科研空间。'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-[11px]">空间名称</Label>
              <Input
                value={gateName}
                onChange={(e) => setGateName(e.target.value)}
                className="h-8 text-[12px]"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px]">存放位置</Label>
              <div className="flex items-center gap-2">
                <Input
                  placeholder="默认：~/Mimir/空间名称"
                  value={gateDir}
                  onChange={(e) => setGateDir(e.target.value)}
                  className="h-8 text-[11px] font-mono flex-1"
                />
                <Button type="button" variant="outline" size="sm" className="h-8 text-[11px] shrink-0" onClick={handlePickGateDir}>
                  <FolderOpen className="h-3 w-3 mr-1" />
                  浏览
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground">
                留空使用默认位置；也可选择任意已有目录（新建空间会写入该目录）。
              </p>
            </div>

            {gateError !== null && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
                {gateError}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              size="sm"
              className="h-8"
              onClick={handleCreateFirstSpace}
              disabled={!gateName.trim() || gateBusy}
            >
              {gateBusy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Plus className="h-3.5 w-3.5 mr-1" />}
              创建并进入
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 首次引导第三步：选择外观 + 开始科研之旅 */}
      <Dialog open={showAppearanceStep} onOpenChange={() => {}}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>选择外观</DialogTitle>
            <DialogDescription>
              {basicModels.count > 0 && (
                <span className="mb-1.5 flex items-center gap-1 rounded-full border border-green-500/25 bg-green-500/5 px-2 py-1 text-[11px] font-medium text-green-600 dark:text-green-400">
                  <Check className="h-3 w-3 shrink-0" />
                  已从本机基础信息导入 {basicModels.count} 个模型
                  {basicModels.name !== '' ? `，默认 ${basicModels.name}` : ''}，无需重复配置
                </span>
              )}
              <span className="mt-1 block">
                最后一步：选一个顺眼的主题（当前：{theme === 'dark' ? '深色' : theme === 'light' ? '浅色' : '跟随系统'}），然后开启科研之旅。
              </span>
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-3 gap-2">
            {(
              [
                { value: 'light', label: '浅色', icon: Sun },
                { value: 'dark', label: '深色', icon: Moon },
                { value: 'system', label: '跟随系统', icon: Monitor }
              ] as const
            ).map((option) => {
              const Icon = option.icon
              const selected = theme === option.value
              return (
                <button
                  key={option.value}
                  onClick={() => applyGuidedTheme(option.value)}
                  className={cn(
                    'flex flex-col items-center gap-2 rounded-lg border p-4 transition-all',
                    selected
                      ? 'border-primary bg-primary/5 text-primary shadow-sm'
                      : 'border-border text-muted-foreground hover:bg-accent'
                  )}
                >
                  <Icon className="h-5 w-5" />
                  <span className="text-[12px] font-medium">{option.label}</span>
                  {selected && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
                </button>
              )
            })}
          </div>

          <DialogFooter>
            <Button size="sm" className="h-8 w-full" onClick={handleFinishOnboarding}>
              开始科研之旅
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
