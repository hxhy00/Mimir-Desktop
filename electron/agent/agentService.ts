import { AsyncLocalStorage } from 'node:async_hooks'
import { createDeepAgent } from 'deepagents'
import { ChatOpenAI } from '@langchain/openai'
import { tool } from 'langchain/tools'
import { z } from 'zod'
import { loadMemoryTool } from './tools/memory'
import { getStoreValue } from '../library/store'
import { loadSkillRegistry } from './skills'
import { candidatesToContext, routeSkills, SKILL_TOP_K } from './skillRouter'
import type { RouterCandidate } from './skillRouter'
import { isEmbeddingUnavailable, rerankByEmbedding, type EmbeddingConfig } from './embeddingRerank'
import { extractArtifacts, type ArtifactRef } from './artifactExtract'
import { basename, extname, resolve } from 'path'
import {
  loadCapabilityDomains,
  buildCapabilityDomainPrompt,
  buildDomainSubagents,
  resolveAllWorkerTools,
  WORKER_TOOL_CATALOG,
  BUILTIN_DOMAINS
} from './capabilityDomains'
import { MimirFsBackend } from './fsBackend'
import { createLanguageMiddleware } from './languageMiddleware'
import {
  initializeOtelFromCurrentConfig,
  withAgentTurnContext,
  startAgentTurnSpan,
  endAgentTurnSpan,
  failAgentTurnSpan
} from './otelTrace'
import { withApprovalSource, type ApprovalSource } from './approval'
import { assertNoDelegationTools, guardSubagentTools } from './delegationFirewall'
import {
  SUBAGENT_RETURN_CONTRACT,
  SINGLE_AGENT_EXECUTION_DISCIPLINE
} from './subagentResult'
import {
  buildGovernedHistory,
  observeToolEvent,
  purgeConversation,
  resetConversation,
  sumTokens,
  type HistoryMsg,
  type SkillRef
} from './contextManager'
import { UltraController, type UltraStrategyPick } from './ultra'
import { pickStructuredMethod } from './gatewayProbe'
import { humanizeAgentError, truncateSummary } from './agentText'
import type { AgentStreamEventDraft } from './streamProtocol'
import { agentLog } from '../logger'

// Ultra 增强层的公开面从 ultra.ts 转出（实现已迁至该模块，见其文件头说明），
// 保持既有引用点（IPC / 测试 / 未来入口）无需改动。
export { ULTRA_STRATEGY_META, ULTRA_STRATEGY_IDS, pickUltraStrategy } from './ultra'
export type { UltraStrategy, UltraStrategyPick, ScExpertId } from './ultra'

/** 单 Agent 模式：一个 Agent 直接持有全部科研工具，自己规划、调用、整合。
 *  工具的调用/返回/出错会以事件外发，渲染层在事件树中展示（按能力域打标签分组）。
 *
 *  ── 上下文治理「不入链清单」（实现见 electron/agent/contextManager.ts）─────────
 *  1. SC 多专家合议的 K 路候选/聚合/反思原文：只进事件树，绝不写入持久会话历史；
 *     反思纪要仅在单轮内参与 finalMessage 拼装。
 *  2. 工具返回（搜索/编译/实验等 ToolMessage）：当轮图内消费即弃，不沉淀为长期上下文。
 *  3. 文档/文献/Wiki 全文：只经 library_search / wiki_search 等检索工具取片段，不复制整库进 prompt。
 *  4. 会话历史由渲染层作为**原文** options.history 传入，主进程 contextManager 统一做
 *     滑动窗口 + 摘要压缩 + 熔断（见 M2 的收敛实现）；历史中的附件只保留引用，
 *     不把附件全文随历史重复注入。
 *  5. 永久层身份常量（见 M5）：主进程每轮从 settings.identity 合成一条前置 system 消息，
 *     恒定在场但不进入渲染层持久历史，不参与压缩/归档；默认未配置时零注入。 */

/** Agent 执行过程事件（渲染层顶部状态条与进程日志/事件树用）。 */
export interface AgentWorkerEvent {
  /** 稳定标识：主 Agent 直调的工具事件统一为 'main'；阶段事件为 'phase:*'（如 phase:routing、phase:context）；
   *  委派子代理的阶段节点为 `subagent:<能力域 id>`；Ultra 为 'ultra'。
   *  **主 Agent 直调时能力域语义写在事件 text 的 `[能力域]` 前缀里**，不要按「一个能力域一个 taskId」理解；
   *  只有发生委派时才会出现独立的 `subagent:*` 节点。 */
  taskId: string
  /** 展示标题：节点名 / 阶段名。 */
  title: string
  status: 'running' | 'done' | 'error'
  /** done 时为该任务产物文本；error 时为错误说明；tool/think 时为过程说明。 */
  text?: string
  /** 工具执行耗时（毫秒），由 withToolTrace 在调用返回/出错时填充。 */
  durationMs?: number
  /** 行类别：task=Agent 主流程节点，tool=工具调用，think=推理文本（缺省视为 task）。 */
  kind?: 'phase' | 'task' | 'tool' | 'think' | 'think-token'
  /** 工具返回中识别出的落盘产物（渲染层在气泡下渲染验收卡）。 */
  artifacts?: ArtifactRef[]
  /**
   * **结构化步骤**：一次工具调用的 `调用/返回/出错` 共享同一 `callId`。
   *
   * 为什么必须有它（而不是继续靠 `text` 里的中文文案）：历史上渲染层判断"这行是调用还是
   * 返回"用的是 `text.startsWith('调用')`、统计工具次数也是同一招；`contextManager` 的
   * 失效提醒则靠 `text.indexOf(' 返回：')` 切分工具名与返回内容。**只要有人改一句文案，
   * 这些逻辑就会静默失效**（调用被当返回、统计归零、失效提醒不再登记）。
   * 因此语义必须落在字段上：谁调用的、调用的哪个工具、处于哪个阶段、参数与结果分别是什么。
   */
  step?: {
    /** 同一次工具调用的三个事件共享它，渲染层据此把「调用+返回」配成一行。 */
    callId: string
    /** 工具名（如 `write_file`、`paper_search`；内置文件工具同样在这里）。 */
    name: string
    /** 能力域展示标签（如「文献」「论文」），未登记时为 undefined。 */
    label?: string
    stage: 'call' | 'result' | 'error'
    /** 参数摘要（已截断，供人读）。 */
    argsSummary?: string
    /** 返回内容摘要（已截断，供人读）/ 出错文案。 */
    resultSummary?: string
    /** 文件动作（内置文件工具才有）：时间线据此显示「写入 model.py +387」。 */
    file?: StepFileAction
    /** 命令行（execute 工具才有）：时间线据此显示「运行 <命令>」并可展开完整命令。 */
    command?: string
    /**
     * 该步骤的执行者：`main` = 主 Agent 直接调用；`subagent` = 委派给能力域子代理后，
     * 由子代理内部调用。渲染层据此把子代理的步骤折叠到「委派」节点下，与主 Agent 步骤区分。
     */
    origin?: 'main' | 'subagent'
    /** 子代理标识（能力域 id，如 `literature`）；仅 origin='subagent' 时存在。 */
    subagentId?: string
    /** 子代理展示名（能力域 label，如「文献」）；仅 origin='subagent' 时存在。 */
    subagentLabel?: string
  }
  /**
   * 内部工程阶段标记。渲染层据此**默认隐藏**这类步骤（用户关心 Agent 做了什么，
   * 不关心技能路由、上下文压缩这些实现细节）。
   */
  phase?: 'context' | 'routing' | 'main' | 'ultra'
}

/**
 * 技能与指令目录（追加进 systemPrompt）。
 * 渲染层输入框以 `/trigger 参数` 触发时会把完整执行说明随消息带入；
 * 这里只维护一份轻量目录，让模型在自然语言请求命中时也知道按对应框架走。
 * 触发词/说明需与 src/lib/slash/registry.ts 保持一致。
 */
/**
 * 正文增量的攒批参数（发送侧）。
 *
 * 逐 token 外发会退化为每 token 一次 `webContents.send`，在渲染进程主线程繁忙时于 IPC
 * 投递层被静默丢弃（实测主进程 242 发 / preload 仅 10 收）。攒批把外发次数压到每轮 ~10 次量级。
 * - 时间阈值取 50ms：约 20fps，肉眼仍为「逐字」观感，同时远低于丢包发生的高频区间。
 * - 字符阈值取 200：长文本时不等满时间片即冲，避免大段延迟。
 */
const TEXT_FLUSH_MS = 50
const TEXT_FLUSH_CHARS = 200

const SLASH_CATALOG_TEXT = `## 技能与指令

Mimir 提供一组科研「技能」与「指令」，用户在输入框以 / 前缀调用（例：/research-lit-review 多智能体可靠性）。当消息以已知的 / 触发词开头时，完整执行说明会随该消息附带，你必须严格按其中的步骤、门禁与硬规则执行。这些触发词也可以自然语言的方式被提出——此时同样按对应技能的框架推进：

指令（/ + 触发词）：
- /research-idea <研究方向> — 从文献出发的科研开题：检索→paper_fetch 落库→产出想法报告
- /research-plan [课题|说明] — 把课题拆成可验证的实验方案与假设清单
- /paper-write [主题|说明] — 起草 LaTeX 论文：骨架→逐节内容→参考文献纪律（编译由用户在「论文」模块配合）
- /paper-compile [项目目录] — 把用户粘贴的 LaTeX 编译日志解析成修复清单
- /research-review <评审重点> — 对用户粘贴内容做 PASS/WARN/FAIL 评审

技能（/ + 触发词）：
- /research-pipeline [课题] — 全流程管线：开题→查新→综述→方案→实验→结论→写作→评审
- /research-lit-review <方向> — 文献综述：并行 paper_search/web_search，逐篇入文献库并写解读
- /research-novelty-check <想法> — 查新门：机制/应用/结果三路检索，判 已有/相邻/新颖
- /research-experiment-plan [课题] — 实验设计：假设→claim 映射的运行序列与预算
- /research-result-to-claim [结果] — 结果到结论门：证据支撑/否定/悬置的判定
- /research-paper-drafting [方向] — 论文逐节起草（编译循环由用户在「论文」模块配合）
- /research-paper-deai [文本] — 中英去 AI 味润色：公式/数字/引用逐字不动
- /research-citation-audit [文本] — 零信任引用审计：每条引用真实存在且被需要
- /research-rebuttal [审稿意见] — 回复审稿：拆解原子问题，证据优先
- /research-figure-plan [说明] — 论文配图规划：结论句图注 + 可复现产出
- /research-meeting-deck [主题] — 组会汇报材料组织（.pptx 由「组会」模块生成）

通用纪律：只断言有证据支撑的结论；本地文件的读取与写入已由「文件」能力域 (files) 提供（在其明确掌握用户给出的路径后），LaTeX 编译 / 图片落盘 / PPT 生成仍主要在对应模块由用户在 GUI 里执行；对尚不具备的能力不要假装已经执行。`

