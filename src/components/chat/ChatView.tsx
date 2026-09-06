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
  Hexagon,
  Zap,
  ChevronDown,
  Pin,
  PinOff,
  Pencil,
  Check,
  X,
  PanelLeftOpen,
  ShieldQuestion
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  COMMAND_ENTRIES,
  SKILL_ENTRIES,
  resolveSlashInput,
  loadUserSkills,
  userSkillToEntry
} from '@/lib/slash'
import type { SlashEntry } from '@/lib/slash/types'

/** Agent 副作用确认（见 electron/agent/approval.ts）。 */
interface PendingApproval {
  id: string
  tool: string
  summary: string
  detail?: string
}

/** 蜂群产物收集里的一行（调度阶段或单个任务的最终产出，供气泡折叠区用）。 */
type SwarmRowStatus = 'running' | 'done' | 'error'
interface SwarmRow {
  id: string
  title: string
  status: SwarmRowStatus
  text?: string
}

/** 蜂王拆解后的任务计划（角色信息经 ref 供事件树标注用）。 */
interface SwarmPlanTask {
  id: string
  title: string
  role: 'researcher' | 'analyst' | 'writer'
  dependsOn: string[]
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
  role?: 'researcher' | 'analyst' | 'writer'
}

export interface SwarmTreeNodeItem {
  node: SwarmEventNode
  children: SwarmTreeNodeItem[]
}

/** 蜂群过程事件信封前缀（与主进程 ipc/index.ts 保持一致）。 */
const SWARM_EVENT_PREFIX = '\u0002MIMIR_SWARM_EVENT\u0002'

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: Date
  isStreaming?: boolean
  /** 蜂群模式：并行子 Agent 的产出分区（气泡内折叠展示）。 */
  swarmSections?: { label: string; text: string }[]
  /** 生成本条回复时的事件树（标准 Agent 与蜂群统一；气泡内折叠展示，历史可回看）。 */
  trace?: SwarmTreeNodeItem
}

interface Conversation {
  id: string
  title: string
  messages: Message[]
  createdAt: Date
  pinned?: boolean
}

export type AgentMode = 'normal' | 'swarm'

const MODE_CONFIG = {
  normal: { label: '标准模式', icon: Zap, description: '单 Agent 对话' },
  swarm: { label: '蜂群模式', icon: Hexagon, description: '多 Agent 协作' }
}

const WELCOME_MESSAGE = `你好，我是 **Mimir**，你的科研助手。

我可以帮你：

- **文献搜索** — 搜索 arXiv 论文，获取最新研究进展
- **论文写作** — 协助撰写和编辑 LaTeX 论文
- **实验管理** — 记录和可视化实验数据
- **组会准备** — 生成组会 PPT 和进展报告
- **服务器管理** — 管理 GPU 服务器和远程作业

有什么需要帮忙的？`

const SWARM_WELCOME = `🐝 **蜂群模式已激活**

多个 Agent 协同工作：

- **搜索 Agent** — 并行检索文献与数据
- **分析 Agent** — 解析论文方法与实验
- **写作 Agent** — 撰写和润色论文内容
- **编排 Agent** — 协调各 Agent 的工作流

描述你的需求，蜂群将自动分配任务。`

interface ChatViewProps {
  rightSidebarCollapsed: boolean
  onToggleRightSidebar: () => void
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
}

// ── 会话持久化（优先 Electron store，浏览器降级 localStorage）──────────
const CONVERSATIONS_KEY = 'chat:conversations'

