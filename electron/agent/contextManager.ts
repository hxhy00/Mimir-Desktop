/**
 * 会话上下文治理（主进程侧）。
 *
 * ── 为什么下沉到主进程 ────────────────────────────────────────────────────
 * 这段逻辑原先长在 `src/components/chat/ChatView.tsx`（渲染层，约 250 行）：
 * 滑动窗口、分段摘要压缩、压缩熔断、原文归档、失效对象提醒、压缩后能力声明重建。
 * 放在渲染层有三个问题：
 * 1. 渲染进程是 UI 进程，却要跑 LLM 压缩调用与 store 读写（重活占 UI 线程）；
 * 2. 治理逻辑与组件耦合在同一个文件里，无法被单测覆盖、无法被其它入口（CLI / 未来 API）复用；
 * 3. 事件（工具调用/返回）在主进程产生，主进程天然知道 conversationId，却要把
 *    「从事件里识别破坏性操作」这件事绕一圈交给渲染层做。
 *
 * 现在：**治理全部在主进程完成**，渲染层只把「原始历史 + 会话 id + 技能目录」传进来。
 *
 * ── 阈值口径：token，不再是字符 ──────────────────────────────────────────
 * 旧实现用 `MAX_CONTEXT_CHARS = 60_000`（字符数）判超限。但字符↔token 的换算随语言剧烈变化：
 * 中文约 1 字符 ≈ 0.6~1 token，英文约 4 字符 ≈ 1 token，代码更不均匀。同一份「6 万字符」
 * 对中文可能是 4~6 万 token，对英文只有 1.5 万 token——阈值等于形同虚设：
 * 要么中文会话被网关拒绝，要么英文会话白白浪费预算、压缩触发时机完全错位。
 * 因此本模块的所有阈值都以 **token** 计量，真实计数由 {@link setTokenCounter} 注入的
 * tokenizer 提供（见 `electron/agent/tokenizer.ts`）。
 *
 * 阈值取值：以「CJK 为主的混合会话」为基准，使触发点与旧的 6 万字符大致同量级，
 * 同时不再让英文会话超支 4 倍。数值集中在文件顶部，便于按模型上下文窗口调整。
 *
 * ── 存储约定 ──────────────────────────────────────────────────────────────
 * 全部走项目既有的空间层 store（`getStoreValue` / `setStoreValue`，同步 API）：
 * - `chat:reminders:<convId>`   —— 失效对象提醒（跨轮、跨重启保留）
 * - `chat:archive:<convId>`     —— 被压缩掉的旧轮原文（供回看，不回灌模型）
 * - `chat:compressFail:<convId>` —— 压缩连续失败计数（熔断依据）
 * 压缩是异步（要等 LLM），期间用户可能切换科研空间；写回前用 {@link currentSpaceEpoch}
 * 校验空间代际，避免把旧空间数据写进新空间。
 */
import { getStoreValue, setStoreValue, currentSpaceEpoch, assertSpaceUnchanged } from '../library/store'
import { loadCapabilityDomains } from './capabilityDomains'

// ─────────────────────────── 阈值（单位：token） ───────────────────────────

/**
 * 上下文超限阈值：历史 token 总数超过它就触发压缩。
 * 旧值等效 60_000 字符；按 CJK 混合会话约 1 token/字折算到同一量级。
 */
const MAX_CONTEXT_TOKENS = 32_000
/** 压缩后仍保留的「最近原文窗口」token 数（约等于旧 32_000 字符）。 */
const KEEP_TAIL_TOKENS = 16_000
/**
 * 单次压缩请求的最大 token 数：超长一次调用易被网关拒绝/超时，分段压缩提高成功率。
 * 旧值等效 8_000 字符。
 */
const COMPRESS_CHUNK_TOKENS = 4_000
/** 同一会话连续压缩失败熔断阈值：达到后本轮直接截断窗口，不再烧 token 重试。 */
const COMPRESS_FAIL_LIMIT = 3
/** 失效提醒保留上限（条）。 */
const REMINDER_LIMIT = 20
/** 归档保留上限（段）。旧实现无上限，长会话会把 store 撑大，这里补一个上限。 */
const ARCHIVE_LIMIT = 50
/** 读取失效提醒时注入的最近条数。 */
const REMINDER_INJECT_LIMIT = 8