/**
 * 主 Agent 系统提示（双轨：主 Agent 直调 + 可选委派）。
 *
 * 架构现状：主 Agent 直接持有全部科研工具，可自己规划、调用、整合；同时也持有
 * deepagents 注入的 `task` 工具，可以把某个能力域内的整块多步工作委派给对应子代理。
 * 这与 CodeBuddy / WorkBuddy / Trae 的默认形态一致（主 Agent 自主决定是否委派）。
 *
 * 与旧 Supervisor 形态的差别：**主 Agent 持有全部工具**（不被切分成「只会委派的空壳」），
 * 委派是可选优化而非唯一路径 —— 简单任务直接做，复杂可独立交付的整块工作才委派。
 *
 * 提示词由 {@link buildCapabilityDomainPrompt} 在构建期把各能力域的工具使用纪律
 * 拼进来（见 initialize），让主 Agent 同时知道「这类任务自己用什么工具」与
 * 「有哪些能力域可以委派」。
 */
const SINGLE_AGENT_SYSTEM = `你是 Mimir，一个以 Agent 为核心的科研助手，运行在桌面科研工作台中。你直接持有全部科研工具，自己规划、自己执行：理解用户意图 → 制定计划 → 调用合适的工具 → 整合结果给出最终回复。

工作原则：
- 使用中文回复，保持专业且友好的语气；
- **语言一致性（硬规则）**：所有面向用户的文字——包括工具调用之间的过程叙述、计划说明、进度更新与错误解释——必须与「交流语言」一致（默认中文），禁止中英混杂的旁白（如 "Let me check..." / "Now I'll..."）。专有名词、代码标识符、论文标题等保留原文即可；
- 先规划再执行：需要工具或专业能力时直接调用对应工具（可连续多次调用、多个工具接力完成一个复杂任务），不要在未实际调用工具的情况下声称已经执行了某项能力；工具返回后整理去重、标注来源，输出完整且对用户可读的最终回答，不凭空添加事实；
- 简单的对话、概念解释、文本润色/改写、对用户粘贴内容的分析等不需要工具的任务，直接完成，不必调用工具；
- 涉及写盘/长耗时/生成产物等副作用时，相关工具会先向用户弹「批准卡片」，请等待用户确认后再继续；用户拒绝就如实说明并停下，不要绕路重试；
- 长期记忆（load_memory，只读工具）：当任务与用户的长期研究方向/常用约束/常用事实相关时才按需调用，不要默认请求每次加载；档案为空时不要臆造用户偏好；
- 每条消息可能附带一段「可选技能候选」：当其中某技能与该请求匹配时，按它的流程执行；不匹配就忽略，保持常规工作方式，不要编造候选之外的技能；${SUBAGENT_RETURN_CONTRACT}${SINGLE_AGENT_EXECUTION_DISCIPLINE}`

/** ── Skill 分层路由（每轮 Meta-Cognition + 规则粗召回 + 可选 LLM 精排）──────── */
const ROUTE_META_SCHEMA = z.object({
  intents: z
    .array(z.string())
    .describe('任务意图标签（小写英文、下划线分隔），如 literature_review / scheme_evaluation / data_analysis / paper_writing / meeting / figure_plan / idea_evaluation / novelty_check / experiment_plan 等'),
  categories: z
    .array(z.enum(['research_design', 'literature', 'paper', 'analysis', 'figures', 'meeting']))
    .describe('命中的 L3 技能目录（0~3 个，越聚焦越好）'),
  complexity: z.enum(['low', 'medium', 'high']).describe('任务复杂度')
})
const ROUTE_META_SYSTEM = `你是 Mimir 的「技能路由元认知」。根据用户请求输出结构化路由信号，供技能召回精排使用（不执行任务、不调用工具；只输出 JSON，不要额外解释）：
- intents：把任务归到 1~4 个意图标签（小写英文，例如 literature_review、scheme_evaluation、data_analysis、paper_writing、idea_evaluation、novelty_check、experiment_plan、citation_audit、result_to_claim、rebuttal、figure_plan、meeting_prep、writing_polish）。
- categories：命中的技能目录（research_design 开题方案 / literature 文献 / paper 论文写作与评审 / analysis 结果分析 / figures 配图 / meeting 组会），最多 3 个。
- complexity：任务复杂度（low 单步/润色/查询；medium 需要多步或检索；high 长流程/多阶段/耗算力）。`

/** 会话历史摘要压缩系统提示（治理 Phase 1：只压 chat_history，不涉及文档库）。 */
const COMPRESS_HISTORY_SYSTEM = `你是对话历史的「结构化摘要器」。把下面一段较早的科研对话压缩成 ≤ 500 字的要点，供后续对话继续使用。必须保留：
- 用户的核心诉求与最终目标；
- 已经确认的结论 / 决策 / 关键实验参数与数值；
- 仍待办 / 仍在讨论的开放问题；
- 用户提到的硬约束（偏好、截止、不许改动等）。
丢弃寒暄与过程细节。只输出摘要正文，不要复述原文、不要加标题之外的寒暄。`

/** 单个 langchain 工具的调用面（只取包装所需的字段）。 */
interface ToolLike {
  name: string
  description?: string
  schema?: unknown
  invoke(input: unknown): Promise<unknown>
}

/** 包装工具：调用前 / 返回 / 出错三处打点（每个工具/用途实例化一份，避免并发互串）；返回/出错附带耗时（ms）。
 *  C3：可选 `source` 会把整条调用链标记为某能力域发起，使链内 `requireUserApproval` 的批准卡带上来源。 */
function withToolTrace(
  base: ToolLike,
  hooks: {
    onCall?: (name: string, args: unknown) => void
    onDone?: (name: string, out: unknown, durationMs: number) => void
    onError?: (name: string, error: unknown, durationMs: number) => void
    source?: ApprovalSource
  }
): ToolLike {
  const proxied = Object.create(base) as ToolLike
  proxied.invoke = async (input: unknown) => {
    hooks.onCall?.(base.name, input)
    const t0 = Date.now()
    const run = async () => {
      const out = await base.invoke.call(proxied, input)
      hooks.onDone?.(base.name, out, Date.now() - t0)
      return out
    }
    try {
      if (hooks.source !== undefined) return await withApprovalSource(hooks.source, run)
      return await run()
    } catch (error) {
      hooks.onError?.(base.name, error, Date.now() - t0)
      throw error
    }
  }
  return proxied
}

/**
 * 由 `taskId` 派生「内部阶段」分类（`phase` 字段）。
 *
 * 为什么需要派生而不是让每个 emit 站点自己标：`taskId` 的历史约定本身就不一致 ——
 * 技能路由同时存在 `'phase:routing'` 与 `'router'` 两种写法。把映射收在一处，
 * 渲染层就能一句话决定「哪些步骤默认隐藏」（内部工程阶段），不必去认这些前缀。
 *
 * 显式带了 `phase` 的事件以显式值为准（新代码可以更精确地标注）。
 */
export function withPhase(event: AgentWorkerEvent): AgentWorkerEvent {
  if (event.phase !== undefined) return event
  const id = event.taskId
  const phase: AgentWorkerEvent['phase'] =
    id === 'main'
      ? 'main'
      : id === 'phase:context'
        ? 'context'
        : id === 'phase:routing' || id === 'router'
          ? 'routing'
          : id === 'ultra'
            ? 'ultra'
            : undefined
  return phase === undefined ? event : { ...event, phase }
}

/** 文件动作的结构化描述（时间线用它渲染「写入 model.py +387」）。 */
export interface StepFileAction {
  path: string
  action: 'read' | 'write' | 'edit' | 'delete'
  /** 新增行数（write / edit 可得）。 */
  added?: number
  /** 移除行数（edit 可得）。 */
  removed?: number
  /** edit 的具体改动内容（供时间线展开渲染红绿 diff；过长由渲染层截断）。 */
  oldString?: string
  newString?: string
}

/**
 * 从 Agent 最终状态里取最后一条 AI 消息的纯文本（对账用第二来源）。
 *
 * 为什么需要它：`run.messages` 的流式累计是「主进程自己算的」，它只能证明链路一致，
 * 无法证明「模型本该说更多」。`run.output` 是 Agent 的最终状态，独立于流，可用来判定
 * 「流被截断」还是「模型只说这么多」。content 兼容 string / 分块数组两种形态。
 */
async function extractFinalAiText(
  output: Promise<{ messages?: Array<{ content?: unknown }> }> | undefined
): Promise<string> {
  if (output === undefined) return ''
  try {
    const state = await output
    const msgs = state?.messages
    if (!Array.isArray(msgs) || msgs.length === 0) return ''
    const last = msgs[msgs.length - 1]
    const content = last?.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === 'string') return part
          if (typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string') {
            return (part as { text: string }).text
          }
          return ''
        })
        .join('')
    }
    return ''
  } catch {
    return ''
  }
}

/**
 * 从工具入参派生「文件动作」信息。
 *
 * 只做**结构性提取**（读 `file_path` / `path` 与内容字段），不做任何文案推断 ——
 * 内置文件工具的入参是固定 schema，因此这是可靠的一手信息。
 *
 * 为什么不区分「新建 / 覆盖」：`WriteResult` 只返回 `error` 与 `path`，**没有新建标志**
 * （见 deepagents 的 WriteResult 定义）。宁可不报，也不猜一个可能错的结论。
 */
export function fileActionOf(toolName: string, input: unknown): StepFileAction | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const rec = input as Record<string, unknown>
  const path =
    typeof rec.file_path === 'string' ? rec.file_path : typeof rec.path === 'string' ? rec.path : ''
  if (path === '') return undefined
  const lineCount = (v: unknown): number | undefined =>
    typeof v === 'string' && v !== '' ? v.split('\n').length : undefined
  switch (toolName) {
    case 'write_file': {
      const added = lineCount(rec.content)
      return { path, action: 'write', ...(added !== undefined ? { added } : {}) }
    }
    case 'edit_file': {
      const added = lineCount(rec.new_string)
      const removed = lineCount(rec.old_string)
      return {
        path,
        action: 'edit',
        ...(added !== undefined ? { added } : {}),
        ...(removed !== undefined ? { removed } : {}),
        ...(typeof rec.old_string === 'string' ? { oldString: rec.old_string } : {}),
        ...(typeof rec.new_string === 'string' ? { newString: rec.new_string } : {})
      }
    }
    case 'delete':
    case 'rm':
      return { path, action: 'delete' }
    case 'read_file':
      return { path, action: 'read' }
    default:
      return undefined
  }
}

