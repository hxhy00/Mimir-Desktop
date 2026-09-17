import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MessageBubble } from './MessageBubble'
import {
  applyRunEvent,
  cancelRun,
  createRun,
  fromLegacyTrace,
  type AgentRun,
  type LegacyTraceNode,
  type RunEvent
} from './agentRun'
import { ChatInput, type Attachment } from './ChatInput'
import { ConvStreamingRegistry } from './convStreaming'
import { RightSidebar, RightSidebarExpandButton } from '@/components/layout/RightSidebar'
import {
  Plus,
  Trash2,
  MessageSquare,
  Pin,
  PinOff,
  Pencil,
  Check,
  X,
  PanelLeftOpen,
  ShieldQuestion,
  Sparkles,
  ChevronDown,
  Loader2
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { isSubmitEnter } from '@/lib/keyboard'
import {
  COMMAND_ENTRIES,
  SKILL_ENTRIES,
  resolveSlashInput,
  loadUserSkills,
  userSkillToEntry,
  loadUserCommands,
  userCommandToEntry
} from '@/lib/slash'
import type { SlashEntry } from '@/lib/slash/types'
import { registerSpaceFlush } from '@/lib/spaceFlush'

/** Agent 副作用确认（见 electron/agent/approval.ts）。字段名与 IPC 数据结构、主进程 approval.ts 对齐，勿改名。 */
interface ApprovalSourceInfo {
  /** 发起方：main = 主 Agent；subagent = 能力域（字段名保留以兼容 IPC 与历史数据）。 */
  origin: 'main' | 'subagent'
  subagentId?: string
  subagentLabel?: string
}
interface PendingApproval {
  id: string
  tool: string
  summary: string
  detail?: string
  /** C3：发起方来源（主 Agent / 能力域），用于批准卡展示「谁在申请」。 */
  source?: ApprovalSourceInfo
  /** 是否支持「允许并记住」（可落成策略时才为 true，如文件后端记住目录）。 */
  rememberable?: boolean
}

/** 对话内产物引用（主进程从工具返回中解析，渲染层做验收卡展示）。 */
export interface ChatArtifact {
  path: string
  name: string
  ext: string
  sizeBytes?: number
}

/** 流式事件协议（结构化事件 + seq/streamId，与主进程 / preload 共用）。 */
import type { AgentStreamEvent } from '../../../electron/agent/streamProtocol'
/** 渲染层日志（经 IPC 送主进程统一落盘，与主进程日志同一时间轴）。 */
import { streamLog } from '../../lib/logger'

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: Date
  isStreaming?: boolean
  /**
   * 本条回复的执行过程（步骤时间线）。新数据一律写这个字段，
   * 语义全部来自结构化字段，见 `agentRun.ts`。
   */
  run?: AgentRun
  /**
   * **旧数据兼容（只读）**：改造前落盘的事件树。读取历史会话时用
   * `fromLegacyTrace` 转换一次后即按 `run` 处理；不再写入。
   */
  trace?: LegacyTraceNode
  /** 本条回复过程中落盘的产物（气泡下方验收卡：打开 / 打开所在文件夹）。 */
  artifacts?: ChatArtifact[]
}

interface Conversation {
  id: string
  title: string
  messages: Message[]
  createdAt: Date
  pinned?: boolean
}

const WELCOME_MESSAGE = `你好，我是 **Mimir**，你的科研助手。

我直接调度文献检索、论文编译、实验管理、组会 PPT、GPU 服务器等专业工具，自己规划、自己执行。

我可以帮你：

- **文献搜索** — 搜索 arXiv 论文，获取最新研究进展
- **论文写作** — 协助撰写和编辑 LaTeX 论文
- **实验管理** — 记录和可视化实验数据
- **组会准备** — 生成组会 PPT 和进展报告
- **服务器管理** — 管理 GPU 服务器和远程作业

有什么需要帮忙的？`

// ── Ultra 增强策略（UI 层枚举；与主进程 electron/agent/ultra.ts 保持一致）─────
// 注意：这里**没有**「普通增强（plain）」。它曾是一段纯提示词式的「长程规划约束」，
// 2026-09 的 A/B 实测为负收益（0 例修复 / 1 例回归，token +43.4%、工具调用 +85.7%），
// 已从策略库移除。自动选型现在会在不需要增强时直接不介入。
type UltraStrategy = 'multi_expert' | 'critique_reflect' | 'hybrid_mix' | 'self_consistency_vote'
type UltraPick = 'auto' | UltraStrategy
const ULTRA_OPTIONS: { value: UltraPick; label: string; desc: string; badge?: string }[] = [
  { value: 'auto', label: '自动选择', desc: 'Ultra 分析任务类型与复杂度自动挑选策略；不需要增强时不会介入', badge: '推荐' },
  { value: 'multi_expert', label: '多专家合议', desc: '多视角对抗：K 路并行推演 + 共识/分歧输出' },
  { value: 'critique_reflect', label: '批判迭代', desc: '方案 → 批判挑错 → 修订，循环 N 轮' },
  { value: 'hybrid_mix', label: '混合增强', desc: '关键判断点触发合议，其余走批判反思' },
  { value: 'self_consistency_vote', label: '一致性投票', desc: '轻量 SC：少路数投票选最优，不出完整评审报告' }
]
const ULTRA_LABEL: Record<UltraPick, string> = Object.fromEntries(
  ULTRA_OPTIONS.map((o) => [o.value, o.label])
) as Record<UltraPick, string>

interface ChatViewProps {
  rightSidebarCollapsed: boolean
  onToggleRightSidebar: () => void
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
}

// ── 会话持久化（优先 Electron store，浏览器降级 localStorage）──────────
const CONVERSATIONS_KEY = 'chat:conversations'
/** 当前激活会话 id 的持久化 key：切模块重挂载后恢复到切走前的对话。 */
const ACTIVE_CONV_KEY = 'chat:activeConvId'

// ── 上下文治理（已下沉主进程）────────────────────────────────────────────
// 滑动窗口、分段摘要压缩、压缩熔断、原文归档、失效对象提醒、压缩后能力声明重建，
// 全部由 `electron/agent/contextManager.ts` 完成（按真实 token 计量）。
// 渲染层在这里只做一件事：把「本会话的 user/assistant 正文历史」原样交给主进程。
type HistoryMsg = { role: 'user' | 'assistant'; content: string }

/** 只取 user/assistant 的正文历史；剔除空消息/流式中消息（不携带 trace、附件全文等）。 */
function toHistoryMessages(list: Message[]): HistoryMsg[] {
  const out: HistoryMsg[] = []
  for (const m of list) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    if (m.isStreaming === true) continue
    if (m.id.startsWith('welcome-')) continue // 欢迎语不进入上下文
    const content = m.content.trim()
    if (content === '') continue
    out.push({ role: m.role, content: m.content })
  }
  return out
}

function makeWelcomeConversation(): Conversation {
  const now = new Date()
  const welcome = WELCOME_MESSAGE
  return {
    id: `conv-${now.getTime()}`,
    title: '新对话',
    messages: [
      {
        id: `welcome-${now.getTime()}`,
        role: 'assistant',
        content: welcome,
        timestamp: now
      }
    ],
    createdAt: now
  }
}

async function readConversations(): Promise<Conversation[] | null> {
  try {
    let raw: unknown
    if (window.electronAPI?.getStoreValue) {
      raw = await window.electronAPI.getStoreValue<Conversation[]>(CONVERSATIONS_KEY)
    } else {
      const cached = localStorage.getItem('mimir-chat-conversations')
      raw = cached ? JSON.parse(cached) : undefined
    }
    return reviveConversations(raw)
  } catch {
    return null
  }
}

async function persistConversations(list: Conversation[]): Promise<void> {
  try {
    const serializable = list.map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt.toISOString(),
      pinned: c.pinned === true ? true : undefined,
      messages: c.messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp.toISOString(),
        ...(m.run !== undefined ? { run: m.run } : {}),
        ...(m.artifacts !== undefined && m.artifacts.length > 0 ? { artifacts: m.artifacts } : {})
      }))
    }))
    if (window.electronAPI?.setStoreValue) {
      await window.electronAPI.setStoreValue(CONVERSATIONS_KEY, serializable)
    } else {
      localStorage.setItem('mimir-chat-conversations', JSON.stringify(serializable))
    }
  } catch {
    // ignore
  }
}

