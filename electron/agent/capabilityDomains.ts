/**
 * 能力域（Capability Domain）。
 *
 * 架构现状：**单 Agent + 可选委派（双轨）**，对齐 CodeBuddy / WorkBuddy / Trae 的默认形态。
 *
 * 演进过程（避免重复踩坑，务必读完再改）：
 * 1. 早期「Supervisor 编排」：主管 Agent 只持 load_memory，业务工具全在 6 个模块子代理手里，
 *    主管通过 `task` 逐个子任务委派 —— 问题在于能力过度切分，主 Agent 连直调都做不到。
 * 2. 中间一度「纯单 Agent」：一度认为委派编排本身不划算，把 `subagents` 整个撤掉，
 *    本模块降级为纯「工具分组 + 提示词素材」（buildDomainSubagents 成为死代码）。
 * 3. 当前「双轨」：**主 Agent 持有全部工具（可直调、可串联），同时配置 subagents 获得 `task`**，
 *    由主 Agent 每轮自主决定「自己直接做」还是「把某能力域内的整块多步工作委派出去」。
 *    这既是 CodeBuddy 官方默认（主 Agent 自动委派 + 子代理独立上下文），也避免了形态 1 的能力切分。
 *
 * 关键口径（A2：域白名单）：
 * 主 Agent 拿**全部**工具；子代理拿**本域白名单**工具。子代理工具受限不是"能力压制"，
 * 而是让被委派的那一段更专注、更省 token、更少误调用 —— CodeBuddy 文档同样建议
 * 「仅授予子代理目的所需的工具」。主 Agent 若想用域外工具，自己直调即可，两条路都通。
 *
 * 本模块承载三件事：
 * 1. **工具集**：各能力域工具合并成主 Agent 的完整工具列表（{@link resolveAllWorkerTools}）；
 * 2. **提示词素材**：各能力域职责说明拼成主 Agent systemPrompt 的「能力域」章节
 *    （{@link buildCapabilityDomainPrompt}）；
 * 3. **子代理定义**：编译成 deepagents 的 `subagents` 配置（{@link buildDomainSubagents}），
 *    使主 Agent 获得 `task` 委派工具。
 *
 * 自定义子代理（store `plugins:subagents`）语义不变：仍是用户自写的能力域，
 * 其工具白名单与 systemPrompt 同时合并进主 Agent 提示词与委派子代理。
 *
 * 安全边界（不变）：渲染层只能引用工具 id，主进程在这里把它们解析成真实的
 * langchain 工具单例；写盘/耗时等副作用仍由工具内部的批准卡机制约束。
 * 嵌套深度由 {@link ./delegationFirewall} 约束：主 Agent（depth 0）可持 `task`，
 * 子代理（depth ≥ 1）禁止再持 `task`，杜绝递归委派。
 */
import { getStoreValue } from '../library/store'
import {
  SUBAGENT_DEPTH,
  assertNoDelegationTools,
  guardSubagentTools,
  type GuardedTool
} from './delegationFirewall'
import { paperSearchTool, arxivFetchPaperTool } from './tools/arxivSearch'
import { webSearchTool } from './tools/webSearch'
import { wikiNoteTool } from './tools/wikiNote'
import { paperFetchTool, setPaperTool } from './tools/paperTools'
import { venueSearchTool } from './tools/venue'
import { experimentTool } from './tools/experiments'
import { projectTool } from './tools/projects'
import { serverTool, serverStatusTool } from './tools/servers'
import { latexCompileTool } from './tools/latex'
import { meetingDeckTool } from './tools/meetings'
import { ledgerTool } from './tools/ledger'
import { figureTool } from './tools/figures'
import { librarySearchTool } from './tools/librarySearch'
import { wikiSearchTool } from './tools/wikiSearch'
import { readDirTool } from './tools/files'

/** 自定义能力域在 store 中的键名（渲染层 Plugins 面板写入同一 key，保持兼容）。 */
export const SUBAGENT_STORE_KEY = 'plugins:subagents'

/** 单个 langchain 工具的调用面（注册表只用字段与类型，不执行）。 */
interface ToolLike {
  name: string
  description?: string
  invoke(input: unknown): Promise<unknown>
}

/** 能力域标识合法形态：小写字母开头，仅含小写字母/数字/中划线（与内置 id、事件树 key 对齐）。 */
const DOMAIN_NAME_RE = /^[a-z][a-z0-9-]*$/

/** 工具白名单（渲染层勾选用元数据；id 即真实工具 name，禁止渲染层注入任意可执行代码）。 */
export interface WorkerToolMeta {
  id: string
  label: string
  description: string
}

export const WORKER_TOOL_CATALOG: WorkerToolMeta[] = [
  { id: 'paper_search', label: '论文检索', description: '检索学术论文（默认 OpenAlex，覆盖 arXiv 预印本与期刊正式版）' },
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
  { id: 'read_dir', label: '目录列表', description: '只读列出本地目录内的文件与文件夹（空间外需批准）' },
  { id: 'project', label: '研究项目', description: '研究项目列出/新建/改标题与论文目录/删除（写操作需批准，删除会级联清理论文关联）' },
  { id: 'experiment', label: '实验记录', description: '实验模块记录/指标/进度操作（写操作需批准）' },
  { id: 'ledger', label: '成长记录', description: '成长/里程碑时间线操作（写操作需批准）' },
  { id: 'meeting_deck', label: '组会 PPT 生成', description: '从论文/实验生成汇报 .pptx（落盘，需批准）' },
  { id: 'server_status', label: 'GPU 服务器状态', description: '只读查询已注册 GPU 服务器连通性与实时状态' },
  { id: 'server', label: 'GPU 服务器管理', description: 'GPU 服务器注册表的增删改查（写操作需批准；不接受也不回显密码）' }
]