// ─────────────────────────── 存储键 ───────────────────────────

export const REMINDER_STORE_PREFIX = 'chat:reminders:'
export const HISTORY_ARCHIVE_PREFIX = 'chat:archive:'
export const COMPRESS_FAIL_PREFIX = 'chat:compressFail:'

// ─────────────────────────── 类型 ───────────────────────────

export type HistoryRole = 'user' | 'assistant'

/** 参与上下文的历史消息（只有 user/assistant 正文，不含工具产物与附件全文）。 */
export interface HistoryMsg {
  role: HistoryRole
  content: string
}

/** 技能目录条目（渲染层 slash 目录的子集：触发词 + 标题）。 */
export interface SkillRef {
  trigger: string
  title: string
}

/** 结构化摘要器返回。 */
export interface CompressResult {
  ok: boolean
  summary?: string
  message?: string
}

/** 摘要器：把一段较早历史压成要点（由 AgentService 注入，内部走 LLM）。 */
export type Compressor = (chunk: HistoryMsg[]) => Promise<CompressResult>

/** 治理输入。 */
export interface GovernanceInput {
  conversationId: string
  /** 本会话原始历史（渲染层按时间顺序给出，不含本轮正在生成的消息）。 */
  messages: readonly HistoryMsg[]
  /** 技能目录（用于压缩后重建能力声明；缺省则只声明能力域）。 */
  skills?: readonly SkillRef[]
  /** 摘要器。 */
  compress: Compressor
}

/** 治理产出。 */
export interface GovernanceOutcome {
  /** 最终要发给模型的（前置提醒 + 摘要 + 尾窗口）。 */
  history: HistoryMsg[]
  /** 本轮是否真正发生了压缩。 */
  compressed: boolean
  /** 治理后的 token 估算（供日志与 Ultra 预算判断）。 */
  tokens: number
  /** 本轮是否因熔断/压缩全失败而走了截断降级。 */
  truncated: boolean
}

/** 工具事件的最小形状（与 AgentWorkerEvent 兼容，避免反向依赖）。 */
export interface ToolEventLike {
  taskId: string
  title: string
  status: string
  kind?: string
  text?: string
  /**
   * 结构化步骤（由 `agentService` 的 `run.toolCalls` 出口填充）。
   *
   * 识别「对象已失效」**必须用它**，不要再去解析 `text` 里的文案：历史上这里靠
   * `text.indexOf(' 返回：')` 切分工具名与返回内容 —— 只要有人改一句事件文案，
   * 失效提醒就会**静默失效**（不报错，只是不再登记）。
   */
  step?: {
    name: string
    stage: 'call' | 'result' | 'error'
    resultSummary?: string
  }
}

// ─────────────────────────── token 计数接缝 ───────────────────────────

/**
 * 真实 tokenizer 的注入点。
 *
 * 用接缝而不是直接 import，是因为：① tokenizer 包（WASM/纯 JS）在个别打包环境加载可能失败，
 * 这里必须有确定性兜底；② 便于单测注入确定性计数器。
 * AgentService 初始化时调用 {@link setTokenCounter} 注入 `electron/agent/tokenizer.ts` 的实现。
 */
type TokenCounter = (text: string) => number

let tokenCounter: TokenCounter = estimateTokensByChars

/** 注入真实 tokenizer；传 null 恢复字符估算兜底。 */
export function setTokenCounter(counter: TokenCounter | null): void {
  tokenCounter = counter ?? estimateTokensByChars
}

/** 计一段文本的 token 数（未注入 tokenizer 时走字符估算）。 */
export function countContextTokens(text: string): number {
  return tokenCounter(text)
}

/**
 * 兜底估算（仅在 tokenizer 不可用时使用）：
 * CJK 字符约 1 token/字（cl100k/o200k 系列对汉字的实际密度），其余约 1 token/4 字符。
 * 比旧的「一律按字符数」准确得多，但仍是估算——正常路径不该走到这里。
 */
