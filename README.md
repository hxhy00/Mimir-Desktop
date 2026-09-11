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

以 **DeepAgents (LangChain/LangGraph)** 为核心，配合 Supervisor 编排 + 子 Agent 协作，用自然语言无侵入驱动整条科研工作流。

### Agent 对话与上下文治理

- **Supervisor 编排**：主管 Agent 把文献 / 论文 / 实验 / 组会 / 服务器等任务按需委派给模块子 Agent 协作并汇总作答；支持 Markdown、流式输出、气泡内**执行过程轨迹卡**，会话管理 / 历史（重命名 / 置顶）本地持久化。
- **可选 Ultra 增强控制器**（Supervisor 之上的增强总开关，默认关闭以控制 token）：自动或手动选择增强策略——普通增强(仅长程规划) / 多专家合议(K 路评审→共识/分歧→反思) / 批判迭代(草稿→批判→修订) / 混合增强(关键判断点合议+整体批判) / 一致性投票(轻量 SC 选最优)；策略带 cost 标签，上下文过长自动降级，选型轨迹可回溯，执行动作全部下沉 Supervisor，分歧点由子 Agent 工具核验。
- **会话上下文治理**：发送时携带最近对话为滑动窗口，超阈值自动把更早对话压缩为结构化摘要（原文归档可回看）；工具返回与增强子产物不沉淀历史；删除 / 改名等破坏性操作触发会话级**失效提醒**，防止跨轮复述旧对象。
- **永久身份常量**：在「设置 → 身份与默认值」维护科研身份 / 交互语言 / 写作语言等几乎不变的 identity，作为极小 system 段每轮恒定注入、保存即生效；默认不注入任何内容，自动学习永不写入该层。
- **长期记忆档案**：全局记忆默认不注入，仅当任务相关时由 Supervisor 调用 `load_memory` 按需读取（「设置 → 长期记忆」维护）。
- **语音输入**：对话输入框支持语音转文本——本地 **SenseVoice**（sherpa-onnx，Electron 主进程离线识别，可下载模型）或浏览器 **Web Speech** 引擎，在「设置 → 语音与资源」切换。

### 技能分层路由（Skill Router）

技能以元数据注册（L3 目录 / tags / 适用边界 / 反例 / 成本 / 会话次数），每轮 Meta-Cognition 意图识别 → 规则粗召回 →(可配) LLM 精排 → 只把 **top-K 候选**注给 Supervisor，替换原先的全量技能目录注入；手动 `/技能` 直通绕过；自定义技能缺字段自动推导、缺关键字段拒绝注册；开关在「设置 → 技能路由」。

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
| **插件 `plugins`** | 统一管理技能 / 子代理 / 插件 / Hooks（增删改查 + 启停开关，本地持久化） |
| **设置 `settings`** | 模型（LLM 管理 · 图像生成端点）/ 外观 / Agent（技能路由 · 身份与默认值 · 长期记忆）/ 科研空间 / 语音与资源 / 关于 |

### 插件模块（技能 / 子代理 / 插件 / Hooks）

- **技能**：内置 `research-*` 只读；**自定义技能**支持弹窗导入（手动表单或粘贴 JSON）与删除，导入即落盘生效；增删后重进「对话」自动刷新斜杠菜单。
- **子代理**：Supervisor 可委派子代理的管理界面——内置 5 个科研 worker（文献 / 论文 / 实验 / 组会 / 服务器）只读展示、可「克隆」改造；支持 **AI 生成**（一句话描述职责草拟 name / 说明 / systemPrompt / 工具白名单）；自定义子代理可增删改查 + 启停，从**内置工具白名单**勾选工具并自写 systemPrompt；保存 / 切换启停自动「重载 Agent」（重建 Supervisor）免重启；副作用仍走批准卡。
- **插件 / Hooks**：注册与管理界面（启用开关 / 描述 / 配置）。

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
| 数据存储 | 双层 JSON Store（全局设置 + 科研空间）+ arXiv API |
| 测试 | Vitest（契约 / 网关探测 / 无头冒烟） |

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
```

> 打包平台：`pnpm build:mac` / `pnpm build:win` / `pnpm build:linux`（分别产出 dmg/zip、nsis/portable、AppImage/deb）。

### 环境要求

- **Node.js ≥ 22**
- 编译论文可选用本机 `latexmk`，或在「设置 → 语音与资源」下载内置 **Tectonic** 单文件引擎（推荐，跨平台，免安装）

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
| `arxiv_search` | 搜索 arXiv 学术论文 |
| `arxiv_fetch_paper` | 按 id 读取单篇论文完整元数据（不写入文献库） |
| `library_search` | 检索文献库内已收藏论文（标题 / 摘要 / 标签 / 笔记关键词，只读片段） |
| `wiki_search` | 检索当前科研空间的 Wiki 笔记（只读片段） |
| `web_search` | 搜索网页获取最新信息 |
| `wiki_note` | 创建 / 追加 Wiki 研究笔记 |
| `paper_fetch` | 获取 arXiv 论文并自动保存到文献库（关联项目） |
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
| `test/smoke` | **无头冒烟**——用生产同款装配构建 Supervisor（拦截中间件/撞名类错误）；文件后端 + 批准卡全链路（获批落盘 / 拒绝不落盘 / 空间内外读差异 / 超时按拒绝） |
| `test/unit` | 批准卡握手机制（回填 / 超时 / 并发 / 无发送器保守放行） |

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
│   └── agent/                     # DeepAgents 集成
│       ├── agentService.ts        # Agent 服务
│       ├── subagentRegistry.ts    # 内置子代理注册（重建 Supervisor）
│       ├── skillRouter.ts         # 技能分层路由
│       ├── approval.ts            # 副作用批准卡
│       ├── fsBackend.ts           # 真实磁盘文件后端（写/改/删前过批准卡）
│       ├── gatewayProbe.ts        # 网关结构化输出能力探测
│       ├── trace.ts               # Agent 轨迹日志
│       └── tools/                 # Agent 工具
├── test/                          # 测试（vitest，无需 Electron 运行时）
│   ├── contract/                  # 工具名契约（防与内置撞名）
│   ├── gateway/                   # 网关能力探测（离线判定 + live 矩阵）
│   ├── smoke/                     # 无头冒烟（构建图 / 批准卡全链路 / live agent）
│   ├── unit/                      # 单元测试（批准卡握手）
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