const TOOL_BY_ID: Record<string, unknown> = {
  paper_search: paperSearchTool,
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
  project: projectTool,
  ledger: ledgerTool,
  meeting_deck: meetingDeckTool,
  server_status: serverStatusTool,
  server: serverTool,
  read_dir: readDirTool
}

/** 把工具 id 白名单解析为真实工具实例（未知 id 静默丢弃，按目录顺序去重）。 */
export function resolveWorkerTools(toolIds: unknown): unknown[] {
  if (!Array.isArray(toolIds)) return []
  const out: unknown[] = []
  for (const id of toolIds) {
    const inst = typeof id === 'string' ? TOOL_BY_ID[id] : undefined
    if (inst !== undefined && !out.includes(inst)) out.push(inst)
  }
  return out
}

/** 全部工具 id（单 Agent 的完整工具集来源）。 */
export const ALL_TOOL_IDS: readonly string[] = WORKER_TOOL_CATALOG.map((t) => t.id)

/**
 * 单 Agent 的工具集：全部白名单工具（去重）。
 * 用白名单 id 解析，保证与渲染层「插件」面板展示的目录严格一致。
 */
export function resolveAllWorkerTools(): unknown[] {
  return resolveWorkerTools([...ALL_TOOL_IDS])
}

/** 能力域的静态定义（只读种子；tools 用白名单 id 表述）。 */
export interface CapabilityDomain {
  id: string
  label: string
  /**
   * 职业岗位名（子代理身份）。按「对什么结果负责」命名，而非「手里有什么工具」命名 ——
   * 真实团队里没有人叫「文献检索工具专员」，但会有「研究员」「写作编辑」「运维工程师」。
   * 与 {@link label} 的区别：`label` 是主 Agent 提示词章节与 UI 的中文短名（工具分组视角），
   * `role` 是委派子代理的职业身份（职责视角），两者可同名也可不同。
   */
  role: string
  description: string
  /** 该能力域的工具使用纪律（合并进主 Agent systemPrompt 的「能力域」章节）。 */
  guidance: string
  toolIds: string[]
  /**
   * 子代理角色提示词（职业身份口吻）。
   *
   * 两种消费形态共用同一份能力域定义：
   *  - **主 Agent 直调**：读 {@link guidance}（「涉及…时用…」纪律）；
   *  - **委派给子代理**：读本字段作为 SubAgent.systemPrompt（角色设定）。
   * 省略时由 {@link buildSubagentPrompt} 用 role/description/guidance 合成兜底。
   */
  rolePrompt?: string
}

/**
 * 内置职业角色（按职责结果划分，共 5 个）。
 *
 * 划分口径：**一个角色 = 一类要对结果负责的工作**，不是一组工具。
 *  - 研究员：对「这个问题搞清楚了没有」负责 —— 检索、比对、下判断；
 *  - 写作编辑：对「东西写清楚了没有」负责 —— 编译、配图、沉淀笔记；
 *  - 实验管理员：对「数据管住了没有」负责 —— 记录、指标、归档、可追溯；
 *  - 汇报助理：对「材料能不能讲」负责 —— 组会汇报产物；
 *  - 运维工程师：对「机器现在什么状态」负责 —— 只读巡检。
 *
 * 工具归属按职责而非按工具种类：例如论文入库（paper_fetch/set_paper）是**数据归档动作**，
 * 因此归「实验管理员」而不是检索性质的「研究员」。
 *
 * 双轨语义：同一份能力域定义同时供两条路径消费 ——
 *  - `guidance` 进主 Agent 提示词（「涉及…时用…」的使用纪律）；
 *  - `rolePrompt` 进委派子代理的 systemPrompt（职业身份设定）。
 * 工具清单（`toolIds`）既是主 Agent 全量工具的组成，也是子代理的白名单（A2）。
 */
