import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MessageBubble } from './MessageBubble'
import { ChatInput, type Attachment } from './ChatInput'
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
  ChevronDown
} from 'lucide-react'
import { cn } from '@/lib/utils'
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

/** Agent 副作用确认（见 electron/agent/approval.ts）。 */
interface PendingApproval {
  id: string
  tool: string
  summary: string
  detail?: string
}

/** Agent 执行事件树节点（run 根 / 阶段 / 任务 / 思考 / 工具行）。 */
export interface SwarmEventNode {
  key: string
  kind: 'run' | 'phase' | 'task' | 'think' | 'tool'
  title: string
  status?: 'running' | 'done' | 'error' | 'canceled'
  /** 叶子完整文本（思考全文 / 工具调用与返回摘要）；超过单行展示上限时在 UI 折叠。 */
  text?: string
  /** 工具执行耗时（毫秒，由主进程在返回/出错时填充）。 */
  durationMs?: number
}

export interface SwarmTreeNodeItem {
  node: SwarmEventNode
  children: SwarmTreeNodeItem[]
}

/** Agent 过程事件信封前缀（与主进程 ipc/index.ts 保持一致）。 */
const AGENT_EVENT_PREFIX = '\u0002MIMIR_AGENT_EVENT\u0002'

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: Date
  isStreaming?: boolean
  /** 生成本条回复时的事件树（Supervisor 与模块子 Agent 统一；气泡内折叠展示，历史可回看）。 */
  trace?: SwarmTreeNodeItem
}

interface Conversation {
  id: string
  title: string
  messages: Message[]
  createdAt: Date
  pinned?: boolean
}

const WELCOME_MESSAGE = `你好，我是 **Mimir**，你的科研助手。

我采用 **Supervisor 编排**：主管 Agent 会把文献检索、论文编译、实验、组会 PPT、GPU 服务器等专业任务自动委派给相应的模块专家协作完成。

我可以帮你：

- **文献搜索** — 搜索 arXiv 论文，获取最新研究进展
- **论文写作** — 协助撰写和编辑 LaTeX 论文
- **实验管理** — 记录和可视化实验数据
- **组会准备** — 生成组会 PPT 和进展报告
- **服务器管理** — 管理 GPU 服务器和远程作业

有什么需要帮忙的？`

