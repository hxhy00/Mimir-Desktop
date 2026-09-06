import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'

// 与左侧边栏一致（Sidebar 的 w-[200px]），保证启动时两侧等宽
const DEFAULT_WIDTH = 200
const MIN_WIDTH = 200

interface RightSidebarProps {
  collapsed: boolean
  onToggle: () => void
  children: React.ReactNode
  headerActions?: React.ReactNode
}

export function RightSidebar({ collapsed, onToggle, children, headerActions }: RightSidebarProps) {
  const [width, setWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('right-sidebar-width')
      return saved ? Math.max(Number(saved), MIN_WIDTH) : DEFAULT_WIDTH
    } catch {
      return DEFAULT_WIDTH
    }
  })
  const [dragging, setDragging] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const widthRef = useRef(width)

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setDragging(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onMouseMove = (ev: MouseEvent) => {
      const el = containerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const parent = el.parentElement
      const parentWidth = parent ? parent.getBoundingClientRect().width : rect.width
      // 最大宽度 = 中间区域 + 右边栏总宽度的一半
      const maxWidth = parentWidth / 2
      const next = Math.min(Math.max(rect.right - ev.clientX, MIN_WIDTH), maxWidth)
      widthRef.current = next
      setWidth(next)
    }

    const onMouseUp = () => {
      setDragging(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      try {
        localStorage.setItem('right-sidebar-width', String(widthRef.current))
      } catch {
        // ignore
      }
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative flex h-full shrink-0 flex-col border-l border-border bg-sidebar',
        collapsed ? 'w-0 overflow-hidden' : '',
        !dragging && 'transition-[width] duration-200'
      )}
      style={collapsed ? undefined : { width }}
    >
      {/* Resize handle */}
      {!collapsed && (
        <div
          onMouseDown={handleResizeStart}
          className="group absolute -left-[5px] top-0 z-20 flex h-full w-[10px] cursor-col-resize items-center justify-center"
          title="拖拽调整宽度"
        >
          <div className="h-10 w-[3px] rounded-full bg-border/60 opacity-0 transition-opacity group-hover:opacity-100 group-active:bg-primary/50" />
        </div>
      )}

      {/* Header with toggle button - background matches main content */}
      <div className="drag-region relative h-12 shrink-0 flex items-center justify-end gap-1.5 bg-background px-4">
        {headerActions}
        <button
          onClick={onToggle}
          title="收起侧边栏"
          className="no-drag flex items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <PanelRightClose className="h-4 w-4" />
        </button>
      </div>

      {/* Content */}
      <ScrollArea className="flex-1">
        {children}
      </ScrollArea>
    </div>
  )
}

// Expand button to show the right sidebar (placed in top bar)
export function RightSidebarExpandButton({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <button
      onClick={onClick}
      title="展开右侧边栏"
      className={cn(
        'flex items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
        className
      )}
    >
      <PanelRightOpen className="h-4 w-4" />
    </button>
  )
}