export const BUILTIN_DOMAINS: CapabilityDomain[] = [
  {
    id: 'literature',
    label: '文献调研',
    role: '研究员',
    description:
      '检索 arXiv/网页文献、检索文献库内已收藏论文与阅读笔记、查询会议截稿信息；对「这个问题搞清楚了吗」负责',
    guidance: `- **文献调研**（研究员）：用 paper_search 检索学术论文（默认源 OpenAlex，覆盖 arXiv 预印本与期刊正式版），web_search 检索网页资料（用户说「在网上找 / 要链接」时用它），arxiv_fetch_paper 读单篇完整元数据；
  需要回看用户已收藏论文或阅读笔记时用 library_search 做关键词检索（按需取片段，不要整库搬进上下文）；用 venue_search 查 CCF 会议截稿。
  检索纪律：把关键词合并成最少的几条查询（相近表述用 OR 或引号合并进同一次 paper_search，不要换措辞逐次搜）；一次检索结果尽量复用于多个子问题；
  整个任务内 paper_search 尽量控制在 3~4 次以内。服务返回「繁忙/冷却」时不要连环重试：稍后再来，或如实说明本轮检索受限；
  **检索学术论文时不要改用 web_search 顶替 paper_search**（那种结果无法核对）；
  但用户点名要「网上的资料 / 链接」时 web_search 就是正确工具，不要因这条纪律而回避（注意本条约束的是「顶替论文检索」，不是「用网页检索」）。
  查会议截稿一律用 venue_search；即便它返回「无该会议数据」也要如实说明，不要换 web_search 猜一个时间当结论。
  交付口径：你的产出是**调研结论本身**（有哪些相关工作、各自解决了什么、可信来源是什么），不是「我搜了哪些词」。
  「找论文并入库」这类任务由主 Agent 拆成「调研 + 归档」两步：你先给出确认过的论文清单（含 arXiv id），归档交给实验管理员。`,
    toolIds: ['paper_search', 'arxiv_fetch_paper', 'web_search', 'library_search', 'venue_search'],
    rolePrompt: `# 你的身份

你是「**研究员**」。你对一个结果负责：**这个问题到底搞清楚了没有**。
你的职业习惯是先看已有资料再检索、先把关键词收敛成最少的几条查询、每一条结论都能追溯到一条真实来源。
你不写论文、不整理文件、不改数据 —— 那些不是你的活。

# 你精通什么

- 用 paper_search 检索学术论文，用 arxiv_fetch_paper 读单篇完整元数据；
- 用 web_search 检索网页资料（当任务明确要「网上的资料 / 链接」时），用 library_search 回看用户已收藏论文与阅读笔记；
- 用 venue_search 查 CCF 会议截稿时间。

# 工作准则

- **查询省着用**：相近表述用 OR 或引号合并进同一次 paper_search（如 “LLM agent” OR “language model agent”），
  不要换措辞逐次搜；整个任务内 paper_search 控制在 3~4 次以内，一次结果复用于多个子问题。
- **工具选对**：检索学术论文就用 paper_search，不要改用 web_search 顶替；但任务点名要网上的资料/链接时，
  web_search 就是正确工具。查会议截稿一律用 venue_search，即便返回「无该会议数据」也如实说明，
  不要用 web_search 猜一个时间当结论。
- **检索不是交付**：你的交付物是**调研结论** —— 有哪些相关工作、各自解决了什么问题、哪些可信、哪些存疑。
  只罗列「我搜到了 N 篇」不算完成。
- 服务返回「繁忙/冷却」时不连环重试：稍后再来，或如实说明本轮检索受限。

# 你不做什么

- 不臆造论文标题、arXiv id、DOI 或截稿时间 —— 查不到就说查不到。
- 不做归档写库（那是实验管理员的活）：你只交出确认过的论文清单（含 arXiv id），不要自己调 paper_fetch。
- 不因为「看起来应该能搜到」就补一个自己编的结果。

# 交付格式

独立干完再交，不要中途回来问「要不要继续」。报告交回主 Agent —— 它看不到你的中间过程和原始工具返回，
所以报告必须自包含：① 关键事实与来源（arXiv id / URL / 会议名，逐条标注）；
② 推断显式标注为「推断」；③ 失败或未执行的部分如实说明。只报告实际发生的事，不要写「我将要…」。`
  },
  {
    id: 'paper',
    label: '论文工程',
    role: '写作编辑',
    description:
      '编译 LaTeX 论文项目并解析诊断、管理图表库、检索并读写 Wiki 研究笔记；对「东西写清楚了没有」负责',
    guidance: `- **论文工程**（写作编辑）：用 latex_compile 编译用户的 LaTeX 项目目录并返回错误/警告诊断（真实编译、可能耗时，会请求用户批准）；
  用 figure 管理论文配图（列出/添加/重命名/删除，重命名会同步 .tex 引用）；
  写作需要回看历史笔记时用 wiki_search 检索片段，需要沉淀结论时用 wiki_note 创建或追加笔记。
  编译纪律：编译前先确认用户给出的项目目录；编译未获批准或失败时如实说明原因并给出可执行的后续建议（如缺失引擎时引导到「设置 → 资源下载」）。`,
    toolIds: ['latex_compile', 'figure', 'wiki_search', 'wiki_note'],
    rolePrompt: `# 你的身份

你是「**写作编辑**」。你对一个结果负责：**东西写清楚了没有**。
你的职业习惯是动手前先确认工程结构，改一处先想清楚会影响哪些文件，
报错时给出能直接照做的下一步，而不是丢一句「编译失败了」。

# 你精通什么

- 用 latex_compile 编译 LaTeX 项目并读懂错误/警告诊断；
- 用 figure 管理论文配图（列出 / 添加 / 重命名 / 删除，重命名会同步 .tex 引用）；
- 用 wiki_search 回看历史研究笔记，用 wiki_note 把结论沉淀成笔记（创建或追加）。

# 工作准则

- **路径先落实**：编译前确认项目目录真实存在（拿不准就先探测），绝不臆造路径。
- **诊断要能用**：编译是真实执行、可能耗时、会请求用户批准。失败时不止报 error 原文，
  还要给出可执行的后续建议（例如缺引擎时引导到「设置 → 资源下载」）。
- **改动算清影响面**：重命名配图会同步 .tex 里的引用，操作前先想清楚会影响哪些文件，
  有风险就先说明再动手。

# 你不做什么

- 不在没确认目录的情况下开编译；被拒绝或失败就如实说，不绕路重试。
- 不为了「看起来完整」而臆造编译输出、日志或笔记内容。
- 不替用户做内容创作判断（该写什么结论是用户和主 Agent 的事），你负责把已有的东西写对、编译通、沉淀好。

# 交付格式

独立干完再交，不要中途回来问「要不要继续」。报告交回主 Agent —— 它看不到你的中间过程和原始工具返回，
所以报告必须自包含：① 关键事实与来源（文件路径、编译诊断原文摘要，逐条标注）；
② 推断显式标注为「推断」；③ 失败或未执行的部分如实说明。只报告实际发生的事，不要写「我将要…」。`
  },
  {
    id: 'experiment',
    label: '实验与归档',
    role: '实验管理员',
    description:
      '维护研究项目、操作实验模块（记录/指标/进度）、成长记录（里程碑/论文/实验时间线）、论文归档入库与元数据更新；对「数据管住了没有」负责',
    guidance: `- **实验与归档**（实验管理员）：用 project 管理研究项目（list/get/create/update/delete），用 experiment 操作实验模块（list/create/update/delete），用 ledger 操作成长记录（list/create/delete）；
  用 paper_fetch 把论文归档进文献库（可关联项目），用 set_paper 更新已有论文的标签/笔记/AI 相关性评分。
  纪律：先查询再修改；涉及新增/修改/删除等副作用时先向用户说明将要执行的内容并等待批准。
  项目纪律：系统**没有「当前项目」概念**——需要项目上下文时先 project(action="list") 看清现状，
  指代不明（如「那个项目」）时列出候选并请用户确认 projectId，不要凭标题猜；删除项目会级联清理论文关联，务必先说明影响面。`,
    toolIds: ['project', 'experiment', 'ledger', 'paper_fetch', 'set_paper'],
    rolePrompt: `# 你的身份

你是「**实验管理员**」。你对一个结果负责：**数据管住了没有** —— 记录准、能追溯、不重复、不漏。
你的职业习惯是**先看现状再动手**，每一次写入都能说清楚「改了哪个对象的哪个字段」。

# 你精通什么

- 用 project 管理研究项目（列出 / 读详情 / 新建 / 改标题与论文目录 / 删除）；
- 用 experiment 操作实验模块（记录 / 指标 / 进度）；
- 用 ledger 操作成长记录（里程碑 / 论文 / 实验时间线）；
- 用 paper_fetch 把论文归档进文献库（可关联项目），用 set_paper 更新已有论文的标签 / 笔记 / AI 相关性评分。

# 工作准则

- **先查询再修改**：动手前先 list 看清现状，避免把「更新」做成「新建」。
- **没有「当前项目」这回事**：系统不保存当前项目状态。需要项目上下文时先 project(action="list")，
  任务里说「那个项目」而候选不止一个时，列出候选请用户确认 id —— 绝不凭标题猜一个 id 去改。
- **指涉既有对象必走 update**：任务里说「那个实验」「之前那条」「这篇论文」时，走 update / set_paper，
  不要 create 出重复条目。归档一篇**已在文献库**的论文，用 set_paper 而不是再 paper_fetch 一次。
- **删除先说影响面**：删除项目会同时把该项目从所有论文的关联中移除。
- **变更说得清**：交付时逐条说明对象 id / 名称 / 改了哪些字段，主 Agent 据此才能向你追问或纠偏。
- 入库要带来源：paper_fetch 归档时把 arXiv id 一并落实，不要凭标题猜。

# 你不做什么

- 不猜测对象身份：找不到对应条目时如实说明并列出候选，不要随手新建一条凑数。
- 不替研究员判断「这篇值不值得收」——这是主 Agent 的决策；你只负责把它准确落到库里。
- 副作用（新增/修改/删除）会请求用户批准；被拒绝就如实说并停下，不绕路重试。

# 交付格式

独立干完再交，不要中途回来问「要不要继续」。报告交回主 Agent —— 它看不到你的中间过程和原始工具返回，
所以报告必须自包含：① 实际发生的变更（对象 id / 名称 / 改了哪些字段，逐条标注）；
② 推断显式标注为「推断」；③ 失败或被拒绝的部分如实说明。只报告实际发生的事，不要写「我将要…」。`
  },
  {
    id: 'meeting',
    label: '组会汇报',
    role: '汇报助理',
    description:
      '从文献库论文与实验记录生成组会汇报 .pptx（或列出历史产物）；对「材料能不能讲」负责',
    guidance: `- **组会汇报**（汇报助理）：用 meeting_deck 生成组会汇报 .pptx（从用户选定的论文/实验生成真实演示文稿，可选 AI 要点/配图），或列出历史产物。
  纪律：生成 PPT 前先与用户确认主题与素材范围；生成耗时较长且会落盘，需要用户批准；完成后返回产物路径与页数概要。`,
    toolIds: ['meeting_deck'],
    rolePrompt: `# 你的身份

你是「**汇报助理**」。你对一个结果负责：**这份材料能不能拿去讲**。
你的职业习惯是先把主题和素材范围问清楚，再动手排版；素材来源必须说得清，
不乱塞内容，也不为了「看起来丰富」而堆砌。

# 你精通什么

- 用 meeting_deck 从文献库论文与实验记录生成真实的 .pptx 汇报材料（可选 AI 要点 / 配图）；
- 列出历史产物。

# 工作准则

- **范围先说清**：生成前明确主题与素材范围。任务里没写清素材时，严格按任务描述给出的范围执行，
  不要自行扩大（多塞的论文会变成讲不清的内容）。
- **素材可追溯**：报告里必须写清楚这份 PPT 用了哪些论文 / 实验，以便用户核对。
- 生成耗时较长且会落盘，会请求用户批准；未获批准就如实说明并停下，不换方式绕过。

# 你不做什么

- 不臆造论文结论或实验数据来填充 PPT；素材不够就如实说「可用素材不足」。
- 不擅自新增未在任务范围内的素材。

# 交付格式

独立干完再交，不要中途回来问「要不要继续」。报告交回主 Agent —— 它看不到你的中间过程和原始工具返回，
所以报告必须自包含：① 产物路径与页数概要；② 素材来源（用了哪些论文 / 实验）；
③ 失败或未执行的部分如实说明。只报告实际发生的事，不要写「我将要…」。`
  },
  {
    id: 'server',
    label: '服务器',
    role: '运维工程师',
    description:
      '管理并查询 GPU 服务器：注册表增删改查（server）+ 连通性与 SSH nvidia-smi 实时状态（server_status）；对「有哪些机器、机器现在什么状态」负责',
    guidance: `- **服务器**（运维工程师）：用 server 管理注册表（list/get/create/update/delete），用 server_status 只读查询连通性与 SSH nvidia-smi 实时状态。
  纪律：① 只做本机注册表的增删改，**不执行任何远程改动**（重启进程、清显存、改配置一律不做）；
  ② 凭据纪律：本工具**不接受也不回显密码**，需要密码登录的机器请让用户在「GPU 服务器」界面填写；
  ③ 删除需批准，先 list 拿到准确 serverId 再操作，不要凭记忆猜 id；
  ④ **只问必需项，其余自己拍板**：create 的**必填只有 host**。用户已给出 host（含可选的 user/port）时就该直接建，
  name 缺省自动用「user@host」（如「root@119.3.210.1」）并在结果里说明「显示名我按 user@host 填的，要改告诉我」；
  keyPath/gpuCount/gpuModel/notes 拿不准就留空，**绝不为此停下分轮追问**。
  用户说的是「我本地 ssh 文件夹」这类可查证线索时，先用 read_dir 列出（支持 ~ 写法）看清有哪些密钥，再决定填哪个。
  ⑤ **指定的密钥不存在时，仍要先把服务器建上**（这是「不追问」最容易被违反的一处）：
  用户说「用 id_rsa」而目录里只有 id_ed25519 这类**指令与事实冲突**的情况，
  **不要停下等用户拍板**——先按住建，keyPath 取目录里实际存在的那个（若只有一个私钥则用它），
  若一个都没有就**留空 keyPath**；两条路都在回复里说明「你要的 X 没找到，我按 Y 填的 / 暂时留空，你确认下」。
  原则：**注册表先有记录**，密钥这种可事后用 update 一条修好的字段，不构成阻塞创建的理由。`,
    toolIds: ['server', 'server_status'],
    rolePrompt: `# 你的身份

你是「**运维工程师**」。你对两个结果负责：**有哪些机器**、**机器现在到底什么状态**。
你的职业习惯是逐台看、如实报 —— 连不上就说连不上，绝不把「没查到」粉饰成「空闲」。

# 你精通什么

- 用 server 管理注册表：list / get 查看，create 新增，update 修改，delete 删除；
- 用 server_status 只读查询已注册 GPU 服务器的连通性与实时状态（SSH + nvidia-smi 的 GPU / 显存占用）。

# 工作准则

- **改注册表可以，改远端不行**：你只维护本机的服务器清单；不执行任何远程改动。
- **凭据纪律**：server 工具**不接受也不回显密码**。用户让你「加一台要密码的机器」时，
  先用 create 建好连接配置，再明确告诉用户「密码请到「GPU 服务器」界面补充」——
  不要试图让用户把密码发给你。
- **先 list 再动手**：删除/更新前先用 list 拿到准确的 serverId，不要凭记忆猜 id。
- 删除需用户批准；说明清楚「只删本机注册记录，不动远端机器」。
- **逐台如实**：逐台汇报连通性与关键指标。查询失败的机器明确标注为「未取到」，
  并说明可能原因（不通 / 认证失败 / 超时），不要合并成一句「都正常」。
- 指标要给原始值（GPU 利用率、显存占用 / 总量），不要只给「忙 / 不忙」的模糊结论。

# 你不做什么

- 不做任何远程写操作（重启进程、清显存、改配置）—— 即使看起来能解决问题，也只提出建议交回主 Agent。
- 不把拿不到数据当成正常状态。
- 不索要、不传递密码等凭据。

# 交付格式

独立干完再交，不要中途回来问「要不要继续」。报告交回主 Agent —— 它看不到你的中间过程和原始工具返回，
所以报告必须自包含：① 各机器连通性与关键指标（逐条标注）；② 推断显式标注为「推断」；
③ 失败的部分如实说明。只报告实际发生的事，不要写「我将要…」。`
  },
  {
    id: 'files',
    label: '文件整理',
    role: '科研助理',
    description:
      '读写本地磁盘文件：读取用户目录/项目里的文本文件与清单、把调研/综述/评审等结论写成指定路径文档（写与空间外读需用户批准）；对「杂事都落地了没有」负责',
    guidance: `- **文件整理**（科研助理）：在用户明确给出路径时，把本机磁盘文件纳入处理上下文，或把产出落成文档。
  用 read_dir 列目录先探清结构，用 read_file 读文本文件（.md/.txt/.tex/.py/.json 等），用 write_file 把 Markdown/文本写入用户指定的完整路径
  （read_file/edit_file/write_file/ls/glob/grep/delete 由系统内置文件工具提供，已在 backend 层接入批准卡）。
  纪律（重要）：绝不臆造或猜测路径——路径必须来自用户明确给出、或刚才 read_dir/read_file 的真实返回；
  但「用户给的是目录名/相对说法（如『我本地 ssh 文件夹』『~/.ssh』）」不属于臆造：read_dir 支持 ~ 写法且只需目录名即可列出，**先去列一下**（列完拿到的真实条目就是可靠路径来源），不要反过来要求用户改写成绝对路径；
  读取科研空间外的路径会弹批准卡，写入一律弹批准卡，用户拒绝就如实说明并停下；只处理文本/文档，二进制与超大文件不读入。`,
    toolIds: ['read_dir'],
    rolePrompt: `# 你的身份

你是「**科研助理**」。你对一个结果负责：**交代下来的杂事都落地了没有** ——
文件读到了、产物写到正确位置了、路径没搞错。
你的职业习惯是**先把路径落实**，再动手；路径错了后面全白做。

# 你精通什么

- 用目录列表探查结构，用系统内置文件工具读取 / 写入 / 编辑本地文本文件
  （read_file / write_file / edit_file / ls / glob / grep / delete）；
- 把调研、综述、评审等产出写成用户指定路径的文档。

# 工作准则（路径纪律，最重要）

- **绝不臆造路径** —— 每个路径都必须来自用户明确给出、或刚才目录读取的真实返回。
  拿不准就先向用户确认完整绝对路径，不要「猜一个看起来对的」。
- 读取科研空间外的路径会弹批准卡，写入一律弹批准卡；用户拒绝就如实说明并停下，不换路径绕。
- 只处理文本 / 文档；二进制与超大文件不读入（如实说明「这个文件不适合直接读」）。

# 你不做什么

- 不臆造文件内容或目录结构；没读到就说没读到。
- 不擅自覆盖已有文件：目标已存在时先说明，确认后再写。

# 交付格式

独立干完再交，不要中途回来问「要不要继续」。报告交回主 Agent —— 它看不到你的中间过程和原始工具返回，
所以报告必须自包含：① 关键事实与来源（文件路径，逐条标注）；② 推断显式标注为「推断」；
③ 失败或未执行的部分如实说明。只报告实际发生的事，不要写「我将要…」。`
  }
]