function estimateTokensByChars(text: string): number {
  if (text === '') return 0
  let cjk = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (
      (code >= 0x2e80 && code <= 0x9fff) || // CJK 部首/汉字
      (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容汉字
      (code >= 0xff00 && code <= 0xffef) || // 全角符号
      (code >= 0x3040 && code <= 0x30ff) || // 日文假名
      (code >= 0xac00 && code <= 0xd7af) // 韩文
    ) {
      cjk += 1
    }
  }
  return cjk + Math.ceil((text.length - cjk) / 4)
}

// ─────────────────────────── 失效对象提醒（主进程侧） ───────────────────────────

/** 破坏性动作特征词：命中则认为会话内对象可能已失效（删除/改名/覆盖等）。 */
const DESTRUCTIVE_ACTION_RE = /(删除|移除|改名|重命名|覆盖|清除|回退)/

/**
 * 从一次工具事件中抽取「对象已失效」提醒文本；非破坏性完成事件返回 null。
 * 工具事件在主进程产生，因此识别动作留在这里，不再绕渲染层。
 */
export function reminderTextFromEvent(event: ToolEventLike): string | null {
  if (event.kind !== 'tool' || event.status !== 'done') return null
  // 只认结构化字段（见 ToolEventLike.step 的说明）：不再解析 text 文案。
  const step = event.step
  if (step === undefined || step.stage !== 'result') return null
  const out = (step.resultSummary ?? '').replace(/\s+/g, ' ').trim()
  if (!DESTRUCTIVE_ACTION_RE.test(out)) return null
  const note = out.length > 60 ? `${out.slice(0, 60)}…` : out
  const clock = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return `${step.name} 于 ${clock} 执行后：${note}（若相关对象已被删除/改名/覆盖，后续请忽略其旧描述）`
}

/** 观察一条工具事件：命中破坏性动作就把失效提醒写入该会话（尽力而为，绝不抛错）。 */
export function observeToolEvent(conversationId: string, event: ToolEventLike): void {
  const text = reminderTextFromEvent(event)
  if (text === null) return
  try {
    const key = `${REMINDER_STORE_PREFIX}${conversationId}`
    const prev = getStoreValue<string[]>(key) ?? []
    if (prev.length > 0 && prev[prev.length - 1] === text) return // 连续去重
    const next = [...prev, text]
    setStoreValue(key, next.length > REMINDER_LIMIT ? next.slice(next.length - REMINDER_LIMIT) : next)
  } catch (error) {
    console.warn('[context] 写入失效提醒失败：', error)
  }
}

/** 读取该会话已累积的失效提醒（最新在前，至多 N 条）。 */
function readReminders(conversationId: string): string[] {
  try {
    const list = getStoreValue<string[]>(`${REMINDER_STORE_PREFIX}${conversationId}`) ?? []
    return list.slice(-REMINDER_INJECT_LIMIT).reverse()
  } catch {
    return []
  }
}

/**
 * 重置某会话的治理状态（用户执行 `/clear` 时调用）：
 * 清空失效提醒与压缩熔断计数。
 *
 * 注：`/clear` 会连归档一并清除（走 {@link purgeConversation}）。渲染层从未提供
 * 归档的回看入口，而 UI 消息列表清空后若留着旧归档，等于把「已清掉的历史」继续
 * 存在 store 里 —— 既无意义也占空间，还容易在上下文重建时被误读回来。
 */
export function resetConversation(conversationId: string): void {
  try {
    setStoreValue(`${REMINDER_STORE_PREFIX}${conversationId}`, [])
  } catch (error) {
    console.warn('[context] 重置失效提醒失败：', error)
  }
  writeFailCount(conversationId, 0)
}

/**
 * 彻底清除某会话的治理数据（用户删除该会话时调用）：
 * 除失效提醒与熔断计数外，连归档原文一并清掉——会话都没了，留档既无意义也占空间。
 */
