import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import {
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  CircleX,
  FileText,
  Loader2,
  Lock,
  Pause,
  Settings2,
  Users,
  Wrench
} from 'lucide-react'
import {
  activityOf as activityText,
  isRunActive,
  summarizeRun,
  visibleSteps,
  type AgentRun,
  type AgentStep
} from './agentRun'

/**
 * Agent 执行过程「步骤时间线」：内嵌在助手消息气泡里。
 *
 * ── 形态 ──────────────────────────────────────────────────────────────────
 * 一次工具调用 = 一行（调用与返回由 `step.callId` 合并，不再拆成两行）；
 * 左侧竖线 + 状态点构成时间线，右侧是步骤内容；标题行给**收据式摘要**
 * （工具次数 / 耗时 / 产物数 / 失败数 / 待批准）。
 *
 * ── 内部步骤默认显示 ──────────────────────────────────────────────────────
 * 技能路由、上下文治理这类**实现细节**，以及**模型思考**（草稿而非动作），
 * 都不占正文（`step.internal === true`）。默认**显示**（用户要求执行过程透明，
 * 2026-09-16），底部开关可收起；开关文案把「思考过程」与「内部步骤」分开报数
 * （见 `summarizeRun`）。
 *
 * ── 语义来源 ──────────────────────────────────────────────────────────────
 * 一切判断取自结构化字段（`step.stage` / `status` / `internal`），
 * **不解析文案** —— 详见 `agentRun.ts` 的模块注释。
 */

/** 毫秒 → 人读耗时。 */
function formatDur(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

/** 文件动作 → 展示动词。 */
const FILE_VERB: Record<'read' | 'write' | 'edit' | 'delete', string> = {
  read: '读取',
  write: '写入',
  edit: '编辑',
  delete: '删除'
}

/**
 * 极简行级 diff（LCS 不必要，用「按行对齐 + 标记增删」即可满足展示）。
 * old/new 通常是小段代码，逐行比对足够；不做词内高亮。
 */
function lineDiff(oldStr: string, newStr: string): { type: 'ctx' | 'add' | 'del'; text: string }[] {
  const a = oldStr.split('\n')
  const b = newStr.split('\n')
  const out: { type: 'ctx' | 'add' | 'del'; text: string }[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ type: 'ctx', text: a[i] })
      i += 1
      j += 1
    } else if (j < b.length && (i >= a.length || !a.slice(i).includes(b[j]))) {
      out.push({ type: 'add', text: b[j] })
      j += 1
    } else if (i < a.length) {
      out.push({ type: 'del', text: a[i] })
      i += 1
    } else {
      out.push({ type: 'add', text: b[j] })
      j += 1
    }
  }
  return out
}

/**
 * 当前活动行文案。
 *
 * 逻辑放在 `agentRun.ts`（纯数据层、可单测）—— 这里只负责渲染。
 */
function activityOf(run: AgentRun, awaiting?: string): { text: string; waiting: boolean } {
  return activityText(run, awaiting)
}

/**
 * 把返回文本里的 URL / arXiv id 渲染成可点外链。
 *
 * 只允许 http(s)：主进程侧 `shell:openExternal` 也会再校验一次协议
 * （`shell.openExternal` 对任意 scheme 是已知风险面）。
 */
function withLinks(text: string): ReactNode[] {
  const pattern = /(https?:\/\/[^\s)】），,]+)|(?:arXiv[:\s]*)(\d{4}\.\d{4,5})/g
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  const open = (url: string): void => {
    void window.electronAPI?.openExternal?.(url)
  }
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const url = m[1] ?? `https://arxiv.org/abs/${m[2]}`
    const label = m[1] ?? `arXiv:${m[2]}`
    out.push(
      <button
        key={`${m.index}-${label}`}
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          open(url)
        }}
        className="cursor-pointer text-sky-600 underline decoration-sky-500/40 hover:decoration-sky-500 dark:text-sky-400"
        title={url}
      >
        {label}
      </button>
    )
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function StepIcon({ step }: { step: AgentStep }) {
  if (step.status === 'running') return <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />
  if (step.status === 'canceled') return <Pause className="h-3 w-3 shrink-0 text-muted-foreground" />
  if (step.status === 'error') return <CircleX className="h-3 w-3 shrink-0 text-destructive" />
  // 委派行：用「多人」图标与普通工具区分 —— 它是唯一会拉起另一个 Agent 的步骤。
  if (step.isDelegation === true) return <Users className="h-3 w-3 shrink-0 text-sky-600 dark:text-sky-400" />
  if (step.kind === 'think') return <BrainCircuit className="h-3 w-3 shrink-0 text-violet-500" />
  if (step.kind === 'phase') return <Settings2 className="h-3 w-3 shrink-0 text-muted-foreground" />
  if (step.artifacts !== undefined && step.artifacts.length > 0)
    return <FileText className="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
  return <Check className="h-3 w-3 shrink-0 text-green-600 dark:text-green-400" />
}