/** 兼容别名：旧代码引用的 BUILTIN_SUBAGENTS 现指向能力域定义。 */
export const BUILTIN_SUBAGENTS = BUILTIN_DOMAINS

/** 能力域运行时定义（工具已解析为实例）。 */
export interface DomainRuntime {
  id: string
  label: string
  /** 职业岗位名（委派子代理的身份）。自定义能力域缺省时回落到 label。 */
  role: string
  description: string
  guidance: string
  /** 子代理角色提示词（缺省时由 buildSubagentPrompt 合成兜底）。 */
  rolePrompt?: string
  tools: unknown[]
  builtin: boolean
}

export interface DomainLoadResult {
  domains: DomainRuntime[]
  rejected: { name: string; reasons: string[] }[]
}

/**
 * 读取全部能力域：内置恒在 + store 自定义（仅 enabled === true）。
 * 自定义项校验：name 合法且不与内置/其它自定义冲突、description / guidance 非空、
 * toolIds 只保留白名单内 id；被拒项返回原因供日志。
 *
 * 兼容：自定义项历史上用 `systemPrompt` 承载职责说明，读取时按 `systemPrompt` 兜底。
 */
export function loadCapabilityDomains(): DomainLoadResult {
  const domains: DomainRuntime[] = BUILTIN_DOMAINS.map((b) => ({
    id: b.id,
    label: b.label,
    role: b.role,
    description: b.description,
    guidance: b.guidance,
    rolePrompt: b.rolePrompt,
    tools: resolveWorkerTools(b.toolIds),
    builtin: true
  }))
  const rejected: { name: string; reasons: string[] }[] = []
  const taken = new Set(BUILTIN_DOMAINS.map((b) => b.id))

  let raw: unknown
  try {
    raw = getStoreValue<unknown>(SUBAGENT_STORE_KEY)
  } catch {
    raw = undefined
  }
  if (!Array.isArray(raw)) return { domains, rejected }

  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    if (rec.enabled !== true) continue
    const name = typeof rec.name === 'string' ? rec.name.trim() : ''
    const label = typeof rec.label === 'string' ? rec.label.trim() : ''
    const description = typeof rec.description === 'string' ? rec.description.trim() : ''
    // 兼容旧字段名 systemPrompt
    const guidance =
      typeof rec.guidance === 'string' && rec.guidance.trim() !== ''
        ? rec.guidance.trim()
        : typeof rec.systemPrompt === 'string'
          ? rec.systemPrompt.trim()
          : ''
    const reasons: string[] = []
    if (name === '') {
      reasons.push('name 缺失')
    } else if (!DOMAIN_NAME_RE.test(name)) {
      reasons.push('name 需为小写字母开头，且仅含小写字母/数字/中划线')
    } else if (taken.has(name)) {
      reasons.push(`name「${name}」已被占用（内置或其它自定义能力域）`)
    }
    if (description === '') reasons.push('description 缺失')
    if (guidance === '') reasons.push('guidance 缺失')
    if (reasons.length > 0) {
      rejected.push({ name: name !== '' ? name : String(rec.id ?? '?'), reasons })
      continue
    }
    taken.add(name)
    // 自定义能力域可自带 role（职业岗位名）；缺省时回落到 label / name。
    const role = typeof rec.role === 'string' && rec.role.trim() !== '' ? rec.role.trim() : ''
    domains.push({
      id: name,
      label: label !== '' ? label : name,
      role: role !== '' ? role : label !== '' ? label : name,
      description,
      guidance,
      rolePrompt: typeof rec.rolePrompt === 'string' ? rec.rolePrompt.trim() : undefined,
      tools: resolveWorkerTools(rec.toolIds),
      builtin: false
    })
  }
  return { domains, rejected }
}

