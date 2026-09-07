import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  MessageSquare,
  LayoutDashboard,
  FileText,
  BookOpen,
  BarChart3,
  Image,
  Presentation,
  Server,
  Clock,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
  FolderKanban,
  ChevronsUpDown,
  Check,
  CalendarClock,
  Puzzle
} from 'lucide-react'

export type ModuleId =
  | 'chat'
  | 'overview'
  | 'paper'
  | 'library'
  | 'experiments'
  | 'figures'
  | 'meetings'
  | 'venues'
  | 'servers'
  | 'ledger'
  | 'plugins'
  | 'settings'

interface NavItem {
  id: ModuleId
  label: string
  icon: React.ElementType
}

interface NavGroup {
  label?: string
  items: NavItem[]
}

const navGroups: NavGroup[] = [
  {
    items: [
      { id: 'chat', label: '对话', icon: MessageSquare },
      { id: 'overview', label: '总览', icon: LayoutDashboard }
    ]
  },
  {
    label: '研究工具',
    items: [
      { id: 'library', label: '文献库', icon: BookOpen },
      { id: 'paper', label: '论文', icon: FileText },
      { id: 'experiments', label: '实验', icon: BarChart3 },
      { id: 'figures', label: '图表', icon: Image }
    ]
  },
  {
    label: '其他',
    items: [
      { id: 'meetings', label: '组会', icon: Presentation },
      { id: 'venues', label: '会议', icon: CalendarClock },
      { id: 'servers', label: '服务器', icon: Server },
      { id: 'ledger', label: '记录', icon: Clock }
    ]
  }
]

interface SidebarProps {
  activeModule: ModuleId
  onNavigate: (id: ModuleId) => void
  collapsed: boolean
  onToggle: () => void
  /** 科研空间（展开态显示选择器）。 */
  spaces?: readonly { id: string; name: string }[] | undefined
  activeSpaceId?: string | null | undefined
  onSelectSpace?: (id: string) => void
  onManageSpaces?: () => void
}

export function Sidebar({
  activeModule,
  onNavigate,
  collapsed,
  onToggle,
  spaces,
  activeSpaceId,
  onSelectSpace,
  onManageSpaces
}: SidebarProps) {
  return (
    <div
      className={cn(
        'flex h-full shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-200 overflow-hidden',
        collapsed ? 'w-0' : 'w-[200px]'
      )}
      style={{ color: 'hsl(var(--sidebar-fg))' }}
    >
      {/* Title bar drag region */}
      <div className="drag-region relative h-12 shrink-0" style={{ paddingTop: '28px' }}>
        {/* 科研空间切换（位于收缩按钮左侧） */}
        {!collapsed && spaces !== undefined && spaces.length > 0 && (
          <SpaceSwitcher
            spaces={spaces}
            activeSpaceId={activeSpaceId ?? null}
            onSelectSpace={(id) => {
              onSelectSpace?.(id)
            }}
            onManage={onManageSpaces}
          />
        )}
        {/* Collapse toggle - aligned with Mimir Agent header height */}
        <button
          onClick={onToggle}
          title="收起侧边栏"
          className="no-drag absolute right-2 top-[12px] flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>

      {/* Navigation */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {navGroups.map((group, gi) => (
          <div key={gi} className={cn('flex flex-col', gi > 0 && 'mt-4')}>
            {group.label && (
              <div className="px-2 mb-1 metric-label text-[10px]">{group.label}</div>
            )}
            {group.items.map((item) => (
              <NavItemComponent
                key={item.id}
                item={item}
                active={activeModule === item.id}
                onClick={() => onNavigate(item.id)}
              />
            ))}
          </div>
        ))}
      </div>

      {/* Bottom */}
      <div className="space-y-0.5 px-2 py-2">
        <NavItemComponent
          item={{ id: 'plugins', label: '插件', icon: Puzzle }}
          active={activeModule === 'plugins'}
          onClick={() => onNavigate('plugins')}
        />
        <NavItemComponent
          item={{ id: 'settings', label: '设置', icon: Settings }}
          active={activeModule === 'settings'}
          onClick={() => onNavigate('settings')}
        />
      </div>
    </div>
  )
}

function NavItemComponent({
  item,
  active,
  onClick
}: {
  item: NavItem
  active: boolean
  onClick: () => void
}) {
  const Icon = item.icon

  return (
    <button
      onClick={onClick}
      className={cn(
        'group flex w-full items-center gap-2.5 rounded-md px-2.5 py-[5px] text-[13px] transition-all duration-100',
        active
          ? 'bg-primary/10 text-primary font-medium'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground'
      )}
    >
      <Icon className={cn('h-4 w-4 shrink-0', active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground')} />
      <span className="truncate">{item.label}</span>
      {active && <div className="ml-auto h-1 w-1 rounded-full bg-primary" />}
    </button>
  )
}

interface SpaceSwitcherProps {
  spaces: readonly { id: string; name: string }[]
  activeSpaceId: string | null
  onSelectSpace: (id: string) => void
  onManage?: (() => void) | undefined
}

/** 侧边栏顶部的科研空间切换器（收缩按钮左侧）。 */
function SpaceSwitcher({ spaces, activeSpaceId, onSelectSpace, onManage }: SpaceSwitcherProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const current = spaces.find((s) => s.id === activeSpaceId) ?? null

  return (
    <div ref={ref} className="no-drag absolute left-[72px] top-[10px] right-8 z-30">
      <button
        onClick={() => setOpen((prev) => !prev)}
        title="切换科研空间"
        className={cn(
          'flex w-full items-center gap-1 rounded-md px-1.5 py-[5px] text-[11px] transition-colors',
          open ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
        )}
      >
        <FolderKanban className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate text-left">{current?.name ?? '未选择空间'}</span>
        <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-60" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-[150px] rounded-md border border-border bg-popover p-1 shadow-md">
          <div className="px-2 pb-1 pt-0.5 text-[10px] font-medium text-muted-foreground">科研空间</div>
          {spaces.map((space) => {
            const active = space.id === activeSpaceId
            return (
              <button
                key={space.id}
                onClick={() => {
                  onSelectSpace(space.id)
                  setOpen(false)
                }}
                className={cn(
                  'flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-[11px] transition-colors',
                  active
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                )}
              >
                <FolderKanban className={cn('h-3 w-3 shrink-0', active ? 'text-primary' : 'text-muted-foreground/60')} />
                <span className="min-w-0 flex-1 truncate">{space.name}</span>
                {active && <Check className="h-3 w-3 shrink-0 text-primary" />}
              </button>
            )
          })}
          {onManage !== undefined && (
            <>
              <div className="my-1 h-px bg-border" />
              <button
                onClick={() => {
                  setOpen(false)
                  onManage()
                }}
                className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Settings className="h-3 w-3 shrink-0" />
                管理科研空间…
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