interface StepRowProps {
  step: AgentStep
  /** 该步骤正在等待用户批准（按工具名匹配当前待批准请求）。 */
  awaiting?: boolean
  last: boolean
}

function StepRow({ step, awaiting, last }: StepRowProps) {
  const [open, setOpen] = useState(false)
  const expandable =
    step.kind === 'think'
      ? (step.text ?? '') !== ''
      : (step.resultSummary ?? '') !== '' ||
        (step.argsSummary ?? '') !== '' ||
        (step.command ?? '') !== '' ||
        step.editDiff !== undefined
  // think 行的耗时来自 applyRunEvent 回填的 thinkMs（工具行用主进程实测的 durationMs）。
  const duration = formatDur(step.kind === 'think' ? step.thinkMs : step.durationMs)
  // 子代理内部步骤：视觉上收拢到委派行之下（缩进 + 竖线弱化），与主 Agent 亲手做的步骤区分。
  const inSubagent = step.origin === 'subagent' && step.isDelegation !== true

  return (
    <div className={cn('relative flex gap-2', inSubagent && 'pl-4')}>
      {/* 时间线竖线 + 状态点 */}
      <div className="relative flex w-3 shrink-0 justify-center">
        <span
          className={cn(
            'absolute left-1/2 top-3 w-px -translate-x-1/2',
            inSubagent ? 'bg-sky-500/25' : 'bg-border',
            last ? 'h-1.5' : 'h-full'
          )}
        />
        <span className="relative z-10 mt-[3px] flex h-3 w-3 items-center justify-center bg-background">
          <StepIcon step={step} />
        </span>
      </div>

      <div className="min-w-0 flex-1 pb-1.5">
        <button
          type="button"
          disabled={!expandable}
          onClick={() => expandable && setOpen((v) => !v)}
          className={cn(
            'flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors',
            expandable && 'hover:bg-accent/60'
          )}
        >
          {expandable &&
            (open ? (
              <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
            ))}
          {step.isDelegation === true ? (
            // 委派行：这是主 Agent「把活派出去」的入口，必须一眼可辨 ——
            // 后续带 origin='subagent' 的步骤都发生在这次委派内部。
            <>
              <span className="shrink-0 text-[11px] font-medium text-sky-700 dark:text-sky-300">委派</span>
              <span className="min-w-0 shrink-0 truncate text-[11px] font-medium text-foreground/95">
                {step.subagentLabel ?? step.subagentId ?? '子代理'}
              </span>
              {step.subagentId !== undefined && step.subagentLabel !== undefined && (
                <span className="shrink-0 font-mono text-[9px] text-muted-foreground">{step.subagentId}</span>
              )}
            </>
          ) : step.file !== undefined ? (
            // 文件步骤按「动作 + 文件名 + 增删行数」渲染（对齐 WorkBuddy 那种一行人读得懂的形式），
            // 不再把一整坨 JSON 入参糊在行上。
            <>
              <span className="shrink-0 text-[11px] font-medium text-foreground/90">
                {FILE_VERB[step.file.action]}
              </span>
              <span className="min-w-0 shrink-0 truncate font-mono text-[11px] font-medium text-foreground/95">
                {step.file.path.split('/').pop() ?? step.file.path}
              </span>
              {step.file.added !== undefined && (
                <span className="shrink-0 text-[10px] tabular-nums text-emerald-600 dark:text-emerald-400">
                  +{step.file.added}
                </span>
              )}
              {step.file.removed !== undefined && (
                <span className="shrink-0 text-[10px] tabular-nums text-rose-500">
                  −{step.file.removed}
                </span>
              )}
            </>
          ) : (
            <>
              <span
                className={cn(
                  'min-w-0 shrink-0 truncate text-[11px] font-medium',
                  step.kind === 'tool' && step.command === undefined ? 'font-mono' : '',
                  step.status === 'error' ? 'text-destructive' : 'text-foreground/90'
                )}
              >
                {step.command !== undefined ? '运行' : step.title}
              </span>
              {step.label !== undefined && (
                <span className="shrink-0 rounded bg-muted px-1 text-[9px] text-muted-foreground">{step.label}</span>
              )}
              {/* 参数摘要：折叠时也露一眼，用户不用点开就知道这一步在动什么 */}
              {!open && (step.argsSummary ?? '') !== '' && step.kind === 'tool' && (
                <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
                  {step.argsSummary}
                </span>
              )}
            </>
          )}
          {/* 命令步骤（execute）：显示「运行 + 命令行」，折叠时也露出命令，点开看完整。 */}
          {!open && step.command !== undefined && (
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
              {step.command}
            </span>
          )}
          {!open && step.file !== undefined && step.command === undefined && <span className="min-w-0 flex-1" />}
          {!open && step.file === undefined && step.command === undefined && step.kind !== 'tool' && (
            <span className="min-w-0 flex-1" />
          )}
          {open && <span className="min-w-0 flex-1" />}
          {awaiting && (
            <span className="flex shrink-0 items-center gap-0.5 rounded-full bg-amber-500/15 px-1.5 py-px text-[9px] font-medium text-amber-700 dark:text-amber-300">
              <Lock className="h-2.5 w-2.5" />
              等待批准
            </span>
          )}
          {duration !== '' && (
            <span className="shrink-0 rounded bg-muted px-1 text-[9px] tabular-nums text-muted-foreground">
              {duration}
            </span>
          )}
        </button>

        {open && (
          <div className="ml-4 space-y-1 pt-0.5">
            {/* 命令全文（execute） */}
            {(step.command ?? '') !== '' && (
              <div className="rounded-md border-l-2 border-sky-400/50 bg-muted/30 py-0.5 pl-2 pr-1 text-[10px] leading-relaxed">
                <div className="mb-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground/70">命令</div>
                <pre className="whitespace-pre-wrap break-words font-mono text-foreground/90">{step.command}</pre>
              </div>
            )}
            {/* edit 具体改动：红绿行级 diff */}
            {step.editDiff !== undefined && (
              <div className="overflow-hidden rounded-md border border-border/60 text-[10px] leading-relaxed">
                <div className="bg-muted/40 px-2 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground/70">
                  改动内容
                </div>
                <div className="max-h-56 overflow-y-auto font-mono">
                  {lineDiff(step.editDiff.old, step.editDiff.new).map((row, idx) => (
                    <div
                      key={idx}
                      className={cn(
                        'whitespace-pre-wrap break-words px-2',
                        row.type === 'add' && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
                        row.type === 'del' && 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
                        row.type === 'ctx' && 'text-muted-foreground'
                      )}
                    >
                      <span className="select-none opacity-60">{row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '}</span>
                      {row.text}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {(step.argsSummary ?? '') !== '' && step.command === undefined && step.editDiff === undefined && (
              <div className="rounded-md border-l-2 border-sky-400/50 py-0.5 pl-2 pr-1 text-[10px] leading-relaxed text-muted-foreground">
                <div className="mb-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground/70">入参</div>
                <div className="whitespace-pre-wrap break-words">{step.argsSummary}</div>
              </div>
            )}
            {(step.kind === 'think' ? step.text : step.resultSummary) !== undefined &&
              (step.kind === 'think' ? step.text : step.resultSummary) !== '' && (
                <div
                  className={cn(
                    'rounded-md border-l-2 py-0.5 pl-2 pr-1 text-[10px] leading-relaxed',
                    step.kind === 'think' && 'border-violet-400/60 text-violet-700/90 dark:text-violet-300/90',
                    step.status === 'error' && 'border-destructive/60 text-destructive/90',
                    step.kind === 'tool' && step.status !== 'error' && 'border-border text-muted-foreground'
                  )}
                >
                  <div className="mb-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground/70">
                    {step.kind === 'think' ? '思考' : step.status === 'error' ? '出错' : '返回'}
                  </div>
                  <div className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words pr-1">
                    {withLinks(step.kind === 'think' ? (step.text ?? '') : (step.resultSummary ?? ''))}
                  </div>
                </div>
              )}
            {step.artifacts !== undefined && step.artifacts.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {step.artifacts.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      void window.electronAPI?.openPath?.(p)
                    }}
                    className="flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/[0.06] px-1.5 py-px text-[10px] text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-300"
                    title={p}
                  >
                    <FileText className="h-2.5 w-2.5" />
                    {p.split('/').pop() ?? p}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export interface AgentTimelineProps {
  run: AgentRun
  /** 是否仍在生成（影响默认展开态）。 */
  isStreaming?: boolean
  /** 当前待批准的工具名（用于在对应步骤上标「等待批准」）。 */
  pendingApprovalTool?: string
}

/** 助手消息内嵌的 Agent 执行过程时间线。 */
export function AgentTimeline({ run, isStreaming, pendingApprovalTool }: AgentTimelineProps) {
  // 用户是否手动开/关过；null = 未干预，按运行态自动决定
  const [manual, setManual] = useState<boolean | null>(null)
  // 内部步骤（思考/技能路由等）默认显示，用户可手动收起（产品要求执行过程透明）。
  const [showInternal, setShowInternal] = useState(true)

  const running = isRunActive(run, isStreaming)

  // 每秒走一次表：耗时必须是**活的**。
  // 否则工具跑几十秒期间没有任何事件到达，标题上的「35.9s」会一直冻着，看着就像卡死。
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setTick((v) => v + 1), 1000)
    return () => window.clearInterval(timer)
  }, [running])

  // 刻意不用 useMemo：耗时依赖"当前时间"，每秒都要重算（O(步骤数)，代价可忽略）
  const receipt = summarizeRun(run)
  const open = manual ?? running
  const steps = useMemo(() => visibleSteps(run, showInternal), [run, showInternal])
  const activity = activityOf(run, pendingApprovalTool)

  const badge = running ? (
    <span className="flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 py-px text-[9px] font-medium text-primary">
      <Loader2 className="h-2.5 w-2.5 animate-spin" />
      执行中
    </span>
  ) : run.status === 'canceled' ? (
    <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[9px] font-medium text-muted-foreground">
      已停止
    </span>
  ) : run.status === 'error' ? (
    <span className="shrink-0 rounded-full bg-destructive/10 px-1.5 py-px text-[9px] font-medium text-destructive">
      执行出错
    </span>
  ) : (
    <span className="flex shrink-0 items-center gap-1 rounded-full bg-green-500/10 px-1.5 py-px text-[9px] font-medium text-green-600 dark:text-green-400">
      <Check className="h-2.5 w-2.5" />
      执行完成
    </span>
  )

  // 收据：工具/耗时/产物/失败 —— 折叠状态下也要能一眼看懂这次干了什么
  const receiptParts: string[] = []
  if (receipt.tools > 0) receiptParts.push(`${receipt.tools} 次工具`)
  if (receipt.artifacts > 0) receiptParts.push(`${receipt.artifacts} 个产物`)
  if (receipt.failed > 0) receiptParts.push(`${receipt.failed} 步失败`)
  if (receipt.durationMs > 0) receiptParts.push(formatDur(receipt.durationMs))

  return (
    <div className={cn('rounded-lg border', running ? 'border-primary/25' : 'border-border/70')}>
      <button
        type="button"
        onClick={() => setManual(!open)}
        className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left transition-colors hover:bg-accent/40"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <Wrench className="h-3 w-3 shrink-0 text-primary/80" />
        <span className="shrink-0 text-[11px] font-semibold text-foreground/90">Agent 执行过程</span>
        {receiptParts.length > 0 && (
          <span className="hidden min-w-0 flex-1 truncate text-[10px] tabular-nums text-muted-foreground sm:inline">
            {receiptParts.join(' · ')}
          </span>
        )}
        <span className="min-w-0 flex-1 sm:hidden" />
        {badge}
      </button>

      {open && (
        <div className="border-t border-border/60 px-1.5 pb-1 pt-1.5">
          {steps.map((step, i) => (
            <StepRow
              key={step.id}
              step={step}
              last={i === steps.length - 1}
              awaiting={
                pendingApprovalTool !== undefined &&
                step.status === 'running' &&
                step.kind === 'tool' &&
                step.title === pendingApprovalTool
              }
            />
          ))}

          {/* 当前活动行：模型写大文件 / 工具长时间执行时，这段时间**没有任何事件**，
              没有它就完全看不出"还在干活"（用户最容易感觉卡死的地方）。 */}
          {running && (
            <div
              className={cn(
                'flex items-center gap-1.5 px-1 pt-1 text-[10px]',
                activity.waiting ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground'
              )}
            >
              <span className="relative flex h-1.5 w-1.5 shrink-0">
                <span
                  className={cn(
                    'absolute inline-flex h-full w-full animate-ping rounded-full opacity-60',
                    activity.waiting ? 'bg-amber-500' : 'bg-primary'
                  )}
                />
                <span
                  className={cn(
                    'relative inline-flex h-1.5 w-1.5 rounded-full',
                    activity.waiting ? 'bg-amber-500' : 'bg-primary'
                  )}
                />
              </span>
              {activity.text}
            </div>
          )}

          {(receipt.thoughts > 0 || receipt.internal > 0) && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                setShowInternal((v) => !v)
              }}
              className="mt-1 flex items-center gap-1 rounded px-1 py-0.5 text-[9px] text-muted-foreground hover:bg-accent/60"
            >
              {receipt.thoughts > 0 ? (
                <BrainCircuit className="h-2.5 w-2.5" />
              ) : (
                <Settings2 className="h-2.5 w-2.5" />
              )}
              {showInternal ? '隐藏' : '显示'}
              {receipt.thoughts > 0 ? `思考过程（${receipt.thoughts}）` : ''}
              {receipt.thoughts > 0 && receipt.internal > 0 ? ' + ' : ''}
              {receipt.internal > 0 ? `内部步骤（${receipt.internal}）` : ''}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
