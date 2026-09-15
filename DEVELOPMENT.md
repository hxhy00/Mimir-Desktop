# 开发文档（DEVELOPMENT）

面向参与开发 / 维护的工程师。用户向文档见 [README.md](./README.md)。

---

## 架构总览

以 **DeepAgents (LangChain/LangGraph)** 为核心，**单 Agent + 职业角色工具集 + 可选委派子代理**：主 Agent 默认直接持有全部科研工具、自己规划执行；遇到属于某位「同事」职责、可独立完成的整块工作时，自主把它委派出去。

### Agent 对话与上下文治理

- **单 Agent + 职业角色工具集**：一个 Agent 直接持有全部科研工具，按任务自行选择调用（工具行按「职业角色」打标签，过程可读）；支持 Markdown、流式输出、气泡内**执行过程轨迹卡**，会话管理 / 历史（重命名 / 置顶）本地持久化。
- **轻量委派（子代理 = 专业同事）**：每个职业角色同时编译为一个 `isolated` 子代理（独立上下文、只见委派任务、结果以 ToolMessage 回传），主 Agent 通过 deepagents 注入的 `task` 工具**自主决定是否委派**——单次工具调用就能解决的小事自己直接做，需要多步工具接力的整块工作才派出去。委派期间渲染层时间线把子代理内部步骤折叠到「委派」节点下（带角色标签），批准卡标注「来自角色：X」；「防嵌套防火墙」限制委派深度为 1（主 Agent 可委派、子代理不得再委派），杜绝递归委派导致拓扑失控。
- **对话内产物验收**：Agent 回复过程中落盘的文件（PPT / PDF / 配图 / 数据等）会自动从工具返回中识别，在气泡下方以**产物卡**列出（类型图标 + 文件名 + 大小），支持「打开」与「打开所在文件夹」；识别只认磁盘上真实存在且扩展名在白名单内的绝对路径。
- **多会话并行（后台任务）**：不同会话可同时生成回复，互不阻塞；侧栏对正在生成的会话显示转圈标记；停止生成按会话生效。窗口关闭时中止全部后台任务。
- **可选 Ultra 增强控制器**（默认关闭以控制 token）：自动或手动选择增强策略——多专家合议 / 批判迭代 / 混合增强 / 一致性投票；策略带 cost 标签，上下文过长**按真实 token** 自动降级，选型轨迹可回溯。
  > 原「普通增强（plain）」已按 A/B 实测移除：配对 18 条用例上 0 例修复 / 1 例回归，token +43.4%、工具调用 +85.7%。**不需要增强时就不介入**。
- **会话上下文治理（主进程侧）**：滑动窗口、超限时的**分段结构化摘要压缩**、压缩熔断降级、原文归档、失效提醒、压缩后能力声明重建，全部由主进程 `electron/agent/contextManager.ts` 统一完成；阈值以**真实 token** 计量（`agent/tokenizer.ts`，gpt-tokenizer），中文/英文/代码的预算口径一致；工具返回与增强子产物不沉淀历史。
- **工具纪律与交付门禁**：`subagentResult.ts` 的三条交付门禁（多步任务不得只做第一步 / 更新已有对象 ≠ 新建 / 结构化数据必须用结构化工具）来自基线实测的高频失败模式。
  > **一条有实测支撑的经验**：写「禁止 X」会稳定生效，写「允许 X」会被忽略——禁令作用域要写窄（「**检索学术论文时**别用 web_search 顶替 paper_search」），「什么时候该用某个工具」要写进**工具自身的描述**。数据见 `test/eval/README.md`。
- **永久身份常量**：「设置 → 身份与默认值」维护几乎不变的 identity，每轮恒定注入、保存即生效。
- **交流语言一致性（每轮前置注入）**：由 `electron/agent/languageMiddleware.ts` 在**每次模型调用时**读取最新设置并前置注入 systemMessage 顶部，禁止中英混杂旁白（专有名词 / 代码 / 论文标题保留原文）；改设置免重启即生效。
- **长期记忆档案**：全局记忆默认不注入，仅当任务相关时由 Agent 调用 `load_memory` 按需读取。
- **语音输入**：本地 **SenseVoice**（sherpa-onnx，主进程离线识别）或浏览器 **Web Speech**，在「设置 → 语音与资源」切换。

### 权限与安全（沙箱档位 × 三态批准）

Agent 拥有真实磁盘读写。改动前是「写入一律弹批准卡」的 一刀切，科研用户一天要点二十次产生**批准疲劳**。现为**策略矩阵 + 三态批准**：

