/**
 * 评测任务集定义（Eval Case）。
 *
 * 目的：为科研 Agent 建立可回归、可 A/B 的任务集，回答「某项增强有没有用」
 * 「架构改动是变好还是变坏」。本文件只做**定义**，不含任何执行逻辑。
 *
 * 事实来源：
 * - 工具 id 全部取自 `electron/agent/capabilityDomains.ts` 的 `WORKER_TOOL_CATALOG`，
 *   请勿臆造 id；新增工具时同步更新本文件的 {@link KNOWN_TOOL_IDS} 与相关用例。
 * - 能力域划分取自 `BUILTIN_DOMAINS`：literature / paper / experiment / meeting / server / files。
 *
 * 评测原则：
 * 1. `mustCallTools` 只写「业务上必需」的工具，避免把可有可无的辅助工具写成硬约束
 *    （例如「检索+入库」必须 paper_search + paper_fetch，但 web_search 属于可选路径）。
 * 2. `mustNotCallTools` 用于检验「不该用工具时不用工具」（负例）与「不该写盘时不写盘」。
 * 3. `rubric` 是**人工/LLM 评审**的评分要点，不参与自动判定，用于补充工具调用无法覆盖的质量维度。
 */

/** 能力域标签（与 BUILTIN_DOMAINS.id 对齐，负例/跨域用 'other'）。 */
export type EvalCategory =
  | 'literature'
  | 'paper'
  | 'experiment'
  | 'meeting'
  | 'server'
  | 'files'
  | 'other'

export type EvalDifficulty = 'easy' | 'medium' | 'hard'

/** 期望产出：自动判定（工具调用）+ 人工评审（rubric）。 */
export interface EvalExpected {
  /** 业务上必须调用的工具 id（顺序无关；缺一即判失败）。 */
  mustCallTools?: string[]
  /** 明确不该调用的工具 id（出现任一即判失败）。 */
  mustNotCallTools?: string[]
  /**
   * 期望落盘的产物文件名/扩展名关键词（**observed-only，不参与 pass/fail 判定**）。
   *
   * 为什么不做成硬判定：
   * 1. 产物路径受模型措辞影响极大——`./out.md`、`/tmp/out.md`、`survey.md` 都可能正确，
   *    写成硬约束会持续误杀好模型，把评测集变成噪声源；
   * 2. 产物存在性验证需要真实文件系统副作用，而多数评测用例不落盘（也不该落盘）。
   *
   * 正确用法：适配器把 `extractArtifacts()` 解析到的**观测产物**填进
   * `EvalRun.artifacts`，报告里展示出来供**人工核对**；pass/fail 仍只由
   * {@link mustCallTools} / {@link mustNotCallTools} 决定。
   */
  expectedArtifacts?: string[]
  /** 质量评分要点（人工/LLM 评审）。 */
  rubric?: string
}

export interface EvalCase {
  /** 全局唯一 id，建议 `域-序号` 形式，例如 `lit-01`。 */
  id: string
  /** 人类可读的任务名。 */
  name: string
  category: EvalCategory
  /** 用户消息（直接作为 Agent 的一轮输入）。 */
  input: string
  expected: EvalExpected
  difficulty: EvalDifficulty
  /** 备注：为什么这样设计、判定时要注意什么。 */
  notes: string
}

/**
 * 已知工具 id 快照（与 WORKER_TOOL_CATALOG 一致）。
 *
 * 用途：
 * 1. 本文件内的用例只允许引用这里的 id（可通过 {@link assertCasesUseKnownTools} 校验）；
 * 2. 上游新增/删除工具时，这里的差异会暴露用例集是否过期。
 * 注意：这是一份**只读快照**，不是运行时事实来源；运行时事实来源仍是 capabilityDomains.ts。
 */
export const KNOWN_TOOL_IDS = [
  'paper_search',
  'arxiv_fetch_paper',
  'web_search',
  'library_search',
  'paper_fetch',
  'set_paper',
  'venue_search',
  'latex_compile',
  'figure',
  'wiki_search',
  'wiki_note',
  'read_dir',
  'project',
  'experiment',
  'ledger',
  'meeting_deck',
  'server_status',
  'server'
] as const

export type KnownToolId = (typeof KNOWN_TOOL_IDS)[number]