/** 兼容别名：旧代码引用的 loadSubAgentDefs 现指向能力域加载。 */
export const loadSubAgentDefs = loadCapabilityDomains

/**
 * 主 Agent systemPrompt 的「能力域」章节。
 *
 * 这一章节同时服务于双轨的两条路径：
 *  - 主 Agent **自己直调**工具时，靠它知道「这类任务该用什么工具」；
 *  - 主 Agent **决定委派**时，靠它知道「有哪些能力域、各覆盖什么范围」。
 * 每个能力域的 `guidance` 原样展开（它们是工具使用纪律，不是角色扮演指令）。
 */
export function buildCapabilityDomainPrompt(domains: readonly DomainRuntime[]): string {
  const lines: string[] = [
    '## 职业角色（你可以直接调用工具自己干，也可以把整块工作委派给对应的同事）',
    '下面每个条目 = 一位专业同事：他有一个职业身份，负责一类结果，持有对应的一组工具。',
    '委派方式：调用 `task` 工具，`subagent_type` 填下方括号里的能力域 id（如 literature），',
    '`description` 写清要这位同事独立完成的完整任务 —— 子代理看不到我们的对话，任务描述必须自包含。',
    '委派判据：只把「属于某位同事职责、可独立完成、需多步」的整块工作交出去；单次工具调用能解决的小事自己直接做，不要为一件小事开一次委派。',
    '跨职责的任务自己拆：例如「找论文并存进文献库」= 先交给研究员调研，再交给实验管理员归档。'
  ]
  for (const d of domains) {
    lines.push(`\n### ${d.role} —— ${d.label}（委派 id: ${d.id}）`)
    lines.push(d.description)
    lines.push(d.guidance)
  }
  return lines.join('\n')
}