/** 持久化当前激活会话 id（切模块重挂载后恢复到切走前的对话）。 */
async function persistActiveConvId(id: string): Promise<void> {
  try {
    if (window.electronAPI?.setStoreValue) {
      await window.electronAPI.setStoreValue(ACTIVE_CONV_KEY, id)
    } else {
      localStorage.setItem('mimir-chat-active-conv', id)
    }
  } catch {
    // ignore
  }
}

/** 读取上次激活的会话 id；无则返回 null。 */
async function readActiveConvId(): Promise<string | null> {
  try {
    if (window.electronAPI?.getStoreValue) {
      return (await window.electronAPI.getStoreValue<string>(ACTIVE_CONV_KEY)) ?? null
    }
    return localStorage.getItem('mimir-chat-active-conv')
  } catch {
    return null
  }
}

/** 把 store 中的 JSON 数据还原为会话（带时间恢复、脏数据过滤）。 */
function reviveConversations(raw: unknown): Conversation[] | null {
  if (!Array.isArray(raw)) return null
  const result: Conversation[] = []
  const toDate = (value: unknown): Date => {
    const parsed = typeof value === 'string' ? new Date(value) : null
    return parsed !== null && !Number.isNaN(parsed.getTime()) ? parsed : new Date()
  }
  for (const entry of raw as Array<Record<string, unknown>>) {
    if (typeof entry?.id !== 'string' || typeof entry.title !== 'string') continue
    const messages: Message[] = []
    if (Array.isArray(entry.messages)) {
      for (const m of entry.messages as Array<Record<string, unknown>>) {
        if (typeof m?.id !== 'string') continue
        const role = m.role === 'user' || m.role === 'assistant' || m.role === 'system' ? m.role : 'user'
        messages.push({
          id: m.id,
          role,
          content: typeof m.content === 'string' ? m.content : '',
          timestamp: toDate(m.timestamp),
          // 新数据直读 run；旧数据（事件树）转换一次后按 run 处理（只读兼容，见 Message.trace）
          ...(m.run !== undefined && typeof m.run === 'object'
            ? { run: m.run as AgentRun }
            : m.trace !== undefined && typeof m.trace === 'object'
              ? { run: fromLegacyTrace(m.trace as LegacyTraceNode) }
              : {}),
          ...(Array.isArray(m.artifacts) && m.artifacts.length > 0
            ? { artifacts: m.artifacts as ChatArtifact[] }
            : {})
        })
      }
    }
    result.push({
      id: entry.id,
      title: entry.title,
      messages,
      createdAt: toDate(entry.createdAt),
      ...(entry.pinned === true ? { pinned: true } : {})
    })
  }
  return result.length > 0 ? result : null
}

