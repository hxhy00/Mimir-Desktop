/**
 * 子代理注册表：Supervisor「可委派的模块子代理」的统一来源。
 *
 * 构成：
 * 1. 内置子代理（BUILTIN_SUBAGENTS）：5 个科研模块 worker（文献/论文/实验/组会/服务器），
 *    代码级定义、只读种子，始终注册（基线能力，不可在 UI 改名/删除，但可「克隆」改造）。
 * 2. 自定义子代理：渲染层「插件 → 子代理」在 store `plugins:subagents` 中增删改查的启用项，
 *    每条可勾选工具白名单（WORKER_TOOL_CATALOG）并自写 systemPrompt。
 *
 * 安全边界：渲染层只能引用工具 id，主进程在这里把它们解析成真实的 langchain 工具单例；
 * 写盘/耗时等副作用仍由工具内部 existing 的批准卡机制约束（与 Agent 位置解耦）。
 */
import { getStoreValue } from '../library/store'
import { arxivSearchTool, arxivFetchPaperTool } from './tools/arxivSearch'
import { webSearchTool } from './tools/webSearch'
import { wikiNoteTool } from './tools/wikiNote'
import { paperFetchTool, setPaperTool } from './tools/paperTools'
import { venueSearchTool } from './tools/venue'
import { experimentTool } from './tools/experiments'
import { serverStatusTool } from './tools/servers'
import { latexCompileTool } from './tools/latex'
import { meetingDeckTool } from './tools/meetings'
import { ledgerTool } from './tools/ledger'
import { figureTool } from './tools/figures'
import { librarySearchTool } from './tools/librarySearch'
import { wikiSearchTool } from './tools/wikiSearch'

/** 自定义子代理在 store 中的键名（渲染层 Plugins 面板写入同一 key）。 */
export const SUBAGENT_STORE_KEY = 'plugins:subagents'

/** 单个 langchain 工具的调用面（注册表只用字段与类型，不执行）。 */
interface ToolLike {
  name: string
  description?: string
  invoke(input: unknown): Promise<unknown>
}

/** 子代理标识合法形态：小写字母开头，仅含小写字母/数字/中划线（与内置 id、事件树 key 对齐）。 */
const SUBAGENT_NAME_RE = /^[a-z][a-z0-9-]*$/

/** 工具白名单（渲染层勾选用元数据；id 即真实工具 name，禁止渲染层注入任意可执行代码）。 */
export interface WorkerToolMeta {
  id: string
  label: string
  description: string
}

export const WORKER_TOOL_CATALOG: WorkerToolMeta[] = [
  { id: 'arxiv_search', label: 'arXiv 检索', description: '检索 arXiv 学术论文（标题/摘要/作者）' },
  { id: 'arxiv_fetch_paper', label: 'arXiv 论文详情', description: '按 arXiv id 读取单篇论文完整元数据' },
  { id: 'web_search', label: '网页搜索', description: '通用网页资料检索（不直接入库）' },
  { id: 'library_search', label: '文献库检索', description: '检索文献库内已收藏论文与阅读笔记片段' },
  { id: 'paper_fetch', label: '论文入库', description: '把论文归档进文献库（可关联项目，写操作）' },
  { id: 'set_paper', label: '论文元数据更新', description: '更新论文标签/笔记/AI 相关性评分（写操作）' },
  { id: 'venue_search', label: '会议截稿查询', description: '查询 CCF 会议截稿时间' },
  { id: 'latex_compile', label: 'LaTeX 编译', description: '编译 LaTeX 论文项目并返回诊断（真实编译，需批准）' },
  { id: 'figure', label: '图表库管理', description: '论文配图列出/添加/重命名/删除（写操作）' },
  { id: 'wiki_search', label: 'Wiki 检索', description: '检索研究笔记片段' },
  { id: 'wiki_note', label: 'Wiki 笔记', description: '创建/追加研究笔记（写操作）' },
  { id: 'experiment', label: '实验记录', description: '实验模块记录/指标/进度操作（写操作需批准）' },
  { id: 'ledger', label: '成长记录', description: '成长/里程碑时间线操作（写操作需批准）' },
  { id: 'meeting_deck', label: '组会 PPT 生成', description: '从论文/实验生成汇报 .pptx（落盘，需批准）' },
  { id: 'server_status', label: 'GPU 服务器状态', description: '只读查询已注册 GPU 服务器连通性与实时状态' }
]