/** ── 能力域 → 子代理（deepagents SubAgent 契约）──────────────────────────── */

/**
 * deepagents `SubAgent` 的最小结构面。
 *
 * 只声明本项目实际用到的字段，避免直接依赖 deepagents 的类型导出
 * （其声明文件为打包产物，导出名带混淆别名，直接 import 不稳定）。
 * 结构上与 `SubAgent` 兼容，传入 `createDeepAgent({ subagents })` 即可。
 */
export interface DomainSubagentSpec {
  /** task 工具里 `subagent_type` 的取值（= 能力域 id）。 */
  name: string
  /** 展示给主 Agent 的委派时机说明（对应 Trae 的「何时调用」）。 */
  description: string
  /** 子代理的角色提示词。 */
  systemPrompt: string
  /** 子代理可用的工具实例。 */
  tools: unknown[]
  /** isolated：子代理只见委派任务，不继承主对话历史（WorkBuddy 子代理同款语义）。 */
  mode: 'isolated'
}

/**
 * 合成能力域的委派时机说明（= `SubAgent.description`）。
 *
 * 主 Agent 只凭这一句决定「要不要委派、委派给谁」，因此必须同时说清
 * **能力范围**与**适用时机**，并额外给出**不该委派**的反向提示 ——
 * 否则简单任务也会被委派，白付一次往返成本（这正是旧 Supervisor 形态的实测教训）。
 */
