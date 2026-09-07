import { useMemo, useState } from 'react'
import type { SwarmTreeNodeItem } from './ChatView'
import { cn } from '@/lib/utils'
import {
  Loader2,
  Check,
  ChevronRight,
  ChevronDown,
  BrainCircuit,
  Reply,
  CircleX,
  Pause,
  Sparkles,
  GitBranch,
  Wrench
} from 'lucide-react'

/**
 * Agent 执行过程「内嵌轨迹卡」：豆包/千问式，展示在助手消息气泡内。
 *
 * - 整卡可折叠：执行中自动展开，完成后默认收起并显示摘要（任务/工具步数与成败）；
 * - 卡内是事件树（run → 阶段/任务 → 思考全文可展开 / 工具调用·返回/出错）；
 * - 支持 running / done / error / canceled 四种状态，工具行标注耗时；
 * - 思考与工具返回等叶子文本可点击标题展开/收起全文。
 */

/** 毫秒 → 人读耗时（<1s 显示毫秒，否则秒/分钟）。 */
function formatDur(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms)) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

type NodeStatus = 'running' | 'done' | 'error' | 'canceled'

function StatusIcon({ status, kind }: { status?: NodeStatus; kind: string }) {
  if (status === 'running') return <Loader2 className="h-3 w-3 animate-spin" />
  if (status === 'canceled') return <Pause className="h-3 w-3 text-muted-foreground" />
  if (kind === 'think') return <BrainCircuit className="h-3 w-3 text-violet-500" />
  if (kind === 'tool') return <Wrench className="h-2.5 w-2.5 text-sky-500/80" />
  if (status === 'error') return <CircleX className="h-3 w-3 text-destructive" />
  if (status === 'done') return <Check className="h-3 w-3 text-green-600 dark:text-green-400" />
  if (kind === 'run') return <Sparkles className="h-3 w-3 text-primary" />
  if (kind === 'phase') return <GitBranch className="h-3 w-3 text-primary/70" />
  return null
}

interface NodeRowProps {
  item: SwarmTreeNodeItem
  depth: number
  collapsedKeys: Set<string>
  onToggle: (key: string) => void
}