/**
 * 命令动作：`execute` 工具（入参 `{ command }`）的命令行提取。
 * 时间线据此显示「运行 <命令>」并可展开看完整命令，而不是只显示一个笼统的工具名。
 */
export function commandActionOf(toolName: string, input: unknown): string | undefined {
  if (toolName !== 'execute') return undefined
  if (typeof input !== 'object' || input === null) return undefined
  const cmd = (input as Record<string, unknown>).command
  return typeof cmd === 'string' && cmd.trim() !== '' ? cmd : undefined
}

/**
 * 按 baseUrl 判断是否可安全开启思考模式（`thinking` 参数）。
 *
 * 目前只有**官方 DeepSeek 端点**经实测确认支持：官方 `deepseek-flash` 在
 * `thinking:{type:'enabled'}` 下会返回 `reasoning_content`，并被 deepagents
 * 投影为 `msg.reasoning`。第三方 OpenAI 兼容代理不透传该参数，故一律不开，
 * 避免未知参数引发 400（历史上对不支持的上游发未知字段确实会 400）。
 *
 * @param baseUrl 模型端点；缺省视为官方（ChatOpenAI 默认指向 api.openai.com，
 *   而本项目默认走 DeepSeek 官方，两者均支持思考模式）。
 */
export function autoReasoningFor(baseUrl?: string): boolean {
  if (baseUrl === undefined || baseUrl.trim() === '') return true
  const host = baseUrl.toLowerCase()
  return host.includes('api.deepseek.com') || host.includes('api.openai.com')
}



export interface AgentConfig {
  apiKey: string
  model: string
  baseUrl?: string
  /** Skill 精排用的 embedding 模型名（复用 apiKey/baseUrl）；缺省用内置默认值。 */
  embeddingModel?: string
  /**
   * 是否开启「思考模式」（推理内容经 `run.messages[].reasoning` 投影逐字外发）。
   *
   * 只有**支持该参数的上游**才能开：实测
   * - 官方 `https://api.deepseek.com` + `deepseek-flash`：开 `thinking` 后
   *   `reasoning_content` 有内容（deepagents 侧拿到 ~500 字符）；
   * - 第三方 OpenAI 兼容代理：多数不透传 `thinking`，发了也拿不到 reasoning，
   *   部分实现甚至会因未知参数直接 400。
   *
   * 缺省 undefined = 由 {@link autoReasoningFor} 按 baseUrl 判断（仅官方端点自动开启）。
   */
  reasoning?: boolean
}

/** deepagents v3 流里一次工具调用的可读字段（字段名按 SDK 文档，已实测确认）。 */
interface ToolCallStream {
  name?: string
  /** 结构化入参（对象，非字符串）。 */
  input?: unknown
  /** 返回值（Promise）；调用失败时 reject。 */
  output?: unknown
  /** 调用状态 —— 注意 SDK 给的是 **Promise**（未 await 前是 pending），不是字符串。 */
  status?: unknown
}

/**
 * `agent.streamEvents(..., { version: 'v3' })` 的返回面（弱化 deepagents 强泛型差异）。
 *
 * 抽成具名类型是为了让 `collectToolEvents` / `collectSubagentEvents` 两个采集方法
 * 能独立声明入参——它们与 `messages` 并发迭代同一份 `run`，互不阻塞。
 */
interface StreamRun {
  messages: AsyncIterable<{ text: AsyncIterable<string>; reasoning?: AsyncIterable<string> }>
  /** 结构化工具调用流，覆盖全部工具（含 deepagents 内置文件工具）。 */
  toolCalls?: AsyncIterable<ToolCallStream>
  /** 委派子代理流：仅当主 Agent 调用 `task` 时才会产生元素。 */
  subagents?: AsyncIterable<{
    name?: string
    toolCalls?: AsyncIterable<ToolCallStream>
    messages?: AsyncIterable<{ text: AsyncIterable<string>; reasoning?: AsyncIterable<string> }>
  }>
  /** Agent 最终状态（promise-like）：含完整 messages 数组，用于流式累计之外的对账。 */
  output?: Promise<{ messages?: Array<{ content?: unknown }> }>
}

/** AgentService 实际用到的 Agent 调用面（弱化 deepagents 的强泛型差异）。 */
interface MimirAgent {
  invoke(input: { messages: Array<{ role: string; content: string }> }): Promise<{ messages: unknown[] }>
  streamEvents(
    state: { messages: Array<{ role: string; content: string }> },
    config: { version: 'v3' }
  ): Promise<{
    messages: AsyncIterable<{ text: AsyncIterable<string>; reasoning?: AsyncIterable<string> }>
    /**
     * **结构化工具调用流，覆盖全部工具**（含 deepagents 内置文件工具
     * write_file/edit_file/read_file/ls/glob/grep/delete —— 它们不在 WORKER_TOOL_CATALOG 里，
     * 也不经过我们的工具包装器，因此过去在执行轨迹中完全不存在）。
     * 实测：可与 `messages` 并发迭代，两条投影互不阻塞。
     */
    toolCalls?: AsyncIterable<ToolCallStream>
  }>
}

export class AgentService {
  private agent: MimirAgent | null = null
  private config: AgentConfig | null = null
  /** 多专家合议：元认知判定 / 聚合 / 反思用的模型（低温、输出稳定）。 */
  private scJudgeModel: ChatOpenAI | null = null
  /** 多专家合议：并行候选生成模型（高温、增强多样性）。 */
  private scCandidateModel: ChatOpenAI | null = null
  /**
   * 本次初始化是否开启了思考模式。用于选结构化输出通道：
   * 思考开启时绝不能走 `functionCalling`（会注入 `tool_choice`，上游 400），
   * 详见 {@link pickStructuredMethod}。
   */
  private reasoningOn = false
  /**
   * 运行中任务的并发登记表：conversationId -> 任务运行时（中止控制器 + 事件外发器）。
   *
   * 由「单 AbortController 串行」升级为「多会话并行」：不同会话各自独立登记，
   * 互不干扰；同一会话重复发送则先中止旧任务（避免同一会话内两条流交叉）。
   */
  private runningTasks = new Map<string, { abort: AbortController; emit: (event: AgentWorkerEvent) => void }>()
  /**
   * 工具事件归属通道（会话级）。
   *
   * 工具打点在 Agent 构建期一次性绑定，无法按调用注入会话 id；原实现用**单个全局游标**
   * （toolEventConvId）记录「当前活跃会话」，并在注释里承认「并发场景下后进入者覆盖前者」。
   * 多会话并行是已支持的一等能力（`runningTasks` 按会话登记），该覆盖会让**会话 A 的工具
   * 事件被发到会话 B 的渲染通道**（表现为：在 B 的时间线里凭空出现 A 的工具行，或 A 的
   * 时间线永远转圈）。
   *
   * 改为 `AsyncLocalStorage`：`streamMessage` 在处理链最外层 `run(conversationId, ...)`，
   * 该链内所有工具调用（含嵌套异步、Promise.all 并发）都能读到正确会话，与 approval.ts
   * 的 `withApprovalSource` 同一机制、同一理由。
   */
  private toolEventConv = new AsyncLocalStorage<string>()
  /** 工具名 → 能力域展示标签（构建工具集时填充，供结构化事件使用）。 */
  private toolDomainLabels = new Map<string, string>()
  /** 会话级技能路由计数：convId -> trigger -> 已被纳入候选次数（对应 max_session_times）。 */
  private sessionSkillCounts = new Map<string, Map<string, number>>()

  constructor() {}

  /** 把一条工具事件路由到「发起该调用的会话」的外发器（无归属则丢弃）。 */
  private emitToolEvent(event: AgentWorkerEvent): void {
    const convId = this.toolEventConv.getStore()
    if (convId === undefined) return
    // 上下文治理（主进程侧）：破坏性工具完成时登记「失效对象提醒」，供后续轮次过滤旧描述。
    // 事件本就产生在主进程，这里直接观测即可，不必再绕渲染层回传。
    observeToolEvent(convId, event)
    this.runningTasks.get(convId)?.emit(event)
  }

  /**
   * 主 Agent 的工具集：全部白名单工具（能力域合并）+ 逐个打点。
   *
   * 事件归属：主 Agent 自己直调的工具事件属于 'main'，事件文本里保留**能力域标签**，
   * 让渲染层的过程日志显示「这一步属于文献/论文/实验…」的语义分组。
   *
   * 架构（双轨）：主 Agent 持有全部工具（可直调、可串联），并额外获得 `task` 委派工具；
   * 「委派给子代理」由 deepagents 注入的 `task` 提供，不在此处注册。
   * 防火墙在此以 depth=0 放行（允许 task），仅对子代理层级（depth≥1）拦截递归委派。
   */
  private buildMainAgentTools(): ToolLike[] {
    const { domains, rejected } = loadCapabilityDomains()
    if (rejected.length > 0) {
      console.warn('[capability-domains] 以下自定义能力域注册被拒绝：', rejected)
    }
    const raw = resolveAllWorkerTools() as ToolLike[]
    // D1 纵深防御：主 Agent（depth 0）允许持有委派工具；此处仅校验业务工具集
    // 未混入未登记的嵌套入口，并做运行期包裹兜底。
    assertNoDelegationTools('main-agent', raw as { name?: string }[], { depth: 0 })
    const guarded = guardSubagentTools('main-agent', raw, { depth: 0 })
    // 工具 → 所属能力域（用于事件文本里显示语义分组）；未登记的工具不显示标签
    const ownerOf = new Map<string, string>()
    for (const d of domains) {
      for (const t of d.tools as ToolLike[]) {
        if (typeof t.name === 'string' && !ownerOf.has(t.name)) ownerOf.set(t.name, d.label)
      }
    }
    // 工具名 → 能力域标签：供结构化事件带出「这一步属于文献/论文/实验…」的语义分组。
    // 存到实例字段：事件改由 streamMessage 里的 run.toolCalls 统一发出（见该处注释）。
    this.toolDomainLabels = ownerOf
    return guarded.map((base) =>
      // 只保留 C3 的来源标记（主 Agent 直接调用）。**事件不再从这里发** ——
      // 统一由 run.toolCalls 出口产出，避免"两处各发一份"造成重复与口径漂移。
      withToolTrace(base as ToolLike, { source: { origin: 'main' } })
    )
  }

  /** 主 Agent 的 systemPrompt：基础人格 + 能力域章节（构建期派生，非硬编码）。 */
  private buildSystemPrompt(): string {
    const { domains } = loadCapabilityDomains()
    return `${SINGLE_AGENT_SYSTEM}\n\n${buildCapabilityDomainPrompt(domains)}`
  }