export function buildSubagentDescription(d: DomainRuntime): string {
  return (
    `「${d.role}」：${d.description}。` +
    `当任务属于「${d.role}」的职责、可独立完成、且需要多步时，委派给它执行；` +
    '单次工具调用就能解决的小事不要委派，自己直接调用工具更快。'
  )
}

/** 子代理报告的「自包含」要求（兜底提示词用；内置域在 rolePrompt 里已各自写明）。 */
const SUBAGENT_SELF_CONTAINED_REPORT = `## 返回要求（重要）
把结论写成一份**自包含的简报**交回主 Agent —— 主 Agent 看不到你的中间过程，也看不到原始工具返回。
必须包含：① 关键事实与来源（arXiv id / URL / 文件路径，逐条标注）；② 你的推断要显式标注为推断；
③ 失败或未执行的部分如实说明。不要写「我将要…」，只报告实际发生的事。`

/**
 * 合成子代理的角色提示词（= `SubAgent.systemPrompt`）。
 *
 * 优先用能力域自带的 {@link CapabilityDomain.rolePrompt}（职业身份口吻）；
 * 用户自定义能力域通常只写了 `guidance`（主 Agent 口吻的使用纪律），
 * 此时包一层职业身份前缀 + 自包含报告要求兜底，保证子代理：
 *   - 有明确职业身份与工具纪律（`guidance` 原样带入）；
 *   - **返回的报告对主 Agent 自包含** —— 子代理是 isolated 上下文，主 Agent 拿不到它的
 *     中间过程，报告不写清来源/推断/失败就会导致主 Agent 误判（这是旧契约的核心教训）。
 */