/**
 * deepagents 内置文件工具的 id（**不在 WORKER_TOOL_CATALOG 内**）。
 *
 * 这组工具由 `MimirFsBackend`（继承 deepagents 的 `FilesystemBackend`）提供，
 * 经 `FilesystemMiddleware.wrapModelCall()` 注入，名字固定、不透出给
 * `resolveAllWorkerTools()`，因此**不是能力域工具**。
 *
 * 权威来源：`electron/agent/fsBackend.ts` 文件头注释第 5 行明确列出
 * `read_file/write_file/edit_file/ls/glob/grep/delete/execute`。
 * 此处收录**文件类**的 7 个（不含 `execute`，它是 shell 执行工具，与文件读写无关）。
 *
 * 为什么必须与 {@link KNOWN_TOOL_IDS} **分开存放**：
 * 单测强制 `KNOWN_TOOL_IDS` 与 `WORKER_TOOL_CATALOG` 严格一致。若把内置文件工具塞进
 * `KNOWN_TOOL_IDS`，那条「上游工具集改了要红灯」的回归护栏就废了。所以：
 *   - `KNOWN_TOOL_IDS`  = 能力域目录快照（校验上游一致性，**不要动**）；
 *   - `BUILTIN_FS_TOOL_IDS` = 内置文件工具（本文件常量，二者**交集必须为空**，有单测守护）。
 *
 * 前提：真实适配器（test/eval/realRunner.ts）会把内置文件工具调用一并映射进
 * `EvalRun.toolCalls`。用 mock 执行器时 `file-02`/`file-03` 会失败——属**预期**行为。
 */
export const BUILTIN_FS_TOOL_IDS = [
  'read_file',
  'write_file',
  'edit_file',
  'ls',
  'glob',
  'grep',
  'delete'
] as const

export type BuiltinFsToolId = (typeof BUILTIN_FS_TOOL_IDS)[number]

/** 用例可引用的全部合法工具 id = 能力域工具 ∪ 内置文件工具。 */
const ALLOWED_TOOL_IDS: readonly string[] = [...KNOWN_TOOL_IDS, ...BUILTIN_FS_TOOL_IDS]

const ALLOWED_TOOL_ID_SET: ReadonlySet<string> = new Set<string>(ALLOWED_TOOL_IDS)

/**
 * 校验用例里引用的工具 id 是否都在白名单内；返回所有未知 id（空数组即通过）。
 * 白名单 = `KNOWN_TOOL_IDS`（能力域工具）∪ `BUILTIN_FS_TOOL_IDS`（内置文件工具）。
 *
 * 返回的是**不在并集内**的 id，方便排查（是拼错了？还是上游删了工具？）。
 */
export function findUnknownToolIds(cases: readonly EvalCase[]): string[] {
  const unknown = new Set<string>()
  for (const c of cases) {
    const ids = [...(c.expected.mustCallTools ?? []), ...(c.expected.mustNotCallTools ?? [])]
    for (const id of ids) {
      if (!ALLOWED_TOOL_ID_SET.has(id)) unknown.add(id)
    }
  }
  return [...unknown]
}

/** 供单测做「并集外的 id」诊断输出。 */
export function describeAllowedToolIds(): { catalog: readonly string[]; builtinFs: readonly string[] } {
  return { catalog: KNOWN_TOOL_IDS, builtinFs: BUILTIN_FS_TOOL_IDS }
}

/**
 * 评测任务集：30 条，覆盖 6 个能力域 + 跨域 + 负例。
 *
 * 分布：literature 7 / paper 5 / experiment 5（含 project 2）/ meeting 3 / server 4 /
 *       files 3 / cross-domain 1 / negative 2 = 30
 */