export function ChatView({ rightSidebarCollapsed, onToggleRightSidebar, sidebarCollapsed, onToggleSidebar }: ChatViewProps) {
  const [conversations, setConversations] = useState<Conversation[]>(() => [makeWelcomeConversation()])
  const [activeConvId, setActiveConvId] = useState<string>(() => conversations[0]?.id ?? '')
  /**
   * 正在生成回复的会话 id 集合（多会话并行）。
   *
   * 原先是单个全局 isStreaming：同一时刻只能有一个会话在跑。改为按会话登记后，
   * 可在会话 A 生成时切到会话 B 继续提问，两者互不阻塞；侧栏据此显示运行态。
   */
  const [streamingConvIds, setStreamingConvIds] = useState<ReadonlySet<string>>(() => new Set())
  /** Ultra 增强控制器（Agent 之上的可选增强层）：开启后本条及后续请求先经增强，成本更高，默认关。 */
  const [ultraEnabled, setUltraEnabled] = useState(false)
  /** Ultra 增强策略：auto = Ultra 按任务自动选；其余为用户手动指定。 */
  const [ultraStrategy, setUltraStrategy] = useState<UltraPick>('auto')
  const [showUltraMenu, setShowUltraMenu] = useState(false)
  const ultraMenuRef = useRef<HTMLDivElement>(null)

  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [hydrated, setHydrated] = useState(false)
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  /**
   * 发送纪元（按会话）：每次发送自增取号。停止即 +1，让「该会话」旧回复的所有
   * chunk/事件/看门狗失效；新发送再取新号，二者互不干扰，杜绝"停后再发导致旧流复活"。
   * 按会话隔离后，会话 A 的停止不会误伤会话 B 正在进行的回复。
   */
  const epochByConvRef = useRef<Map<string, number>>(new Map())
  /** 取下一条纪元号（该会话）。 */
  const nextEpoch = useCallback((convId: string): number => {
    const next = (epochByConvRef.current.get(convId) ?? 0) + 1
    epochByConvRef.current.set(convId, next)
    return next
  }, [])
  /** 读当前纪元号（该会话）；不存在视为 0。 */
  const currentEpoch = useCallback((convId: string): number => epochByConvRef.current.get(convId) ?? 0, [])
  /** 发送锁（按会话）：防止同一会话快速双击并发调用 streamMessage；不同会话互不阻塞。 */
  const sendingRefs = useRef<Set<string>>(new Set())
  /**
   * 会话级「正在生成」状态的归属记账（见 `convStreaming.ts` 的模块注释）。
   *
   * 为什么不能省：`setConvStreaming(convId, false)` 是无条件关灯，而一条回复的收尾
   * （finally）可能发生在**下一条回复已经开始之后**（用户停止/重发）。若旧流无条件关灯，
   * 会把新流的运行态一起关掉；反之若用 `currentEpoch === sendId` 当唯一清理条件，
   * 旧流被顶掉后就永远没人关灯 → 界面永久「正在思考…」。归属比较是唯一能同时避免
   * 这两种错的判据，逻辑收敛在 registry 里（纯数据、可单测）。
   */
  const streamingRegistry = useRef(new ConvStreamingRegistry())

  // ── 斜杠「技能与指令」：内置注册表 + 自定义技能 / 指令 ──
  const [customSkillEntries, setCustomSkillEntries] = useState<readonly SlashEntry[]>([])
  const [customCommandEntries, setCustomCommandEntries] = useState<readonly SlashEntry[]>([])
  const slashEntries = useMemo(
    () => [...COMMAND_ENTRIES, ...SKILL_ENTRIES, ...customCommandEntries, ...customSkillEntries],
    [customSkillEntries, customCommandEntries]
  )

  // ── Agent 执行过程：步骤时间线挂在生成中的助手消息上（message.run），历史可回看 ──
  /**
   * 步骤 id 序号按**消息**计数，而不是全局单值。
   *
   * 原实现是一个共享的 `runSeq` ref：每次发送把它归零，事件到达时自增取号。多会话并行时
   * 这会串号 —— 会话 A 生成中，用户切到 B 发送，B 的 `runSeq.current = 0` 把 A 的计数器
   * 打回原点，A 接下来的步骤 id 与已有步骤重复；`phase:${n}` 这类纯序号 id 冲突后，
   * `applyRunEvent` 里按 id 定位/收尾的分支会认错行（表现为步骤错并、该收的没收）。
   *
   * 改为以「该消息已有步骤数」为基数取自增号：天然按消息隔离，且不依赖调用时机，
   * 并发多少会话都各算各的。id 只要求**同一次运行内唯一**，此口径已足够。
   */
  const nextStepSeq = useRef<Map<string, number>>(new Map())

  /**
   * 事件应用：把一条主进程事件并入该助手消息的执行记录。
   *
   * 事件语义全部交给 `agentRun.applyRunEvent`（纯函数、有单测）处理 ——
   * 这里只负责「找到哪条消息」与「产物累加」，**不做任何文案解析**。
   */
  const applyTraceEvent = useCallback((convId: string, messageId: string, event: RunEvent): void => {
    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== convId) return c
        return {
          ...c,
          messages: c.messages.map((m) => {
            if (m.id !== messageId) return m
            const base = m.run ?? createRun()
            // 该消息专属的 id 序号：键用 messageId，并发会话互不影响（见 nextStepSeq 说明）。
            const seqKey = m.id
            const withRun: Message = {
              ...m,
              run: applyRunEvent(base, event, () => {
                const next = (nextStepSeq.current.get(seqKey) ?? 0) + 1
                nextStepSeq.current.set(seqKey, next)
                return next
              })
            }
            if (event.artifacts === undefined || event.artifacts.length === 0) return withRun
            // 产物按绝对路径去重后累加（同一次回复内多次写入同一文件只展示一次）
            const existing = new Map((m.artifacts ?? []).map((a) => [a.path, a]))
            for (const art of event.artifacts) {
              const path = art.path ?? ''
              if (path === '') continue
              existing.set(path, {
                path,
                name: art.name ?? path.split('/').pop() ?? path,
                ext: art.ext ?? '',
                ...(art.sizeBytes !== undefined ? { sizeBytes: art.sizeBytes } : {})
              })
            }
            return { ...withRun, artifacts: [...existing.values()] }
          })
        }
      })
    )
  }, [])

  const activeConv = conversations.find((c) => c.id === activeConvId) || conversations[0]
  /** 活跃会话镜像（ref）：handleSend 内读最新消息构建历史，避免 useCallback 闭包过期。 */
  const activeConvRef = useRef<Conversation>(activeConv)
  activeConvRef.current = activeConv
  const displayMessages = activeConv.messages.filter((m) => m.role !== 'system')
  /** 当前活跃会话是否正在生成（输入区禁用 / 停止按钮据此显示；其它会话的后台任务不阻塞本会话输入）。 */
  const isStreaming = streamingConvIds.has(activeConv.id)

  // 启动时从 store 恢复会话历史（并恢复到切走前激活的对话）
  useEffect(() => {
    let alive = true
    ;(async () => {
      const list = await readConversations()
      if (!alive || list === null) return
      setConversations(list)
      const savedId = await readActiveConvId()
      if (!alive) return
      const target = savedId !== null && list.some((c) => c.id === savedId) ? savedId : (list[0]?.id ?? '')
      setActiveConvId(target)
    })()
      .catch(() => {})
      .finally(() => {
        if (alive) setHydrated(true)
      })
    return () => {
      alive = false
    }
  }, [])

  /** 最新会话与激活 id 镜像（ref）：供卸载 flush 时读到最新值，避免闭包过期。 */
  const latestPersistRef = useRef<{ conversations: Conversation[]; activeConvId: string; hydrated: boolean }>({
    conversations,
    activeConvId,
    hydrated
  })
  latestPersistRef.current = { conversations, activeConvId, hydrated }
  /** 防抖持久化计时器。 */
  const persistTimer = useRef<number | undefined>(undefined)

  // 会话变化时持久化：防抖写入（流式中也保存，避免切 tab 重挂载读到旧数据）
  useEffect(() => {
    if (!hydrated) return
    window.clearTimeout(persistTimer.current)
    persistTimer.current = window.setTimeout(() => {
      void persistConversations(latestPersistRef.current.conversations)
      void persistActiveConvId(latestPersistRef.current.activeConvId)
    }, 300)
  }, [conversations, activeConvId, hydrated])

  // 卸载时立即 flush 当前会话（防止切到别的 tab 后重挂载时数据回滚）
  useEffect(() => {
    return () => {
      const latest = latestPersistRef.current
      window.clearTimeout(persistTimer.current)
      if (!latest.hydrated) return
      void persistConversations(latest.conversations)
      void persistActiveConvId(latest.activeConvId)
    }
  }, [])

  // 切空间前同步落盘：会话按空间隔离，防抖写入尚未触发时必须先写回旧空间。
  // 注册在卸载之前（App 推进 uiSpaceEpoch 会先调用本 flush，再重挂载本组件）。
  useEffect(() => {
    return registerSpaceFlush(() => {
      const latest = latestPersistRef.current
      window.clearTimeout(persistTimer.current)
      if (!latest.hydrated) return
      void persistConversations(latest.conversations)
      void persistActiveConvId(latest.activeConvId)
    })
  }, [])

  // 加载自定义技能 / 指令（插件页导入/删除后重新进入本模块即刷新）
  useEffect(() => {
    let alive = true
    loadUserSkills()
      .then((skills) => {
        if (alive) setCustomSkillEntries(skills.map(userSkillToEntry))
      })
      .catch(() => {})
    loadUserCommands()
      .then((cmds) => {
        if (alive) setCustomCommandEntries(cmds.map(userCommandToEntry))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // ── Agent 副作用确认 ────────────────────────────────────────────
  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onApprovalRequest) return
    const off = api.onApprovalRequest((request) => {
      setPendingApproval(request)
    })
    return () => {
      off()
    }
  }, [])

  // 本地兜底：主进程 120s 超时后仍未回应时收起卡片
  useEffect(() => {
    if (pendingApproval === null) return
    const timer = setTimeout(() => setPendingApproval(null), 125_000)
    return () => clearTimeout(timer)
  }, [pendingApproval])

  const respondApproval = useCallback(
    (allow: boolean, remember = false) => {
      if (pendingApproval === null) return
      // remember=true → 主进程把这次放行升级为「这一类允许」（如记住该目录），
      // 目的是压低批准卡频次：只给「允许一次」会把人训练成无脑点是。
      window.electronAPI?.approvalRespond?.(pendingApproval.id, allow, remember)
      setPendingApproval(null)
    },
    [pendingApproval],
  )

  // Close Ultra strategy menu on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ultraMenuRef.current && !ultraMenuRef.current.contains(e.target as Node)) {
        setShowUltraMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  /** 标记某会话进入 / 退出生成态（驱动侧栏运行标记与输入区禁用）。 */
  const setConvStreaming = useCallback((convId: string, running: boolean): void => {
    setStreamingConvIds((prev) => {
      const next = new Set(prev)
      if (running) next.add(convId)
      else next.delete(convId)
      return next
    })
  }, [])

  /**
   * 本条回复收尾时**按归属**关灯：只有登记的活跃回复仍是自己，才真正清掉运行态。
   *
   * 与「无条件关灯」的区别（这就是 bug 的根因）：一条回复的收尾可能晚于下一条
   * 回复的开场（用户点停止后立刻重发、或快速连发）。此时：
   *   - 无条件关灯 → 把**新流**的运行态误关（新流看起来已结束，实则还在跑）；
   *   - 只用 `currentEpoch === sendId` 才关 → 旧流被顶掉后**永远没人关灯**，
   *     `streamingConvIds` 残留 → 界面永久停在「正在思考…」、输入区永久禁用。
   * 取「归属比较」这一个条件可以同时避免这两种错：旧的关不掉新的，新的也不会漏关。
   *
   * 注意这里**不顺带释放 sendingRefs**：发送锁的释放语义与 UI 运行态不同
   * （锁只防同一会话并发，见 handleSend），由调用点各自处理。
   */
  const releaseConvStreaming = useCallback(
    (convId: string, sendId: number): void => {
      // 归属比较（compare-and-clear）：不是当前活跃回复的收尾就保持沉默，
      // 否则会把已经开场的新流误关。见 convStreaming.ts 的模块注释。
      if (!streamingRegistry.current.release(convId, sendId)) return
      setConvStreaming(convId, false)
    },
    [setConvStreaming]
  )

  /**
   * 停止指定会话的生成（缺省为当前活跃会话）：立即本地收尾（UI 即刻可交互），并通知主进程 abort 该会话。
   * 多会话并行下，停止只影响目标会话，其它会话的后台任务继续。
   */
  const handleStop = useCallback(
    (convId: string = activeConvId) => {
      // 纪元 +1：该会话本回复后续所有 chunk / 事件 / 看门狗回调全部失效
      nextEpoch(convId)
      setConvStreaming(convId, false)
      // 清掉归属登记：旧流之后的 finally 会拿这个旧 sendId 做比较，必须让它认不出「自己」，
      // 否则用户停止后立刻重发时，旧流的收尾会误关新流的运行态（与本次修复同一类问题）。
      streamingRegistry.current.forget(convId)
      // 立即释放发送锁：旧流被 abort 后 finally 因纪元不匹配不会重置，这里主动释放避免卡死
      sendingRefs.current.delete(convId)
      void window.electronAPI?.stopMessage?.(convId)
      // 终止该会话内任何正在流式生成的消息
      setConversations((prev) =>
        prev.map((c) =>
          c.id !== convId
            ? c
            : {
                ...c,
                messages: c.messages.map((m) => {
                  if (m.isStreaming !== true) return m
                  // 该消息已定稿，回收其步骤序号（与正常收尾一致的清理）
                  nextStepSeq.current.delete(m.id)
                  return {
                    ...m,
                    isStreaming: false,
                    run: m.run !== undefined ? cancelRun(m.run) : m.run
                  }
                })
              }
        )
      )
    },
    [activeConvId, setConvStreaming]
  )

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      const viewport = scrollRef.current.querySelector('[data-radix-scroll-area-viewport]')
      if (viewport) {
        viewport.scrollTop = viewport.scrollHeight
      }
    }
  }, [])

  /** 取 Radix ScrollArea 的真实滚动视口（组件重挂载后会换 DOM，故每次现查）。 */
  const getViewport = useCallback((): HTMLElement | null => {
    return scrollRef.current?.querySelector('[data-radix-scroll-area-viewport]') ?? null
  }, [])

  /**
   * 「用户是否贴着底部」的镜像，由滚动事件实时维护 —— **不在内容变化后再测**。
   *
   * 为什么不能用 isNearBottom() 现测：新消息插入后 scrollHeight 已被撑大，
   * 此时再算 `scrollHeight - scrollTop - clientHeight < 80` 必然得到一个很大的值，
   * 判定为「用户没在底部」从而放弃跟随。现象就是发完消息停在中间、追不上最新一条。
   * 结论：贴底状态必须在**上一次渲染**时就记下来。
   */
  const stickToBottomRef = useRef(true)

  /** 视口是否已贴着底部（用户没往上翻）。 */
  const isNearBottom = useCallback((): boolean => {
    const viewport = getViewport()
    if (viewport === null) return true
    return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80
  }, [getViewport])

  // 监听视口滚动：用户主动上滑即解除跟随，滑回底部则恢复跟随。
  // 视口 DOM 由 Radix ScrollArea 内部渲染，首帧可能还不存在（如 hydration 未完成），
  // 故用 rAF 重试若干次；否则依赖数组不变会让监听器永远挂不上，表现为「跟随失效」。
  useEffect(() => {
    let raf = 0
    let attempts = 0
    let viewport: HTMLElement | null = null
    const onScroll = (): void => {
      stickToBottomRef.current = isNearBottom()
    }
    const attach = (): void => {
      viewport = getViewport()
      if (viewport !== null) {
        viewport.addEventListener('scroll', onScroll, { passive: true })
        return
      }
      if (++attempts < 30) raf = requestAnimationFrame(attach)
    }
    attach()
    return () => {
      cancelAnimationFrame(raf)
      viewport?.removeEventListener('scroll', onScroll)
    }
  }, [getViewport, isNearBottom])

  /**
   * 流式期间自动跟随，但**不抢用户的手**：只有当视口本来就在底部时才跟随滚动。
   * 否则用户往上翻去看前面的内容时，每个 token 都会被强行拽回底部（历史行为）。
   *
   * 用 useLayoutEffect：DOM 变更后、浏览器绘制前同步执行，此时 scrollHeight 已是新值，
   * 避免「先画在旧位置再跳一下」的抖动。
   */
  useLayoutEffect(() => {
    if (stickToBottomRef.current) scrollToBottom()
  }, [displayMessages, scrollToBottom])

  // 切换会话时一律回到底部，并恢复跟随态（否则会停在上一个会话的阅读位置）。
  useEffect(() => {
    stickToBottomRef.current = true
    scrollToBottom()
  }, [activeConvId, scrollToBottom])

  const updateMessage = useCallback((convId: string, messageId: string, updater: (m: Message) => Message) => {
    setConversations((prev) =>
      prev.map((c) =>
        c.id === convId
          ? { ...c, messages: c.messages.map((m) => (m.id === messageId ? updater(m) : m)) }
          : c
      )
    )
  }, [])

  /**
   * 把一条助手回复的运行记录收敛到**终态**（幂等）。
   *
   * ── 为什么必须有这一层 ──────────────────────────────────────────────────
   * `isRunActive()`（见 agentRun.ts）**只认 `run.status`**，而 `run.status` 的权威
   * 来源只有一个：主进程 `main` 容器事件的 done/error。一旦那两个事件没送到
   * （流中断、`streamMessage` 只 resolve 不发 end、渲染层自己抛异常…），run 就永远
   * 停在 'running' —— 界面表现正是「回复完了还一直显示思考中」+ 输入区永久禁用。
   *
   * 因此**每个出口**（流内报错 / 异常捕获 / finally）都必须显式写终态，且遵守同一条
   * 契约（agentRun.ts 顶部的约定）：**终态不可复活** —— 已 done/error/canceled 的 run
   * 不再被改写，先到的终态即最终结论。这样多个出口各写一次也绝对安全。
   *
   * @param note 失败文案：仅在气泡还没有正文时补写（已有内容说明模型已产出，
   *             不该被错误提示整段盖掉；非空时追加在正文之后，保证失败始终可见）。
   */
  const finishRun = useCallback(
    (
      convId: string,
      messageId: string,
      status: 'done' | 'error' | 'canceled',
      note?: string
    ): void => {
      updateMessage(convId, messageId, (m) => {
        // 终态不可复活：只有仍处于 running 的 run 才会被收敛。
        const run =
          m.run === undefined || m.run.status !== 'running'
            ? m.run
            : status === 'canceled'
              ? cancelRun(m.run)
              : // 复用主进程「整轮结束」的既有收尾路径：main 容器事件会顺带把仍在运行的
                // 思考 / 委派行关掉，与成功出口完全一致。该分支不新建步骤，nextId 不会用到。
                applyRunEvent(m.run, { taskId: 'main', title: 'Mimir', status }, () => 0)
        let content = m.content
        if (note !== undefined && note !== '') {
          content = m.content.trim() === '' ? note : `${m.content}\n\n${note}`
        }
        if (run === m.run && content === m.content) return m
        return { ...m, ...(run !== undefined ? { run } : {}), content }
      })
    },
    [updateMessage]
  )

  const handleSend = useCallback(
    async (content: string, attachments?: Attachment[]) => {
      const trimmed = content.trim()
      // 目标会话：最早捕获，防止后续 await（如历史压缩）期间用户切会话导致消息落到错误会话
      const convId = activeConvId
      if (!trimmed) return
      // 同一会话已在生成则忽略（不同会话可并行）
      if (sendingRefs.current.has(convId)) return
      sendingRefs.current.add(convId)

      // 斜杠「技能与指令」解析（统一在最前面做）
      const slashMatch = resolveSlashInput(trimmed, slashEntries)

      // 客户端特殊指令：由 clientAction 标记决定前端行为
      if (slashMatch?.entry.clientAction === 'clear') {
        // 原地清空当前会话（保留会话 id 与侧栏条目）：必须连归档一起清 ——
        // 归档的唯一消费方是上下文治理，UI 列表已清空后再留旧归档既无回看入口
        // （渲染层从未读取 chat:archive:），又会在下一轮被当作历史复活。
        void window.electronAPI?.resetConversationContext?.(convId, true)
        const fresh = makeWelcomeConversation()
        setConversations((prev) =>
          prev.map((c) =>
            c.id === convId
              ? { ...c, title: '新对话', createdAt: fresh.createdAt, messages: fresh.messages }
              : c
          )
        )
        // 清空后恢复跟随：否则若用户此前上滑过，空白态不会自动回到底部。
        stickToBottomRef.current = true
        sendingRefs.current.delete(convId)
        return
      }

      if (slashMatch?.entry.clientAction === 'reload') {
        // 重载 = 销毁当前 renderer。在跑的会话不会被自动中止（旧 renderer 的 IPC 监听
        // 随页面一起消失，任务成了收不到事件的孤儿），因此必须先显式中止本会话，
        // 并把「重载」这个动作的后果如实落日志（规则：不静默）。
        streamLog.info(`renderer.reload conv=${convId} source=slash`)
        sendingRefs.current.delete(convId)
        void window.electronAPI?.stopMessage?.(convId)
        window.location.reload()
        return
      }

      if (slashMatch?.entry.clientAction === 'help') {
        const lines: string[] = ['以下是所有可用的斜杠指令与技能：\n']
        const commands = slashEntries.filter((e) => e.kind === 'command')
        const skills = slashEntries.filter((e) => e.kind === 'skill')
        if (commands.length > 0) {
          lines.push('**指令（Command）**')
          for (const c of commands) {
            lines.push(`- \`/${c.trigger}\` — ${c.description}${c.requiresArg ? '（需参数）' : ''}`)
          }
          lines.push('')
        }
        if (skills.length > 0) {
          lines.push('**技能（Skill）**')
          for (const s of skills) {
            lines.push(`- \`/${s.trigger}\` — ${s.description}`)
          }
          lines.push('')
        }
        lines.push('用法：在输入框输入 `/触发词 参数` 即可调用。')
        const helpText = lines.join('\n')
        const userMessage: Message = {
          id: `user-${Date.now()}`,
          role: 'user',
          content: trimmed,
          timestamp: new Date()
        }
        const assistantMessage: Message = {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          content: helpText,
          timestamp: new Date()
        }
        setConversations((prev) =>
          prev.map((c) =>
            c.id === convId
              ? { ...c, messages: [...c.messages, userMessage, assistantMessage] }
              : c
          )
        )
        sendingRefs.current.delete(convId)
        return
      }

      // 取本次回复的纪元号（按会话：多会话并行时各会话的纪元互不干扰）
      const sendId = nextEpoch(convId)
      // 【诊断埋点】确认渲染层是否对同一条用户消息重复进入 handleSend：
      // 若一次点击出现多个不同 sendId，则后续调用会把前一轮顶掉（epoch 变化 → 前一轮事件被丢）。
      streamLog.error(`send.enter conv=${convId} sendId=${sendId}`)

      // 指令/技能需要参数但用户没给
      if (slashMatch !== null && slashMatch.entry.requiresArg && slashMatch.args === '') {
        window.alert(`「/${slashMatch.entry.trigger}」需要参数。\n用法：${slashMatch.entry.usage}`)
        sendingRefs.current.delete(convId)
        return
      }

      // 上下文治理（主进程侧）：这里只交「本会话正文历史 + 技能目录」，不在这里做任何治理。
      // 滑动窗口、分段摘要压缩、熔断降级、失效对象提醒、压缩后能力声明重建由主进程完成。
      const outgoingHistory = toHistoryMessages(activeConvRef.current.messages)
      const skillRefs = slashEntries.map((e) => ({ trigger: e.trigger, title: e.title }))

      // Build full message with attachments
      let fullMessage = slashMatch === null ? trimmed : slashMatch.expanded
      if (attachments && attachments.length > 0) {
        const attachmentParts: string[] = []
        for (const att of attachments) {
          if (att.content) {
            attachmentParts.push(`[附件: ${att.name}]\n\`\`\`\n${att.content}\n\`\`\``)
          } else {
            attachmentParts.push(`[附件: ${att.name} (${att.path})]`)
          }
        }
        fullMessage = attachmentParts.join('\n\n') + '\n\n---\n\n' + fullMessage
      }

      const userMessage: Message = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: trimmed + (attachments && attachments.length > 0 ? `\n\n📎 ${attachments.length}个附件` : ''),
        timestamp: new Date()
      }
      // 每条助手回复都预先挂一份空的执行记录：Agent 及其工具调用的事件都并入它，
      // 完成后内嵌在气泡里展示并随会话持久化（历史消息仍可点开复盘）。
      const assistantMessage: Message = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: '',
        timestamp: new Date(),
        isStreaming: true,
        run: createRun()
      }

      setConversations((prev) =>
        prev.map((c) =>
          c.id === convId
            ? {
                ...c,
                title: c.messages.length <= 1 ? content.trim().slice(0, 20) : c.title,
                messages: [...c.messages, userMessage, assistantMessage]
              }
            : c
        )
      )

      // 新回复的步骤序号无需手工归零：序号按消息 id 计数（见 nextStepSeq），
      // 新消息自然从 0 起算，且不会影响其它并行会话的计数。

      // 登记「本会话当前活跃回复 = sendId」：这是收尾时判断「该不该由我关灯」的唯一依据
      // （见 releaseConvStreaming）。必须在 setConvStreaming(true) 之前登记，
      // 否则极短回复在 finally 里比较时会读不到自己。
      streamingRegistry.current.begin(convId, sendId)
      setConvStreaming(convId, true)

      // 说明：**不做任何超时中止**。此前有一层「滚动看门狗」（连续 120s/360s 无正文或
      // 过程事件即判定卡死并中止整条回复），实践证伪：Agent 一轮回复包含多轮工具调用，
      // 其中论文下载、arXiv 限流退避（5s/15s 重试）、大文件写入等都会长时间**无事件产出**，
      // 这是正常长任务而非卡死，却被看门狗腰斩（现象：「跑着跑着就不动了，然后就中止了」）。
      // 且主进程工具的 HTTP 超时、审批超时本就各有兜底，渲染层再加一层只会误杀。
      // 现在唯一的终止路径是**用户手动点停止**（handleStop 会 abort 该会话并释放锁）。

      // 流式正文缓冲 + 合并刷新（节流到 ~40ms）。声明在 try 之外：finally 要做最后一次刷尾。
      //
      // 为什么必须节流：模型每个 token 都经 IPC 单独送达（见 ipc/index.ts 的 chunk 通道），
      // 而这里每收一个 token 都做一次 updateMessage（= 全量会话状态拷贝 + 整列表重渲染 +
      // 强制滚动）。一旦渲染速度低于 token 到达速度，渲染进程的事件队列就**无界增长** ——
      // 独立通道送来的批准请求会排在队尾，表现就是「界面说要弹批准卡，却等好久好久才弹」。
      const STREAM_FLUSH_MS = 40
      let fullContent = ''
      /** 渲染层实际收到的正文 chunk 总字符数（与 fullContent 可能因覆盖式定稿而不同）。 */
      let inChars = 0
      /**
       * 本轮**已写入的运行终态**（null = 还没有任何出口写过）。
       *
       * 它是「状态机是否收敛」的显式证据：三个出口（流内报错 / 异常捕获 / finally）
       * 谁先写谁负责，finally 兜底时据此判断是否还需要补写，避免把已有终态改坏。
       */
      let terminal: AgentRun['status'] | null = null
      let flushTimer: number | undefined
      const flushContent = (): void => {
        window.clearTimeout(flushTimer)
        flushTimer = undefined
        if (fullContent === '') return
        // 【临时诊断】记录 flush 后，正文文本所在元素的**可见性细节**。
        {
          const w = window as unknown as { __mimirEvt?: Array<Record<string, unknown>>; __mimirT0?: number }
          if (!w.__mimirT0) w.__mimirT0 = Date.now()
          if (!w.__mimirEvt) w.__mimirEvt = []
          const rec: Record<string, unknown> = { t: Date.now() - w.__mimirT0, type: 'flush', len: fullContent.length }
          w.__mimirEvt.push(rec)
          const probe = fullContent.slice(-12)
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              rec.inInnerText = document.body.innerText.includes(probe)
              // 遍历所有含该文本的元素，记录其祖先链上是否有 hidden/display:none
              const all = Array.from(document.querySelectorAll('*'))
              const hits = all.filter((el) => (el.textContent ?? '').includes(probe))
              rec.textContentHits = hits.length
              const leaf = hits[hits.length - 1]
              if (leaf) {
                const chain: string[] = []
                let cur: HTMLElement | null = leaf
                while (cur && cur !== document.body) {
                  const cs = getComputedStyle(cur)
                  const r = cur.getBoundingClientRect()
                  chain.push(
                    `${cur.tagName}${cur.className ? '.' + String(cur.className).split(' ')[0] : ''}[disp=${cs.display},vis=${cs.visibility},op=${cs.opacity},w=${Math.round(r.width)},h=${Math.round(r.height)}]`
                  )
                  cur = cur.parentElement
                }
                rec.chain = chain.slice(0, 8)
              }
            })
          )
        }
        updateMessage(convId, assistantMessage.id, (m) =>
          m.content === fullContent ? m : { ...m, content: fullContent }
        )
      }
      const scheduleFlush = (): void => {
        if (flushTimer !== undefined) return
        flushTimer = window.setTimeout(flushContent, STREAM_FLUSH_MS)
      }

      try {
        if (window.electronAPI) {
          await window.electronAPI.streamMessage(
            fullMessage,
            convId,
            (evt) => {
              // 已被停止/已开启新一轮回复：丢弃本回复剩余所有事件。
              // 注：陈旧**流**的过滤已下沉到 preload（按 streamId，见 streamProtocol.ts）；
              // 这里只处理「本会话被用户停止 / 被顶掉」这一层语义。
              if (currentEpoch(convId) !== sendId) {
                // 埋点：丢弃原因（停止 / 被新一轮顶掉）。此前这类静默丢弃不可见，
                // 排查「内容不全」时无法区分「没收到」与「收到后被丢」。
                streamLog.debug(`stream.evt.drop conv=${convId} epoch=${sendId} type=${evt.type} seq=${evt.seq}`)
                return
              }
              // ① 过程事件（工具/思考/阶段）：直接喂事件树，不进入正文。
              if (evt.type === 'worker') {
                applyTraceEvent(convId, assistantMessage.id, evt.payload as Parameters<typeof applyTraceEvent>[2])
                return
              }
              // ② 出错：写入正文提示（与旧的错误路径行为一致）+ 立即收敛终态。
              if (evt.type === 'error') {
                fullContent += evt.message
                scheduleFlush()
                // 流内报错 = 本轮已失败：必须当场把 run 写成 error。
                // 此前这里只写正文不写终态，而 `streamMessage` 出错时常常是 **resolve**
                // （不是 reject），catch 根本不会走 —— run 就永远停在 running，
                // 界面永久「正在思考…」、输入区永久禁用。
                terminal = 'error'
                finishRun(convId, assistantMessage.id, 'error')
                return
              }
              // ③ 正文流结束：模型已完整生成（主进程在逐字流收尾时发出）。
              // 只带 finalLength 用于**对账**，不再携带全量全文（消除主进程/渲染层双份状态）。
              // 此刻工具收尾/子代理可能还要跑很久，故立即定稿并关灯，**不等 invoke 返回**。
              if (evt.type === 'end') {
                window.clearTimeout(flushTimer)
                flushTimer = undefined
                // 兜底可见性：end 分支此前**一定会打** info 日志却从未出现在 main.log，
                // 说明渲染层可能压根没走到这里。先用 error 级（不会被级别过滤）留下铁证。
                streamLog.error(
                  `stream.end.enter conv=${convId} expect=${evt.finalLength} got=${fullContent.length} recvChars=${inChars}`
                )
                // stream.end.in：渲染层实际收到字符数 vs 主进程声明长度。
                // 二者不一致说明中途丢包（preload 的 seq 跳号日志会指出丢在第几号）。
                if (evt.finalLength !== fullContent.length) {
                  streamLog.warn(
                    `stream.end.mismatch conv=${convId} expect=${evt.finalLength} got=${fullContent.length} recvChars=${inChars}`
                  )
                } else {
                  streamLog.info(`stream.end.in conv=${convId} chars=${fullContent.length} stream=${evt.streamId}`)
                }
                flushContent()
                // 提前把本条消息标记为非流式（时间线停止转圈）；invoke 的 finally 再执行一遍也无害。
                updateMessage(convId, assistantMessage.id, (m) => ({ ...m, isStreaming: false }))
                // 正文流结束 = 本轮定稿：同步写 done 终态（与「立即关灯」同一个事实）。
                // 收尾事件若缺失，run 也不会停在 running。终态幂等：已 error 则保留 error。
                if (terminal === null) terminal = 'done'
                finishRun(convId, assistantMessage.id, 'done')
                releaseConvStreaming(convId, sendId)
                if (currentEpoch(convId) === sendId) {
                  sendingRefs.current.delete(convId)
                }
                return
              }
              // ④ 正文增量：累加后合并刷新。
              fullContent += evt.delta
              // stream.chunk.in：逐增量落盘（量级为 token 级，debug 级避免生产噪音）。
              inChars += evt.delta.length
              // 【临时诊断】记录 delta 到达时刻，供 E2E 取证渐进渲染时序。
              {
                const w = window as unknown as { __mimirEvt?: Array<{ t: number; type: string; len: number }> }
                if (!w.__mimirEvt) w.__mimirEvt = []
                if (!w.__mimirT0) (w as unknown as { __mimirT0?: number }).__mimirT0 = Date.now()
                w.__mimirEvt.push({ t: Date.now() - ((w as unknown as { __mimirT0: number }).__mimirT0), type: 'text-delta', len: evt.delta.length })
              }
              // 正文开始流出 = 本轮「思考结束」的一手信号：把运行中的思考步骤收尾，
              // 否则最后一段思考会永远转圈（applyRunEvent 只在 tool/阶段事件时关闭 think 行，
              // 而最终回复前往往没有新工具调用）。纯文本事件无 kind、不碰 run，需显式派发。
              applyTraceEvent(convId, assistantMessage.id, {
                taskId: 'content-start',
                title: 'Mimir',
                status: 'running'
              })
              // 正文渲染改为合并刷新（见上方注释），不再每 token 触发一次全量状态更新
              scheduleFlush()
            },
            {
              // Ultra 增强控制器（可选增强层）：enabled 总开关 + 增强策略（auto 由 Ultra 自动选）
              ultra: ultraEnabled ? { enabled: true, strategy: ultraStrategy } : undefined,
              // 手动 / 技能直通：跳过 Agent 自动技能路由（正文已注入）
              manual: slashMatch !== null,
              ...(outgoingHistory.length > 0 ? { history: outgoingHistory, skills: skillRefs } : {})
            }
          )
        } else {
          // 浏览器降级：直接调用 LLM API
          let settings: Record<string, unknown> = {}
          try {
            const cached = localStorage.getItem('mimir-settings')
            if (cached) settings = JSON.parse(cached)
          } catch {
            // ignore
          }
          const models = (settings.models as Array<Record<string, unknown>> | undefined) || []
          const selectedModelId = settings.selectedModelId as string | undefined
          const selected = models.find((m) => m.id === selectedModelId) || models[0]

          if (!selected?.apiKey) {
            updateMessage(convId, assistantMessage.id, (m) => ({
              ...m,
              content:
                '请先在「设置」中配置模型和 API Key，或在 Electron 环境中运行以获得完整功能。'
            }))
            // 没有可用模型 = 本轮没能开始：写 error 终态，否则时间线一直转圈。
            terminal = 'error'
            finishRun(convId, assistantMessage.id, 'error')
            return
          }

          const systemPrompt =
            '你是 Mimir，一个直接持有全部科研工具的科研 Agent：复杂任务先拆解规划，自己按需调用文献检索、论文编译、实验管理、组会 PPT、GPU 服务器等工具，汇总后给出最终回答。使用中文回复，保持专业且友好的语气。'
          const baseUrl = (selected.baseUrl as string) || 'https://api.deepseek.com/v1'
          const apiUrl = baseUrl.replace(/\/+$/, '') + '/chat/completions'

          const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${selected.apiKey}`
            },
            body: JSON.stringify({
              model: selected.modelId || 'deepseek-chat',
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: fullMessage }
              ],
              temperature: 0.7,
              stream: false
            })
          })

          if (!response.ok) {
            const errText = await response.text()
            throw new Error(`API 请求失败 (${response.status}): ${errText}`)
          }

          const data = await response.json()
          const reply =
            data.choices?.[0]?.message?.content || '模型未返回有效内容，请检查 API 配置。'
          updateMessage(convId, assistantMessage.id, (m) => ({ ...m, content: reply }))
          terminal = 'done'
          finishRun(convId, assistantMessage.id, 'done')
        }
      } catch (error) {
        // 失败必须显式可见：把异常写进气泡（正文已有内容时追加，不覆盖已产出的回答）。
        terminal = 'error'
        finishRun(
          convId,
          assistantMessage.id,
          'error',
          `错误: ${error instanceof Error ? error.message : '未知错误'}`
        )
      } finally {
        // 兜底证据：finally 必然执行，记录渲染层最终累计长度（与主进程 chars 对照）。
        streamLog.error(`stream.finally conv=${convId} fullContentChars=${fullContent.length} recvChars=${inChars}`)
        // 刷尾：把节流窗口内最后一段正文落定，再标记流式结束（否则末尾几十 ms 会被丢掉）
        flushContent()
        // 本条消息已定稿，回收它的步骤序号（否则 nextStepSeq 会随会话增长长期留存）。
        nextStepSeq.current.delete(assistantMessage.id)
        // 标记本条助手消息流式结束（无论纪元是否已过期都需执行，确保单条消息状态正确）
        updateMessage(convId, assistantMessage.id, (m) => ({ ...m, isStreaming: false }))
        // 兜底收敛：**无论上面走了哪条路径**（end / 流内报错 / 抛异常 / 浏览器降级 /
        // 被用户停止），run.status 都必须离开 'running' —— isRunActive 只认它，停在
        // running 就等于界面永久「正在思考…」+ 输入区永久禁用。
        // finishRun 幂等且「终态不可复活」，故这里无条件调用也不会改坏已有终态
        // （被停止时 handleStop 已写入 canceled，这里自然是空操作）。
        finishRun(
          convId,
          assistantMessage.id,
          terminal ?? (fullContent.trim() === '' ? 'error' : 'done'),
          terminal === null && fullContent.trim() === ''
            ? '错误：本轮回复没有正常结束（既没收到模型输出，也没有报错）。请重试。'
            : undefined
        )
        // 会话级运行态收尾：**必须无条件走这里**（按归属比较，见 releaseConvStreaming）。
        // 此前用 `currentEpoch(convId) === sendId` 当唯一条件，导致被新流顶掉的旧回复
        // 永远不关灯 → 界面永久「正在思考…」、输入区永久禁用。
        releaseConvStreaming(convId, sendId)
        // 发送锁的释放语义与 UI 运行态不同：只在本流仍是该会话当前纪元时才释放，
        // 避免旧流的 finally 把新流刚拿到的锁删掉（那会让同一会话又能并发发第二条）。
        if (currentEpoch(convId) === sendId) {
          sendingRefs.current.delete(convId)
        }
      }
    },
    [
      activeConvId,
      updateMessage,
      finishRun,
      slashEntries,
      applyTraceEvent,
      ultraEnabled,
      ultraStrategy,
      nextEpoch,
      currentEpoch,
      releaseConvStreaming
    ]
  )

  /** 重试：移除该条失败的助手消息，重新发送其前一条用户消息。 */
  const retryMessage = useCallback(
    (assistantId: string) => {
      if (activeConvId === '' || isStreaming) return
      const conv = conversations.find((c) => c.id === activeConvId)
      if (conv === undefined) return
      const index = conv.messages.findIndex((m) => m.id === assistantId)
      if (index <= 0) return
      const prompt = [...conv.messages.slice(0, index)]
        .reverse()
        .find((m) => m.role === 'user')?.content
      if (prompt === undefined || prompt.trim() === '') return
      setConversations((prev) =>
        prev.map((c) =>
          c.id === activeConvId
            ? { ...c, messages: c.messages.filter((m) => m.id !== assistantId) }
            : c
        )
      )
      void handleSend(prompt)
    },
    [conversations, activeConvId, isStreaming, handleSend],
  )

  const handleNewChat = useCallback(() => {
    const newConv = makeWelcomeConversation()
    setConversations((prev) => [newConv, ...prev])
    setActiveConvId(newConv.id)
  }, [])

  // 跨模块「交给 Agent」若携带初始提问：会话恢复完成后自动发送一次（读后即清，避免重挂载重发）
  useEffect(() => {
    if (!hydrated) return
    let pendingPrompt: string | null = null
    try {
      pendingPrompt = sessionStorage.getItem('mimir:agent-handoff-prompt')
      if (pendingPrompt !== null) sessionStorage.removeItem('mimir:agent-handoff-prompt')
    } catch {
      pendingPrompt = null
    }
    if (pendingPrompt !== null && pendingPrompt.trim() !== '') {
      void handleSend(pendingPrompt)
    }
  }, [hydrated, handleSend])

  const handleDeleteConv = useCallback(
    (id: string) => {
      // 清理该会话在主进程侧的治理数据（失效提醒 + 熔断计数 + 归档原文）。
      // 走主进程 API 而不是直接写 store 键：治理数据的键名与结构由 contextManager 拥有，
      // 渲染层不应重复实现（避免两条读写路径不一致）。
      void window.electronAPI?.resetConversationContext?.(id, true)
      setConversations((prev) => {
        const filtered = prev.filter((c) => c.id !== id)
        if (filtered.length === 0) {
          // 保留至少一个会话，避免空状态
          const fresh = makeWelcomeConversation()
          setActiveConvId(fresh.id)
          return [fresh]
        }
        if (activeConvId === id) {
          setActiveConvId(filtered[0]?.id || '')
        }
        return filtered
      })
    },
    [activeConvId]
  )

  const handleTogglePin = useCallback((id: string) => {
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, pinned: !c.pinned } : c))
    )
  }, [])

  const handleStartRename = useCallback((conv: Conversation) => {
    setRenamingId(conv.id)
    setRenameValue(conv.title)
  }, [])

  const handleConfirmRename = useCallback(() => {
    if (renamingId && renameValue.trim()) {
      setConversations((prev) =>
        prev.map((c) => (c.id === renamingId ? { ...c, title: renameValue.trim() } : c))
      )
    }
    setRenamingId(null)
    setRenameValue('')
  }, [renamingId, renameValue])

  // Sort: pinned first, then by createdAt desc
  const sortedConversations = [...conversations].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
    return b.createdAt.getTime() - a.createdAt.getTime()
  })

  // Conversation list content for right sidebar
  const conversationListContent = (
    <div className="p-3">
      <div className="mb-3">
        <span className="text-[11px] font-medium text-muted-foreground">会话列表</span>
      </div>
      <div className="space-y-1">
        {sortedConversations.map((conv) => (
          <div
            key={conv.id}
            className={cn(
              'group flex items-center gap-1.5 rounded-md px-2 py-1.5 cursor-pointer transition-colors',
              conv.id === activeConvId
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
            onClick={() => setActiveConvId(conv.id)}
          >
            <Pin
              className={cn(
                'h-3 w-3 shrink-0',
                conv.pinned ? 'text-amber-500' : 'opacity-0 group-hover:opacity-40'
              )}
            />
            {renamingId === conv.id ? (
              <div className="flex flex-1 items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <Input
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (isSubmitEnter(e)) handleConfirmRename()
                    if (e.key === 'Escape') setRenamingId(null)
                  }}
                  className="h-6 text-[11px] px-1.5"
                  autoFocus
                />
                <button onClick={handleConfirmRename} className="text-success hover:text-success/80">
                  <Check className="h-3 w-3" />
                </button>
                <button onClick={() => setRenamingId(null)} className="text-muted-foreground hover:text-foreground">
                  <X className="h-3 w-3" />
                </button>
              </div>
            ) : (
              <>
                <span className="flex-1 truncate text-[11px]">{conv.title}</span>
                {/* 后台任务标记：该会话正在生成回复（即使当前未打开，也能看到它在跑） */}
                {streamingConvIds.has(conv.id) && (
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" aria-label="生成中" />
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    handleTogglePin(conv.id)
                  }}
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-amber-500 transition-opacity"
                  title={conv.pinned ? '取消置顶' : '置顶'}
                >
                  {conv.pinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    handleStartRename(conv)
                  }}
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity"
                  title="重命名"
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    handleDeleteConv(conv.id)
                  }}
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                  title="删除"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )

  return (
    <div className="flex h-full">
      {/* Main chat area */}
      <div className="flex flex-col flex-1 overflow-hidden">
        {/* Header */}
        <div className={cn('drag-region flex h-12 items-center justify-between shrink-0', sidebarCollapsed ? 'pl-[76px] pr-5' : 'px-5')}>
          <div className="flex items-center gap-2">
            {/* Sidebar expand button - only visible when sidebar is collapsed */}
            {sidebarCollapsed && (
              <button
                onClick={onToggleSidebar}
                title="展开侧边栏"
                className="no-drag flex items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <PanelLeftOpen className="h-4 w-4" />
              </button>
            )}
            <span className="status-dot bg-green-500" title="就绪" />
            <span className="text-[11px] text-muted-foreground">就绪</span>
          </div>
          <div className="flex items-center gap-1.5 no-drag">
            {/* Ultra 二级：增强策略选择（开启后展示，放在 Ultra 左边） */}
            {ultraEnabled && (
              <div className="relative" ref={ultraMenuRef}>
                <button
                  type="button"
                  onClick={() => setShowUltraMenu((v) => !v)}
                  className="flex h-7 items-center gap-1 rounded-full bg-violet-500/10 px-2 text-[11px] font-medium text-violet-600 transition-colors hover:bg-violet-500/15 dark:text-violet-300"
                  title="增强策略：自动选择 / 普通增强 / 多专家合议 / 批判迭代 / 混合增强 / 一致性投票"
                >
                  策略：{ULTRA_LABEL[ultraStrategy]}
                  <ChevronDown className={cn('h-3 w-3 transition-transform', showUltraMenu && 'rotate-180')} />
                </button>
                {showUltraMenu && (
                  <div className="absolute right-0 top-full mt-1 z-50 w-64 rounded-lg border border-border bg-popover p-1 shadow-md">
                    {ULTRA_OPTIONS.map((opt) => {
                      const active = ultraStrategy === opt.value
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => {
                            setUltraStrategy(opt.value)
                            setShowUltraMenu(false)
                          }}
                          className={cn(
                            'flex w-full items-start gap-2 px-2.5 py-2 text-left rounded-md transition-colors',
                            active ? 'bg-primary/5 text-primary' : 'hover:bg-accent'
                          )}
                        >
                          <span
                            className={cn(
                              'mt-0.5 h-3 w-3 shrink-0 rounded-full border',
                              active ? 'border-primary bg-primary' : 'border-muted-foreground/40'
                            )}
                            aria-hidden="true"
                          />
                          <span className="min-w-0">
                            <span className="flex items-center gap-1.5 text-[12px] font-medium text-foreground">
                              {opt.label}
                              {opt.badge !== undefined && (
                                <span className="rounded bg-violet-500/10 px-1 py-px text-[9px] font-medium text-violet-600 dark:text-violet-300">
                                  {opt.badge}
                                </span>
                              )}
                            </span>
                            <span className="block text-[10px] leading-snug text-muted-foreground">{opt.desc}</span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Ultra 增强总开关 */}
            <button
              type="button"
              onClick={() => setUltraEnabled((v) => !v)}
              className={cn(
                'flex h-7 items-center gap-1 rounded-full px-2.5 text-[11px] font-medium transition-all',
                ultraEnabled
                  ? 'ultra-active text-white'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
              title={
                ultraEnabled
                  ? 'Ultra 增强已开启（策略：' + ULTRA_LABEL[ultraStrategy] + '）。点击关闭增强。'
                  : 'Ultra：Agent 之上的增强层——长程规划 + 增强策略调度（多专家合议只是可选项之一）。开启成本更高。'
              }
            >
              <Sparkles className={cn('h-3.5 w-3.5', ultraEnabled && 'animate-pulse')} />
              Ultra
            </button>

            {/* Right sidebar toggle - only shown when sidebar is collapsed */}
            {rightSidebarCollapsed && (
              <RightSidebarExpandButton
                onClick={onToggleRightSidebar}
                className="h-7 w-7"
              />
            )}
          </div>
        </div>

        {/* Messages */}
        <ScrollArea ref={scrollRef} className="flex-1 px-4">
          <div className="mx-auto max-w-3xl py-6 space-y-4">
            {displayMessages.map((message) => (
              <div key={message.id} className="group/message rounded-lg transition-colors">
                <MessageBubble
                  message={message}
                  onRetry={
                    message.role === 'assistant' && !message.isStreaming
                      ? () => retryMessage(message.id)
                      : undefined
                  }
                  // 待批准的工具名 → 时间线上对应步骤标「等待批准」（批准入口仍在输入区上方）
                  {...(pendingApproval !== null ? { pendingApprovalTool: pendingApproval.tool } : {})}
                />
              </div>
            ))}
          </div>
        </ScrollArea>

        {/* Input */}
        {pendingApproval !== null && (
          <div className="mx-auto w-full max-w-3xl px-4 pb-1">
            <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2.5">
              <ShieldQuestion className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-medium text-foreground">Agent 请求执行「{pendingApproval.tool}」</span>
                  <span className="rounded bg-amber-500/15 px-1.5 py-px text-[9px] font-medium text-amber-700">需确认</span>
                  {pendingApproval.source?.origin === 'subagent' && (
                    <span
                      className="rounded bg-sky-500/15 px-1.5 py-px text-[9px] font-medium text-sky-700"
                      title={pendingApproval.source.subagentId !== undefined ? `能力域 id：${pendingApproval.source.subagentId}` : undefined}
                    >
                      来自能力域：{pendingApproval.source.subagentLabel ?? pendingApproval.source.subagentId ?? '未命名'}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-[12px] text-foreground/90">{pendingApproval.summary}</p>
                {pendingApproval.detail !== undefined && pendingApproval.detail !== '' && (
                  <p className="mt-1 whitespace-pre-wrap break-all text-[10px] leading-relaxed text-muted-foreground">
                    {pendingApproval.detail}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 text-[11px]"
                  onClick={() => respondApproval(false)}
                >
                  <X className="h-3.5 w-3.5 mr-1" />
                  拒绝
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-7 text-[11px] bg-amber-500 hover:bg-amber-600 text-white"
                  onClick={() => respondApproval(true)}
                >
                  <Check className="h-3.5 w-3.5 mr-1" />
                  允许一次
                </Button>
                {pendingApproval.rememberable === true && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px] border-amber-500/40 text-amber-700 hover:bg-amber-500/10 dark:text-amber-300"
                    title="把这次放行升级为「这个目录以后免问」（可在「设置 → 权限与安全」撤销）"
                    onClick={() => respondApproval(true, true)}
                  >
                    允许并记住此目录
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
        <ChatInput
          onSend={handleSend}
          onStop={() => handleStop(activeConv.id)}
          entries={slashEntries}
          disabled={isStreaming}
          isStreaming={isStreaming}
          ultraEnabled={ultraEnabled}
          ultraStrategyLabel={ULTRA_LABEL[ultraStrategy]}
        />
      </div>

      {/* Right Sidebar - Conversation list */}
      <RightSidebar
        collapsed={rightSidebarCollapsed}
        onToggle={onToggleRightSidebar}
        headerActions={
          <Button
            onClick={handleNewChat}
            variant="ghost"
            size="sm"
            className="no-drag h-7 text-[11px]"
          >
            <Plus className="h-3.5 w-3.5" />
            新对话
          </Button>
        }
      >
        {conversationListContent}
      </RightSidebar>
    </div>
  )
}