  /**
   * Initialize the DeepAgents agent (single Agent holding all tools) with the given config
   */
  async initialize(config: AgentConfig): Promise<void> {
    this.config = config

    // 模型层全链路可观测性（OpenTelemetry，见 otelTrace.ts）：
    // 插桩挂在 LangChain 的 CallbackManager 上（manuallyInstrument），覆盖 Agent 主循环 /
    // 各增强子图 / 历史压缩 / 技能路由等**全部**模型与工具调用，无需在库内埋桩。
    // 未配置 OTLP 端点时完全不初始化 SDK：零开销、零网络请求。
    await initializeOtelFromCurrentConfig()

    // 思考模式：仅对确认支持的上游开启（详见 AgentConfig.reasoning 注释）。
    const reasoningOn = config.reasoning ?? autoReasoningFor(config.baseUrl)
    this.reasoningOn = reasoningOn
    if (reasoningOn) {
      console.log('[agent] 思考模式已开启（thinking=enabled, reasoning_effort=high）：推理内容将经 msg.reasoning 投影到时间线')
      console.log('[agent] 结构化输出通道：jsonMode（思考模式不支持 tool_choice，functionCalling 会被上游 400 拒绝）')
    }

    const buildModel = (temperature: number): ChatOpenAI =>
      new ChatOpenAI({
        apiKey: config.apiKey,
        model: config.model,
        temperature,
        ...(config.baseUrl ? { configuration: { baseURL: config.baseUrl } } : {}),
        ...(reasoningOn
          ? { modelKwargs: { thinking: { type: 'enabled' }, reasoning_effort: 'high' } }
          : {})
      })
    const model = buildModel(0.7)
    // 多专家合议（可选增强，默认关闭）：低温用于判定/聚合/反思，高温用于并行候选生成
    this.scJudgeModel = buildModel(0.3)
    this.scCandidateModel = buildModel(0.9)

    // 主 Agent 持有全部能力域工具 + 只读长期记忆工具（load_memory）。
    // 同时配置 `subagents`：deepagents 会据此注入 `task` 委派工具，主 Agent 可以
    // 「自己直调工具」或「把某能力域内的整块多步工作委派给对应子代理」——两条路都通。
    const memoryToolTraced = withToolTrace(loadMemoryTool as unknown as ToolLike, {
      // 只保留主进程诊断日志。**事件不再从这里发**：load_memory 同样出现在 run.toolCalls 里，
      // 两处都发会让时间线出现重复步骤。
      onCall: (name, args): void => {
        console.log(`[agent][memory-tool] 调用 ${name}${args ? ` args=${truncateSummary(args, 200)}` : ''}`)
      },
      onDone: (name, out, durationMs): void => {
        console.log(`[agent][memory-tool] ${name} 返回 ${durationMs}ms:${truncateSummary(out, 4000)}`)
      },
      onError: (name, error, durationMs): void => {
        console.log(`[agent][memory-tool] ${name} 出错 ${durationMs}ms:${humanizeAgentError(error)}`)
      }
    })
    // 全部能力域工具（主 Agent 全持有）+ 只读长期记忆工具，统一挂到主 Agent 上；
    // 另配 subagents —— 每个能力域一个子代理，只持有本域工具白名单（A2：专注、省 token、少误用）。
    const allTools = this.buildMainAgentTools()
    const { domains } = loadCapabilityDomains()
    const subagents = buildDomainSubagents(domains)
    this.agent = createDeepAgent({
      model,
      // 不再静态注入全量技能目录：由每轮 Skill 路由注入 top-K 候选（SLASH_CATALOG_TEXT
      // 仅在路由不可用时作为兜底目录注入），解决全量目录的 token 与召回噪声问题。
      systemPrompt: this.buildSystemPrompt(),
      tools: [memoryToolTraced, ...allTools] as never,
      // 委派子代理：会同时注入 `task` 工具。主 Agent 仍持有全部工具，可自主选择
      // 「直接串联调用」还是「把整块工作委派给对应能力域子代理」。
      subagents: subagents as never,
      // 内置文件工具（read_file/write_file/edit_file/ls/glob/grep/delete）默认走内存 StateBackend，
      // 不会落到真实磁盘。注入 MimirFsBackend：真实磁盘读写 + 写/空间外读的批准卡。
      backend: new MimirFsBackend() as never,
      // 语言约束中间件：每次模型调用时读取最新「交流语言」并前置注入——修复
      // 「最终回答中文、工具间过程叙述整段英文」的问题，且改设置免重启即生效。
      middleware: [createLanguageMiddleware()] as never
    }) as unknown as MimirAgent

    // 工具注册诊断：打印主 Agent 的工具清单与子代理清单。
    // 复现「模型没有调用某能力」时，先确认清单内容；若在列但从未被调用，
    // 则是模型判定问题而非绑定问题。
    console.log(
      `[agent] 主 Agent 工具注册（${allTools.length + 1} 个 + task 委派）:[${([memoryToolTraced, ...allTools] as ToolLike[])
        .map((t) => t.name)
        .join(', ')}]`
    )
    console.log(
      `[agent] 委派子代理（${subagents.length} 个）:[${subagents
        .map((s) => `${s.name}(${s.tools.length} 工具)`)
        .join(', ')}]`
    )
  }

  /**
   * Check if the agent is initialized
   */
  isInitialized(): boolean {
    return this.agent !== null
  }

  /** 单次模型调用并抽取纯文本（SC 各子阶段通用）。 */
  private async invokeModelText(
    model: ChatOpenAI,
    messages: Array<{ role: string; content: string }>
  ): Promise<string> {
    const out = await model.invoke(messages)
    return this.textContentOf(out.content)
  }


  /** 从任意 agent 返回结果中抽取末条消息的文本内容。 */
  private lastTextOf(result: { messages: unknown[] }): string {
    const last = result.messages[result.messages.length - 1] as { content?: unknown } | undefined
    return last ? this.textContentOf(last.content) : ''
  }