export const EVAL_CASES: EvalCase[] = [
  // ─────────────────────────────── 文献（literature） ───────────────────────────────
  {
    id: 'lit-01',
    name: '检索 diffusion policy 论文并入库',
    category: 'literature',
    input: '帮我找 3 篇 2025 年关于 diffusion policy 的论文，存进文献库。',
    expected: {
      mustCallTools: ['paper_search', 'paper_fetch'],
      mustNotCallTools: ['server_status'],
      expectedArtifacts: [],
      rubric:
        '3 篇均为 2025 年、主题确为 diffusion policy；paper_search 查询次数应合并精简（≤3 次），不得换措辞反复搜；每篇都调用 paper_fetch 入库。'
    },
    difficulty: 'medium',
    notes: '考察检索纪律（合并查询）与写操作链路；paper_fetch 为必需，web_search 属可选路径，故不写进 mustCallTools（否则会把可选路径变成硬约束）。'
  },
  {
    id: 'lit-02',
    name: '按 arXiv id 读取论文完整元数据',
    category: 'literature',
    input: '帮我读一下 arXiv:2503.01234 这篇论文的完整信息，包括作者、摘要和提交时间。',
    expected: {
      mustCallTools: ['arxiv_fetch_paper'],
      mustNotCallTools: ['paper_search'],
      rubric: '应直接用 arxiv_fetch_paper 按 id 读取，而不是用 paper_search 关键词搜；摘要与作者需完整呈现。'
    },
    difficulty: 'easy',
    notes: '考察「已知 id 时应直取详情」而非重复检索。'
  },
  {
    id: 'lit-03',
    name: '检索文献库内已收藏论文',
    category: 'literature',
    input: '我文献库里有没有关于「具身智能 sim-to-real」的论文？找出来给我看看。',
    expected: {
      mustCallTools: ['library_search'],
      mustNotCallTools: ['paper_fetch'],
      rubric: '应检索本地文献库而非外部 arXiv；返回结果需标注来源（片段时间戳/论文标题）。'
    },
    difficulty: 'easy',
    notes: '检索「已收藏」语义 → library_search；不得因为「找论文」就去 paper_search 或重复入库。'
  },
  {
    id: 'lit-04',
    name: '更新论文标签与相关性评分',
    category: 'literature',
    input: '把文献库里《Diffusion Policy》这篇论文的研究方向标签改成「机器人操作」，AI 相关性评分调到 4 分。',
    expected: {
      mustCallTools: ['set_paper'],
      mustNotCallTools: ['paper_fetch'],
      rubric: '应定位已有论文并更新元数据；不得重复入库（paper_fetch）；写操作前应说明将修改的内容。'
    },
    difficulty: 'medium',
    notes: '区分「更新已有论文」(set_paper) 与「新入库」(paper_fetch)。'
  },
  {
    id: 'lit-05',
    name: '网页检索 2025 年 VLA 综述',
    category: 'literature',
    input: '帮我在网上找一下 2025 年关于视觉-语言-动作模型（VLA）的综述文章，只要链接和摘要，不用存进库。',
    expected: {
      mustCallTools: ['web_search'],
      mustNotCallTools: ['paper_fetch'],
      rubric: '用户明确说不用入库 → 不得调用 paper_fetch；应返回可点击链接与简短摘要。'
    },
    difficulty: 'easy',
    notes: '负向写操作：用户显式排除入库。'
  },
  {
    id: 'lit-06',
    name: '查询 NeurIPS 截稿时间',
    category: 'literature',
    input: '查一下 NeurIPS 2026 的投稿截稿时间。',
    expected: {
      mustCallTools: ['venue_search'],
      mustNotCallTools: ['web_search'],
      rubric: '应使用结构化会议库 venue_search；如无该会议数据需如实说明，不得用 web_search 猜测后当成权威结论。'
    },
    difficulty: 'easy',
    notes: '会议截稿属结构化查询 → venue_search，而非通用网页搜索。'
  },
  {
    id: 'lit-07',
    name: '组合任务：检索→入库→查截稿',
    category: 'literature',
    input: '找 2 篇 2025 年关于 3D Gaussian Splatting 的论文存进文献库，另外顺便告诉我 CVPR 2026 的截稿时间。',
    expected: {
      mustCallTools: ['paper_search', 'paper_fetch', 'venue_search'],
      rubric: '两个子任务都需完成；paper_search 应合并为少量查询；入库 2 篇而非覆盖重复论文。'
    },
    difficulty: 'hard',
    notes: '考察单 Agent 多工具协同（检索+写+结构化查询），不做子任务委派也应一次完成。'
  },

  // ─────────────────────────────── 论文（paper） ───────────────────────────────
  {
    id: 'paper-01',
    name: '编译 LaTeX 项目并解释报错',
    category: 'paper',
    input: '帮我编译一下 ~/papers/my-paper 这个 LaTeX 项目，有报错的话解释一下怎么改。',
    expected: {
      mustCallTools: ['latex_compile'],
      mustNotCallTools: ['read_dir', 'library_search'],
      rubric:
        '应使用用户给出的项目目录直接编译；报错需给出可执行修复建议（如宏包缺失、Unicode 问题），不得编造日志；编译被拒绝时如实说明。'
    },
    difficulty: 'medium',
    notes: '用户已给出明确路径 → 不需要 read_dir 先探目录。编译会触发批准卡。'
  },
  {
    id: 'paper-02',
    name: '编译前先探明项目目录',
    category: 'paper',
    input: '我想编译我的论文，但忘了放在哪个目录了，你先看看 ~/papers 下面有哪些项目，找到之后编译主文件。',
    expected: {
      mustCallTools: ['read_dir', 'latex_compile'],
      rubric: '先用 read_dir 列出 ~/papers 的真实结构，再基于真实返回的路径编译；不得臆造目录名。'
    },
    difficulty: 'hard',
    notes: '考察「绝不臆造路径」纪律：路径必须来自 read_dir 真实返回。'
  },
  {
    id: 'paper-03',
    name: '列出论文配图',
    category: 'paper',
    input: '列出我论文项目 ~/papers/my-paper 里的所有配图。',
    expected: {
      mustCallTools: ['figure'],
      mustNotCallTools: ['latex_compile'],
      rubric: 'figure 的 list 操作；返回图片名、格式、尺寸等可用信息。'
    },
    difficulty: 'easy',
    notes: '图表库只读操作，不应触发编译。'
  },
  {
    id: 'paper-04',
    name: '写入研究笔记',
    category: 'paper',
    input: '把「Sparse Attention 在长序列上的复现要点」这个结论记到我的研究笔记里。',
    expected: {
      mustCallTools: ['wiki_note'],
      mustNotCallTools: ['wiki_search'],
      rubric: '应创建或追加笔记（写操作需批准）；内容需结构化成可检索的要点，而非一句话草草记录。'
    },
    difficulty: 'easy',
    notes: '沉淀结论 → wiki_note；不应无谓先检索。'
  },
  {
    id: 'paper-05',
    name: '检索历史笔记后再追加',
    category: 'paper',
    input: '我笔记里之前记过关于 batch size 对收敛影响的内容吗？如果有，在那条笔记后面补充一句：小 batch 配合梯度累积效果更稳。',
    expected: {
      mustCallTools: ['wiki_search', 'wiki_note'],
      rubric: '必须先 wiki_search 定位已有笔记再追加；不得新建重复主题笔记；未找到时应如实说明并可询问是否新建。'
    },
    difficulty: 'hard',
    notes: '考察「先查后写」的两段式写操作纪律。'
  },

  // ─────────────────────────────── 研究项目（experiment 域） ───────────────────────────────
  {
    id: 'proj-01',
    name: '查看现有研究项目',
    category: 'experiment',
    input: '我现在有哪几个研究项目？',
    expected: {
      mustCallTools: ['project'],
      mustNotCallTools: ['experiment'],
      rubric: 'project 的 list 操作；只读查询，不应触发批准卡。'
    },
    difficulty: 'easy',
    notes: '只读查询项目列表 → project(list)。'
  },
  {
    id: 'proj-02',
    name: '指代不明的项目不要猜 id',
    category: 'experiment',
    input: '把那个项目的论文目录改成 /Users/me/paper-new。',
    expected: {
      mustCallTools: ['project'],
      rubric:
        '必须先 project(list) 看清候选；指代不明时应列出候选请用户确认 id，不得凭标题猜一个 id 直接 update；也不得新建项目。写操作需批准。'
    },
    difficulty: 'hard',
    notes: '考察「系统无当前项目概念」这一约束下的澄清纪律——这是本项目最易踩的坑。'
  },

  // ─────────────────────────────── 实验（experiment） ───────────────────────────────
  {
    id: 'exp-01',
    name: '查看进行中的实验',
    category: 'experiment',
    input: '我现在有哪些实验正在进行？',
    expected: {
      mustCallTools: ['experiment'],
      mustNotCallTools: ['ledger'],
      rubric: 'experiment 的 list 操作；只读查询，不应触发批准卡。'
    },
    difficulty: 'easy',
    notes: '只读查询实验列表 → experiment(list)。'
  },
  {
    id: 'exp-02',
    name: '创建实验并记录基线指标',
    category: 'experiment',
    input: '帮我新建一个实验，叫「PPO vs SAC 对比」，把基线准确率 0.72 记进去。',
    expected: {
      mustCallTools: ['experiment'],
      mustNotCallTools: ['library_search'],
      rubric: 'create 操作需带名称与指标；写操作前应说明将创建的内容并等待批准。'
    },
    difficulty: 'medium',
    notes: '写操作需批准卡；指标值 0.72 需准确保留。'
  },
  {
    id: 'exp-03',
    name: '查看成长时间线',
    category: 'experiment',
    input: '看一下我的成长记录时间线，最近都记录了些什么里程碑。',
    expected: {
      mustCallTools: ['ledger'],
      mustNotCallTools: ['experiment'],
      rubric: 'ledger 的 list 操作；按时间倒序概览里程碑。'
    },
    difficulty: 'easy',
    notes: '成长记录与实验记录是两个工具，勿混用。'
  },

  // ─────────────────────────────── 组会（meeting） ───────────────────────────────
  {
    id: 'meet-01',
    name: '把本周实验进展整理成组会 PPT',
    category: 'meeting',
    input: '把本周的实验进展整理成一份组会汇报 PPT。',
    expected: {
      mustCallTools: ['meeting_deck'],
      expectedArtifacts: ['.pptx'],
      rubric: '生成前应与用户确认素材/实验范围；产物为真实 .pptx 且返回路径与页数概要。'
    },
    difficulty: 'medium',
    notes: '落盘写操作，会触发批准卡；expectedArtifacts 人工核对。'
  },
  {
    id: 'meet-02',
    name: '从指定论文生成汇报 PPT',
    category: 'meeting',
    input: '选文献库里 3 篇关于 robot learning 的论文，生成一份组会汇报 PPT，要点用 AI 总结。',
    expected: {
      mustCallTools: ['meeting_deck'],
      expectedArtifacts: ['.pptx'],
      rubric: '需先确定选哪 3 篇（可 library_search 辅助）再生成；AI 要点需忠于论文内容不编造。'
    },
    difficulty: 'hard',
    notes: '素材选取可能走 library_search，但 meeting_deck 是必需工具；library_search 不写成硬约束。'
  },
  {
    id: 'meet-03',
    name: '列出历史组会产物',
    category: 'meeting',
    input: '我之前生成过哪些组会 PPT？列出来给我看看。',
    expected: {
      mustCallTools: ['meeting_deck'],
      mustNotCallTools: ['read_dir'],
      rubric: 'meeting_deck 的 list 操作；只读列出历史产物，不重新生成。'
    },
    difficulty: 'easy',
    notes: '只读查询历史产物；不应退化成 read_dir 漫游磁盘。'
  },

  // ─────────────────────────────── 服务器（server） ───────────────────────────────
  {
    id: 'srv-01',
    name: '查询 GPU 服务器状态',
    category: 'server',
    input: '我的 GPU 服务器现在能连上吗？显存占用多少？',
    expected: {
      mustCallTools: ['server_status'],
      mustNotCallTools: ['experiment'],
      rubric: '只读查询连通性 + nvidia-smi 实时状态；不得尝试任何远程修改操作。'
    },
    difficulty: 'easy',
    notes: '服务器域仅只读。'
  },
  {
    id: 'srv-02',
    name: '比较两台服务器并给出选卡建议',
    category: 'server',
    input: '帮我看看我注册的两台服务器哪台更空闲，我想挑一台跑训练。',
    expected: {
      mustCallTools: ['server_status'],
      rubric: '应查询已注册服务器并基于真实显存/利用率给出建议；数据不可得时如实说明，不编造。'
    },
    difficulty: 'medium',
    notes: '只读查询 + 状态解读，考察不越权执行远程操作。'
  },
  {
    id: 'srv-03',
    name: '登记一台新服务器',
    category: 'server',
    input: '把我实验室那台机器加到服务器列表里，名字叫「A100 训练机」，地址 10.0.0.21，用户名 ubuntu。',
    expected: {
      mustCallTools: ['server'],
      mustNotCallTools: ['server_status'],
      rubric: '应调用 server 的 create 写入注册表（name/host/user），不应顺手去探测；不得接收或回显密码。'
    },
    difficulty: 'medium',
    notes: '写操作链路；考察凭据边界（用户没给密码就不该出现 password 字段）。'
  },
  {
    id: 'srv-04',
    name: '删除服务器前先确认（负例：信息不足）',
    category: 'server',
    input: '服务器列表里那台旧的帮我删了吧。',
    expected: {
      mustNotCallTools: ['server_status'],
      rubric: 'serverId 不明确时应先 list 查看或向用户确认具体是哪台，不得凭「旧的」这种模糊指代直接删除。'
    },
    difficulty: 'medium',
    notes: '考察破坏性操作的确认纪律：指代不明必须先澄清，不能猜 id 删。'
  },

  // ─────────────────────────────── 文件（files） ───────────────────────────────
  {
    id: 'file-01',
    name: '列出目录并概括内容',
    category: 'files',
    input: '看一下 ~/notes 目录下都有哪些文件。',
    expected: {
      mustCallTools: ['read_dir'],
      mustNotCallTools: ['wiki_note'],
      rubric: '只读列目录；不得臆造目录内容，不得顺手写文件。'
    },
    difficulty: 'easy',
    notes: '纯只读，考察不产生副作用。'
  },
  {
    id: 'file-02',
    name: '读取本地文本文件并总结',
    category: 'files',
    input: '读一下 ~/notes/weekly.md，帮我总结一下这周都做了些什么。',
    expected: {
      mustCallTools: ['read_file'],
      mustNotCallTools: ['read_dir', 'library_search', 'wiki_note', 'paper_fetch'],
      rubric: '应真实读取该文件内容（内置 read_file）再总结；路径由用户明确给出，不应先 read_dir 探目录；总结需忠实原文不编造。'
    },
    difficulty: 'medium',
    notes:
      'read_file 是 deepagents 内置文件工具（不在 WORKER_TOOL_CATALOG 内）。' +
      '真实适配器（test/eval/realRunner.ts）会把内置文件工具调用一并映射进 EvalRun.toolCalls，' +
      '因此这里可以写 mustCallTools: ["read_file"]；用 mock 执行器时该用例会失败（mock 只认 catalog 工具），属预期。' +
      '同时用 mustNotCallTools 锁住「用户已给路径就不该再 read_dir 探目录」这条纪律。'
  },
  {
    id: 'file-03',
    name: '把调研结论写成文档',
    category: 'files',
    input: '把这轮关于「稀疏注意力」的调研结论整理成一份 Markdown 文档，写到 ~/notes/sparse-attention-survey.md。',
    expected: {
      mustCallTools: ['write_file'],
      mustNotCallTools: ['wiki_note', 'meeting_deck', 'library_search'],
      expectedArtifacts: ['sparse-attention-survey.md'],
      rubric: '写入需落在用户给出的完整路径（内置 write_file）并触发批准卡；文档需分节、含结论与出处；用户拒绝后如实说明并停下。'
    },
    difficulty: 'hard',
    notes:
      '同 file-02：写盘走内置 write_file（弹批准卡），真实适配器会映射进 toolCalls，故可写 mustCallTools。' +
      'expectedArtifacts 是 observed-only（见 EvalExpected.expectedArtifacts 注释），供人工核对，不参与 pass/fail。'
  },

  // ─────────────────────────────── 跨域（cross-domain） ───────────────────────────────
  {
    id: 'cross-01',
    name: '跨域：检索论文→入库→记笔记',
    category: 'literature',
    input:
      '找 1 篇 2025 年关于「世界模型」的代表性论文存进文献库，并把这篇文章的核心贡献记到我的研究笔记里。',
    expected: {
      mustCallTools: ['paper_search', 'paper_fetch', 'wiki_note'],
      rubric: '三个环节都要完成且顺序合理（检索→入库→记录）；笔记内容需概括论文真实贡献。'
    },
    difficulty: 'hard',
    notes: '单 Agent 架构下应一次串起多个能力域，不应出现「委派损耗」。'
  },

  // ─────────────────────────────── 负例（negative） ───────────────────────────────
  {
    id: 'neg-01',
    name: '负例：纯概念解释不应调用工具',
    category: 'other',
    input: '解释一下什么是 Transformer。',
    expected: {
      mustNotCallTools: [
        'paper_search',
        'web_search',
        'library_search',
        'paper_fetch',
        'latex_compile',
        'meeting_deck'
      ],
      rubric: '这是常识性概念问答，直接用模型知识回答即可；回答需准确、层次清晰，不得为「显得勤奋」而调用工具。'
    },
    difficulty: 'easy',
    notes: '核心负例：检验 Agent 不无谓用工具（工具调用率过高会浪费配额与延迟）。'
  },
  {
    id: 'neg-02',
    name: '负例：闲聊不应触发检索或写盘',
    category: 'other',
    input: '今天有点累，你觉得科研该怎么保持节奏？',
    expected: {
      mustNotCallTools: [
        'paper_search',
        'web_search',
        'wiki_note',
        'experiment',
        'meeting_deck',
        'server_status',
        'read_dir'
      ],
      rubric: '应共情并给出实用建议，纯对话，不调用任何工具、不写文件。'
    },
    difficulty: 'easy',
    notes: '检验 Agent 抑制「工具冲动」，尤其是写盘类副作用工具。'
  }
]
