# Mimir Desktop

以 Agent 为核心的科研工作台，基于 Electron + React + DeepAgents 构建。

## 功能特性

- **Agent 对话**：以 DeepAgents 为核心的自然语言交互，支持 Markdown 渲染、流式输出、会话管理，会话历史（含重命名/置顶）本地持久化
- **文献库**：arXiv + Web 双来源搜索，项目关联、标签、AI 相关性评分、内嵌 PDF 阅读器 + 阅读笔记、BibTeX 导出、arXiv 订阅、Zotero 集成
- **论文编辑**：以文件夹为项目的 LaTeX 工作区——打开/新建论文项目，管理 `main.tex` 与章节文件的多标签编辑（语法高亮 + 行号跳转），一键用 latexmk / Tectonic 真实编译，错误/警告诊断点击跳转行，编译产物 `main.pdf` 内嵌预览；引擎缺失时可在「设置 → 资源下载」中下载内置 Tectonic 单文件引擎
- **论文增强**：编译成功后自动快照项目（列表对比 main.tex 差异并可一键回退），错误行一键 AI 修复并自动重编译，references.bib 结构化编辑，会议排版模板注入（template/TEMPLATE.md）
- **实验管理**：实验记录、指标可视化、训练进度跟踪
- **图表管理**：图片上传并落盘到本地目录（mimir-img 协议内联预览），一键复制 LaTeX 代码，支持从 PDF 提取论文内嵌图、重命名并预览后同步 LaTeX 引用
- **组会管理**：从文献库项目论文与实验记录生成真实 16:9 .pptx 汇报（封面 / 目录 / 文献分享 / 实验结果 / 下一步计划），支持按 AI 相关度排序选文、AI 要点提炼（可选），产物统一管理（列表 / 打开所在文件夹 / 删除）；可选 AI 配图（封面 / 论文概念插图，图片存入图表库可复用，需在设置「图像生成」配置端点）
- **服务器管理**：SSH 远程连接，nvidia-smi 实时 GPU/显存监控，内置远程终端
- **成长记录**：研究进展时间线，支持里程碑/论文/实验等类型；本地持久化、可删除
- **Wiki 笔记**：Agent 自动保存研究笔记
- **科研空间**：目录制多空间（默认 `~/Mimir/<空间名>`，可自选任意目录），每个空间独立承载论文/实验/图表/组会/对话等研究数据，基础设置（模型/主题/服务器）全局共享；支持切换当前空间、设定默认空间与启动恢复，旧版单目录数据会自动迁移进默认空间；首次使用走三步引导（选择/创建空间 → 模型 → 外观）——若本机基础信息（全局模型/apiKey 等）已存在，引导会检测并直接复用：跳过模型手填、在界面标注“已导入 N 个模型”，外观主题自动预填
- **会议截稿**：ccfddl 会议截稿目录（本地缓存优先、启动自动抓取 + 6h 定时/手动刷新，离线可用），支持按领域/CCF 等级/时间窗过滤与倒计时高亮、关注星标；内置 CCF-A 期刊目录；对话中可直接让 Agent 用 `venue_search` 查询截稿

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | Electron 33 |
| 构建工具 | electron-vite 2 |
| UI 框架 | React 18 + TypeScript |
| 样式 | Tailwind CSS 3 + Shadcn-UI |
| Markdown | react-markdown + remark-gfm |
| Agent 引擎 | DeepAgents (LangChain) |
| PPT 渲染 | PptxGenJS 4 |
| 数据存储 | 双层 JSON Store（全局设置 + 科研空间）+ arXiv API |

## 快速开始

```bash
# 安装依赖
pnpm install

# 开发模式
pnpm dev

# 构建
pnpm build

# 类型检查
pnpm typecheck
```

## 配置 Agent

1. 打开应用，进入「设置」
2. 在「模型管理」中点击「添加模型」
3. 填写请求地址、模型ID、API密钥，选择是否支持图片输入
4. 点击「测试并添加」，应用会自动测试连通性
5. 测试通过后模型自动保存，选中即可使用

## 项目结构

```
├── electron/               # Electron 主进程
│   ├── main.ts             # 主进程入口（注册 mimir-pdf / mimir-tex 本地预览协议）
│   ├── preload.ts          # 预加载脚本（IPC 桥接）
│   ├── latex.ts            # LaTeX 编译引擎（latexmk / Tectonic）与编译日志解析
│   ├── latex/runtime.ts    # Tectonic 引擎探测 / 官方 release 下载安装（内置引擎）
│   ├── ipc/                # IPC 处理器
│   ├── library/            # 文献库服务（论文/项目/订阅 CRUD、BibTeX、Zotero）
│   ├── figures/            # 图表管理（图片落盘 + mimir-img 协议服务）
│   ├── paper/              # 论文增强（快照 / AI 修复 / Bib / 会议模板）
│   ├── meetings/           # 组会演示文稿（DeckSlide 纯模型 + pptxgenjs 渲染 + 可选 LLM 要点）
│   ├── venues/             # 会议截稿（ccfddl 缓存 + venue_search 工具）
│   └── agent/              # DeepAgents 集成
│       ├── agentService.ts # Agent 服务
│       └── tools/          # Agent 工具
├── src/
│   ├── renderer/           # 渲染进程（React 应用）
│   │   ├── App.tsx         # 主应用
│   │   └── index.css       # 全局样式 + 主题
│   ├── components/
│   │   ├── chat/           # Agent 对话组件
│   │   ├── layout/         # 侧边栏
│   │   ├── modules/        # 10 大功能模块
│   │   │   └── paper/      # LatexEditor：语法高亮覆盖层编辑器
│   │   └── ui/             # Shadcn-UI 组件
│   └── lib/                # 工具函数（latex-highlight.ts：LaTeX 语法高亮 tokenizer）
└── electron.vite.config.ts # 构建配置
```