  /** 把模型返回的 content（字符串 / 文本块数组）归一化为纯文本。 */
  private textContentOf(content: unknown): string {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content
        .map((item) => {
          if (typeof item === 'string') return item
          if (item && typeof item === 'object' && 'text' in item) {
            return String((item as { text: unknown }).text ?? '')
          }
          return ''
        })
        .join('')
    }
    return ''
  }

  /**
   * Send a message to the agent and get a response
   */
  async sendMessage(message: string, conversationId: string): Promise<string> {
    const agent = this.agent
    if (!agent) {
      throw new Error('Agent 未初始化，请先在设置中配置 API Key')
    }

    const result = await agent.invoke({
      messages: [{ role: 'user', content: message }]
    })

    return this.lastTextOf(result)
  }

  /**
   * 永久层（全局身份常量，治理 Phase 4 / M5）：读取设置 settings.identity，
   * 若用户显式配置了身份信息则生成「每轮恒定在场」的文本块，否则返回 ''（默认零注入）。
   *
   * 与 load_memory 的分界：长期记忆默认不在场、判定相关才按需读取；身份常量一旦配置，
   * 就作为 system 消息恒定前置到每次 Agent 输入（不参与窗口/压缩/归档/时效管理），
   * 量极小（≤ 数十 token）。自动学习/对话写回永不落入永久层——仅由用户在设置页手动维护。
   */
  private buildIdentityBlock(): string {
    try {
      const settings = (getStoreValue<Record<string, unknown>>('settings') ?? {}) as Record<string, unknown>
      const id = (settings.identity ?? {}) as Record<string, unknown>
      const role = typeof id.role === 'string' ? id.role.trim() : ''
      // 仅语言与系统默认（中文交流）不同时才需要声明覆盖；写作语言需用户显式指定
      const interact =
        id.interactLanguage === 'en' ? 'English' : id.interactLanguage === 'zh' ? '' : ''
      const writing =
        id.writingLanguage === 'en' ? 'English' : id.writingLanguage === 'zh' ? '中文' : ''
      if (role === '' && interact === '' && writing === '') return ''
      const lines: string[] = [
        '【用户身份（永久层设定，每次对话恒定在场，非本轮任务指令；若与系统提示中的语言默认冲突，以此为准）】'
      ]
      if (role !== '') lines.push(`- 科研身份：${role}`)
      if (interact !== '') lines.push(`- 与用户交流语言：${interact}`)
      if (writing !== '') lines.push(`- 论文与正式写作语言：${writing}`)
      return lines.join('\n')
    } catch {
      return ''
    }
  }

  /**
   * Stream a message to the agent, calling onEvent for each structured event.
   *
   * 只发**结构化事件**（见 `streamProtocol.ts`），不再产出「前缀信封字符串」：
   * 正文增量 / 过程事件 / 流结束 / 出错统一走一条事件通道，由调用方（IPC 层）编排 seq。
   * 可通过 {@link stopStreaming} 中止：abort 后返回已收到的部分内容。
   *
   * @param onEvent 结构化事件外发器（正文增量 / 过程事件 / 结束 / 出错）
   * @param options.ultra 开启「Ultra 增强控制器」（可选的增强层）：enabled 总开关，strategy 为
   *   增强策略（'auto' 由 Ultra 自动选，或 plain / multi_expert / critique_reflect / hybrid_mix /
   *   self_consistency_vote）。
   * @param options.history 最近对话历史**原文**（仅 user/assistant 纯文本，不含工具产物与附件全文）。
   *   调用方不再做上下文治理：滑动窗口、分段摘要压缩、熔断降级、失效对象提醒、压缩后能力声明
   *   重建全部由主进程 {@link buildGovernedHistory} 统一完成（见 `contextManager.ts`）。
   * @param options.skills 渲染层 slash 目录（技能/指令）的触发词与标题，供压缩后重建能力声明。
   */
  async streamMessage(
    message: string,
    conversationId: string,
    onEvent: (event: AgentStreamEventDraft) => void,
    options?: {
      ultra?: { enabled: boolean; strategy?: UltraStrategyPick }
      history?: HistoryMsg[]
      /** 渲染层 slash 目录（技能/指令）的触发词与标题，供压缩后重建能力声明。 */
      skills?: SkillRef[]
      /** 手动 /trigger 直通：跳过技能路由（用户显式触发，正文已注入）。 */
      manual?: boolean
    }
  ): Promise<string> {
    const agent = this.agent
    if (!agent) {
      throw new Error('Agent 未初始化，请先在设置中配置 API Key')
    }
    // 工具事件归属：整条执行链在「本会话」的 AsyncLocalStorage 上下文里运行，
    // 链内所有工具调用（含并发）据此路由到本会话的外发器，不会被其它并行会话覆盖。
    //
    // 可观测性：在会话上下文外层再包一层 OTel 根 span（`agent.turn`），本轮所有
    // 模型/工具 span 都会挂到它下面，在 Langfuse 里呈现为「一轮对话一棵树」。
    // 未启用 OTel 时 `turn` 为 null，两个包装函数都直接透传 —— 零开销。
    const turn = startAgentTurnSpan(message, conversationId, {
      'agent.model': this.config?.model ?? '',
      'agent.manual': options?.manual === true,
      'agent.ultra': options?.ultra?.enabled === true
    })
    return withAgentTurnContext(turn, () =>
      this.toolEventConv
        .run(conversationId, () => this.runConversation(agent, message, conversationId, onEvent, options))
        .then((content) => {
          endAgentTurnSpan(turn, content)
          return content
        })
        .catch((error: unknown) => {
          failAgentTurnSpan(turn, error)
          throw error
        })
    )
  }

  /**
   * 采集**委派子代理事件**。
   *
   * deepagents 的 `task` 工具被调用时会 fork 一个独立上下文的子代理，其内部工具
   * **不会**出现在主 `run.toolCalls` 里，必须订阅 `run.subagents` 才能看到。
   * 归因规则：子代理名即能力域 id，用它反查展示标签，事件带 `origin='subagent'`，
   * 让渲染层把它折叠到对应委派节点下。
   */
  private async collectSubagentEvents(
    run: StreamRun,
    signal: AbortSignal,
    emit: (event: AgentWorkerEvent) => void
  ): Promise<void> {
    const subs = run.subagents
    if (subs === undefined) return
    for await (const sub of subs) {
      if (signal.aborted) return
      const domainId = typeof sub?.name === 'string' ? sub.name : ''
      const domainLabel = this.toolDomainLabels.get(domainId) ?? domainId
      // 委派开始：一条 task 节点，渲染层据此折叠后续子代理步骤。
      emit({
        taskId: `subagent:${domainId}`,
        title: domainLabel !== '' ? domainLabel : '子代理',
        status: 'running',
        kind: 'task',
        phase: 'main',
        step: {
          callId: `subagent:${domainId}`,
          name: 'task',
          ...(domainLabel !== '' ? { label: domainLabel } : {}),
          stage: 'call',
          origin: 'subagent',
          ...(domainId !== '' ? { subagentId: domainId } : {}),
          ...(domainLabel !== '' ? { subagentLabel: domainLabel } : {})
        },
        text: `委派给「${domainLabel}」子代理`
      })
      const inner = (async (): Promise<void> => {
        const innerCalls = sub?.toolCalls
        if (innerCalls === undefined) return
        let innerSeq = 0
        for await (const call of innerCalls) {
          if (signal.aborted) return
          innerSeq += 1
          const name = typeof call?.name === 'string' && call.name !== '' ? call.name : `tool#${innerSeq}`
          const callId = `${domainId}:${name}#${innerSeq}`
          const file = fileActionOf(name, call.input)
          const command = commandActionOf(name, call.input)
          const stamp = {
            origin: 'subagent' as const,
            ...(domainId !== '' ? { subagentId: domainId } : {}),
            ...(domainLabel !== '' ? { subagentLabel: domainLabel } : {})
          }
          emit({
            taskId: `subagent:${domainId}`,
            title: domainLabel !== '' ? domainLabel : '子代理',
            status: 'running',
            kind: 'tool',
            phase: 'main',
            step: {
              callId,
              name,
              ...(domainLabel !== '' ? { label: domainLabel } : {}),
              ...(file !== undefined ? { file } : {}),
              ...(command !== undefined ? { command } : {}),
              stage: 'call',
              argsSummary: truncateSummary(call.input, 200),
              ...stamp
            },
            text: `调用 ${name}${call.input !== undefined ? `：${truncateSummary(call.input, 120)}` : ''}`
          })
          const t0 = Date.now()
          try {
            const out = await call.output
            const artifacts = extractArtifacts(out)
            if (file !== undefined && (file.action === 'write' || file.action === 'edit')) {
              const abs = resolve(file.path)
              if (!artifacts.some((a) => a.path === abs)) {
                artifacts.unshift({ path: abs, name: basename(abs), ext: extname(abs).toLowerCase() })
              }
            }
            emit({
              taskId: `subagent:${domainId}`,
              title: domainLabel !== '' ? domainLabel : '子代理',
              status: 'done',
              kind: 'tool',
              phase: 'main',
              durationMs: Date.now() - t0,
              step: {
                callId,
                name,
                ...(domainLabel !== '' ? { label: domainLabel } : {}),
                ...(file !== undefined ? { file } : {}),
                ...(command !== undefined ? { command } : {}),
                stage: 'result',
                resultSummary: truncateSummary(out, 4000),
                ...stamp
              },
              ...(artifacts.length > 0 ? { artifacts } : {}),
              text: `${name} 返回：${truncateSummary(out, 4000)}`
            })
          } catch (error) {
            emit({
              taskId: `subagent:${domainId}`,
              title: domainLabel !== '' ? domainLabel : '子代理',
              status: 'error',
              kind: 'tool',
              phase: 'main',
              durationMs: Date.now() - t0,
              step: {
                callId,
                name,
                ...(domainLabel !== '' ? { label: domainLabel } : {}),
                ...(file !== undefined ? { file } : {}),
                stage: 'error',
                resultSummary: humanizeAgentError(error),
                ...stamp
              },
              text: `${name} 出错：${humanizeAgentError(error)}`
            })
          }
        }
      })()
      // 子代理产出文本（可选）：用于把「子代理自己说了什么」也带出来。
      const innerText = (async (): Promise<void> => {
        const msgs = sub?.messages
        if (msgs === undefined) return
        for await (const m of msgs) {
          if (signal.aborted) return
          // 子代理的逐字文本对主回复无贡献（结果由 task 的 ToolMessage 回传），
          // 这里只把 reasoning 当作过程信息透出，避免与主回复文本混流。
          const reasoning = m?.reasoning
          if (reasoning === undefined) continue
          let buf = ''
          for await (const piece of reasoning) {
            if (signal.aborted) return
            buf += piece
          }
          if (buf !== '') {
            emit({
              taskId: `subagent:${domainId}`,
              title: domainLabel !== '' ? domainLabel : '子代理',
              status: 'running',
              kind: 'think',
              phase: 'main',
              text: buf,
              step: {
                callId: `${domainId}:think`,
                name: 'think',
                ...(domainLabel !== '' ? { label: domainLabel } : {}),
                stage: 'call',
                origin: 'subagent',
                ...(domainId !== '' ? { subagentId: domainId } : {})
              }
            })
          }
        }
      })()
      try {
        await Promise.all([inner, innerText])
      } catch {
        /* 子代理内部异常不应中断主流；细节已由内层捕获或 task 的 ToolMessage 带回 */
      }
      emit({
        taskId: `subagent:${domainId}`,
        title: domainLabel !== '' ? domainLabel : '子代理',
        status: 'done',
        kind: 'task',
        phase: 'main',
        step: {
          callId: `subagent:${domainId}`,
          name: 'task',
          ...(domainLabel !== '' ? { label: domainLabel } : {}),
          stage: 'result',
          origin: 'subagent',
          ...(domainId !== '' ? { subagentId: domainId } : {}),
          ...(domainLabel !== '' ? { subagentLabel: domainLabel } : {})
        },
        text: `「${domainLabel}」子代理已完成`
      })
    }
  }
  /**
   * 采集主 Agent 的**工具调用事件**（结构化，覆盖全部工具）。
   *
   * 用 SDK 的 `run.toolCalls` 而不是逐工具包装：它是唯一覆盖**全部**工具的出口，
   * 包括 deepagents 内置文件工具（write_file/edit_file/read_file/ls/glob/grep/delete
   * —— 它们过去完全不在轨迹里），而且直接给名字/入参/出参，无需任何文案嗅探。
   * 与正文流（`run.messages`）可并发迭代，因此与主循环并行跑。
   */
  private async collectToolEvents(
    run: StreamRun,
    signal: AbortSignal,
    emit: (event: AgentWorkerEvent) => void
  ): Promise<void> {
    const calls = run.toolCalls
    if (calls === undefined) return
    let seq = 0
    for await (const call of calls) {
      if (signal.aborted) return
      seq += 1
      const name = typeof call?.name === 'string' && call.name !== '' ? call.name : `tool#${seq}`
      // 同一次调用的 调用/返回/出错 共享 callId，渲染层据此配成一行（不再猜文案）
      const callId = `${name}#${seq}`
      const label = this.toolDomainLabels.get(name)
      // 文件动作（内置文件工具才有）：让时间线显示「写入 model.py +387」而不是一坨 JSON 入参
      const file = fileActionOf(name, call.input)
      // 命令行（execute 才有）：让时间线显示「运行 <命令>」而不是笼统的工具名。
      const command = commandActionOf(name, call.input)
      emit({
        taskId: 'main',
        title: 'Mimir',
        status: 'running',
        kind: 'tool',
        phase: 'main',
        step: {
          callId,
          name,
          ...(label !== undefined ? { label } : {}),
          ...(file !== undefined ? { file } : {}),
          ...(command !== undefined ? { command } : {}),
          stage: 'call',
          argsSummary: truncateSummary(call.input, 200),
          origin: 'main'
        },
        text: `调用 ${name}${call.input !== undefined ? `：${truncateSummary(call.input, 120)}` : ''}`
      })
      const t0 = Date.now()
      try {
        const out = await call.output
        // 产物识别双通道：① 结构化——write/edit/delete 的目标路径是一手事实，直接计入；
        // ② 文本嗅探——模块工具返回自然语言里的路径（extractArtifacts）。二者并集去重。
        // 此前只有②，且白名单不含 .py，导致「写了 6 个文件、验收卡只显示 2 个」。
        const artifacts = extractArtifacts(out)
        if (file !== undefined && (file.action === 'write' || file.action === 'edit')) {
          const abs = resolve(file.path)
          if (!artifacts.some((a) => a.path === abs)) {
            artifacts.unshift({
              path: abs,
              name: basename(abs),
              ext: extname(abs).toLowerCase()
            })
          }
        }
        emit({
          taskId: 'main',
          title: 'Mimir',
          status: 'done',
          kind: 'tool',
          phase: 'main',
          durationMs: Date.now() - t0,
          step: {
            callId,
            name,
            ...(label !== undefined ? { label } : {}),
            ...(file !== undefined ? { file } : {}),
            ...(command !== undefined ? { command } : {}),
            stage: 'result',
            resultSummary: truncateSummary(out, 4000),
            origin: 'main'
          },
          ...(artifacts.length > 0 ? { artifacts } : {}),
          text: `${name} 返回：${truncateSummary(out, 4000)}`
        })
      } catch (error) {
        emit({
          taskId: 'main',
          title: 'Mimir',
          status: 'error',
          kind: 'tool',
          phase: 'main',
          durationMs: Date.now() - t0,
          step: {
            callId,
            name,
            ...(label !== undefined ? { label } : {}),
            ...(file !== undefined ? { file } : {}),
            stage: 'error',
            resultSummary: humanizeAgentError(error),
            origin: 'main'
          },
          text: `${name} 出错：${humanizeAgentError(error)}`
        })
      }
    }
  }

  /**
   * `streamMessage` 的执行真身（在会话级 AsyncLocalStorage 上下文中被调用，见上）。
   * 拆出来只为把「建立上下文」与「执行」分离，避免整段 try/finally 再嵌一层缩进。
   */
  private async runConversation(
    agent: NonNullable<AgentService['agent']>,
    message: string,
    conversationId: string,
    onEvent: (event: AgentStreamEventDraft) => void,
    options: {
      ultra?: { enabled: boolean; strategy?: UltraStrategyPick }
      history?: HistoryMsg[]
      skills?: SkillRef[]
      manual?: boolean
    } | undefined
  ): Promise<string> {
    const controller = new AbortController()
    /** 本次回复的轨迹外发器；主流程各阶段用它补齐 Agent 自身的节点。 */
    // 所有过程事件都从这里出去 —— 因此 `phase` 在这里统一补全，各 emit 站点无需重复标注。
    // 过程事件与正文增量共用同一个 onEvent 出口（协议统一），不再区分两条回调。
    const emit = (event: AgentWorkerEvent): void =>
      onEvent({ type: 'worker', payload: withPhase(event) })
    // 多会话并行：本会话登记自己的任务运行时。若同会话已有任务在跑，先中止旧的，
    // 避免同一会话内两条流交叉；不同会话互不影响。
    this.runningTasks.get(conversationId)?.abort.abort()
    this.runningTasks.set(conversationId, { abort: controller, emit })
    let fullContent = ''
    const isManual = options?.manual === true || message.trim().startsWith('/')
    // 进入主流程前的上下文片段（当前消息 → 技能路由候选 → Ultra 增强产出）
    const contextParts: string[] = [message]
    /** 治理后的历史：滑动窗口/分段压缩/熔断/失效提醒已由主进程 contextManager 完成。 */
    let governed: HistoryMsg[] = []
    // Skill 路由 Meta 画像：Ultra 自动选策略时复用（同一判定，避免重复计费）
    let routeMeta: { intents: string[]; categories: string[]; complexity: 'low' | 'medium' | 'high' } | null = null

    try {
      const ultraCfg = options?.ultra
      const ultraOn = ultraCfg?.enabled === true

      // ── 上下文治理（主进程统一入口，见 contextManager.ts）──────────────────
      // 渲染层只交「本会话原始历史 + 技能目录」；超限判定、分段摘要压缩、熔断降级、
      // 失效对象提醒、压缩后能力声明重建都在这里完成。任何失败都降级（原样或截断），
      // 绝不阻断发送——治理是增益，不是发送的必要条件。
      if ((options?.history ?? []).length > 0) {
        const outcome = await buildGovernedHistory({
          conversationId,
          messages: options?.history ?? [],
          skills: options?.skills ?? [],
          compress: async (chunk) => {
            try {
              const summary = await this.compressHistory(chunk)
              return summary.trim() === ''
                ? { ok: false, message: '摘要为空' }
                : { ok: true, summary }
            } catch (error) {
              return { ok: false, message: error instanceof Error ? error.message : '摘要压缩失败' }
            }
          }
        })
        governed = outcome.history
        if (outcome.compressed) {
          emit({
            taskId: 'phase:context',
            title: '上下文治理',
            status: 'done',
            kind: 'phase',
            text: `历史超限：已把较早对话压缩为摘要（治理后约 ${outcome.tokens} token）。`
          })
        } else if (outcome.truncated) {
          emit({
            taskId: 'phase:context',
            title: '上下文治理',
            status: 'done',
            kind: 'phase',
            text: `历史超限且压缩不可用：已截断为最近窗口（约 ${outcome.tokens} token）。`
          })
        }
      }

      console.log(
        `[agent] 回复开始（v3 逐字流）会话=${conversationId}${ultraOn ? `（Ultra 增强：策略 ${ultraCfg?.strategy ?? 'auto'}）` : ''}` +
          `${governed.length > 0 ? `（携带 ${governed.length} 条历史 / 约 ${sumTokens(governed)} token）` : ''}` +
          `${isManual ? '（手动技能直通）' : ''}`
      )

      // Skill 分层路由（每轮自动；手动 / 触发绕过）：粗召回 + 精排 → 仅注入 top-K 候选。
      if (!isManual && this.readSettingsFlag('skillRouting', true)) {
        emit({ taskId: 'phase:routing', title: '技能路由', status: 'running' })
        const routed = await this.runSkillRouting(message, conversationId, controller.signal, emit)
        if (controller.signal.aborted) {
          console.log('[agent] 技能路由阶段被用户中止')
          emit({ taskId: 'phase:routing', title: '技能路由', status: 'error', text: '已被用户中止。' })
          return ''
        }
        emit({
          taskId: 'phase:routing',
          title: '技能路由',
          status: 'done',
          text:
            routed === null
              ? '路由不可用，回退静态技能目录。'
              : `已召回 ${routed.meta?.categories.length ?? 0} 类技能候选。`
        })
        if (routed === null) {
          // 路由不可用（无判定模型/判定失败）→ 回退静态目录，保留原有的自然语言命中能力
          contextParts.push(SLASH_CATALOG_TEXT)
        } else {
          routeMeta = routed.meta
          if (routed.context !== '') contextParts.push(routed.context)
        }
      }

      // Ultra 增强控制器（可选增强层，默认关闭；Agent 之上的策略调度）：
      // 选策略（自动/手动 + token 预算降级）→ 跑对应子图 → 产出「约束段」拼入本轮请求，
      // 执行动作全部下沉 Agent（含工具核验）。
      if (ultraOn && this.scJudgeModel !== null && this.scCandidateModel !== null) {
        const manualStrategy =
          ultraCfg?.strategy !== undefined && ultraCfg.strategy !== 'auto' ? ultraCfg.strategy : undefined
        // Ultra 增强层实现在 electron/agent/ultra.ts —— 与评测执行器共用同一份代码，
        // 这样「单 Agent vs 单 Agent + Ultra」的 A/B 才反映真实差异。
        const ultra = new UltraController({
          judgeModel: this.scJudgeModel,
          candidateModel: this.scCandidateModel,
          emit,
          reasoningOn: this.reasoningOn
        })
        const uc = await ultra.run({
          message,
          signal: controller.signal,
          // 预算按治理后的真实 token 计量（旧口径是字符数，对中英文严重失真）
          historyTokens: sumTokens(governed),
          manual: manualStrategy,
          routerMeta: routeMeta
        })
        if (controller.signal.aborted) {
          console.log('[agent] Ultra 增强阶段被用户中止')
          return ''
        }
        if (uc.output !== '') contextParts.push(uc.output)
      }
      const finalMessage = contextParts.join('\n\n')

      // 上下文治理（主进程侧）：治理后的历史（失效提醒 + 摘要 + 尾窗口）以「引用」方式前置注入；
      // Ultra 增强子图不读历史（隔离）；历史只含 user/assistant 纯文本，不含工具产物/附件全文。
      // 永久层身份常量（M5）：用户配置过则作为前置 system 消息恒定在场——由主进程服务端
      // 合成，不进渲染层持久历史，不参与滑动窗口/压缩/归档；默认未配置时零注入。
      const identityBlock = this.buildIdentityBlock()
      const inputMessages: Array<{ role: string; content: string }> = [
        ...(identityBlock !== '' ? [{ role: 'system' as const, content: identityBlock }] : []),
        ...governed,
        { role: 'user', content: finalMessage }
      ]

      // 主流程节点：工具事件（taskId='main'）会长在这个容器下，使渲染层的事件树能显示
      // 「Agent → 工具」的层级（工具行文本里另带能力域标签），而不是散落的顶层行。
      emit({ taskId: 'main', title: 'Mimir', status: 'running', kind: 'task', phase: 'main' })

      // 三条并行消费协程（正文流之外的旁路）。在 try 外声明，使 catch 收尾时也能统一 await 收敛，
      // 避免异常/中止路径下它们仍在后续运行并向已关闭的渲染层投递事件。
      let toolLoop: Promise<void> = Promise.resolve()
      let subagentLoop: Promise<void> = Promise.resolve()
      const reasoningLoops: Array<Promise<void>> = []

      // 官方推荐：streamEvents(state, { version: 'v3' }) → run.messages 内每条
      // AI 消息的 .text 是逐字 AsyncIterable。deepagents legacy `.stream()` 的
      // chunk 结构与文本抽取不匹配（会“正常结束但零输出”），已弃用。
      try {
        const run = await (agent.streamEvents as unknown as (
          state: { messages: Array<{ role: string; content: string }> },
          config: { version: 'v3' },
        ) => Promise<{
          messages: AsyncIterable<{ text: AsyncIterable<string>; reasoning?: AsyncIterable<string> }>
          toolCalls?: AsyncIterable<ToolCallStream>
          /** 委派子代理流：仅当主 Agent 调用 `task` 时才会产生元素（见下方 subagentLoop）。 */
          subagents?: AsyncIterable<{
            name?: string
            toolCalls?: AsyncIterable<ToolCallStream>
            messages?: AsyncIterable<{ text: AsyncIterable<string>; reasoning?: AsyncIterable<string> }>
          }>
          /** Agent 最终状态（promise-like）：含完整 messages 数组，是「流式累计」之外的第二个事实来源，用于对账。 */
          output?: Promise<{ messages?: Array<{ content?: unknown }> }>
        }>)(
          { messages: inputMessages },
          { version: 'v3' },
        )

        // 委派子代理事件由 collectSubagentEvents 采集（与正文流并行）。
        subagentLoop = this.collectSubagentEvents(run, controller.signal, emit)

        // ── 正文流消费 ───────────────────────────────────────────────────────
        // msgSeq/msgChars 仅用于观测（见下方 stream.msg / stream.reconcile 日志）。
        let msgSeq = 0

        // ── 正文增量攒批外发 ─────────────────────────────────────────────────
        // 逐 token 调用 onEvent 会退化成「每 token 一次 webContents.send」，在渲染进程主线程
        // 繁忙时于 IPC 投递层静默丢包（实测 242 发 / 10 收）。这里在**发送侧**把 token 攒成批：
        // 达到 TEXT_FLUSH_CHARS 或距上次外发超过 TEXT_FLUSH_MS 即合并成一帧下发。
        // 协议无需变更——`text-delta.delta` 本就是「增量字符串」，一批也是增量，接收端累加语义不变。
        let textBuf = ''
        let lastTextFlush = 0
        /** 冲掉缓冲：非空才外发，避免产生空增量事件。 */
        const flushText = (): void => {
          if (textBuf === '') return
          onEvent({ type: 'text-delta', delta: textBuf })
          textBuf = ''
        }

        // 工具调用事件由 collectToolEvents 与正文流并行采集（见方法注释）。
        toolLoop = this.collectToolEvents(run, controller.signal, emit)

        for await (const msg of run.messages) {
          msgSeq += 1
          let msgChars = 0
          // 思考（reasoning）：是否有内容取决于上游是否开了思考模式（见 AgentConfig.reasoning）。
          // 官方 deepseek-flash 在 thinking=enabled 下 `reasoning_content` 逐字流会被
          // deepagents 投影为 msg.reasoning（已实测 ~500 字符）；第三方代理不透传该参数时
          // 该流长度恒为 0，此处保持"有就显示"，不假装它在工作。
          // 按 ~200ms 合并成批再外发：逐 token 发会让渲染层再次被事件洪流压住
          // （正是「批准卡迟迟不弹」的成因）。
          const reasoning = msg.reasoning
          // 关键：`msg.reasoning` 与 `msg.text` 共享同一个 ReplayBuffer（见 @langchain/core
          // language_models/stream：ChatModelStream 的 text/reasoning 都是同一 _buffer 的投影）。
          // ReasoningContentStream 在**没有 reasoning 内容**时不会提前结束，必须等到底层
          // `message-finish` 才 return——若在此处同步 await 它，会把整个流的时长阻塞在
          // 正文迭代之前，导致 msg.text 的 content-block-delta 全部积压、最后一次性吐出
          // （表现为首字延迟=整段回答时长、打字机失效）。
          // 因此 reasoning 必须与 text **并发消费**，各自在自己的时间线推进。
          if (reasoning !== undefined) {
            const thinkBufState = { buf: '', lastFlush: 0 }
            const flushThink = (): void => {
              if (thinkBufState.buf === '') return
              emit({
                taskId: 'main',
                title: 'Mimir',
                status: 'running',
                kind: 'think-token',
                phase: 'main',
                text: thinkBufState.buf
              })
              thinkBufState.buf = ''
            }
            // 与正文流并行推进，不阻塞 text 消费；收尾时统一 await 收敛（见下方 Promise.all）。
            reasoningLoops.push(
              (async (): Promise<void> => {
                for await (const piece of reasoning) {
                  if (controller.signal.aborted) break
                  thinkBufState.buf += piece
                  const now = Date.now()
                  if (now - thinkBufState.lastFlush >= 200) {
                    flushThink()
                    thinkBufState.lastFlush = now
                  }
                }
                flushThink()
              })()
            )
          }
          for await (const token of msg.text) {
            if (controller.signal.aborted) break
            fullContent += token
            msgChars += 1
            // 只发增量：接收端自行累加。结束事件只带 finalLength，不重复传全文
            // （旧设计用「结束信封带全量 content」对账，制造了主进程/渲染层两份 fullContent）。
            //
            // 按 ~50ms / 200 字符合并成批再外发（与上方 reasoning 同款思路）。
            // 逐 token 直发会造成每轮 200+ 次 webContents.send 的高频外发洪流，渲染进程主线程
            // 繁忙时这些消息会在 IPC **投递层被静默丢弃**（实测主进程发 242 个事件、preload
            // 仅收到 10 个），表现为「回复说一半就断了」且接收端看不到任何跳号/陈旧日志——
            // 因为丢失的事件根本没进入 JS 回调。攒批把外发次数压到每轮 ~10 次量级，从源头消除丢包。
            textBuf += token
            const now = Date.now()
            if (textBuf.length >= TEXT_FLUSH_CHARS || now - lastTextFlush >= TEXT_FLUSH_MS) {
              flushText()
              lastTextFlush = now
            }
          }
          // 本条消息文本流收尾：强制冲掉缓冲，保证不丢尾部（否则末段不足阈值会滞留到下一条消息）。
          flushText()
          // stream.msg：逐条 AI 消息的产出量。多条 = 工具调用后的续写轮次。
          agentLog.info(`stream.msg conv=${conversationId} seq=${msgSeq} chars=${msgChars}`)
          if (controller.signal.aborted) break
        }
        // 正文流结束（模型停止生成）：立即发「结束事件」。此刻全文已 emit 完毕，而工具收尾/
        // 子代理可能还要跑很久 —— 渲染层据此马上定稿正文并关灯，不必等整轮 invoke 返回。
        //
        // 收尾前强制冲缓冲：这是**最后一个**出口（含 abort 提前 break 的路径），
        // 保证 end 之前正文全部送达，避免「最后不足一级阈值的尾巴」被滞留。
        flushText()
        // stream.end.emit：模型逐字流已收尾（这是全文长度的一手来源）。
        // 若此处长度已小于预期，问题在**模型/网关**，与 IPC 和渲染层无关。
        agentLog.info(`stream.end.emit conv=${conversationId} chars=${fullContent.length}`)
        onEvent({ type: 'end', finalLength: fullContent.length })
        // 等工具流收尾：模型可能已停止生成，但最后一次工具调用仍在返回。
        // 子代理流同样要收尾——`task` 的返回依赖子代理跑完，委派节点的 done 事件不能漏发。
        await Promise.all([toolLoop, subagentLoop, ...reasoningLoops])
        // ── 双来源对账（观测）─────────────────────────────────────────────────
        // stream.msg 只能证明「流里收到多少」；run.output 是 Agent 的最终状态，是独立第二来源。
        // 若 output 末条 AI 文本显著长于 fullContent，则问题在**流消费**（提前结束 / 漏轮次）；
        // 若两者一致，则模型/网关本身只产出了这么多，与 IPC 和渲染层无关。
        {
          const finalAiText = await extractFinalAiText(run.output)
          const finalLen = finalAiText.length
          const gap = finalLen - fullContent.length
          agentLog.info(
            `stream.reconcile conv=${conversationId} streamChars=${fullContent.length} outputChars=${finalLen} gap=${gap}`
          )
          if (gap > 0) {
            agentLog.warn(
              `stream.reconcile.mismatch conv=${conversationId} 流式少 ${gap} 字符（流被提前截断，根因在流消费而非 IPC/渲染层）`
            )
          }
        }
        emit({ taskId: 'main', title: 'Mimir', status: 'done' })
      } catch (streamError) {
        // 异常路径同样收敛并发循环：reasoningLoops 会随 controller.abort 退出，但必须等它们
        // 真正结束，避免其在函数返回后仍向已关闭的 renderer 发事件（toolLoop/subagentLoop 同）。
        await Promise.allSettled([toolLoop, subagentLoop, ...reasoningLoops])
        if (controller.signal.aborted) {
          console.log('[agent] v3 流被用户中止')
          emit({ taskId: 'main', title: 'Mimir', status: 'error', text: '已被用户中止。' })
        } else {
          console.warn('[agent] v3 逐字流执行异常，回退 invoke：', streamError)
          emit({
            taskId: 'main',
            title: 'Mimir',
            status: 'error',
            text: `执行异常：${humanizeAgentError(streamError)}`
          })
        }
      }

      if (controller.signal.aborted) {
        console.log(`[agent] 回复被中止，已收到 ${fullContent.length} 字符`)
        return ''
      }

      // v3 未产出文本（流异常/模型空回/兼容问题）→ 不再回退 invoke，因为流式执行期间工具
      // 可能已被调用，invoke 会重复执行导致副作用重复（如重复写库/审批）。
      if (fullContent === '') {
        console.warn('[agent] v3 流完成但未产出文本，流式过程中工具可能已执行。')
        throw new Error('模型返回了空回复（流式执行期间工具已运行但未生成文本）。请检查模型配置/接口是否兼容，或换个模型重试。')
      }

      console.log(`[agent] 回复完成，共 ${fullContent.length} 字符`)
      return fullContent
    } catch (error) {
      console.error('[agent] 回复失败：', error)
      throw error
    } finally {
      // 只在「本会话登记的任务仍是自己」时清理，避免误清新任务（同会话重发场景）
      const registered = this.runningTasks.get(conversationId)
      if (registered !== undefined && registered.abort === controller) {
        this.runningTasks.delete(conversationId)
      }
    }
  }

  /**
   * 会话历史摘要压缩（由主进程 contextManager 在上下文超限时调用）。
   * 只压缩 chat_history 文本；压缩只改「送入模型的上下文」，原始消息由 contextManager 归档供回看。
   * @returns 结构化摘要文本；history 为空返回 ''
   */
  async compressHistory(
    history: { role: 'user' | 'assistant'; content: string }[]
  ): Promise<string> {
    const judge = this.scJudgeModel
    if (judge === null) throw new Error('Agent 未初始化，请先在设置中配置 API Key')
    if (history.length === 0) return ''
    const body = history
      .map((m) => `${m.role === 'user' ? '【用户】' : '【助手】'}\n${m.content}`)
      .join('\n\n')
    const text = (
      await this.invokeModelText(judge, [
        { role: 'system', content: COMPRESS_HISTORY_SYSTEM },
        { role: 'user', content: body }
      ])
    ).trim()
    return text
  }

  /** 读取全局设置布尔开关（settings.<key>；缺省 def）。 */
  private readSettingsFlag(key: string, def: boolean): boolean {
    try {
      const settings = (getStoreValue<Record<string, unknown>>('settings') ?? {}) as Record<string, unknown>
      const v = settings[key]
      return typeof v === 'boolean' ? v : def
    } catch {
      return def
    }
  }

  /**
   * Skill 精排的 embedding 配置：复用当前 chat 模型的 apiKey / baseUrl，
   * 模型名优先取 settings.embeddingModel，其次 AgentConfig.embeddingModel，缺省由
   * embeddingRerank 内部兜底。Agent 未初始化时返回 null（调用方跳过精排）。
   */
  private embeddingConfig(): EmbeddingConfig | null {
    const cfg = this.config
    if (cfg === null || cfg.apiKey.trim() === '') return null
    let model: string | undefined
    try {
      const settings = (getStoreValue<Record<string, unknown>>('settings') ?? {}) as Record<string, unknown>
      const raw = settings.embeddingModel
      if (typeof raw === 'string' && raw.trim() !== '') model = raw.trim()
    } catch {
      // 读取失败用缺省模型名
    }
    return {
      apiKey: cfg.apiKey,
      ...(cfg.baseUrl !== undefined && cfg.baseUrl !== '' ? { baseUrl: cfg.baseUrl } : {}),
      ...(model !== undefined ? { model } : cfg.embeddingModel !== undefined ? { model: cfg.embeddingModel } : {})
    }
  }

  /**
   * Skill 分层路由（每轮自动执行；手动 / 触发在调用方已跳过）。
   * Meta-Cognition（意图/目录/复杂度）→ 规则粗召回 →（可选）LLM 精排 → 仅注入 top-K 候选上下文。
   * @returns { context, meta } 候选注入文本与路由 Meta 画像；null 表示路由不可用（调用方可用目录兜底）。
   */
  private async runSkillRouting(
    message: string,
    conversationId: string,
    signal: AbortSignal,
    emit: (event: AgentWorkerEvent) => void
  ): Promise<
    | {
        context: string
        meta: { intents: string[]; categories: string[]; complexity: 'low' | 'medium' | 'high' } | null
      }
    | null
  > {
    const judge = this.scJudgeModel
    if (judge === null) return null
    const { skills, rejected } = loadSkillRegistry()
    if (skills.length === 0) return null
    if (rejected.length > 0) {
      console.warn('[skill-router] 以下自定义技能注册被拒绝：', rejected)
    }

    emit({ taskId: 'router', title: '技能路由', status: 'running' })
    // ① Meta-Cognition：意图 / 目录 / 复杂度
    let intents: string[] = []
    let categories: string[] = []
    let complexity: 'low' | 'medium' | 'high' = 'medium'
    try {
      const meta = await judge
        .withStructuredOutput(ROUTE_META_SCHEMA, { name: 'skill_route_meta', method: pickStructuredMethod(this.reasoningOn) })
        .invoke([
          { role: 'system', content: ROUTE_META_SYSTEM },
          { role: 'user', content: `用户请求：\n${message}` }
        ])
      intents = meta.intents ?? []
      categories = (meta.categories ?? []).slice(0, 3)
      complexity = meta.complexity
    } catch (error) {
      emit({
        taskId: 'router',
        title: '技能路由',
        status: 'error',
        text: `路由判定失败：${humanizeAgentError(error)}（本次不注入技能候选）`
      })
      return null
    }
    if (signal.aborted) return { context: '', meta: { intents, categories, complexity } }

    const counts = this.sessionSkillCounts.get(conversationId) ?? new Map<string, number>()
    this.sessionSkillCounts.set(conversationId, counts)
    const rerankEnabled = this.readSettingsFlag('skillRerank', true)

    // ② 粗召回 + ③ 精排（规则；候选 > 1 且开启时叠加 embedding 精排）
    // 精排改用 embedding 向量相似度（复用 chat 的 baseUrl/apiKey），省掉一次 LLM 调用；
    // 网关无 embeddings 接口或模型名不可用时抛错，由 routeSkills 回退规则排序。
    const embedCfg = this.embeddingConfig()
    const llmRerank =
      rerankEnabled === false || embedCfg === null
        ? undefined
        : async (cands: RouterCandidate[], q: string): Promise<RouterCandidate[] | null> => {
            try {
              return await rerankByEmbedding(cands, q, embedCfg)
            } catch (error) {
              if (isEmbeddingUnavailable(error)) {
                console.warn('[skill-router] embedding 精排不可用，回退规则排序：', error instanceof Error ? error.message : error)
              } else {
                console.warn('[skill-router] embedding 精排失败，回退规则排序：', error)
              }
              return null
            }
          }

    const picked = await routeSkills(skills, { message, intents, categories, complexity, sessionCounts: counts }, SKILL_TOP_K, llmRerank)
    if (signal.aborted) return { context: '', meta: { intents, categories, complexity } }

    // ④ 更新会话级候选计数（max_session_times 治理）
    for (const c of picked) counts.set(c.trigger, (counts.get(c.trigger) ?? 0) + 1)

    if (picked.length === 0) {
      emit({ taskId: 'router', title: '技能路由', status: 'done', text: '无合适技能候选，按常规流程处理。' })
      return { context: '', meta: { intents, categories, complexity } }
    }
    const context = candidatesToContext(picked)
    emit({
      taskId: 'router',
      title: '技能路由',
      status: 'done',
      text: `候选：${picked.map((c) => `/${c.trigger}`).join('、')}`
    })
    return { context, meta: { intents, categories, complexity } }
  }

  /**
   * 中止正在进行的流式回复。
   * @param conversationId 指定会话则只停该会话的任务；缺省停止全部（退出 / 全局停止）。
   */
  stopStreaming(conversationId?: string): void {
    if (conversationId !== undefined) {
      this.runningTasks.get(conversationId)?.abort.abort()
      return
    }
    for (const task of this.runningTasks.values()) task.abort.abort()
  }

  /** 当前正在运行的会话 id 列表（渲染层侧栏「后台任务」态用）。 */
  runningConversationIds(): string[] {
    return [...this.runningTasks.keys()]
  }

  /**
   * 重置某会话的上下文治理状态。
   * @param conversationId 目标会话
   * @param includeArchive 是否连归档原文一并清除。`/clear`（仅清上下文）传 false，
   *   删除会话传 true——会话都没了，归档留着既无意义也占空间。
   */
  resetConversationContext(conversationId: string, includeArchive = false): void {
    if (includeArchive) purgeConversation(conversationId)
    else resetConversation(conversationId)
  }

  /** 用最近一次配置重新初始化 Agent（「插件 → 能力域」增删改查后调用，免重启生效）。 */
  async reload(): Promise<{ ok: boolean; message: string }> {
    if (this.config === null) {
      return { ok: false, message: 'Agent 尚未初始化，请先在设置中配置 API Key 并重新初始化。' }
    }
    try {
      await this.initialize(this.config)
      return { ok: true, message: 'Agent 已按最新能力域配置重新初始化，变更即时生效。' }
    } catch (error) {
      return { ok: false, message: `重新初始化失败：${humanizeAgentError(error)}` }
    }
  }

  /**
   * 「插件 → 能力域」面板所需的只读目录：工具白名单 + 内置能力域（供展示/克隆）。
   *
   * 返回值字段名保持不变（`builtin` / `systemPrompt`）以兼容渲染层既有代码；
   * 语义上 `systemPrompt` 现为能力域的**使用纪律**（guidance），见 capabilityDomains。
   */
  getSubagentCatalog(): {
    tools: { id: string; label: string; description: string }[]
    builtin: {
      id: string
      label: string
      role: string
      description: string
      systemPrompt: string
      toolIds: string[]
    }[]
  } {
    return {
      tools: WORKER_TOOL_CATALOG,
      builtin: BUILTIN_DOMAINS.map((b) => ({
        id: b.id,
        label: b.label,
        role: b.role,
        description: b.description,
        systemPrompt: b.guidance,
        toolIds: [...b.toolIds]
      }))
    }
  }

  /** 一句话职责描述 → AI 生成自定义能力域草稿（name/label/说明/纪律/工具白名单）。 */
  async generateSubagentFromPrompt(
    prompt: string,
    takenNames: string[]
  ): Promise<{
    ok: boolean
    draft?: { name: string; label: string; description: string; systemPrompt: string; toolIds: string[] }
    message?: string
  }> {
    const judge = this.scJudgeModel
    if (judge === null) {
      return { ok: false, message: 'Agent 尚未初始化，请先在设置中配置 API Key 并重新初始化。' }
    }
    const p = prompt.trim()
    if (p === '') return { ok: false, message: '请先描述你想创建的能力域职责。' }
    const toolIds = WORKER_TOOL_CATALOG.map((t) => t.id)
    const toolEnum = z.enum(toolIds as [string, ...string[]])
    const GEN_SCHEMA = z.object({
      name: z.string().describe('小写字母开头，仅含小写字母/数字/中划线，2~4 段词'),
      label: z.string().describe('中文展示名，8 字内'),
      description: z.string().describe('一句话说明该能力域覆盖什么任务 + 能力边界，60 字内'),
      systemPrompt: z.string().describe('完整中文能力域使用纪律（适用范围/工具用法/纪律边界/输出要求），300~600 字'),
      toolIds: z.array(toolEnum).describe('从工具白名单中按职责勾选；无关则留空'),
      note: z.string().describe('给用户的生成说明，≤ 40 字').optional()
    })
    const toolLines = WORKER_TOOL_CATALOG.map((t) => `- ${t.id}：${t.label} — ${t.description}`).join('\n')
    const system = `你是 Mimir 的「能力域设计师」。Mimir 采用单 Agent 架构：一个 Agent 直接持有全部工具，各「能力域」只是给它的工具使用纪律分组。用户会给你一句对某个科研/办公能力域的职责描述，请生成一份可直接注册的自定义能力域配置（只输出 JSON）：
- name：小写字母开头，仅含小写字母/数字/中划线（2~4 段词，如 my-critic）；以下 name 已被占用，绝不能重复：${takenNames.join('、') || '（无）'}
- label：中文展示名（8 字内）；
- description：一句话说明该能力域覆盖什么任务 + 能力边界（≤ 60 字）；
- systemPrompt：完整中文能力域使用纪律：适用范围 → 相关工具怎么用 → 纪律与边界 → 输出要求（300~600 字；写成「涉及…时用…」的指令式，不要写成角色扮演；不得声称拥有白名单之外的能力）；
- toolIds：只从下面白名单选择与本职责真正相关的工具，不相关就不选（可为空数组）。

工具白名单：
${toolLines}

用户职责描述：${p}`
    try {
      const parsed = await judge
        .withStructuredOutput(GEN_SCHEMA, { name: 'subagent_design', method: pickStructuredMethod(this.reasoningOn) })
        .invoke([
          { role: 'system', content: system },
          { role: 'user', content: `一句话职责描述：\n${p}` }
        ])
      const name = (parsed.name ?? '').trim().toLowerCase()
      if (name === '') return { ok: false, message: '模型未产出有效 name，请重试。' }
      const allowed = new Set(toolIds)
      const picked = (Array.isArray(parsed.toolIds) ? parsed.toolIds : [])
        .map((t) => String(t))
        .filter((t) => allowed.has(t))
      return {
        ok: true,
        draft: {
          name,
          label: (parsed.label ?? '').trim(),
          description: (parsed.description ?? '').trim(),
          systemPrompt: (parsed.systemPrompt ?? '').trim(),
          toolIds: [...new Set(picked)]
        }
      }
    } catch (error) {
      return { ok: false, message: `能力域生成失败：${humanizeAgentError(error)}` }
    }
  }
}

// Singleton instance
export const agentService = new AgentService()

/** 中止全部会话的后台任务（窗口关闭 / 应用退出时调用）。 */
export function stopAllAgentTasks(): void {
  agentService.stopStreaming()
}