export function purgeConversation(conversationId: string): void {
  resetConversation(conversationId)
  try {
    setStoreValue(`${HISTORY_ARCHIVE_PREFIX}${conversationId}`, [])
  } catch (error) {
    console.warn('[context] 清除会话归档失败：', error)
  }
}

// ─────────────────────────── 压缩熔断计数 ───────────────────────────

function readFailCount(conversationId: string): number {
  try {
    const n = getStoreValue<number>(`${COMPRESS_FAIL_PREFIX}${conversationId}`)
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

function writeFailCount(conversationId: string, n: number): void {
  try {
    setStoreValue(`${COMPRESS_FAIL_PREFIX}${conversationId}`, n)
  } catch (error) {
    console.warn('[context] 写入压缩熔断计数失败：', error)
  }
}

// ─────────────────────────── 能力声明（压缩后重建） ───────────────────────────

/** 内置文件工具的能力说明（由 deepagents backend 提供，不属于 WORKER_TOOL_CATALOG）。 */
const BUILTIN_FS_CAPABILITY_LINE =
  '- 内置文件工具：read_file/write_file/edit_file/glob/grep/ls/execute（写盘与读空间外路径会先弹批准卡）。'

/**
 * 压缩后能力声明（B1）。
 *
 * 上下文被压缩后，早期历史里出现过的「能力域 / 技能与指令」会一起消失，模型容易「失忆」
 * 到只记得摘要内容，从而不再主动使用对应工具或建议技能。声明**不硬编码能力清单**，
 * 而是从当前真实注册表（`capabilityDomains`，含用户自定义能力域）实时派生——
 * 这样增删能力域时声明自动同步，不会像静态常量那样漂移成幻觉来源。
 */
export function buildCapabilityDeclarationText(skills: readonly SkillRef[] = []): string {
  const { domains } = loadCapabilityDomains()
  // files 能力由内置 fs 工具说明覆盖，避免重复表述
  const named = domains.filter((d) => d.id !== 'files')
  const lines: string[] = [
    BUILTIN_FS_CAPABILITY_LINE,
    named.length > 0
      ? `- 可调用能力域：${named.map((d) => `${d.label}(${d.id})`).join('、')}。`
      : '- 可调用能力域：见系统提示词中的能力域章节。',
    skills.length > 0
      ? `- 技能与指令：${skills.map((s) => `/${s.trigger}`).join('、')}；用户以「/触发词 参数」调用时，完整说明会随该消息附带。`
      : '- 技能与指令：用户可随时以「/触发词 参数」形式调用。',
    '若任务匹配某技能或某个能力域的职责（如文献综述、查新、实验设计、回复审稿、文件产出），直接调用对应工具推进，不要因为早期记录被压缩而遗忘。'
  ]
  return lines.join('\n')
}

// ─────────────────────────── 窗口切分（token 计量） ───────────────────────────

/**
 * 断点保护：从 end 往前取一段「token 数 ≤ maxTokens」的历史，边界只落在 user 消息上，
 * 保证不把一轮问答（user+assistant）拆散——拆散会让摘要丢上下文、让尾窗口从半轮开始。
 *
 * 返回值语义（两点容易误读，特此写明）：
 * - 消费完全部条目（各条合计 ≤ maxTokens）时返回 **段首 0**；
 * - **返回原 end** 只发生在「end 的前一条自身就超过 maxTokens」时——此时无法回退哪怕一条，
 *   返回的 end 会让调用方切出空段。
 *
 * 第二种情况是调用方必须处理的：分段循环遇到空段应当停止（当前实现如此），
 * 但**不能**把它当作「摘要器失败」去累计熔断 —— 见 {@link buildGovernedHistory} 的 attempted 计数。
 *
 * @param sizes 每条历史的 token 数（与 messages 等长，预先算好避免重复计数）
 */
export function findChunkStart(
  messages: readonly HistoryMsg[],
  sizes: readonly number[],
  end: number,
  maxTokens: number
): number {
  let acc = 0
  let idx = end
  while (idx > 0) {
    const len = sizes[idx - 1] ?? 0
    if (acc + len > maxTokens) break
    acc += len
    idx -= 1
    if (messages[idx]?.role === 'user') return idx // 落在 user 边界，收束
  }
  return idx
}

/**
 * 截断保留最近 maxTokens 的历史（降级路径共用）。
 * 需要硬切单条消息时按「尾部保留」切（最近的内容更重要）。
 * @param noticeTruncated 为 true 时在队首加一条提示，告知模型更早内容被截断。
 */
export function truncateToTail(
  all: readonly HistoryMsg[],
  sizes: readonly number[],
  maxTokens: number,
  noticeTruncated: boolean
): HistoryMsg[] {
  const cut: HistoryMsg[] = []
  let budget = maxTokens
  for (let i = all.length - 1; i >= 0; i--) {
    if (budget <= 0) break
    const msg = all[i]
    const len = sizes[i] ?? countContextTokens(msg.content)
    if (len > budget) {
      // 单条超预算：按尾部截断（保留最近的正文）
      cut.unshift({ ...msg, content: tailByTokens(msg.content, budget) })
      break
    }
    budget -= len
    cut.unshift(msg)
  }
  if (noticeTruncated) {
    cut.unshift({
      role: 'assistant',
      content:
        '【注意】更早的对话历史因上下文超限且压缩多次失败而被截断，缺失部分可能影响连续性；如需关键细节请向用户确认。'
    })
  }
  return cut
}

/** 从尾部保留约 maxTokens 的文本（从尾部按行/字符回退，直到估算 token 不超预算）。 */
function tailByTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return ''
  // 先用字符比例粗切，再逐步收缩，避免对超长文本做 O(n²) 的逐字符切片
  const totalTokens = countContextTokens(text)
  if (totalTokens <= maxTokens) return text
  const ratio = maxTokens / totalTokens
  let cut = Math.max(1, Math.floor(text.length * ratio))
  let sliced = text.slice(text.length - cut)
  let guard = 0
  while (countContextTokens(sliced) > maxTokens && cut > 1 && guard < 8) {
    cut = Math.floor(cut / 2)
    sliced = text.slice(text.length - cut)
    guard += 1
  }
  return sliced
}

// ─────────────────────────── 主流程 ───────────────────────────

/**
 * 组装发送给模型的对话历史（治理总入口）。
 *
 * 顺序：
 * 0) 前置本会话的「失效对象提醒」（防止跨轮复述已删除/改名对象的旧描述）；
 * 1) token 总量 ≤ {@link MAX_CONTEXT_TOKENS} → 原样返回（并在有余量时重置熔断计数）；
 * 2) 超限 → 从最新往旧**逐段**压缩（每段 ≤ {@link COMPRESS_CHUNK_TOKENS}，段级熔断），
 *    摘要置于队首，随后拼接能力声明（B1）与最近原文窗口（断点落在 user 边界）；
 * 3) 压缩全失败 / 会话级熔断已打开 → 降级为「只保留最近窗口」并在队首提示已截断。
 *
 * 被压缩原文归档到 `chat:archive:<convId>` 供回看，不回灌模型。
 * 本函数不抛错：任何治理失败都降级为「原样或截断返回」，绝不阻断用户发送。
 */
export async function buildGovernedHistory(input: GovernanceInput): Promise<GovernanceOutcome> {
  const { conversationId, messages, skills = [], compress } = input
  const reminders = readReminders(conversationId)
  const reminderMsgs: HistoryMsg[] = reminders.map((text) => ({ role: 'assistant', content: text }))
  const all: HistoryMsg[] = [...reminderMsgs, ...messages]
  const sizes = all.map((m) => countContextTokens(m.content))
  const total = sizes.reduce((a, b) => a + b, 0)

  const plain = (tokens: number): GovernanceOutcome => ({
    history: all,
    compressed: false,
    tokens,
    truncated: false
  })

  if (all.length === 0) return { history: [], compressed: false, tokens: 0, truncated: false }

  const failCount = readFailCount(conversationId)
  if (total <= MAX_CONTEXT_TOKENS) {
    // 有余量即重置熔断计数，下次超限可重试压缩
    if (failCount > 0) writeFailCount(conversationId, 0)
    return plain(total)
  }
  if (failCount >= COMPRESS_FAIL_LIMIT) {
    const cut = truncateToTail(all, sizes, KEEP_TAIL_TOKENS, true)
    return { history: cut, compressed: false, tokens: sumTokens(cut), truncated: true }
  }

  // 找到「最近 KEEP_TAIL_TOKENS」对应的起始索引，之前部分进入压缩（断点落在 user 边界）
  let start = findChunkStart(all, sizes, all.length, KEEP_TAIL_TOKENS)
  // 尾窗口至少保留最新一条消息。
  // 若最新一条自身就超过 KEEP_TAIL_TOKENS，按 token 口径「≤ KEEP_TAIL 的后缀」只有空集，
  // findChunkStart 会返回 all.length —— 于是尾窗口为空、**连最新一轮也进入压缩**，把最相关的
  // 上下文换成摘要，损失通常大于收益。这里退化为「保留最新一条（超预算但保留原文）」，
  // 让更早的部分去承担压缩；若整段历史就只有这一条，start 归 0 → 走下面的原样返回。
  if (start >= all.length && all.length > 0) start = all.length - 1
  // 没有任何「可压缩的更早内容」（历史只有一条，或最新一条自身就占满尾窗口预算）：
  // 压缩无从下手，而**静默截断用户刚粘贴的长文**比超预算更糟，故原样返回（由网关/模型去处理长度）。
  // 注：这正是旧实现里那个**不可达分支的原始意图** —— 旧代码因 findChunkStart 的返回语义偏差
  // 永远走不到这里（见该函数文档），这里是把意图真正接通。
  if (start === 0) return plain(total)
  const head = all.slice(0, start)
  const tail = all.slice(start)

  // ── 分段压缩：从最新往旧逐段，每段独立限额 + 段级熔断 ──────────────────
  // ① 单段失败只丢该段，更旧的不再尝试（避免连环烧 token），已成功段落照常保留；
  // ② 段间边界只落在 user 消息上，不会把一轮问答拆散。
  const spaceEpoch = currentSpaceEpoch()
  const summaries: string[] = []
  let cursor = head.length
  let compressedAny = false
  let segmentFail = 0
  /** 实际提交给摘要器的段数（用于区分「摘要器失败」与「一段都没能切出来」）。 */
  let attempted = 0
  while (cursor > 0) {
    let chunkStart = findChunkStart(head, sizes, cursor, COMPRESS_CHUNK_TOKENS)
    // ── 保证分段前进 ────────────────────────────────────────────────────
    // 当边界的这一条消息**自身**就超过分段预算时，findChunkStart 会原样返回 cursor（切出空段）。
    // 旧实现就此 `break`，后果是：「历史里有一条较长消息」这种常见形态（粘论文段落、长报错、
    // 长 diff）会导致**一段都压不了**，静默退化成截断——明明更早的内容完全可压，却被整段丢掉。
    // 处理：让它独占一段，循环因此必然前进。
    //
    // ⚠️ 取舍代价（有意接受）：强制前进会让分段边界**不再只落在 user 消息上**——
    // 独占一段的那条若是 assistant 回复，它会与上文（提问）被拆到相邻两段里。即此处的
    // 「断点保护」被有意放宽。判断依据：这种情况下旧行为是**一段都不压、整段丢掉**，
    // 让摘要器拿到半轮上下文远好于让旧内容彻底消失；且该分支只在「单条超分段预算」时触发。
    //
    // 上界保护：单条超过上下文阈值的 2 倍属病态输入（整篇论文全文、百万字日志），
    // 不做强制压缩——把远超窗口的输入丢给摘要器只会白烧一次调用并超时，此时走截断降级。
    if (chunkStart === cursor) {
      if ((sizes[cursor - 1] ?? 0) > MAX_CONTEXT_TOKENS * 2) break
      chunkStart = cursor - 1
    }
    const chunk = head.slice(chunkStart, cursor)
    cursor = chunkStart
    if (chunk.length === 0) break // 防御：上面的前进保证下不应触发
    let res: CompressResult
    attempted += 1
    try {
      res = await compress(chunk)
    } catch (error) {
      res = { ok: false, message: error instanceof Error ? error.message : '摘要压缩失败' }
    }
    if (res.ok && res.summary !== undefined && res.summary.trim() !== '') {
      summaries.unshift(`【对话片段摘要】\n${res.summary.trim()}`)
      compressedAny = true
      segmentFail = 0
      archiveChunk(conversationId, chunk, spaceEpoch)
    } else {
      segmentFail += 1
      if (segmentFail >= COMPRESS_FAIL_LIMIT) break // 段级熔断：连续失败即停止继续压缩旧段
    }
  }

  if (compressedAny) {
    if (failCount > 0) writeFailCount(conversationId, 0)
    // B1：压缩后重建能力声明，避免模型「失忆」到不再使用对应工具/技能
    const head0: HistoryMsg[] = [
      { role: 'assistant', content: `【更早对话摘要（已压缩）】\n${summaries.join('\n\n')}` },
      {
        role: 'assistant',
        content: `【能力提醒（历史已压缩，此为按当前注册表生成的固定声明）】\n${buildCapabilityDeclarationText(skills)}`
      }
    ]
    const history = [...head0, ...tail]
    return { history, compressed: true, tokens: sumTokens(history), truncated: false }
  }

  // 未压缩成功，降级为「仅保留最近窗口」。
  //
  // 熔断计数只在**确实把段落提交给了摘要器、且全部失败**时才累加。
  // 修正前的缺陷：只要 `compressedAny === false` 就累加，包括「一段都没能切出来（chunk 为空
  // 立即 break）」的情况——那等于把「切不出段落」错误归因成「模型压缩失败」。后果有双重：
  // ① 连累整个会话：累积到阈值后熔断打开，之后每轮都被强制截断并注入「【注意】…被截断」；
  // ② 掩盖真因：日志现象会让人去查模型/网关，而实际问题在分段切分上。
  if (attempted > 0) writeFailCount(conversationId, failCount + 1)
  const cut = truncateToTail(all, sizes, KEEP_TAIL_TOKENS, false)
  return { history: cut, compressed: false, tokens: sumTokens(cut), truncated: true }
}

/**
 * 归档一段被压缩掉的原文（尽力而为，失败不阻塞主流程）。
 * 跨异步（压缩期间可能切空间）写回前校验空间代际。
 */
function archiveChunk(conversationId: string, chunk: HistoryMsg[], spaceEpoch: string): void {
  try {
    assertSpaceUnchanged(spaceEpoch)
    const key = `${HISTORY_ARCHIVE_PREFIX}${conversationId}`
    const prev = getStoreValue<unknown[]>(key) ?? []
    const next = [...prev, { at: new Date().toISOString(), head: chunk }]
    setStoreValue(key, next.length > ARCHIVE_LIMIT ? next.slice(next.length - ARCHIVE_LIMIT) : next)
  } catch (error) {
    // 空间已切换 / 写盘失败：归档是尽力而为，静默降级但记录日志便于排查
    console.warn('[context] 归档压缩原文失败：', error)
  }
}

/** 一段历史的 token 总量（供 Ultra 预算判断与日志）。 */
export function sumTokens(messages: readonly HistoryMsg[]): number {
  return messages.reduce((n, m) => n + countContextTokens(m.content), 0)
}

/** 当前治理阈值快照（供设置页/日志展示，避免把常量散落到调用方）。 */
export function contextLimits(): {
  maxTokens: number
  keepTailTokens: number
  compressChunkTokens: number
  failLimit: number
} {
  return {
    maxTokens: MAX_CONTEXT_TOKENS,
    keepTailTokens: KEEP_TAIL_TOKENS,
    compressChunkTokens: COMPRESS_CHUNK_TOKENS,
    failLimit: COMPRESS_FAIL_LIMIT
  }
}