function NodeRow({ item, depth, collapsedKeys, onToggle }: NodeRowProps) {
  const { node } = item
  const collapsed = collapsedKeys.has(node.key)
  const hasBody = item.children.length > 0 || node.text !== undefined
  const leafText = item.children.length === 0 && node.text !== undefined
  const toolResult = node.kind === 'tool' && !node.text?.startsWith('调用')
  const duration = formatDur(node.durationMs)

  return (
    <div className="relative">
      {/* 节点标题行 */}
      <button
        type="button"
        onClick={() => hasBody && onToggle(node.key)}
        className={cn(
          'flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-accent/60',
          depth === 0 ? 'text-[11px]' : 'text-[10px]'
        )}
      >
        <span style={{ width: depth * 14 }} className="shrink-0" />
        {hasBody ? (
          collapsed ? (
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span style={{ width: 12 }} className="shrink-0" />
        )}
        <StatusIcon status={node.status} kind={node.kind} />
        <span
          className={cn(
            'min-w-0 flex-1 truncate font-medium',
            node.status === 'canceled' ? 'text-muted-foreground line-through decoration-muted-foreground/40' : depth === 0 ? 'text-foreground/95' : 'text-foreground/80'
          )}
        >
          {node.title}
        </span>
        {node.status === 'canceled' && (
          <span className="shrink-0 text-[9px] text-muted-foreground">已取消</span>
        )}
        {node.status === 'running' && <span className="shrink-0 text-[9px] text-primary">进行中</span>}
        {node.status === 'error' && <span className="shrink-0 text-[9px] text-destructive">出错</span>}
        {node.durationMs !== undefined && toolResult && (
          <span className="shrink-0 rounded bg-muted px-1 text-[9px] tabular-nums text-muted-foreground">
            {duration}
          </span>
        )}
      </button>

      {!collapsed && (
        <>
          {/* 叶子内容：思考全文 / 工具调用·返回（超长区可纵向滚动） */}
          {leafText && node.text !== undefined && node.text !== '' && (
            <div className="ml-[27px]">
              <div
                className={cn(
                  'whitespace-pre-wrap break-words rounded-md border-l-2 py-0.5 pl-2 pr-1 text-[10px] leading-relaxed',
                  node.status === 'error' && 'border-destructive/60 text-destructive/90',
                  node.kind === 'think' && 'border-violet-400/60 text-violet-700/90 dark:text-violet-300/90',
                  toolResult && 'text-muted-foreground'
                )}
              >
                <span className="inline-flex items-start gap-1">
                  {node.kind === 'think' ? (
                    <BrainCircuit className="mt-0.5 h-2.5 w-2.5 shrink-0" />
                  ) : toolResult ? (
                    <Reply className="mt-0.5 h-2.5 w-2.5 shrink-0 text-sky-500" />
                  ) : (
                    <Wrench className="mt-0.5 h-2.5 w-2.5 shrink-0 text-sky-500/80" />
                  )}
                  <span className="max-h-56 overflow-y-auto pr-1">{node.text}</span>
                </span>
              </div>
            </div>
          )}

          {/* 子节点 */}
          {item.children.map((child) => (
            <NodeRow
              key={child.node.key}
              item={child}
              depth={depth + 1}
              collapsedKeys={collapsedKeys}
              onToggle={onToggle}
            />
          ))}
        </>
      )}
    </div>
  )
}

/** 统计树上是否有节点处于运行中（用于卡片自动展开/摘要）。 */
function hasRunning(item: SwarmTreeNodeItem): boolean {
  return item.node.status === 'running' || item.children.some(hasRunning)
}

/** 统计工具调用对数（调用行 → 返回行各算一次调用）与运行节点数。 */
function countSummary(item: SwarmTreeNodeItem): { tools: number; tasks: number; done: number } {
  let tools = 0
  let tasks = 0
  let done = 0
  const walk = (n: SwarmTreeNodeItem): void => {
    if (n.node.kind === 'tool' && (n.node.text?.startsWith('调用') ?? false)) tools += 1
    if (n.node.kind === 'task' || n.node.kind === 'phase') {
      tasks += 1
      if (n.node.status === 'done' || n.node.status === 'error') done += 1
    }
    n.children.forEach(walk)
  }
  walk(item)
  return { tools, tasks, done }
}

export interface AgentTraceCardProps {
  trace: SwarmTreeNodeItem
  /** 是否仍处于流式生成（影响默认展开态）。 */
  isStreaming?: boolean
}

/** 助手消息内嵌的 Agent 执行轨迹卡（豆包/千问式）。 */
export function AgentTraceCard({ trace, isStreaming }: AgentTraceCardProps) {
  // 用户是否手动开/关过卡片；null = 未干预，按运行态自动决定
  const [manual, setManual] = useState<boolean | null>(null)
  const stats = useMemo(() => countSummary(trace), [trace])
  const running = useMemo(() => hasRunning(trace), [trace])
  const effectiveOpen = manual ?? running

  const anyCanceled = useMemo(() => {
    let found = false
    const walk = (n: SwarmTreeNodeItem): void => {
      if (n.node.status === 'canceled') found = true
      n.children.forEach(walk)
    }
    walk(trace)
    return found
  }, [trace])

  const stateBadge = running ? (
    <span className="flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 py-px text-[9px] font-medium text-primary">
      <Loader2 className="h-2.5 w-2.5 animate-spin" />
      执行中
    </span>
  ) : anyCanceled ? (
    <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[9px] font-medium text-muted-foreground">
      已停止
    </span>
  ) : (
    <span className="flex shrink-0 items-center gap-1 rounded-full bg-green-500/10 px-1.5 py-px text-[9px] font-medium text-green-600 dark:text-green-400">
      <Check className="h-2.5 w-2.5" />
      执行完成
    </span>
  )

  return (
    <div className={cn('rounded-lg border', running ? 'border-primary/25' : 'border-border/70')}>
      {/* 卡片标题行（点击开合） */}
      <button
        type="button"
        onClick={() => setManual((prev) => !(prev ?? running))}
        className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left transition-colors hover:bg-accent/40"
      >
        {effectiveOpen ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <StatusIcon status={trace.node.status} kind="run" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-foreground/90">
          {trace.node.title}
        </span>
        {stats.tasks > 0 && stats.tasks === stats.done && (
          <span className="hidden shrink-0 text-[9px] tabular-nums text-muted-foreground sm:inline">
            {stats.tools} 次工具 · {stats.tasks} 个任务
          </span>
        )}
        {stateBadge}
      </button>

      {effectiveOpen && (
        <div className="space-y-px border-t border-border/60 px-1 py-1">
          {trace.children.map((child) => (
            <RowGroup key={child.node.key} root={child} depth={1} />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 递归树行组：管理每个节点的「手动折叠」集合，状态提升到叶子，避免整组重算。
 * 为减少嵌套组件间传参，这里用一个内部轻量容器。
 */
function RowGroup({ root, depth }: { root: SwarmTreeNodeItem; depth: number }) {
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(new Set())
  const toggle = (key: string): void => {
    setCollapsedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  return (
    <NodeRow
      item={root}
      depth={depth}
      collapsedKeys={collapsedKeys}
      onToggle={toggle}
    />
  )
}