// ── Ultra 增强策略（UI 层枚举；与主进程 electron/agent/agentService.ts 保持一致）─────
type UltraStrategy = 'plain' | 'multi_expert' | 'critique_reflect' | 'hybrid_mix' | 'self_consistency_vote'
type UltraPick = 'auto' | UltraStrategy
const ULTRA_OPTIONS: { value: UltraPick; label: string; desc: string; badge?: string }[] = [
  { value: 'auto', label: '自动选择', desc: 'Ultra 分析任务类型与复杂度自动挑选策略', badge: '推荐' },
  { value: 'plain', label: '普通增强', desc: '长程规划约束，不启用多专家合议' },
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

// ── 上下文治理（M2/M3）：发给 Agent 的历史滑动窗口 + 超限摘要压缩 + 失效对象提醒 ──
type HistoryMsg = { role: 'user' | 'assistant'; content: string }
/** 历史总字符阈值：超过则对最旧部分压缩（SS 估算，避免把长会话整包塞进 prompt）。 */
const MAX_CONTEXT_CHARS = 60_000
/** 压缩后仍保留的「最近原文窗口」字符数。 */
const KEEP_TAIL_CHARS = 32_000
/** 归档 store key 前缀：被压缩掉的旧轮原文，key = chat:archive:<convId>。 */
const HISTORY_ARCHIVE_PREFIX = 'chat:archive:'
/** 失效对象提醒 store key 前缀：key = chat:reminders:<convId>（治理 M3）。 */
const REMINDER_STORE_PREFIX = 'chat:reminders:'
/** 破坏性动作特征词：命中则认为会话内对象可能已失效（删除/改名/覆盖等）。 */
const DESTRUCTIVE_ACTION_RE = /(删除|移除|改名|重命名|覆盖|清除|回退)/

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

/** 从一次工具事件中抽取「对象已失效」提醒文本；非破坏性完成事件返回 null（治理 M3）。 */
function reminderTextFromEvent(event: {
  taskId: string
  title: string
  status: string
  text?: string
  kind?: string
}): string | null {
  if (event.kind !== 'tool' || event.status !== 'done') return null
  const raw = event.text ?? ''
  const sep = ' 返回：'
  const at = raw.indexOf(sep)
  if (at === -1) return null
  const toolName = raw.slice(0, at).trim()
  const out = raw.slice(at + sep.length).replace(/\s+/g, ' ').trim()
  if (!DESTRUCTIVE_ACTION_RE.test(out)) return null
  const note = out.length > 60 ? `${out.slice(0, 60)}…` : out
  return `${toolName} 于 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 执行后：${note}（若相关对象已被删除/改名/覆盖，后续请忽略其旧描述）`
}

/** 读取该会话已累积的失效提醒（最新在前，至多 N 条）。 */
async function loadConversationReminders(convId: string): Promise<string[]> {
  const api = window.electronAPI
  if (!api?.getStoreValue) return []
  try {
    const list = (await api.getStoreValue<string[]>(`${REMINDER_STORE_PREFIX}${convId}`)) ?? []
    return list.slice(-8).reverse()
  } catch {
    return []
  }
}

/** 把一条失效提醒异步写入该会话（去重、上限 20 条；尽力而为）。 */
async function addConversationReminder(convId: string, text: string): Promise<void> {
  const api = window.electronAPI
  if (!api?.getStoreValue || !api.setStoreValue) return
  try {
    const key = `${REMINDER_STORE_PREFIX}${convId}`
    const prev = (await api.getStoreValue<string[]>(key)) ?? []
    if (prev.length > 0 && prev[prev.length - 1] === text) return // 去重连续同款
    const next = [...prev, text]
    await api.setStoreValue(key, next.length > 20 ? next.slice(next.length - 20) : next)
  } catch {
    // ignore
  }
}

/**
 * 组装发送给 Agent 的对话历史：
 * 0) 前置本会话的「失效对象提醒」（M3：删除/改名/覆盖后防止跨轮复述旧描述）；
 * 1) 总长 ≤ 阈值 → 直接原样返回（滑动窗口无需触发）；
 * 2) 超过阈值 → 保留最近 KEEP_TAIL_CHARS 原文，更早部分先做 LLM 结构化摘要，
 *    摘要以一条 assistant 消息置于队首；压缩失败则降级为截断窗口。
 * 被压缩原文异步归档到 store（chat:archive:<convId>）供回看，不回灌模型。
 */
async function buildOutgoingHistory(conv: Conversation): Promise<HistoryMsg[]> {
  const api = window.electronAPI
  // M3：本会话失效对象提醒（删除/改名/覆盖）作为轻量 assistant 消息前置，防止跨轮复述旧描述
  const reminders = await loadConversationReminders(conv.id)
  const reminderMsgs: HistoryMsg[] = reminders.map((text) => ({ role: 'assistant', content: text }))
  const all = [...reminderMsgs, ...toHistoryMessages(conv.messages)]
  if (all.length === 0) return all
  if (!api?.compressConversation) return all
  const total = all.reduce((sum, m) => sum + m.content.length, 0)
  if (total <= MAX_CONTEXT_CHARS) return all

  // 找到「最近 KEEP_TAIL_CHARS」对应的起始索引，之前部分进入压缩
  let start = all.length
  let acc = 0
  while (start > 0) {
    const len = all[start - 1].content.length
    if (acc + len > KEEP_TAIL_CHARS) break
    acc += len
    start -= 1
  }
  if (start === 0) return all // 单条消息就超长：不循环压缩同一条，原样返回
  const head = all.slice(0, start)
  const tail = all.slice(start)

  let res: { ok: boolean; summary?: string; message?: string }
  try {
    res = await api.compressConversation(head)
  } catch {
    res = { ok: false }
  }
  if (res.ok && res.summary !== undefined && res.summary.trim() !== '') {
    // 归档最旧原文（尽力而为，失败不阻塞主流程）
    try {
      const key = `${HISTORY_ARCHIVE_PREFIX}${conv.id}`
      const prev = (await api.getStoreValue<unknown[]>(key)) ?? []
      await api.setStoreValue(key, [...prev, { at: new Date().toISOString(), head }])
    } catch {
      // ignore archive error
    }
    return [{ role: 'assistant', content: `【更早对话摘要（已压缩）】\n${res.summary}` }, ...tail]
  }
  // 压缩失败降级：仅保留最近窗口
  const cut: HistoryMsg[] = []
  let budget = KEEP_TAIL_CHARS
  for (let i = tail.length - 1; i >= 0; i--) {
    if (budget <= 0) break
    const content = tail[i].content
    if (content.length > budget) {
      cut.unshift({ ...tail[i], content: content.slice(-budget) })
      break
    }
    budget -= content.length
    cut.unshift(tail[i])
  }
  return cut
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
        ...(m.trace !== undefined ? { trace: m.trace } : {})
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
          ...(m.trace !== undefined && typeof m.trace === 'object' ? { trace: m.trace as SwarmTreeNodeItem } : {})
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
  const [isStreaming, setIsStreaming] = useState(false)
  /** Ultra 增强控制器（Supervisor 之上的可选增强层）：开启后本条及后续请求先经增强，成本更高，默认关。 */
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
  /** 发送纪元：每次发送自增取号。停止即 +1，让旧回复的所有 chunk/事件/看门狗失效；
   *  新发送再取新号，二者互不干扰，杜绝"停后再发导致旧流复活"。 */
  const sendEpochRef = useRef(0)
  /** 发送锁：防止快速双击等场景下并发调用 streamMessage（React setState 异步，isStreaming 守卫不可靠）。 */
  const sendingRef = useRef(false)

  // ── 斜杠「技能与指令」：内置注册表 + 自定义技能 / 指令 ──
  const [customSkillEntries, setCustomSkillEntries] = useState<readonly SlashEntry[]>([])
  const [customCommandEntries, setCustomCommandEntries] = useState<readonly SlashEntry[]>([])
  const slashEntries = useMemo(
    () => [...COMMAND_ENTRIES, ...SKILL_ENTRIES, ...customCommandEntries, ...customSkillEntries],
    [customSkillEntries, customCommandEntries]
  )

  // ── Agent 执行 trace：事件树挂在生成中的助手消息上（message.trace），历史可回看 ──
  /** 事件树内行节点序号（同一消息树内保证 key 唯一；每次发送归零）。 */
  const swarmEventSeq = useRef(0)

  type SwarmEvent = {
    taskId: string
    title: string
    status: 'running' | 'done' | 'error'
    text?: string
    durationMs?: number
    kind?: 'phase' | 'task' | 'tool' | 'think' | 'think-token'
  }

  /** 事件应用：不可变更新该助手消息上挂的事件树（Supervisor 与模块子 Agent 统一）。 */
  const applyTraceEvent = useCallback((convId: string, messageId: string, event: SwarmEvent): void => {
    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== convId) return c
        return {
          ...c,
          messages: c.messages.map((m) => {
            if (m.id !== messageId || m.trace === undefined) return m
            return { ...m, trace: applyOne(m.trace, event) }
          })
        }
      })
    )
  }, [])

  /** 单个事件对一棵事件树的不可变应用（纯树更新，key 生成引用外部序号）。 */
  function applyOne(run: SwarmTreeNodeItem, event: SwarmEvent): SwarmTreeNodeItem {
    const piece = event.text ?? ''
    const isPhase =
      event.kind === 'phase' || event.taskId === 'scheduler' || event.taskId === 'aggregate'
    const index = run.children.findIndex((item) => item.node.key === event.taskId)

    // 1) 思考逐字 token → 追加到该任务下最后一条运行中思考（文本保留可展开全文）
    if (event.kind === 'think-token') {
      if (piece === '' || index === -1) return run
      return {
        ...run,
        children: run.children.map((item, i) => {
          if (i !== index) return item
          const last = item.children[item.children.length - 1]
          if (last !== undefined && last.node.kind === 'think' && last.node.status === 'running') {
            return {
              ...item,
              children: [
                ...item.children.slice(0, -1),
                { ...last, node: { ...last.node, text: (last.node.text ?? '') + piece } }
              ]
            }
          }
          swarmEventSeq.current += 1
          return {
            ...item,
            children: [
              ...item.children,
              {
                node: {
                  key: `${event.taskId}:think:${swarmEventSeq.current}`,
                  kind: 'think',
                  title: '思考',
                  status: 'running',
                  text: piece
                },
                children: []
              }
            ]
          }
        })
      }
    }

    // 2) 工具行（调用/返回/出错）→ 追加到该任务下；容器缺失（普通模式"主 Agent"）先补建
    if (event.kind === 'tool') {
      const container: SwarmTreeNodeItem = {
        node: {
          key: event.taskId,
          kind: isPhase ? 'phase' : 'task',
          title: event.title || 'Agent'
        },
        children: []
      }
      const baseChildren = index === -1 ? [...run.children, container] : run.children
      const targetIndex = index === -1 ? baseChildren.length - 1 : index
      const toolTitle = piece.startsWith('调用')
        ? '工具调用'
        : piece.includes('返回') || piece.includes('出错')
          ? '工具返回'
          : '工具'
      swarmEventSeq.current += 1
      return {
        ...run,
        children: baseChildren.map((item, i) => {
          if (i !== targetIndex) return item
          return {
            ...item,
            children: [
              ...item.children,
              {
                node: {
                  key: `${event.taskId}:e:${swarmEventSeq.current}`,
                  kind: 'tool',
                  title: toolTitle,
                  status: piece.includes('出错') ? 'error' : undefined,
                  text: piece,
                  durationMs: event.durationMs
                },
                children: []
              }
            ]
          }
        })
      }
    }

    // 3) 阶段 / 任务事件 → 根下节点 upsert（收尾时把最后一条思考置为完成态）
    const base: SwarmTreeNodeItem =
      index >= 0
        ? run.children[index]
        : {
            node: {
              key: event.taskId,
              kind: isPhase ? 'phase' : 'task',
              title: event.title
            },
            children: []
          }
    let node: SwarmTreeNodeItem = {
      ...base,
      node: { ...base.node, title: event.title, status: event.status, text: piece || base.node.text }
    }

    // 任务收尾：把最后一条思考置为完成态（文本保留可展开）
    if (
      node.node.kind === 'task' &&
      (event.status === 'done' || event.status === 'error') &&
      node.children.length > 0
    ) {
      const tail = node.children[node.children.length - 1]
      if (tail.node.kind === 'think' && tail.node.status === 'running') {
        node = {
          ...node,
          children: [...node.children.slice(0, -1), { ...tail, node: { ...tail.node, status: 'done' } }]
        }
      }
    }

    const children =
      index >= 0 ? run.children.map((item, i) => (i === index ? node : item)) : [...run.children, node]
    return { ...run, children }
  }

  const activeConv = conversations.find((c) => c.id === activeConvId) || conversations[0]
  /** 活跃会话镜像（ref）：handleSend 内读最新消息构建历史，避免 useCallback 闭包过期。 */
  const activeConvRef = useRef<Conversation>(activeConv)
  activeConvRef.current = activeConv
  const displayMessages = activeConv.messages.filter((m) => m.role !== 'system')

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
    (allow: boolean) => {
      if (pendingApproval === null) return
      window.electronAPI?.approvalRespond?.(pendingApproval.id, allow)
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

  /** 把树中所有运行中的节点置为「已取消」（用户主动停止时调用）。 */
  const cancelRunningNodes = (tree: SwarmTreeNodeItem): SwarmTreeNodeItem => ({
    ...tree,
    node: tree.node.status === 'running' ? { ...tree.node, status: 'canceled' } : tree.node,
    children: tree.children.map(cancelRunningNodes)
  })

  /**
   * 停止当前生成：立即本地收尾（UI 即刻可交互），并通知主进程 abort。
   * 后续到达的文本/事件 chunk 会被 stoppedReplyRef 丢弃，不会出现"停后又冒出内容"。
   */
  const handleStop = useCallback(() => {
    // 纪元 +1：本回复后续所有 chunk / 事件 / 看门狗回调全部失效
    sendEpochRef.current += 1
    setIsStreaming(false)
    // 立即释放发送锁：旧流被 abort 后 finally 因纪元不匹配不会重置，这里主动释放避免卡死
    sendingRef.current = false
    void window.electronAPI?.stopMessage?.()
    // 遍历所有会话，终止任何正在流式生成的消息（用户可能在流式过程中切走了会话）
    setConversations((prev) =>
      prev.map((c) => ({
        ...c,
        messages: c.messages.map((m) =>
          m.isStreaming === true
            ? {
                ...m,
                isStreaming: false,
                trace: m.trace !== undefined ? cancelRunningNodes(m.trace) : m.trace
              }
            : m
        )
      }))
    )
  }, [])

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      const viewport = scrollRef.current.querySelector('[data-radix-scroll-area-viewport]')
      if (viewport) {
        viewport.scrollTop = viewport.scrollHeight
      }
    }
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [displayMessages, scrollToBottom])

  const updateMessage = useCallback((convId: string, messageId: string, updater: (m: Message) => Message) => {
    setConversations((prev) =>
      prev.map((c) =>
        c.id === convId
          ? { ...c, messages: c.messages.map((m) => (m.id === messageId ? updater(m) : m)) }
          : c
      )
    )
  }, [])

  const handleSend = useCallback(
    async (content: string, attachments?: Attachment[]) => {
      const trimmed = content.trim()
      if (!trimmed || isStreaming) return
      if (sendingRef.current) return // 并发发送守卫：防止快速双击等场景下同时发起两次流式请求
      sendingRef.current = true

      // 最早捕获目标会话 id，防止后续 await（如历史压缩）期间用户切会话导致消息落到错误会话
      const convId = activeConvId

      // 斜杠「技能与指令」解析（统一在最前面做）
      const slashMatch = resolveSlashInput(trimmed, slashEntries)

      // 客户端特殊指令：由 clientAction 标记决定前端行为
      if (slashMatch?.entry.clientAction === 'clear') {
        const fresh = makeWelcomeConversation()
        setConversations((prev) =>
          prev.map((c) =>
            c.id === convId
              ? { ...c, title: '新对话', createdAt: fresh.createdAt, messages: fresh.messages }
              : c
          )
        )
        sendingRef.current = false
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
        sendingRef.current = false
        return
      }

      // 取本次回复的纪元号（同一时刻只允许一路流式）
      const sendId = ++sendEpochRef.current

      // 指令/技能需要参数但用户没给
      if (slashMatch !== null && slashMatch.entry.requiresArg && slashMatch.args === '') {
        window.alert(`「/${slashMatch.entry.trigger}」需要参数。\n用法：${slashMatch.entry.usage}`)
        sendingRef.current = false
        return
      }

      // 上下文治理（M2）：滑动窗口历史 + 超限时对最旧部分摘要压缩（大会话才触发 LLM 压缩）
      const outgoingHistory = await buildOutgoingHistory(activeConvRef.current)

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
      // 每条助手回复都预先挂一棵空事件树：Supervisor / 模块子 Agent 的事件都长在这棵树上，
      // 完成后内嵌在气泡里展示并随会话持久化（历史消息仍可点开复盘）。
      const assistantMessage: Message = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: '',
        timestamp: new Date(),
        isStreaming: true,
        trace: {
          node: {
            key: `trace:run:${Date.now()}`,
            kind: 'run',
            title: 'Agent 执行过程'
          },
          children: []
        }
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

      // 一次新回复：重置行节点序号（执行树在 assistantMessage.trace 上逐条生长）
      swarmEventSeq.current = 0

      setIsStreaming(true)

      // 看门狗：滚动超时——收到正文 token 或 Agent 过程事件即重置计时，只有连续 stallMs
      // 无任何产出才中止。此前为固定 120s 一次性定时：长回复/工具往返一超时即被误杀
      // （表现为主进程"回复被中止，已收到 N 字符"，正文正常流却被腰斩）。
      // Supervisor 一次回复要经历 委派→模块子 Agent（可能限流自动退避重试）→汇总，放宽到 120s；
      // Ultra 增强还要先跑策略子图（合议/批判迭代），正文迟迟未开始，再放宽到 360s。
      const stallMs = ultraEnabled ? 360_000 : 120_000
      const stallMsg = ultraEnabled
        ? '错误: Ultra 增强在 6 分钟内未开始产出正文（增强子图可能较慢或失败）。可能原因：① 接口配额/网络不稳定，策略子图或模块 Agent 委派触发限流/超时；② 模型接口兼容问题。建议：先在「设置 → 模型管理」测试连接，等 1 分钟后再试，或临时关闭 Ultra / 换用「普通增强」。'
        : '错误: Supervisor 在 2 分钟内未开始回复。可能原因：① 接口配额/网络不稳定，模块子 Agent 委派触发了限流或超时；② 模型接口兼容问题。建议：先在「设置 → 模型管理」测试连接，等 1 分钟后再试。'
      let stallTimer: number | undefined
      const stallFire = (): void => {
        // 已被停止/已开启新一轮回复：本次回复不再处理
        if (sendEpochRef.current !== sendId) return
        updateMessage(convId, assistantMessage.id, (m) => {
          if (m.content !== '') return m
          return {
            ...m,
            content: stallMsg,
          }
        })
        // 超时中止同样把执行树里运行中的节点标为已取消
        setConversations((prev) =>
          prev.map((c) =>
            c.id === convId
              ? {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.id === assistantMessage.id && m.trace !== undefined
                      ? { ...m, trace: cancelRunningNodes(m.trace) }
                      : m
                  )
                }
              : c
          )
        )
        void window.electronAPI?.stopMessage?.()
      }
      /** 重新武装看门狗：正文 token 或 Agent 过程事件到达都视为"有进展"，重置计时。 */
      const armStall = (): void => {
        window.clearTimeout(stallTimer)
        stallTimer = window.setTimeout(stallFire, stallMs)
      }
      armStall()

      try {
        if (window.electronAPI) {
          let fullContent = ''
          await window.electronAPI.streamMessage(
            fullMessage,
            convId,
            (chunk: string) => {
              // 已被停止/已开启新一轮回复：丢弃本回复剩余所有文本/事件 chunk
              if (sendEpochRef.current !== sendId) return
              // Agent 过程事件经同一 chunk 通道送达（前缀信封）：拆包应用到该回复消息的事件树，不进入正文。
              if (chunk.startsWith(AGENT_EVENT_PREFIX)) {
                try {
                  const event = JSON.parse(
                    chunk.slice(AGENT_EVENT_PREFIX.length)
                  ) as Parameters<typeof applyTraceEvent>[2]
                  applyTraceEvent(convId, assistantMessage.id, event)
                  // M3：破坏性工具完成时记录「失效提醒」，供后续轮次过滤旧描述
                  const reminder = reminderTextFromEvent(event)
                  if (reminder !== null) void addConversationReminder(convId, reminder)
                  // Agent 侧有活动（工具执行/阶段推进）也算进展，重置看门狗
                  armStall()
                } catch {
                  // 忽略无法解析的行程
                }
                return
              }
              fullContent += chunk
              // 收到正文 token：有进展，重置看门狗
              armStall()
              updateMessage(convId, assistantMessage.id, (m) => ({ ...m, content: fullContent }))
            },
            undefined,
            {
              // Ultra 增强控制器（可选增强层）：enabled 总开关 + 增强策略（auto 由 Ultra 自动选）
              ultra: ultraEnabled ? { enabled: true, strategy: ultraStrategy } : undefined,
              // 手动 / 技能直通：跳过 Agent 自动技能路由（正文已注入）
              manual: slashMatch !== null,
              ...(outgoingHistory.length > 0 ? { history: outgoingHistory } : {})
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
            return
          }

          const systemPrompt =
            '你是 Mimir，一个以 Supervisor 编排架构工作的科研 Agent：复杂任务先拆解规划，需要工具或专业知识时委派给模块子 Agent，汇总后给出最终回答。使用中文回复，保持专业且友好的语气。'
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
        }
      } catch (error) {
        updateMessage(convId, assistantMessage.id, (m) => ({
          ...m,
          content: `错误: ${error instanceof Error ? error.message : '未知错误'}`
        }))
      } finally {
        window.clearTimeout(stallTimer)
        // 标记本条助手消息流式结束（无论纪元是否已过期都需执行，确保单条消息状态正确）
        updateMessage(convId, assistantMessage.id, (m) => ({ ...m, isStreaming: false }))
        // 仅当本流仍是当前纪元时才重置全局流状态——若用户已停止并发起新流，不得覆盖新流的状态
        if (sendEpochRef.current === sendId) {
          setIsStreaming(false)
          sendingRef.current = false
        }
      }
    },
    [isStreaming, activeConvId, updateMessage, slashEntries, applyTraceEvent, ultraEnabled, ultraStrategy]
  )

  /** 重试：移除该条失败的助手消息，重新发送其前一条用户消息。 */
  const retryMessage = useCallback(
    (assistantId: string) => {
      if (isStreaming) return
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

  const handleDeleteConv = useCallback(
    (id: string) => {
      // 异步清理该会话的归档历史与失效提醒键（跨空间串键 + 敏感内容残留）
      const api = window.electronAPI
      if (api?.setStoreValue) {
        void api.setStoreValue(`${HISTORY_ARCHIVE_PREFIX}${id}`, [] as unknown[]).catch(() => {})
        void api.setStoreValue(`${REMINDER_STORE_PREFIX}${id}`, [] as string[]).catch(() => {})
      }
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
                    if (e.key === 'Enter') handleConfirmRename()
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
            <span className="module-title">Mimir Agent</span>
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
                  : 'Ultra：Supervisor 之上的增强层——长程规划 + 增强策略调度（多专家合议只是可选项之一）。开启成本更高。'
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
                  允许
                </Button>
              </div>
            </div>
          </div>
        )}
        <ChatInput onSend={handleSend} onStop={handleStop} entries={slashEntries} disabled={isStreaming} isStreaming={isStreaming} ultraEnabled={ultraEnabled} ultraStrategyLabel={ULTRA_LABEL[ultraStrategy]} />
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