function makeWelcomeConversation(mode: AgentMode): Conversation {
  const now = new Date()
  const welcome = mode === 'swarm' ? SWARM_WELCOME : WELCOME_MESSAGE
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
        timestamp: m.timestamp.toISOString()
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
          timestamp: toDate(m.timestamp)
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
  const [conversations, setConversations] = useState<Conversation[]>(() => [makeWelcomeConversation('normal')])
  const [activeConvId, setActiveConvId] = useState<string>(() => conversations[0]?.id ?? '')
  const [isStreaming, setIsStreaming] = useState(false)
  const [agentMode, setAgentMode] = useState<AgentMode>('normal')
  const [showModeMenu, setShowModeMenu] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [hydrated, setHydrated] = useState(false)
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const modeMenuRef = useRef<HTMLDivElement>(null)
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({})
  /** 发送纪元：每次发送自增取号。停止即 +1，让旧回复的所有 chunk/事件/看门狗失效；
   *  新发送再取新号，二者互不干扰，杜绝“停后再发导致旧流复活”。 */
  const sendEpochRef = useRef(0)

  // ── 斜杠「技能与指令」：内置注册表 + 设置里导入的自定义技能 ──
  const [customSkillEntries, setCustomSkillEntries] = useState<readonly SlashEntry[]>([])
  const slashEntries = useMemo(
    () => [...COMMAND_ENTRIES, ...SKILL_ENTRIES, ...customSkillEntries],
    [customSkillEntries]
  )

  // ── Agent 执行 trace：事件树挂在生成中的助手消息上（message.trace），历史可回看 ──
  /** 蜂王拆解出的任务计划（仅写；角色经 swarmPlanRef 消费）。 */
  const [, setSwarmPlan] = useState<SwarmPlanTask[] | null>(null)
  /** 计划镜像（ref），供 apply 的事件回调读取角色信息而不引入闭包过期。 */
  const swarmPlanRef = useRef<SwarmPlanTask[] | null>(null)
  /** 事件树内行节点序号（同一消息树内保证 key 唯一；每次发送归零）。 */
  const swarmEventSeq = useRef(0)
  /** 收集任务产物（按 taskId），供气泡折叠区使用（ref 避免异步闭包过期）。 */
  const swarmCollectRef = useRef<Record<string, SwarmRow>>({})

  type SwarmEvent = {
    taskId: string
    title: string
    status: 'running' | 'done' | 'error'
    text?: string
    durationMs?: number
    kind?: 'phase' | 'task' | 'tool' | 'think' | 'think-token'
    detail?: SwarmPlanTask[]
  }

  /** 事件应用：不可变更新该助手消息上挂的事件树（标准 Agent 与蜂群统一）。 */
  const applyTraceEvent = useCallback((convId: string, messageId: string, event: SwarmEvent): void => {
    // 计划镜像：蜂王拆解完成时保存角色信息（供任务徽标等消费）
    if (event.taskId === 'scheduler' && event.status === 'done' && event.detail !== undefined) {
      setSwarmPlan(event.detail)
      swarmPlanRef.current = event.detail
    }

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

    // 产物收集：供蜂群气泡折叠区 / 普通模式无需展示，过滤无产物阶段
    const current = swarmCollectRef.current
    if (event.taskId !== 'main') {
      current[event.taskId] = {
        id: event.taskId,
        title: event.title,
        status: event.status,
        text: event.text ?? current[event.taskId]?.text
      }
    }
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

    // 2) 工具行（调用/返回/出错）→ 追加到该任务下；容器缺失（普通模式“主 Agent”）先补建
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

    // 角色信息（任务节点）
    if (node.node.kind === 'task' && node.node.role === undefined) {
      const planMeta = (swarmPlanRef.current ?? []).find((t) => t.id === event.taskId)
      if (planMeta !== undefined) node = { ...node, node: { ...node.node, role: planMeta.role } }
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
  const displayMessages = activeConv.messages.filter((m) => m.role !== 'system')

  // 启动时从 store 恢复会话历史
  useEffect(() => {
    let alive = true
    readConversations()
      .then((list) => {
        if (!alive) return
        if (list !== null) {
          setConversations(list)
          setActiveConvId(list[0]?.id ?? '')
        }
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setHydrated(true)
      })
    return () => {
      alive = false
    }
  }, [])

  // 会话变化时持久化（流式过程中跳过，避免每个 chunk 都写盘）
  useEffect(() => {
    if (!hydrated || isStreaming) return
    void persistConversations(conversations)
  }, [conversations, isStreaming, hydrated])

  // 加载自定义技能（设置页导入/删除后重新进入本模块即刷新）
  useEffect(() => {
    let alive = true
    loadUserSkills()
      .then((skills) => {
        if (alive) setCustomSkillEntries(skills.map(userSkillToEntry))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // Close mode menu on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (modeMenuRef.current && !modeMenuRef.current.contains(e.target as Node)) {
        setShowModeMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
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
    void window.electronAPI?.stopMessage?.()
    setConversations((prev) =>
      prev.map((c) =>
        c.id === activeConvId
          ? {
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
            }
          : c
      )
    )
  }, [activeConvId])

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

  const scrollToMessage = useCallback((messageId: string) => {
    const el = messageRefs.current[messageId]
    if (el && scrollRef.current) {
      const viewport = scrollRef.current.querySelector('[data-radix-scroll-area-viewport]')
      if (viewport) {
        const top = el.offsetTop - viewport.clientHeight / 2 + el.clientHeight / 2
        viewport.scrollTo({ top, behavior: 'smooth' })
      }
    }
  }, [])

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
      // 取本次回复的纪元号（同一时刻只允许一路流式）
      const sendId = ++sendEpochRef.current

      const convId = activeConvId

      // 斜杠「技能与指令」：命中注册表则展开为任务提示发给 Agent（气泡仍保留原文）。
      const slashMatch = resolveSlashInput(trimmed, slashEntries)
      if (slashMatch !== null && slashMatch.entry.requiresArg && slashMatch.args === '') {
        window.alert(`「/${slashMatch.entry.trigger}」需要参数。\n用法：${slashMatch.entry.usage}`)
        return
      }

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
      // 每条助手回复都预先挂一棵空事件树：标准 Agent / 蜂群的事件都长在这棵树上，
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
            title: agentMode === 'swarm' ? '蜂群执行过程' : 'Agent 执行过程'
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

      // 一次新回复：重置产物收集 / 计划镜像 / 行节点序号（执行树在 assistantMessage.trace 上逐条生长）
      swarmCollectRef.current = {}
      swarmPlanRef.current = null
      setSwarmPlan(null)
      swarmEventSeq.current = 0

      setIsStreaming(true)

      // 看门狗：模型长时间未开始回复时中止并提示。
      // 蜂群要经历 规划→工蜂(可能限流自动退避重试)→汇总，单次可能远超 60s，单独放宽。
      const stallMs = agentMode === 'swarm' ? 240_000 : 60_000
      const stallTimer = window.setTimeout(() => {
        // 已被停止/已开启新一轮回复：本次回复不再处理
        if (sendEpochRef.current !== sendId) return
        updateMessage(convId, assistantMessage.id, (m) => {
          if (m.content !== '') return m
          return {
            ...m,
            content:
              agentMode === 'swarm'
                ? '错误: 蜂群在 4 分钟内未产出任何结果。可能原因：① 接口每分钟请求数配额太低，多个工蜂并发触发了限流；② 网络/接口不稳定。建议：先在「设置 → 模型管理」测试连接，等 1 分钟后再试，或临时改用标准模式。'
                : '错误: 模型在 60 秒内未开始回复。请检查：① 网络与接口地址（「设置 → 模型管理」里可点测试连接）；② API Key 是否正确有效；③ 若仍复现，请把应用控制台/终端输出发来排查。',
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
      }, stallMs)

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
              if (chunk.startsWith(SWARM_EVENT_PREFIX)) {
                try {
                  const event = JSON.parse(
                    chunk.slice(SWARM_EVENT_PREFIX.length)
                  ) as Parameters<typeof applyTraceEvent>[2]
                  applyTraceEvent(convId, assistantMessage.id, event)
                } catch {
                  // 忽略无法解析的行程
                }
                return
              }
              fullContent += chunk
              updateMessage(convId, assistantMessage.id, (m) => ({ ...m, content: fullContent }))
            },
            agentMode
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
            agentMode === 'swarm'
              ? '你是 Mimir 蜂群模式的编排 Agent。拆解复杂任务并委派给子 Agent 协作完成。使用中文回复。'
              : '你是 Mimir，一个以 Agent 为核心的科研助手。使用中文回复，保持专业且友好的语气。'
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
        // 蜂群：把各子 Agent 的最终产出挂到该气泡的折叠区（执行树已内嵌在气泡上方）
        if (agentMode === 'swarm') {
          const sections = Object.values(swarmCollectRef.current)
            .filter(
              (row): row is SwarmRow & { text: string } =>
                row.id !== 'scheduler' &&
                row.id !== 'aggregate' &&
                row.id !== 'main' &&
                row.status === 'done' &&
                typeof row.text === 'string' &&
                row.text.trim() !== ''
            )
            .map((row) => ({ label: row.title, text: row.text }))
          if (sections.length > 0) {
            updateMessage(convId, assistantMessage.id, (m) => ({ ...m, swarmSections: sections }))
          }
        }
        updateMessage(convId, assistantMessage.id, (m) => ({ ...m, isStreaming: false }))
        setIsStreaming(false)
      }
    },
    [isStreaming, activeConvId, updateMessage, agentMode, slashEntries, applyTraceEvent]
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
    const newConv = makeWelcomeConversation(agentMode)
    setConversations((prev) => [newConv, ...prev])
    setActiveConvId(newConv.id)
  }, [agentMode])

  const handleDeleteConv = useCallback(
    (id: string) => {
      setConversations((prev) => {
        const filtered = prev.filter((c) => c.id !== id)
        if (filtered.length === 0) {
          // 保留至少一个会话，避免空状态
          const fresh = makeWelcomeConversation(agentMode)
          setActiveConvId(fresh.id)
          return [fresh]
        }
        if (activeConvId === id) {
          setActiveConvId(filtered[0]?.id || '')
        }
        return filtered
      })
    },
    [activeConvId, agentMode]
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

  const toggleMode = useCallback((mode: AgentMode) => {
    setAgentMode(mode)
    setShowModeMenu(false)
  }, [])

  const currentMode = MODE_CONFIG[agentMode]
  const ModeIcon = currentMode.icon

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
            {/* Mode selector */}
            <div className="relative" ref={modeMenuRef}>
              <button
                onClick={() => setShowModeMenu(!showModeMenu)}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
                  agentMode === 'swarm'
                    ? 'bg-amber-500/10 text-amber-600 hover:bg-amber-500/15'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                )}
              >
                <ModeIcon className="h-3.5 w-3.5" />
                {currentMode.label}
                <ChevronDown className={cn('h-3 w-3 transition-transform', showModeMenu && 'rotate-180')} />
              </button>
              {showModeMenu && (
                <div className="absolute right-0 top-full mt-1 z-50 w-52 rounded-md border border-border bg-popover shadow-md">
                  {(Object.keys(MODE_CONFIG) as AgentMode[]).map((mode) => {
                    const cfg = MODE_CONFIG[mode]
                    const Icon = cfg.icon
                    return (
                      <button
                        key={mode}
                        onClick={() => toggleMode(mode)}
                        className={cn(
                          'flex w-full items-start gap-2.5 px-3 py-2.5 text-left text-[12px] transition-colors',
                          agentMode === mode
                            ? 'bg-primary/5 text-primary'
                            : 'hover:bg-accent'
                        )}
                      >
                        <Icon className={cn('h-4 w-4 mt-0.5 shrink-0', mode === 'swarm' ? 'text-amber-500' : 'text-muted-foreground')} />
                        <div>
                          <div className="font-medium">{cfg.label}</div>
                          <div className="text-[10px] text-muted-foreground mt-0.5">{cfg.description}</div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

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
              <div
                key={message.id}
                ref={(el) => {
                  messageRefs.current[message.id] = el
                }}
                onClick={() => scrollToMessage(message.id)}
                className="group/message cursor-pointer rounded-lg transition-colors"
                title="点击跳转到此消息"
              >
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
        <ChatInput onSend={handleSend} onStop={handleStop} entries={slashEntries} disabled={isStreaming} isStreaming={isStreaming} agentMode={agentMode} />
      </div>

      {/* Right Sidebar - Conversation list */}
      <RightSidebar
        collapsed={rightSidebarCollapsed}
        onToggle={onToggleRightSidebar}
        headerActions={
          <Button onClick={handleNewChat} variant="ghost" size="sm" className="h-7 text-[11px]">
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