## Agent 工具

| 工具 | 说明 |
|---|---|
| `arxiv_search` | 搜索 arXiv 学术论文 |
| `arxiv_fetch_paper` | 按 id 读取单篇论文完整元数据（不写入文献库） |
| `web_search` | 搜索网页获取最新信息 |
| `wiki_note` | 创建/追加 Wiki 研究笔记 |
| `paper_fetch` | 获取 arXiv 论文并自动保存到文献库（关联项目） |
| `set_paper` | 更新文献库论文的标签、笔记、AI 相关性评分 |
| `venue_search` | 查询 CCF 会议截稿时间与倒计时（本地缓存，离线可用） |
| `experiment` | 操作实验模块：list / create / update / delete（副作用先确认） |
| `server_status` | 只读查询已注册 GPU 服务器：连通性 + SSH nvidia-smi 实时状态 |
| `latex_compile` | 编译用户论文项目目录（真实 latexmk/Tectonic，最长 120s）并返回诊断 |
| `meeting_deck` | 生成组会 .pptx（复用组会模块，可选 AI 要点/配图）或列出历史 |
| `ledger` | 操作成长记录：list / create / delete（副作用先确认） |
| `figure` | 操作图表库：list / add(磁盘路径) / rename(同步 .tex) / remove |

> 副作用确认：写盘/长耗时的桥工具（experiment / ledger / figure / latex_compile / meeting_deck）在执行前会向聊天区推送「批准卡片」，用户允许后才真正执行；拒绝或 120s 未响应自动取消。

## 技能与指令

对话输入框输入 `/` 会弹出「技能与指令」菜单（过滤 + 键盘补全），清单照搬 Mimir 的 commands/skills，展开为任务提示注入 Agent（L0，无文件副作用）：

- **指令**：`/research-idea <方向>` 科研开题 · `/research-plan [课题]` 实验方案 · `/paper-write [主题]` 论文写作 · `/paper-compile` 编译诊断 · `/research-review` 论文评审
- **技能**：`/research-pipeline` 全流程管线 · `/research-lit-review <方向>` 文献综述 · `/research-novelty-check <想法>` 查新 · `/research-experiment-plan` 实验设计 · `/research-result-to-claim` 结果到结论 · `/research-paper-drafting` 论文逐节起草 · `/research-paper-deai` 去 AI 味 · `/research-citation-audit` 引用审计 · `/research-rebuttal` 回复审稿 · `/research-figure-plan` 配图规划 · `/research-meeting-deck` 组会汇报

### 自定义技能（设置 → 技能管理）

「设置 → 技能管理」可查看全部技能详情、导入/删除自定义技能：

- 内置 research-* 技能只读；**自定义技能**支持弹窗导入（手动表单或粘贴 JSON）与删除，导入即在本机落盘并立即生效（无需点「保存设置」），增删后重新进入「对话」模块自动刷新斜杠菜单。
- 输入 `/trigger 参数` 即可调用自定义技能；参数会替换任务正文中的 `{{args}}` 占位符（正文无占位符时参数前置为「本次任务对象」，未带参数时正文给出澄清提示）。
- 自定义技能在菜单中与内置技能并列展示，仍以 `skill` 语义展开为任务提示注入 Agent（L0，无文件副作用）。

## 路线图

- [x] 基础框架（Electron + React + Tailwind + Shadcn）
- [x] DeepAgents 引擎集成
- [x] Agent 对话核心（Markdown 渲染 + 会话管理 + 流式输出）
- [x] 10 大功能模块
- [x] 真实 arXiv 文献搜索
- [x] 模型连通性测试（添加时自动验证）
- [x] 文献库增强（收藏持久化 + PDF 下载 + 阅读笔记）
- [x] 真正文献库（项目关联 + 标签 + AI 相关性评分 + 内嵌 PDF 阅读器 + BibTeX 导出 + arXiv 订阅 + Zotero 集成 + Web 搜索导入）
- [x] GPU 服务器管理（SSH 远程连接 + nvidia-smi GPU 监控）
- [x] 实验管理（指标跟踪 + 进度可视化）
- [x] 图表管理（上传 + LaTeX 代码生成）
- [x] 成长记录时间线
- [x] 主题系统（浅色/深色/跟随系统）
- [x] 工作台自定义背景图（设置-外观：本地选图 + 背景浓度/明暗遮罩，随主题适配）
- [x] 可展开侧边栏
- [x] LaTeX 论文项目管理（打开/新建项目、多 .tex 标签编辑、语法高亮、诊断跳转、内嵌 PDF 预览；依赖本机 latexmk 或 Tectonic）
- [x] 组会 PPT 实际生成（pptxgenjs 确定性渲染 + 可选 LLM 要点提炼）
- [x] 蜂群模式（调度/执行分离：蜂王将请求拆成带依赖的 DAG 子任务，就绪任务分波并发、上层等待依赖产物；界面含实时调度状态条与分任务产出折叠区）
- [ ] 数据持久化（SQLite）
