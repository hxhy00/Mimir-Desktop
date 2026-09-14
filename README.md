<p align="center">
  <img src="src/assets/logo.png" alt="Mimir Desktop" width="120" />
</p>

<h1 align="center">Mimir Desktop</h1>

<p align="center"><b>以 Agent 为核心的一站式科研工作台 · 桌面版</b></p>

<p align="center">文献 · 论文 · 实验 · 图表 · 组会 · 会议截稿 · GPU 服务器 · Agent 语音 —— 覆盖科研全生命周期</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-33-blue" alt="Electron" />
  <img src="https://img.shields.io/badge/React-18-blueviolet" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-blue" alt="TypeScript" />
  <img src="https://img.shields.io/badge/DeepAgents-purple" alt="DeepAgents" />
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License" />
</p>

> **Mimir Desktop** 是 [dsh-Mimir-Academic-research](https://github.com/1692775560/dsh-Mimir-Academic-research)（Mimir 的一站式科研工作台）的**独立桌面发行版**。
> 父项目以 DeepSeek Harness (dsh) 为宿主、以插件形态运行于 `dsh web`；本项目把它工程化重写为**开箱即用的 Electron 桌面应用** ——
> 自带主进程 / 渲染进程 / IPC 与本地协议层，无需安装 dsh、无需自起后端，下载安装即可启动。

---

## 演示视频

> **尚未录制** —— 此处为预留插槽。录制后把下方 `<source src>` 替换为实际地址即可显示。
> 两种放法任选其一：
> - **本地文件**：将影片放入仓库（如 `docs/demo.mp4`），并把 `src` 改为 `docs/demo.mp4`；
> - **在线直链**：上传到公网后填写直链。

```html
<video controls width="820">
  <source src="PATH_TO_YOUR_VIDEO.mp4" type="video/mp4" />
  你的浏览器不支持 video 标签。
</video>
```

> 你也可以在其中夹层展示应用截图作静态预览。

---

## 功能特性

以 **DeepAgents (LangChain/LangGraph)** 为核心，采用**单 Agent + 职业角色工具集 + 可选委派子代理**（主 Agent 默认直接持有全部科研工具、自己规划执行；遇到属于某位「同事」职责、可独立完成的整块工作时，可自主把它委派出去），用自然语言无侵入驱动整条科研工作流。

### Agent 对话与上下文治理

- **单 Agent + 职业角色工具集**：一个 Agent 直接持有全部科研工具，按任务自行选择调用（工具行按「职业角色」打标签，过程可读）；支持 Markdown、流式输出、气泡内**执行过程轨迹卡**，会话管理 / 历史（重命名 / 置顶）本地持久化。
- **轻量委派（子代理 = 专业同事）**：每个职业角色同时编译为一个 `isolated` 子代理（独立上下文、只见委派任务、结果以 ToolMessage 回传），主 Agent 通过 deepagents 注入的 `task` 工具**自主决定是否委派**——单次工具调用就能解决的小事自己直接做，需要多步工具接力的整块工作才派出去（对齐 WorkBuddy / Trae 的默认形态）。委派期间渲染层时间线把子代理内部步骤折叠到「委派」节点下（带角色标签），批准卡标注「来自角色：X」；「防嵌套防火墙」限制委派深度为 1（主 Agent 可委派、子代理不得再委派），杜绝递归委派导致拓扑失控。
- **对话内产物验收**：Agent 回复过程中落盘的文件（PPT / PDF / 配图 / 数据等）会自动从工具返回中识别，在气泡下方以**产物卡**列出（类型图标 + 文件名 + 大小），支持「打开」与「打开所在文件夹」；识别只认磁盘上真实存在且扩展名在白名单内的绝对路径，避免把示例路径误判为产物。
- **多会话并行（后台任务）**：不同会话可同时生成回复，互不阻塞——A 会话在跑时可切到 B 会话继续提问；侧栏对正在生成的会话显示转圈标记；停止生成按会话生效，只影响目标会话。窗口关闭时中止全部后台任务。
- **可选 Ultra 增强控制器**（Agent 之上的增强总开关，默认关闭以控制 token）：自动或手动选择增强策略——多专家合议(K 路评审→共识/分歧→反思) / 批判迭代(草稿→批判→修订) / 混合增强(关键判断点合议+整体批判) / 一致性投票(轻量 SC 选最优)；策略带 cost 标签，上下文过长**按真实 token** 自动降级（降级即「本次不增强」，不塞无效提示词），选型轨迹可回溯，执行动作全部下沉 Agent，分歧点由工具核验。
  > 原「普通增强（plain，仅注入一段长程规划约束）」已按 A/B 实测移除：配对 18 条用例上 0 例修复 / 1 例回归，token +43.4%、工具调用 +85.7%。它能改的不是判断力而是「勤快度」，反而推高撞上「不该调的工具」的概率。**不需要增强时就不介入**，而不是注入一段确定有害的文本。
- **会话上下文治理（主进程侧）**：滑动窗口、超限时的**分段结构化摘要压缩**、压缩熔断降级、原文归档、失效提醒、压缩后能力声明重建，全部由主进程 `electron/agent/contextManager.ts` 统一完成（渲染层只传「原始历史 + 技能目录」）；阈值以**真实 token** 计量（不再是字符数估算），中文/英文/代码的预算口径一致；工具返回与增强子产物不沉淀历史；删除 / 改名等破坏性操作触发会话级**失效提醒**，防止跨轮复述旧对象。
- **工具纪律与交付门禁**：`subagentResult.ts` 的三条交付门禁（多步任务不得只做第一步 / 更新已有对象 ≠ 新建 / 结构化数据必须用结构化工具）来自基线实测的高频失败模式，`capabilityDomains.ts` 按能力域给出使用纪律。
  > **一条有实测支撑的经验**：写「禁止 X」会稳定生效，写「允许 X」会被忽略 —— 过度收紧会把**必需**的工具调用一起压掉。因此禁令要把作用域写窄（「**检索学术论文时**别用 web_search 顶替 paper_search」），而「什么时候该用某个工具」要写进**工具自身的描述**（模型选工具时读的是它），不能只写进 systemPrompt 规则。数据见 `test/eval/README.md` 的配对分析②③。
- **永久身份常量**：在「设置 → 身份与默认值」维护科研身份 / 交互语言 / 写作语言等几乎不变的 identity，作为极小 system 段每轮恒定注入、保存即生效；默认不注入任何内容，自动学习永不写入该层。
- **交流语言一致性（每轮前置注入）**：身份常量只作用于会话开头的 systemPrompt，对多轮工具循环的**中间轮次**约束力不足——实测表现为「最终回答是中文，但工具调用之间的过程叙述整段英文」（"Let me check..." / "Now I'll..."）。因此「交流语言」由 `electron/agent/languageMiddleware.ts` 作为中间件在**每次模型调用时**读取最新设置并前置注入 systemMessage 顶部：覆盖正文、计划说明、进度更新与错误解释，禁止中英混杂旁白（专有名词 / 代码 / 论文标题保留原文）；改设置免重启即生效。
  > 另一实测漏点是**「英文材料 → 英文总结」**：任务上下文全是英文论文/代码时，模型会把最终总结也滑回英文。指令对此显式点名——即使材料是英文，总结正文仍必须用中文书写，仅引用原文术语/标题/代码时保留英文（单测锁定该条款存在，防回退）。
- **长期记忆档案**：全局记忆默认不注入，仅当任务相关时由 Agent 调用 `load_memory` 按需读取（「设置 → 长期记忆」维护）。
- **语音输入**：对话输入框支持语音转文本——本地 **SenseVoice**（sherpa-onnx，Electron 主进程离线识别，可下载模型）或浏览器 **Web Speech** 引擎，在「设置 → 语音与资源」切换。

### 权限与安全（沙箱档位 × 三态批准）

Agent 拥有真实磁盘读写，因此权限模型决定「它能不问自取地动哪里」。改动前是「一刀切」——写入一律弹批准卡；科研用户一天写二十个文件要点二十次，结果是**批准疲劳**（无脑点是），安全性反而下降。现在改为**策略矩阵 + 三态批准**：

- **沙箱档位**（「设置 → 权限与安全」）：只读档（禁止一切写盘）/ **工作区可写（默认）** / 全权档（控制平面除外）；决策顺序即优先级，见 `electron/agent/permissions.ts`。
- **空间内免批准**：科研空间是用户自己的资料库，在里面产出笔记 / 图表 / PPT / 编译产物默认**不打扰**（可开关「空间内也要确认」）。
- **「允许并记住此目录」**：批准卡从「拒绝 / 允许一次」升级为三态。点记住即把这一次放行升级为**这一类的允许**，后续同类动作不再弹卡；已记住的目录在设置页可随时撤销。
- **路径口径统一**：判定、空间根、允许列表三处都用**磁盘实体路径**（`realpath`）。macOS 上 `/var → /private/var` 是软链，口径不一致会造成「记住了却照样弹卡」与「空间内被误判成空间外」，软链也会成为绕过前缀匹配的口子。
- **业务卡的档位感知**：文献入库 / PPT 生成 / LaTeX 编译这类「业务副作用卡」曾绕过沙箱档位无条件弹卡，导致设了全权档仍被反复打断（档位形同虚设）。现统一走 `requireBusinessApproval`：**全权档下非破坏性动作自动放行**（审计照记，与人工允许可区分），**删除类操作任何档位都弹卡**（误删没有后悔药，风险不对称）；判定只看批准卡 `summary` 前缀（删除 / 移除 / 清空），避免 detail 里的解释性文字（如「不会删除你的源文件」）被误判成破坏动作。见 `electron/agent/approval.ts`。
- **审计日志**：每次文件读写的判定与用户裁决都落盘（工具 / 路径 / 决定 / 时间），设置页可回看。**这是把「每次都问」换成「问一次」的前提**——放行必须可追溯，否则等于交进黑箱。
- **控制平面永远硬拒绝**：`~/.mimir`、应用配置目录（settings / 能力域与技能定义、运行时凭据）不参与任何允许列表，**全权档也不放行、也不弹卡**（不给出「用户误点同意」的机会）。理由见 `electron/agent/controlPlane.ts`：那是 Agent 给自己加工具的提权入口。
- **渲染层不等于可信**：上述矩阵只约束 Agent 的写盘路径；渲染层另有 `fs:readFile` / `fs:writeFile` 通道，**曾被无校验地透传给 `fs`** —— 任何被注入的渲染内容都能借它读走整块磁盘，与 Agent 侧形成两条口径不一的旁路。现改为**白名单/边界收口**：读只放行「用户在原生文件对话框里显式选择过」的文件，写只放行科研空间根目录内（见 `electron/ipc/index.ts` 的 `assertRendererFilePath`）。**判断放在主进程**，渲染层的判断只是 UX，不作为信任依据。
- **外链协议白名单**：`shell.openExternal` 会把 URL 原样交给操作系统，`file:` / 自定义 scheme 都可能产生系统侧副作用；链接可能来自模型返回的 Markdown（不可信输入）。窗口层的 `setWindowOpenHandler` 与 IPC 层的 `shell:openExternal` **共用同一份白名单**（仅 http(s)，见 `electron/safeUrl.ts`），杜绝两处口径漂移。
- **子代理工具上防**：委派链路的防火墙按层级判定——主 Agent（depth 0）可持 `task` 作为委派入口，子代理（depth ≥ 1）禁止，否则会形成「主 → 子 → 孙…」的递归委派。该约束**在能力域编译成子代理时逐域施加**（`buildDomainSubagents`），而非只覆盖主 Agent 工具集（见 `electron/agent/delegationFirewall.ts`）。

### 技能分层路由（Skill Router）

技能以元数据注册（L3 目录 / tags / 适用边界 / 反例 / 成本 / 会话次数），每轮 Meta-Cognition 意图识别 → 规则粗召回 →(可配) **向量精排**（embedding 相似度，复用当前对话模型的接口与 Key，模型名在「设置 → 技能路由」配置）→ 只把 **top-K 候选**注入给 Agent，替换原先的全量技能目录注入；手动 `/技能` 直通绕过；自定义技能缺字段自动推导、缺关键字段拒绝注册。相比原先的 LLM 精排，把每轮 2 次 LLM 调用降到 1 次；网关无 embeddings 接口时自动回退规则排序，不影响正常对话。

### 科研空间

目录制多空间（默认 `~/Mimir/<空间名>`，可自选任意目录），每个空间独立承载论文 / 实验 / 图表 / 组会 / 对话等研究数据；基础设置（模型 / 主题 / 服务器）全局共享；支持切换当前空间、设定默认与启动恢复；旧版单目录数据自动迁移进默认空间；首次使用三步引导（选空间 → 模型 → 外观）。

### 功能模块

| 模块 | 说明 |
|---|---|
| **对话 `chat`** | Agent 自然语言总入口（含语音输入、技能与指令菜单） |
| **总览 `overview`** | 研究总览——各模块（论文 / 实验 / 记录 / 图表…）统计指标聚合 |
| **文献库 `library`** | arXiv + Web 双来源搜索，项目关联、标签、AI 相关性评分、内嵌 PDF 阅读器 + 阅读笔记、BibTeX 导出、arXiv 订阅、Zotero 集成 |
| **论文 `paper`** | 以文件夹为项目的 LaTeX 工作区——打开 / 新建项目，多 `main.tex` & 章节文件多标签编辑（语法高亮 + 行号跳转），latexmk / Tectonic 真实编译，错误 / 警告诊断点击跳行，`main.pdf` 内嵌预览；引擎缺失可在「设置 → 语音与资源」下载内置 Tectonic 单文件引擎 |
| **论文增强** | 编译成功自动快照（列表对比 `main.tex` 差异并可一键回退），错误行一键 AI 修复并自动重编译，`references.bib` 结构化编辑，会议排版模板注入 |
| **实验 `experiments`** | 实验记录、指标可视化、训练进度跟踪 |
| **图表 `figures`** | 图片上传落盘（`mimir-img` 协议内联预览），一键复制 LaTeX 代码；从 PDF 提取论文内嵌图、重命名并预览后同步 LaTeX 引用；图片存入图表库供组会 AI 配图复用 |
| **组会 `meetings`** | 从项目论文与实验记录生成真实 16:9 `.pptx`（封面 / 目录 / 文献分享 / 实验结果 / 下一步计划），AI 相关度排序选文、AI 要点提炼（可选），产物统一管理；可选 AI 配图（数据存图表库） |
| **服务器 `servers`** | SSH 远程连接，nvidia-smi 实时 GPU / 显存监控，内置远程终端 |
| **记录 `ledger`** | 成长记录时间线（里程碑 / 论文 / 实验等），本地持久化、可删除 |
| **会议截稿 `venues`** | ccfddl 会议截稿目录（本地缓存优先、启动自动抓取 + 6h 定时 / 手动刷新，离线可用），领域 / CCF 等级 / 时间窗过滤、倒计时高亮、关注星标；内置 CCF-A 期刊目录 |
| **插件 `plugins`** | 统一管理指令 / 技能 / 能力域 / 插件 / Hooks（增删改查 + 启停开关，本地持久化） |
| **设置 `settings`** | 模型（LLM 管理 · 图像生成端点 · `/v1/models` 自动发现）/ 外观 / Agent（技能路由 · 身份与默认值 · 长期记忆）/ **权限与安全** / 科研空间 / 语音与资源 / 关于 |

### 模型自动发现

「设置 → 模型 → 添加模型」支持按 `baseUrl` + API Key 自动拉取 OpenAI 兼容端点的 `/v1/models`：

- **URL 归一化**：自动补齐 / 去重 `/v1`，兼容末尾 `/` 与直接填写完整 `/v1/models` 的情况。
- **宽松响应解析**：兼容标准 OpenAI 格式、纯数组、`models` 字段等；缺 `id` 的条目自动跳过，空列表给出明确提示。
- **安全**：API Key 仅通过 `Authorization` 头发送，不写日志、不回显到错误信息。
- **错误处理**：覆盖无效 URL、网络不可达、401/403、端点不支持、超时、格式异常等情况。
- **多选批量添加**：发现结果可勾选多个模型（支持全选）一次性写入；按 `baseUrl + modelId` 自动跳过已存在项；批量添加不做逐条连通测试（发现成功即证明端点与 Key 可达）。

### 本地只读协作桥接

`electron/plugins/bridge.ts` 在 Electron 主进程中起一个 HTTP 服务，**只绑定 `127.0.0.1`**，把端口与确认令牌写入 `~/.mimir/bridge.json`，供本机其它进程查询 Mimir 的科研数据。

- **只暴露只读查询**：早期面向外部 agent 宿主插件的写入路由**已全部下线**——多宿主（harness）集成本身已取消；确认令牌只能证明调用方读过 `~/.mimir/bridge.json`（同机任意进程都能读），无法构成远程鉴权，因此把危险面整体移除，而不是去加固一个挡不住的令牌。
- **IPC**：`bridge:start` / `bridge:stop` / `bridge:status`。

> 写入能力（库导入 / 组会生成 / 服务器执行 / 论文编辑）不在桥接层提供；所有写盘与副作用统一走对话内的批准卡。

### 插件模块（指令 / 技能 / 能力域 / 插件 / Hooks）

- **指令 / 技能**：内置只读；**自定义指令与技能**支持弹窗导入（手动表单或粘贴 JSON）与删除，导入即落盘生效；增删后重进「对话」自动刷新斜杠菜单。
- **能力域（= 职业角色）**：Agent 可委派的**专业同事**管理界面——内置 5 个角色（研究员 / 写作编辑 / 实验管理员 / 汇报助理 / 运维工程师）只读展示、可「克隆」改造；支持 **AI 生成**（一句话描述职责草拟 name / 说明 / 纪律 / 工具白名单）；自定义能力域可增删改查 + 启停，从**内置工具白名单**勾选工具并自写使用纪律；保存 / 切换启停自动「重载 Agent」（按最新能力域配置重新初始化）免重启；副作用仍走批准卡。
  > 角色按**职责结果**划分，而不是按工具种类划分 —— 一个角色 = 一类要对结果负责的工作（如「研究员」对「问题搞清楚了没有」负责，「实验管理员」对「数据管住了没有」负责）。因此归档类工具（`paper_fetch` / `set_paper`）归实验管理员而非检索性质的「研究员」；跨职责的任务由主 Agent 自己拆分（先调研、再归档）。每个角色的提示词是一份岗位说明书：身份 / 精通什么 / 工作准则 / **不做什么** / 交付格式。
- **插件 / Hooks**：注册与管理界面（启用开关 / 描述 / 配置）；运行时消费尚未接入，当前作为能力清单管理。

---

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | Electron 33 |
| 构建工具 | electron-vite 2 + electron-builder |
| UI 框架 | React 18 + TypeScript |
| 样式 | Tailwind CSS 3 + Shadcn-UI |
| Markdown | react-markdown + remark-gfm |
| Agent 引擎 | DeepAgents (LangChain / LangGraph) |
| PPT 渲染 | PptxGenJS 4 |
| LaTeX | latexmk / Tectonic |
| 远程终端 | @xterm/xterm + node-pty |
| 语音 | sherpa-onnx (SenseVoice) / Web Speech |
| 数据存储 | 双层 JSON Store（全局设置 + 科研空间） |
| 文献检索 | OpenAlex（主源）+ Semantic Scholar（标题精确匹配，辅助）+ arXiv API（新鲜预印本补充 / 最新提交排序） |
| 测试 | Vitest（契约 / 网关探测 / 无头冒烟 / 上下文治理）+ 科研 Agent 评测集（`test/eval`）+ Node 模块自检 |
| 本地协作 | 只读 HTTP Bridge（仅绑定 `127.0.0.1`，写路由已下线） |

---

## 快速开始

```bash
# 1. 安装依赖（国内加速：npm 配置 registry 或使用 cnpm / pnpm --registry）
pnpm install

# 2. 开发模式
pnpm dev

# 3. 构建产物
pnpm build

# 4. 类型检查
pnpm typecheck

# 5. 测试（离线契约 + 冒烟，不需要网络与凭据）
pnpm test

# 6. 各模块自检（离线）
pnpm test:model-discovery   # /v1/models URL 归一化与响应解析

# 7. 科研 Agent 评测集（默认 mock 执行器；接真实网关见 test/eval/README.md）
pnpm test:eval              # 评测指标与任务集的一致性单测
pnpm eval -- --label baseline   # 跑一轮评测并落盘报告（mock 执行器）
pnpm eval:real              # 真实网关评测 / A/B 入口（需 MIMIR_GW_URL/KEY/MODEL，缺凭据则跳过）
pnpm eval:compare <A.json> <B.json>   # A/B 对比两份报告
```

> 打包平台：`pnpm build:mac` / `pnpm build:win` / `pnpm build:linux`（分别产出 dmg/zip、nsis/portable、AppImage/deb）。

### 环境要求

- **Node.js ≥ 22**
- 编译论文可选用本机 `latexmk`，或在「设置 → 语音与资源」下载内置 **Tectonic** 单文件引擎（推荐，跨平台，免安装）

### 构建注意：依赖处理是「分类策略」，不是全外置也不是全内联

`electron.vite.config.ts` 里 main/preload 的依赖处理踩过**两个方向相反的坑**，改之前请读完本节。

#### 坑 1：数据型依赖必须外置（否则构建就失败）

- **现象**：`pnpm build` 在渲染 chunk 阶段失败 ——
  `[vite:esbuild-transpile] Transform failed ... index.js:367298:2: ERROR: Unterminated string literal`，
  出错位置附近能看到 `// -- CommonJS Shims --`。
- **机制**：`electron/agent/tokenizer.ts` 引入的 `gpt-tokenizer` 词表是两张共约 30 万行的**字符串数组**
  （BPE 词表，元素本身就是 `"\timport"`、`" corrupt"` 这类「源码片段」）。只要它们被打进 chunk，
  electron-vite 的 `vite:esm-shim` 插件（`"type": "module"` 下为 main/preload 注入 CJS 互操作 shim）
  就会用**不识别字符串边界**的正则 `ESMStaticImportRe` 去找插入点，命中词表里的伪
  `import … from " "` 序列，把 shim 插进字符串字面量中间 —— 产出的 chunk 本身就不是合法 JS。
- **结论**：**任何"数据文件里含源码片段字符串"的依赖都必须外置**（当前是 `gpt-tokenizer`）。
  只把某一个包加进 external 不算修好，换一个同类依赖会再犯。

#### 坑 2：LangChain 生态**不能**外置（否则能构建、但启动即崩）

- **现象**：构建全过，`pnpm dev` 时主进程崩：
  `SyntaxError: Cannot use import statement outside a module`，栈顶指向
  `@langchain/langgraph-sdk/dist/node_modules/.pnpm/p-retry@7.1.1/node_modules/p-retry/index.js`。
- **机制**：`@langchain/langgraph-sdk@1.10.2` 的发布产物里带着一棵**被剥掉 package.json 的
  pnpm 嵌套 node_modules**（该目录只有 `index.js`(ESM) 与 `index.cjs`，没有 package.json）。
  Electron 33 内置 **Node 20** 不做语法嗅探，只能把 `index.js` 当 CJS 解析 → 直接语法错误。
- **结论**：`langchain` / `langsmith` / `deepagents` / `@langchain/*` 必须**打进 bundle**，
  由 Rollup 解析并内联，运行时就不再去读那棵坏树。

> ⚠️ **不要用系统 node 的 `import()` 测试代替"能否在 Electron 里启动"的验证**：
> 在 Node 22 下 `import('deepagents')` 是**通过**的（Node 22 会按语法嗅探 ESM），
> 而同样的代码在 Electron 33 的 Node 20 里会崩。唯一可信的验证是 `pnpm dev` 能起。

#### 坑 3：zod 必须跟着一起内联（否则运行时缺符号）

LangChain 生态内部用的是 **zod 4**（`zod/v4/core` 的 `$ZodNever` / `toJSONSchema` 等内部符号），
而本项目顶层 zod 是 **3.25.x**（声明 `^3.23.8`，只提供 v3 API + v4 子路径）。若 zod 外置，
被 bundle 的 LangChain 代码会在运行时去顶层 zod 解析 `zod/v4/core`，版本对不上就会以
「does not provide an export named …」在启动时崩溃。内联后每个导入方各取自己依赖的版本。

#### 收敛后的外置面（`BUNDLE_INSTEAD_OF_EXTERNAL` 的反面）

```
electron · node 内建 · gpt-tokenizer/encoding/* · js-yaml · node-pty
```

其余全部内联（main bundle ≈ 1500 模块 / 4.3 MB）。改 `package.json` / 配置时注意：

1. **要外置的依赖必须留在 `dependencies`** —— `externalizeDepsPlugin` 只把 `dependencies` 列为
   外置候选，放进 devDependencies 会被当源码打进 bundle；
2. **原生 / 二进制依赖要加进 `electron-builder.yml` 的 `asarUnpack`**（当前：`node-pty` / `sherpa-onnx` / `ffmpeg-static`）；
3. **改完依赖相关配置必须跑到"能启动"**：`pnpm build` 通过**不等于**能跑。用 `pnpm dev` 确认主进程
   打印出 `[agent] 主 Agent 工具注册（N 个 + task 委派）` 与 `[agent] 委派子代理（M 个）` —— 那才说明 bundle 真的被 Electron 加载了。

---

## 配置 Agent（模型）

1. 启动应用，进入「设置」
2. 在「模型管理」点击「添加模型」
3. 填写 **请求地址**、**模型 ID**、**API 密钥**，选择是否支持图片输入
4. 点击 **测试并添加**，应用自动测试连通性
5. 测试通过后模型自动保存，选中即可使用

> 采用 OpenAI 兼容接口：可直连 DeepSeek / OpenAI，也可挂到任意自建 / 网关 / 本地推理端点。

---

## Agent 工具

| 工具 | 说明 |
|---|---|
| `paper_search` | 检索学术论文：默认源 OpenAlex（覆盖 arXiv 预印本与期刊正式版）并自动补充 arXiv 最新预印本；`sortBy=submittedDate` 时才走 arXiv 原生接口 |
| `arxiv_fetch_paper` | 按 arXiv id 读取单篇论文完整元数据（走 OpenAlex / Semantic Scholar，不写入文献库） |
| `library_search` | 检索文献库内已收藏论文（标题 / 摘要 / 标签 / 笔记关键词，只读片段） |
| `wiki_search` | 检索当前科研空间的 Wiki 笔记（只读片段） |
| `web_search` | 搜索网页获取最新信息（只读）。用户说「在网上找 / 要链接」时用它——即便话题是学术主题 |
| `wiki_note` | 创建 / 追加 Wiki 研究笔记 |
| `paper_fetch` | 按 arXiv id 或 DOI 获取论文并自动保存到文献库（走统一检索访问层，不受 arXiv 限流影响） |
| `set_paper` | 更新文献库论文的标签、笔记、AI 相关性评分 |
| `venue_search` | 查询 CCF 会议截稿与倒计时（本地缓存，离线可用） |
| `experiment` | 操作实验模块：list / create / update / delete（副作用先确认） |
| `server_status` | 只读查询 GPU 服务器连通性 + nvidia-smi 实时状态 |
| `latex_compile` | 编译用户论文（真实 latexmk/Tectonic，最长 120s）返回诊断 |
| `meeting_deck` | 生成组会 .pptx（可选 AI 要点 / 配图）或列出历史 |
| `ledger` | 操作成长记录：list / create / delete（副作用先确认） |
| `figure` | 操作图表库：list / add(磁盘路径) / rename(同步 .tex) / remove |
| `load_memory` | 按需读取全局长期记忆档案（默认不注入） |

> **副作用确认**：写盘 / 长耗时的桥工具（experiment / ledger / figure / latex_compile / meeting_deck）执行前向聊天区推送「批准卡片」，允许后才执行；拒绝或 120s 未响应自动取消。
>
> **调试 Agent**：主进程输出 `[agent-trace]` 日志并落盘 `~/.mimir/logs/agent-trace-*.jsonl`，级别经 `MIMIR_AGENT_TRACE` 或 `settings.agentTraceLevel` 控制（off / compact / full）。

---

## 测试

离线测试**不需要网络与 API 凭据**，`pnpm test` 即可跑完（约 2s）；打真实网关的 live 测试默认跳过。

```bash
pnpm test            # 全量：离线契约 + 冒烟
pnpm test:watch      # 监听模式
pnpm test:gateway    # 只跑网关相关（离线判定逻辑 + live 矩阵）
```

| 用例目录 | 覆盖内容 |
|---|---|
| `test/contract` | **工具名契约**——自定义工具不得与 deepagents 内置名（`ls`/`read_file`/`write_file`/`edit_file`/`delete`/`glob`/`grep`/`execute`）及中间件保留名（`task`/`write_todos`/`load_memory`）冲突。撞名会在构建 agent 时抛 `MiddlewareError`，本测试在 CI 阶段即拦截 |
| `test/gateway` | **网关能力探测**——用注入的 fetch 桩离线验证三通道（`json_schema` / `json_object` / `function_calling`）判定逻辑正确性 |
| `test/smoke` | **无头冒烟**——用生产同款装配构建单 Agent 图（拦截中间件/撞名类错误）；文件后端 + 批准卡全链路（获批落盘 / 拒绝不落盘 / 空间内外读差异 / 超时按拒绝） |
| `test/unit` | 批准卡握手机制（回填 / 超时 / 并发 / 无发送器保守放行）与**档位感知放行**（全权档放行 / 删除除外）、控制平面写保护、上下文治理（窗口/压缩/熔断）、产物识别、评测指标、**文献检索访问层**（多源合并去重 / 缓存 / 失败信息）、**交流语言注入**（热生效 / 前置 / 不污染入参） |
| `test/eval` | **科研 Agent 评测集**——任务集 + 指标 + A/B 对比（详见 `test/eval/README.md`） |

### 网关能力探测（Gateway Probe）

LangChain v1 的 `withStructuredOutput()` **默认优先选 `json_schema`**，而多数「OpenAI 兼容」第三方网关并未实现该能力，会返回 `400 This response_format type is unavailable now` —— 这类问题只在运行时才暴露。

`electron/agent/gatewayProbe.ts` 把「网关支持哪条结构化输出通道」变成**可探测、可缓存的事实**：

```ts
const caps = await probeGatewayCapabilities({ baseUrl, apiKey, model })
console.log(formatCapabilityReport(caps))
// → 选用 method: functionCalling（网关支持 function calling，兼容性最好）
const { method } = pickStructuredOutputMethod(caps)  // 传给 withStructuredOutput
```

优先级：`functionCalling` > `jsonMode` > `jsonSchema`（`json_schema` 即便可用也排最后，因在兼容网关上最脆弱）。

**⚠️ 思考模式（thinking）必须避开 `tool_choice`**：DeepSeek 思考模式（`thinking:{type:'enabled'}`）**明确拒绝 `tool_choice`**（不论 `auto` / `required` / 具名函数），一律返回 `400 Thinking mode does not support this tool_choice`；而 LangChain 的 `withStructuredOutput(schema, { method: 'functionCalling' })` 恰恰会注入 `tool_choice`（强制调用该 schema 函数）。因此**思考开启时改走 `jsonMode`**（只发 `response_format: {type:'json_object'}`，不发 `tool_choice`）。统一由 `pickStructuredMethod(reasoningOn)` 选路（思考开 → `jsonMode`，思考关 → `functionCalling`），所有结构化调用点（技能路由 / Ultra 合议 / 能力域生成）都走它，不要硬编码 `method: 'functionCalling'`。

### Live 测试（打真实网关）

换网关 / 换模型后跑一次，立刻知道该用哪条通道，并验证「探测结论与真实调用自洽」：

```bash
MIMIR_GW_URL=https://xxx/v1 \
MIMIR_GW_KEY=sk-xxx \
MIMIR_GW_MODEL=deepseek-chat \
pnpm vitest run test/gateway/liveMatrix.test.ts
```

`test/smoke/liveAgent.test.ts` 则用真实模型**真的跑一轮 agent**（纯对话 / 写文件全链路 / 读空间外文件），需要如下环境变量启用，未设置时自动跳过：

```bash
MIMIR_GW_URL=... MIMIR_GW_KEY=... MIMIR_GW_MODEL=... \
  pnpm vitest run test/smoke/liveAgent.test.ts
```

---

## 技能与指令

对话框输入 `/` 弹出「技能与指令」菜单（过滤 + 键盘补全），清单照搬 Mimir 的 commands/skills，展开为任务提示注入 Agent（L0，无文件副作用）：

- **指令**：`/research-idea <方向>` 科研开题 · `/research-plan [课题]` 实验方案 · `/paper-write [主题]` 论文写作 · `/paper-compile` 编译诊断 · `/research-review` 论文评审
- **技能**：`/research-pipeline` 全流程管线 · `/research-lit-review <方向>` 文献综述 · `/research-novelty-check <想法>` 查新 · `/research-experiment-plan` 实验设计 · `/research-result-to-claim` 结果到结论 · `/research-paper-drafting` 论文逐节起草 · `/research-paper-deai` 去 AI 味 · `/research-citation-audit` 引用审计 · `/research-rebuttal` 回复审稿 · `/research-figure-plan` 配图规划 · `/research-meeting-deck` 组会汇报
- 输入 `/trigger 参数` 可调用自定义技能（覆盖 `{{args}}` 占位符）。

---

## 项目结构

```
├── electron/                      # Electron 主进程
│   ├── main.ts                    # 进程入口（mimir-pdf / mimir-tex / mimir-img 本地协议注册）
│   ├── preload.ts                 # 预加载脚本（IPC 桥接）
│   ├── safeUrl.ts                 # 外链协议白名单（仅 http(s)；窗口层与 IPC 层共用）
│   ├── latex.ts                   # LaTeX 编译引擎（latexmk / Tectonic）与编译日志解析
│   ├── latex/runtime.ts           # Tectonic 探测与官方 release 下载安装（内置引擎）
│   ├── ipc/                       # IPC 处理器
│   ├── library/                   # 文献库服务（论文 / 项目 / 订阅 CRUD、BibTeX、Zotero）
│   ├── figures/                   # 图表管理（落盘 + mimir-img 协议服务）
│   ├── paper/                     # 论文增强（快照 / AI 修复 / Bib / 会议模板）
│   ├── meetings/                  # 组会演示文稿（DeckSlide + pptxgenjs 渲染 + 可选 LLM 要点）
│   ├── venues/                    # 会议截稿（ccfddl 缓存 + venue_search 工具）
│   ├── servers/                   # 服务器（SSH / nvidia-smi / 终端）
│   ├── speech/                    # 语音识别（SenseVoice / sherpa-onnx）
│   ├── modelDiscovery.ts          # /v1/models 自动发现（URL 归一化 + 宽松解析）
│   ├── agent/                     # DeepAgents 集成（单 Agent + 能力域）
│   │   ├── agentService.ts        # Agent 服务（单 Agent 装配 / 技能路由 / 主流程）
│   │   ├── ultra.ts               # Ultra 增强控制器（生产与评测共用同一份实现）
│   │   ├── agentText.ts           # 文本小工具（摘要截断 / 错误压缩）
│   │   ├── capabilityDomains.ts   # 能力域目录（工具分组 + 使用纪律 + 子代理定义）
│   │   ├── contextManager.ts      # 会话上下文治理（token 计量 / 分段摘要 / 熔断 / 归档）
│   │   ├── controlPlane.ts        # 控制平面写保护（防 Agent 自我提权）
│   │   ├── delegationFirewall.ts  # 限制委派嵌套深度（主 Agent 可委派、子代理不可再委派）
│   │   ├── subagentResult.ts      # 工具结果消费纪律 + 执行纪律
│   │   ├── artifactExtract.ts     # 工具返回中的落盘产物识别
│   │   ├── embeddingRerank.ts     # 技能候选 embedding 精排
│   │   ├── skillRouter.ts         # 技能分层路由
│   │   ├── tokenizer.ts           # 真实 token 计数
│   │   ├── approval.ts            # 副作用批准卡（Fail-Closed + 档位感知）
│   │   ├── languageMiddleware.ts  # 交流语言每轮前置注入（改设置免重启）
│   │   ├── paperSearch.ts         # 文献检索统一访问层（OpenAlex/S2/arXiv）
│   │   ├── fsBackend.ts           # 真实磁盘文件后端（写/改/删前过批准卡）
│   │   ├── gatewayProbe.ts        # 网关结构化输出能力探测
│   │   ├── trace.ts               # Agent 轨迹日志
│   │   ├── subagentRegistry.ts    # 兼容转发层（deprecated → capabilityDomains）
│   │   ├── skills/                # 技能注册表
│   │   └── tools/                 # Agent 工具
│   └── plugins/                   # 本机只读协作
│       └── bridge.ts              # 本地 HTTP 桥接（仅 127.0.0.1，只读）
├── test/                          # 测试（vitest，无需 Electron 运行时）
│   ├── contract/                  # 工具名契约（防与内置撞名）
│   ├── gateway/                   # 网关能力探测（离线判定 + live 矩阵）
│   ├── smoke/                     # 无头冒烟（构建图 / 批准卡全链路 / live agent）
│   ├── unit/                      # 单元测试（批准卡握手 / 上下文治理 / 产物识别）
│   ├── eval/                      # 科研 Agent 评测集（任务集 / 指标 / A-B 对比）
│   └── stubs/                     # electron / electron-store / store 测试桩
├── src/
│   ├── renderer/                  # 渲染进程（React 应用）
│   │   ├── App.tsx                # 主应用
│   │   └── index.css              # 全局样式 + 主题
│   ├── components/
│   │   ├── chat/                  # Agent 对话组件（ChatInput / ChatView / MessageBubble…）
│   │   ├── layout/                # 侧边栏（Sidebar）与导航
│   │   ├── modules/               # 功能模块（library / paper / figures / Experiments / Meetings…）
│   │   │   └── paper/             # LatexEditor：语法高亮覆盖层编辑器
│   │   └── ui/                    # Shadcn-UI 组件
│   ├── stores/                    # 状态管理
│   └── lib/                       # 工具（latex-highlight.ts：LaTeX 语法高亮 tokenizer）
├── build/                         # electron-builder 资源（icon.png）
└── components.json / tailwind.config / electron.vite / electron-builder
```

---

## 相关项目

- [**dsh-Mimir-Academic-research**](https://github.com/1692775560/dsh-Mimir-Academic-research) —— 本项目来源与功能同源：一个以 DeepSeek Harness (dsh) 为宿主的科研工作台插件，覆盖相同科研生命周期。**Mimir Desktop 是其工程化重写的独立桌面版**。

---

## License

本项目采用 **MIT License**（见 `package.json` 中 `license` 字段；如需分发请补充仓库根目录 `LICENSE` 文件）。功能与理念承自 [dsh-Mimir-Academic-research](https://github.com/1692775560/dsh-Mimir-Academic-research)（MIT）。