- **沙箱档位**：只读档 / **工作区可写（默认）** / 全权档（控制平面除外）；决策顺序即优先级，见 `electron/agent/permissions.ts`。
- **空间内免批准**：科研空间内产出笔记 / 图表 / PPT 默认不打扰（可开关）。
- **「允许并记住此目录」**：批准卡三态（拒绝 / 允许一次 / 允许并记住），记住的目录在设置页可撤销。
- **路径口径统一**：判定、空间根、允许列表三处都用**磁盘实体路径**（`realpath`），封堵 macOS `/var → /private/var` 软链绕过。
- **业务卡的档位感知**：统一走 `requireBusinessApproval`——**全权档下非破坏性动作自动放行**（审计照记），**删除类任何档位都弹卡**；判定只看批准卡 `summary` 前缀（删除 / 移除 / 清空）。见 `electron/agent/approval.ts`。
- **审计日志**：每次文件读写的判定与用户裁决都落盘，设置页可回看。
- **控制平面永远硬拒绝**：`~/.mimir`、应用配置目录不参与任何允许列表，全权档也不放行、也不弹卡（不给「误点同意」的机会）。见 `electron/agent/controlPlane.ts`。
- **渲染层不等于可信**：`fs:readFile` / `fs:writeFile` 通道白名单收口（读只放行用户在原生对话框显式选择过的文件，写只放行空间根内，见 `electron/ipc/index.ts` 的 `assertRendererFilePath`）。**判断放在主进程**。
- **外链协议白名单**：`setWindowOpenHandler` 与 IPC 层 `shell:openExternal` 共用同一份白名单（仅 http(s)，见 `electron/safeUrl.ts`）。
- **子代理工具上防**：委派防火墙按层级判定，在能力域编译成子代理时逐域施加（`buildDomainSubagents`）。见 `electron/agent/delegationFirewall.ts`。

### 技能分层路由（Skill Router）

技能以元数据注册（目录 / tags / 适用边界 / 反例 / 成本），每轮 Meta-Cognition 意图识别 → 规则粗召回 →(可配) **向量精排**（embedding 相似度，复用当前对话模型接口）→ 只把 **top-K 候选**注入给 Agent；手动 `/技能` 直通绕过；网关无 embeddings 接口时自动回退规则排序。

### 文献检索访问层（`electron/agent/paperSearch.ts` + `tools/arxivSearch.ts`）

三源并行，全部免 key，按「成熟产品五层防御」工程化：

| 源 | 角色 | 说明 |
|---|---|---|
| **OpenAlex** | 主检索源 | 免费宽松（礼貌池 10 万次/天，请求带 mailto），覆盖预印本与期刊正式版，支持 DOI / arXiv id 直取 |
| **Semantic Scholar** | 辅助匹配 | 仅做「已知标题 → 论文」与 by-id 回退（其 search 端点共享配额脆弱，失败静默降级） |
| **arXiv API** | 新鲜度补充 | 仅「最新提交排序」与刚提交数日内的预印本；官方 3 秒/次限速 |

arXiv 访问层加固（`tools/arxivSearch.ts`）：

- 3s 串行节流 + 结果缓存 + 在途合并 + 429/503 退避重试；
- **L1**：退避优先解析 `Retry-After` 响应头（秒数 / HTTP-date，封顶 60s）；
- **L2**：三态熔断器——连续 3 次限流 → OPEN 180s（排队请求让路）→ HALF_OPEN 放行探测；
- **L4**：差异化 TTL——单篇 id 读取 6h / 关键词搜索 1h（对齐 arXiv 元数据每日午夜更新）。

> ⚠️ 已知待修：arXiv 的 `fetch` 尚无 `AbortSignal` 超时（paperSearch 已有 15s）；熔断 OPEN 时排队等待改为立即失败（fail-fast）是更优解；`arxiv_fetch_paper` 整体缺 deadline 兜底。

### 模型自动发现

「设置 → 模型 → 添加模型」按 `baseUrl` + API Key 自动拉取 `/v1/models`：URL 归一化、宽松响应解析、Key 不落日志、多选批量添加。

### 本地只读协作桥接

`electron/plugins/bridge.ts` 在主进程起 HTTP 服务，**只绑定 `127.0.0.1`**，端口与令牌写入 `~/.mimir/bridge.json`，只暴露只读查询。早期面向外部 agent 宿主的写入路由**已全部下线**（确认令牌无法构成远程鉴权，把危险面整体移除）。