const TOOL_BY_ID: Record<string, unknown> = {
  arxiv_search: arxivSearchTool,
  arxiv_fetch_paper: arxivFetchPaperTool,
  web_search: webSearchTool,
  library_search: librarySearchTool,
  paper_fetch: paperFetchTool,
  set_paper: setPaperTool,
  venue_search: venueSearchTool,
  latex_compile: latexCompileTool,
  figure: figureTool,
  wiki_search: wikiSearchTool,
  wiki_note: wikiNoteTool,
  experiment: experimentTool,
  ledger: ledgerTool,
  meeting_deck: meetingDeckTool,
  server_status: serverStatusTool
}

/** 把工具 id 白名单解析为真实工具实例（未知 id 静默丢弃）。 */
export function resolveWorkerTools(toolIds: unknown): unknown[] {
  if (!Array.isArray(toolIds)) return []
  const out: unknown[] = []
  for (const id of toolIds) {
    const inst = typeof id === 'string' ? TOOL_BY_ID[id] : undefined
    if (inst !== undefined) out.push(inst)
  }
  return out
}

/** 内置子代理的静态定义（只读种子；tools 用白名单 id 表述）。 */
export interface BuiltinSubAgent {
  id: string
  label: string
  description: string
  systemPrompt: string
  toolIds: string[]
}

/** 内置 5 个科研模块子代理（原 agentService WORKER_DEFS 迁入，语义不变）。 */
export const BUILTIN_SUBAGENTS: BuiltinSubAgent[] = [
  {
    id: 'literature',
    label: '文献 Agent',
    description: '检索 arXiv/网页文献、检索文献库内已收藏论文与阅读笔记、把论文保存进文献库、更新论文标签与 AI 相关性评分、查询会议截稿信息',
    systemPrompt: `你是 Mimir 科研工作台中的「文献 Agent」。你的职责：
- 用 arxiv_search 检索 arXiv 学术论文，用 web_search 检索网页资料，用 arxiv_fetch_paper 读取单篇论文的完整元数据；
- 需要回看用户已收藏的论文或其阅读笔记时，用 library_search 在文献库内做关键词检索（按需取片段，不要整库搬进上下文）；
- 需要把论文归档到文献库时用 paper_fetch（可关联项目）；用 set_paper 更新论文的标签、笔记与 AI 相关性评分；
- 用 venue_search 查询 CCF 会议截稿时间。

检索纪律：把关键词合并成最少的几条查询（同义/相近表述用 OR 或引号合并进同一次 arxiv_search，不要换措辞逐次搜）；一次检索的结果尽量复用于多个子问题；整个任务内 arxiv_search 尽量控制在 3~4 次以内，确需新角度才加搜。服务返回“繁忙/冷却”提示时不要连环重试，稍后再来或改用 web_search。
输出：结构化中文结果，分点列出标题、来源（arXiv id / URL）与摘要级要点，尽量给出可直接引用的出处。只做检索、入库与资料整理，不做超出请求范围的长篇综述。`,
    toolIds: ['arxiv_search', 'arxiv_fetch_paper', 'web_search', 'library_search', 'paper_fetch', 'set_paper', 'venue_search']
  },
  {
    id: 'paper',
    label: '论文 Agent',
    description: '编译 LaTeX 论文项目并解析诊断、管理图表库、检索并读写 Wiki 研究笔记（论文写作相关）',
    systemPrompt: `你是 Mimir 科研工作台中的「论文 Agent」。你的职责：
- 用 latex_compile 编译用户的 LaTeX 论文项目目录并返回错误/警告诊断（真实编译、可能耗时，会请求用户批准）；
- 用 figure 管理论文配图（列出/添加/重命名/删除，重命名会同步 .tex 引用）；
- 写作需要回看历史笔记时用 wiki_search 在 Wiki 中检索片段，需要沉淀结论时用 wiki_note 创建或追加笔记。

编译纪律：编译前先确认用户给出的项目目录；编译未获批准或失败时如实说明原因并给出可执行的后续建议（如缺失引擎时引导到「设置 → 资源下载」）。
输出：结构化中文结果；涉及写作任务时语言专业、符合学术规范，引用标注来源，不编造无依据的结论。`,
    toolIds: ['latex_compile', 'figure', 'wiki_search', 'wiki_note']
  },
  {
    id: 'experiment',
    label: '实验 Agent',
    description: '操作实验模块（记录/指标/进度）与成长记录（里程碑/论文/实验时间线）',
    systemPrompt: `你是 Mimir 科研工作台中的「实验 Agent」。你的职责：
- 用 experiment 操作实验模块：list / create / update / delete（写操作会先请求用户批准）；
- 用 ledger 操作成长记录：list / create / delete（写操作会先请求用户批准）。

纪律：先查询再修改；涉及新增/修改/删除等副作用的操作，先向用户说明将要执行的内容并等待批准；返回结构化中文结果。`,
    toolIds: ['experiment', 'ledger']
  },
  {
    id: 'meeting',
    label: '组会 Agent',
    description: '从文献库论文与实验记录生成组会汇报 .pptx（或列出历史产物）',
    systemPrompt: `你是 Mimir 科研工作台中的「组会 Agent」。你的职责：
- 用 meeting_deck 生成组会汇报 .pptx（从用户选定的论文/实验生成真实演示文稿，可选 AI 要点/配图），或列出历史产物。

纪律：生成 PPT 前先与用户确认主题与素材范围；生成耗时较长且会落盘文件，需要用户批准；返回产物路径与页数概要。`,
    toolIds: ['meeting_deck']
  },
  {
    id: 'server',
    label: '服务器 Agent',
    description: '查询已注册 GPU 服务器：连通性 + SSH nvidia-smi 实时 GPU/显存状态（只读）',
    systemPrompt: `你是 Mimir 科研工作台中的「服务器 Agent」。你的职责：
- 用 server_status 只读查询已注册 GPU 服务器：连通性 + SSH nvidia-smi 实时状态。

纪律：只做只读查询与状态解读，不执行任何远程改动；返回结构化中文结果（服务器名/状态/GPU 利用率与显存）。`,
    toolIds: ['server_status']
  }
]