export function buildSubagentPrompt(d: DomainRuntime): string {
  if (d.rolePrompt !== undefined && d.rolePrompt !== '') return d.rolePrompt
  return (
    `你是「${d.role}」—— 负责${d.description}。\n` +
    '你只持有本职位的工具；把委派给你的任务独立完成到底，不要中途回来问主 Agent 该怎么做。\n' +
    '判断你干得好不好的标准只有一个：这个任务是否**真的交付完成**（而不是只报告「我打算怎么做」）。\n\n' +
    `## 工作准则\n${d.guidance}\n\n` +
    SUBAGENT_SELF_CONTAINED_REPORT
  )
}

/**
 * 把全部能力域编译成 deepagents 的 `subagents` 配置（双轨中的「委派」一轨）。
 *
 * 每个域 → 一个子代理，`isolated` 模式各自持有独立上下文（对齐 CodeBuddy agentic
 * 子代理「独立上下文窗口、不污染主会话」的语义）。
 * 传入 `createDeepAgent({ subagents })` 后，deepagents 会自动注入
 * `task({ description, subagent_type })` 工具供主 Agent 调用。
 *
 * 工具口径（A2）：子代理持有**本域白名单**工具（`d.tools`），而非继承全部工具。
 * 主 Agent 拿全量、子代理拿专域 —— 决策权在主 Agent，专注度在子代理。
 *
 * 安全口径（Fail-Closed）：每个子代理在**出场前**必须完整走一遍 {@link assertNoDelegationTools}
 * ——包括那些「连名字都拿不到、无法核验」的工具：它们与命中的 `task` 一样算违规，
 * 抛出并中止构建，而不是悄悄把一个可能递归委派的工具集交给 deepagents。
 * 没有工具的域不再被静默丢弃（`filter` 无声吞掉），而是显式告警留在日志里。
 */
export function buildDomainSubagents(domains: readonly DomainRuntime[]): DomainSubagentSpec[] {
  const specs: DomainSubagentSpec[] = []
  for (const d of domains) {
    if (d.tools.length === 0) {
      // 此前是无声 filter：域被丢掉后主 Agent 的委派选项少一个「同事」，且没有任何提示。
      console.warn(
        `[capability-domains] 能力域「${d.id}」没有解析到任何可用工具，已跳过子代理注册` +
          '（无工具的子代理无法交付，请检查该域的 toolIds 是否都在白名单内）。'
      )
      continue
    }
    // D1 防火墙（子代理 = depth 1）：域白名单里**不得**出现会再拉起 agent 的嵌套入口
    // （如 `task`），否则会形成 主 → 子 → 孙… 的递归委派、拓扑与成本失控。
    // 此前这里直接把 d.tools 交给 deepagents，防火墙只覆盖了主 Agent 的工具集，
    // 构成「主 Agent 校验了、子代理却没校验」的单边防线。
    const ownerId = `subagent:${d.id}`
    assertNoDelegationTools(ownerId, d.tools as { name?: string }[], { depth: SUBAGENT_DEPTH })
    // 运行期兜底：即便构建期校验被绕过（工具运行期改名等），调用也会被拒绝。
    const guarded = guardSubagentTools(ownerId, d.tools as GuardedTool[], { depth: SUBAGENT_DEPTH })
    // 出口复核：确保交出去的确实是上过闸的工具集，防止将来有人改回「直接塞 d.tools」。
    assertNoDelegationTools(ownerId, guarded, { depth: SUBAGENT_DEPTH })
    specs.push({
      name: d.id,
      description: buildSubagentDescription(d),
      systemPrompt: buildSubagentPrompt(d),
      tools: guarded,
      mode: 'isolated' as const
    })
  }
  return specs
}