### 插件模块（指令 / 技能 / 能力域 / 插件 / Hooks）

- **指令 / 技能**：内置只读；自定义支持弹窗导入与删除，导入即落盘生效。
- **能力域（= 职业角色）**：内置 5 角色（研究员 / 写作编辑 / 实验管理员 / 汇报助理 / 运维工程师）可克隆改造、支持 AI 生成；角色按**职责结果**划分而非工具种类（如归档类工具 `paper_fetch`/`set_paper` 归实验管理员）；保存 / 切换启停自动重载 Agent。
- **插件 / Hooks**：注册与管理界面；运行时消费尚未接入。

---

## 构建注意：依赖处理是「分类策略」，不是全外置也不是全内联

`electron.vite.config.ts` 里 main/preload 的依赖处理踩过**两个方向相反的坑**，改之前先读这节。

### 坑 1：数据型依赖必须外置（否则构建就失败）

- **现象**：`pnpm build` 在渲染 chunk 阶段失败 `[vite:esbuild-transpile] … Unterminated string literal`。
- **机制**：`gpt-tokenizer` 词表是两张共约 30 万行的**字符串数组**（元素本身是 `"\timport"` 这类「源码片段」）。被打进 chunk 后，electron-vite 的 `vite:esm-shim` 用**不识别字符串边界**的正则找 CJS shim 插入点，命中词表里的伪 `import` 序列，把 shim 插进字符串字面量中间。
- **结论**：**任何「数据文件里含源码片段字符串」的依赖都必须外置**。只外置某一个包不算修好，换一个同类依赖会再犯。

### 坑 2：LangChain 生态不能外置（否则能构建、但启动即崩）

- **现象**：构建全过，`pnpm dev` 主进程崩 `SyntaxError: Cannot use import statement outside a module`。
- **机制**：`@langchain/langgraph-sdk` 发布产物里带一棵**被剥掉 package.json 的 pnpm 嵌套 node_modules**；Electron 33 内置 Node 20 不做语法嗅探，把 ESM 的 `index.js` 当 CJS 解析直接崩。
- **结论**：`langchain` / `langsmith` / `deepagents` / `@langchain/*` 必须**打进 bundle**（见 `BUNDLE_INSTEAD_OF_EXTERNAL`）。

> ⚠️ 不要用系统 node 的 `import()` 代替「能否在 Electron 里启动」的验证：Node 22 会语法嗅探 ESM 所以能过，Electron 33 的 Node 20 会崩。唯一可信验证是 `pnpm dev` 能起、主进程打印 `[agent] 主 Agent 工具注册（N 个 + task 委派）`。

### 坑 3：zod 必须跟着一起内联（否则运行时缺符号）

LangChain 生态内部用 **zod 4**（`zod/v4/core`），顶层 zod 是 3.x。zod 外置时被 bundle 的 LangChain 会在运行时解析错版本 → `does not provide an export named …` 启动即崩。内联后各导入方各取所需。

### 收敛后的外置面

```
electron · node 内建 · gpt-tokenizer/encoding/* · js-yaml · node-pty
```

注意事项：

1. **要外置的依赖必须留在 `dependencies`**——`externalizeDepsPlugin` 只把 `dependencies` 列为外置候选；
2. **原生 / 二进制依赖要加进 `electron-builder.yml` 的 `asarUnpack`**（当前：`node-pty` / `sherpa-onnx` / `ffmpeg-static`）；
3. **改完依赖相关配置必须跑到「能启动」**：`pnpm build` 通过 ≠ 能跑。

---

## 打包与发布

### macOS：ad-hoc 签名与「已损坏」

无 Apple Developer 账号时 `electron-builder.yml` 的 `mac:` 段配置：

```yaml
identity: null          # 走 ad-hoc 签名（codesign --sign -）；arm64 无签名会被内核直接拒绝
hardenedRuntime: false  # 加固运行时需有效签名，无签名时开启反而启动失败
gatekeeperAssess: false # 打包后 spctl 评估无证书必失败，关掉
```

本机构建、本机直接打开没有问题；**从网络下载**的包因 quarantine 属性仍可能报「已损坏」，用户侧 `xattr -cr /Applications/Mimir.app` 或右键打开。对外正式分发需 Developer ID 签名 + 公证（notarize）。

### 产物命名

`artifactName: ${productName}-${arch}.${ext}`——文件名**不带版本号**（版本由 Release tag 表达）；win 的 nsis 用 `-setup` 后缀与 portable 区分。