/** Supervisor 构造时实际使用的子代理运行时定义（工具已解析为实例）。 */
export interface SubAgentRuntime {
  id: string
  label: string
  description: string
  systemPrompt: string
  tools: unknown[]
  builtin: boolean
}

export interface SubAgentLoadResult {
  agents: SubAgentRuntime[]
  rejected: { name: string; reasons: string[] }[]
}

/**
 * 读取全部可注册子代理：内置恒在 + store 自定义（仅 enabled === true）。
 * 自定义项校验：name 合法且不与内置/其它自定义冲突、description / systemPrompt 非空、
 * toolIds 只保留白名单内 id；被拒项返回原因供日志。
 */
export function loadSubAgentDefs(): SubAgentLoadResult {
  const agents: SubAgentRuntime[] = BUILTIN_SUBAGENTS.map((b) => ({
    id: b.id,
    label: b.label,
    description: b.description,
    systemPrompt: b.systemPrompt,
    tools: resolveWorkerTools(b.toolIds),
    builtin: true
  }))
  const rejected: { name: string; reasons: string[] }[] = []
  const taken = new Set(BUILTIN_SUBAGENTS.map((b) => b.id))

  let raw: unknown
  try {
    raw = getStoreValue<unknown>(SUBAGENT_STORE_KEY)
  } catch {
    raw = undefined
  }
  if (!Array.isArray(raw)) return { agents, rejected }

  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    const name = typeof rec.name === 'string' ? rec.name.trim() : ''
    const label = typeof rec.label === 'string' ? rec.label.trim() : ''
    const description = typeof rec.description === 'string' ? rec.description.trim() : ''
    const systemPrompt = typeof rec.systemPrompt === 'string' ? rec.systemPrompt.trim() : ''
    const reasons: string[] = []
    if (name === '') {
      reasons.push('name 缺失')
    } else if (!SUBAGENT_NAME_RE.test(name)) {
      reasons.push('name 需为小写字母开头，且仅含小写字母/数字/中划线')
    } else if (taken.has(name)) {
      reasons.push(`name「${name}」已被占用（内置或其它自定义子代理）`)
    }
    if (description === '') reasons.push('description 缺失')
    if (systemPrompt === '') reasons.push('systemPrompt 缺失')
    if (reasons.length > 0) {
      rejected.push({ name: name !== '' ? name : String(rec.id ?? '?'), reasons })
      continue
    }
    taken.add(name)
    agents.push({
      id: name,
      label: label !== '' ? label : name,
      description,
      systemPrompt,
      tools: resolveWorkerTools(rec.toolIds),
      builtin: false
    })
  }
  return { agents, rejected }
}