### 应用图标规范

`build/icon.png`：**1024×1024、透明背景、图形内容约占 80% 居中**（Apple 网格安全边距）。内容顶满画布会让 Dock 图标视觉偏大——electron-builder 生成 `.icns` 时不会自动补边距。

### 发布流程

`.github/workflows/release.yml`：**推送 `v*` tag 触发** → 三平台矩阵构建 → 自动创建 Release 并上传产物。不要在 GitHub 网页端手动建 Release（会产生与代码脱节的旧产物）。

---

## 测试

离线测试**不需要网络与 API 凭据**，`pnpm test` 即可（约 2s）；打真实网关的 live 测试默认跳过。

```bash
pnpm test            # 全量：离线契约 + 冒烟
pnpm test:watch      # 监听模式
pnpm test:gateway    # 只跑网关相关
```

| 用例目录 | 覆盖内容 |
|---|---|
| `test/contract` | **工具名契约**——自定义工具不得与 deepagents 内置名（`ls`/`read_file`/`write_file`/`edit_file`/`delete`/`glob`/`grep`/`execute`）及中间件保留名（`task`/`write_todos`/`load_memory`）冲突 |
| `test/gateway` | **网关能力探测**——用 fetch 桩离线验证三通道（`json_schema` / `json_object` / `function_calling`）判定逻辑 |
| `test/smoke` | **无头冒烟**——生产同款装配构建单 Agent 图；文件后端 + 批准卡全链路 |
| `test/unit` | 批准卡握手 / 档位感知放行、控制平面写保护、上下文治理、产物识别、评测指标、文献检索访问层、**arXiv 限流加固**（Retry-After / 差异化 TTL / 熔断状态机）、交流语言注入 |
| `test/eval` | **科研 Agent 评测集**——任务集 + 指标 + A/B 对比（详见 `test/eval/README.md`） |

### 网关能力探测（Gateway Probe）

LangChain v1 的 `withStructuredOutput()` 默认优先 `json_schema`，而多数「OpenAI 兼容」网关并不支持，运行时才暴露。`gatewayProbe.ts` 把「网关支持哪条通道」变成可探测、可缓存的事实：

```ts
const caps = await probeGatewayCapabilities({ baseUrl, apiKey, model })
const { method } = pickStructuredMethod(reasoningOn)  // 思考开 → jsonMode，思考关 → functionCalling
```

**⚠️ 思考模式必须避开 `tool_choice`**：DeepSeek 思考模式拒绝 `tool_choice`（400），而 `functionCalling` 恰恰注入它——因此思考开启时走 `jsonMode`。所有结构化调用点（技能路由 / Ultra 合议 / 能力域生成）统一走 `pickStructuredMethod`，不要硬编码。

### Live 测试（打真实网关）

```bash
MIMIR_GW_URL=https://xxx/v1 MIMIR_GW_KEY=sk-xxx MIMIR_GW_MODEL=deepseek-chat \
  pnpm vitest run test/gateway/liveMatrix.test.ts
```

`test/smoke/liveAgent.test.ts` 用真实模型跑完整 agent 轮次，同样凭环境变量启用，缺省自动跳过。

---

## Agent 工具清单

| 工具 | 说明 |
|---|---|
| `paper_search` | 检索学术论文：主源 OpenAlex，自动补充 arXiv 最新预印本；`sortBy=submittedDate` 才走 arXiv 原生接口 |
| `arxiv_fetch_paper` | 按 arXiv id 读取单篇完整元数据（OpenAlex / S2 优先，不写入文献库） |
| `paper_fetch` | 按 arXiv id 或 DOI 获取并保存到文献库 |
| `library_search` | 检索文献库已收藏论文 |
| `wiki_search` / `wiki_note` | 检索 / 追加 Wiki 研究笔记 |
| `web_search` | 网页搜索（只读） |
| `set_paper` | 更新文献库论文的标签、笔记、相关性评分 |
| `venue_search` | CCF 会议截稿与倒计时（本地缓存） |
| `experiment` | 实验模块 list / create / update / delete |
| `server_status` | GPU 服务器连通性 + nvidia-smi（只读） |
| `latex_compile` | 编译论文（latexmk / Tectonic，最长 120s） |
| `meeting_deck` | 生成组会 .pptx |
| `ledger` | 成长记录 list / create / delete |
| `figure` | 图表库 list / add / rename / remove |
| `load_memory` | 按需读取全局长期记忆 |

> **副作用确认**：写盘 / 长耗时工具执行前推送「批准卡片」，拒绝或 120s 未响应自动取消。
> **调试**：主进程输出 `[agent-trace]` 并落盘 `~/.mimir/logs/agent-trace-*.jsonl`，级别经 `MIMIR_AGENT_TRACE` 或 `settings.agentTraceLevel` 控制（off / compact / full）。

## 技能与指令

对话框输入 `/` 弹出「技能与指令」菜单（过滤 + 键盘补全），展开为任务提示注入 Agent（L0，无文件副作用）：

- **指令**：`/research-idea` `/research-plan` `/paper-write` `/paper-compile` `/research-review`
- **技能**：`/research-pipeline` `/research-lit-review` `/research-novelty-check` `/research-experiment-plan` `/research-result-to-claim` `/research-paper-drafting` `/research-paper-deai` `/research-citation-audit` `/research-rebuttal` `/research-figure-plan` `/research-meeting-deck`
- 输入 `/trigger 参数` 可调用自定义技能（覆盖 `{{args}}` 占位符）。

---

## 项目结构

```
├── electron/                      # Electron 主进程
│   ├── main.ts                    # 进程入口（mimir-pdf / mimir-tex / mimir-img 本地协议注册）
│   ├── preload.ts                 # 预加载脚本（IPC 桥接）
│   ├── safeUrl.ts                 # 外链协议白名单（窗口层与 IPC 层共用）
│   ├── latex.ts                   # LaTeX 编译引擎与日志解析
│   ├── ipc/                       # IPC 处理器
│   ├── library/                   # 文献库服务（论文 / 项目 / 订阅、BibTeX、Zotero）
│   ├── figures/                   # 图表管理
│   ├── paper/                     # 论文增强（快照 / AI 修复 / Bib / 会议模板）
│   ├── meetings/                  # 组会演示文稿
│   ├── venues/                    # 会议截稿
│   ├── servers/                   # 服务器（SSH / nvidia-smi / 终端）
│   ├── speech/                    # 语音识别（SenseVoice / sherpa-onnx）
│   ├── modelDiscovery.ts          # /v1/models 自动发现
│   ├── agent/                     # DeepAgents 集成（单 Agent + 能力域）
│   │   ├── agentService.ts        # Agent 服务（装配 / 技能路由 / 主流程）
│   │   ├── ultra.ts               # Ultra 增强控制器
│   │   ├── capabilityDomains.ts   # 能力域目录（工具分组 + 纪律 + 子代理定义）
│   │   ├── contextManager.ts      # 会话上下文治理
│   │   ├── controlPlane.ts        # 控制平面写保护
│   │   ├── delegationFirewall.ts  # 委派嵌套防火墙
│   │   ├── subagentResult.ts      # 工具结果消费纪律
│   │   ├── artifactExtract.ts     # 落盘产物识别
│   │   ├── skillRouter.ts         # 技能分层路由
│   │   ├── tokenizer.ts           # 真实 token 计数
│   │   ├── approval.ts            # 批准卡（Fail-Closed + 档位感知）
│   │   ├── permissions.ts         # 沙箱档位决策
│   │   ├── languageMiddleware.ts  # 交流语言每轮前置注入
│   │   ├── paperSearch.ts         # 文献检索统一访问层
│   │   ├── fsBackend.ts           # 磁盘文件后端（写/改/删前过批准卡）
│   │   ├── gatewayProbe.ts        # 网关结构化输出能力探测
│   │   ├── trace.ts               # Agent 轨迹日志
│   │   └── tools/                 # Agent 工具
│   └── plugins/bridge.ts          # 本机只读 HTTP 桥接（仅 127.0.0.1）
├── test/                          # 测试（vitest，无需 Electron 运行时）
│   ├── contract/                  # 工具名契约
│   ├── gateway/                   # 网关探测（离线 + live 矩阵）
│   ├── smoke/                     # 无头冒烟
│   ├── unit/                      # 单元测试
│   ├── eval/                      # 科研 Agent 评测集
│   └── stubs/                     # electron / store 测试桩
├── src/                           # 渲染进程（React + Tailwind + Shadcn-UI）
├── build/                         # electron-builder 资源（icon.png）
└── .github/workflows/release.yml  # tag 触发的三平台构建发布
```

---

## License

MIT（见 `package.json` 的 `license` 字段）。功能与理念承自 [dsh-Mimir-Academic-research](https://github.com/1692775560/dsh-Mimir-Academic-research)（MIT）。
