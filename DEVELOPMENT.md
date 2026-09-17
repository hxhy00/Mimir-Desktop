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
- **子代理工具上防（限制嵌套深度）**：主 Agent 可持 `task`（委派入口），子代理不得再持——深度上限 1。深度是**运行期状态**（`AsyncLocalStorage`，随委派进入/退出自动增减，与 `approval.ts` 的来源通道同机制）：每次放行一次委派，其整段执行跑在 `depth+1` 上下文里，链内再次委派一律被拒绝；无法核验的工具（缺 `name`）与命中的嵌套入口同等处理（Fail-Closed）。构建期校验在 `buildDomainSubagents` 逐域施加。见 `electron/agent/delegationFirewall.ts`。
- **store 读写的完整性**：「文件不存在」与「文件损坏」严格区分——前者按默认值处理，后者抛 `StoreCorruptError` 并把该层置为**只读**（拒绝写入），绝不用空对象覆盖磁盘上的真实数据，异常同时进 `storeLoadIssues()` 供上层展示。见 `electron/library/store.ts`。
- **凭据落盘权限**：全局层 store（承载 `servers:list` 明文 password、settings 里的 API Key）写入即收紧为 `0600`，空间层按内容检出凭据键名后同样收权；Windows 无 POSIX 权限位则跳过。见 `electron/library/store.ts`。

### 技能分层路由（Skill Router）

技能以元数据注册（目录 / tags / 适用边界 / 反例 / 成本），每轮 Meta-Cognition 意图识别 → 规则粗召回 →(可配) **向量精排**（embedding 相似度，复用当前对话模型接口）→ 只把 **top-K 候选**注入给 Agent；手动 `/技能` 直通绕过；网关无 embeddings 接口时自动回退规则排序。

### 文献检索访问层（`electron/agent/paperSearch.ts` + `tools/arxivSearch.ts`）

三源分工，全部免 key（S2 / OpenAlex 均可选配免费 key），按「成熟产品五层防御」工程化：

| 源 | 角色 | 说明 |
|---|---|---|
| **OpenAlex** | 主检索源 | 覆盖预印本与期刊正式版；查询用官方推荐的 `filter=title_and_abstract.search:"…"`（命中专用索引，优于裸 `search=` 全文模式）；单篇直取走 **singleton 端点** `/works/doi:{doi}`（免费，比 `filter=` 列表查询省额度）。⚠️ OpenAlex 已从「mailto 礼貌池」转为 **API Key + 每日预算制**：mailto 仍被接受但无配额增益；设置页可填免费账号 key（`settings.openAlexApiKey`，额度 ×10，未配置回退 mailto）。注意：OpenAlex **没有** `arxiv:` 过滤器，arXiv id 只能走其注册 DOI（`10.48550/arxiv.{id}`，映射覆盖不完整） |
| **Semantic Scholar** | 语义兜底 + 标题匹配 | OpenAlex 空结果时用 `search/vector` 做概念级语义检索；另有 match/by-id。匿名共享配额脆弱 → 失败一律静默降级。设置页可填**免费申请的账号 key**（`settings.s2ApiKey`，经 provider 接缝注入）：节流放宽到 200ms、429 冷却 30s→5s |
| **arXiv API** | 检索：新鲜度补充（条件触发）；解析：arXiv id 主源 | 检索：仅当 OpenAlex 结果最新发表日期距今 ≤ 7 天（主题近期活跃）才补一次；`sortBy=submittedDate` 仍走原生路径。解析：按 arXiv id 取单篇时官方 `id_list` 直查 100% 命中（不依赖第三方映射），复用批量合并/节流/缓存。官方 3 秒/次限速——跳过即省掉排队与 429 暴露面 |

按 id 解析回退链（`resolvePaperById`，paper_fetch / arxiv_fetch_paper 共用）：

- **arXiv id** → ① arXiv 官方 `id_list`（主源，100% 命中）→ ② OpenAlex singleton DOI 通道（映射不完整，仅中间回退）→ ③ S2 by-id（兜底）；
- **DOI** → OpenAlex singleton（单源即可，免费且权威）；
- 全部失败时报错**如实列出各源**，不再谎称"限流相关"。

主进程 HTTP 出口（`electron/http.ts`）带统一退避重试：**仅 429/5xx** 指数退避（1s/2s/4s，尊重 `Retry-After`），4xx 不重试；`net.fetch` 走系统代理，不可用时降级全局 fetch。

arXiv 访问层加固（`tools/arxivSearch.ts`）：

- 3s 串行节流 + 结果缓存 + 在途合并 + 熔断器；
- **L1**：限流退避优先解析 `Retry-After` 响应头（秒数 / HTTP-date，封顶 60s；无头默认 60s）；
- **L2**：三态熔断器——连续 3 个**独立请求事件**被限流 → OPEN 180s（排队请求让路）→ HALF_OPEN 放行探测；
- **单次尝试**：撞 429/503 后设冷却并立即抛错降级，不在同一次调用里循环重试（旧实现的"重试循环 × 全局冷却"会把同一事件计成多次、熔断误开、tool call 挂死后被 Agent 层超时重发，反而放大流量）；
- **L4**：差异化 TTL——单篇 id 读取 6h / 关键词搜索 1h（对齐 arXiv 元数据每日午夜更新）。

> ⚠️ 已知待修：arXiv 的 `fetch` 尚无 `AbortSignal` 超时（paperSearch 已有 15s）；`arxiv_fetch_paper` 整体缺 deadline 兜底。

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
| `test/smoke` | **无头冒烟**——生产同款装配构建单 Agent 图；文件后端 + 批准卡全链路；**真实 agent 端到端**（`liveAgent` / `liveServerTool`，凭 `MIMIR_GW_*` 启用，缺省跳过） |
| `test/unit` | 批准卡握手 / 档位感知放行、控制平面写保护、上下文治理、产物识别、评测指标、文献检索访问层、**arXiv 限流加固**（Retry-After / 差异化 TTL / 熔断状态机）、交流语言注入、**会话级运行态收尾**（`convStreaming` / `agentTimelineStreaming`）、**server 工具不追问契约**（`serverCreateDefaults`） |
| `test/eval` | **科研 Agent 评测集**——任务集 + 指标 + A/B 对比（详见 `test/eval/README.md`） |

渲染层用例（`test/unit/*.test.tsx`）与主进程用例共用一份 vitest 配置，靠文件头
`// @vitest-environment jsdom` 切环境（缺省 node）。写这类用例时注意三点，否则会加载失败：

- 需要 `@vitejs/plugin-react`（vitest.config.ts 已启用）——否则报 `React is not defined`；
- 需要 `@/*` 别名（已配置，对齐 `tsconfig.web.json`）——渲染层组件内部普遍用它导包；
- 变更后务必用 `read_lints` + `tsc -p tsconfig.web.json` 复核，typecheck 与用例是两套独立信号。

> **验证一个回归测试是否有效**：把对应的修复**临时回退**，确认用例变红，再恢复。
> 只看到绿灯不能说明用例有效——它可能根本没断言到出问题的那条路径。

### 端到端测试（E2E / Playwright）

上层测试补的是**单元测试看不到的东西**：真实 Electron 进程里的渲染、原生 `window.confirm`、IPC 往返、自定义协议 `mimir-img://` 的实际渲染。用 Playwright 驱动**构建产物**（`out/`），不是 dev server。

```bash
pnpm test:e2e         # 构建 + 全量 E2E（62 用例，约 29s）
pnpm test:e2e:headed  # 带界面（本地排查用）
pnpm test:e2e:ui      # 交互式 UI 模式
```

**与单元测试的边界**：E2E 用例**不触真实网络、不触真实 AI 模型**。凡是会联网（arXiv 检索、ccfddl 拉取、SSH 探测）或调用模型（生成 PPT 要点）的路径，一律用 `page.route()` 拦截 / 只验证 UI 而不点最终提交，并在用例头部注释写明避让理由。

**例外——桩网关**：对话链路（`11-chat-flow.spec.ts`）需要模型才有意义，因此另起一个**本地离线桩网关**（`e2e/fixtures/fakeGateway.ts`，Node 原生 `http`，零新依赖），用 `makeGatewayTest()` 把它的地址写进 seed 的模型配置。桩网关走**纯 OpenAI 兼容协议**（`POST {baseUrl}/chat/completions`），产品代码零改动即连上，从而让「发消息 → 流式渲染 → 停止 → 落盘」全链路可离线验证。

**例外——真实网关**：`14-chat-real-gateway.spec.ts` 用**真实大模型**验证桩测不到的「输出完整性」——要求模型逐字回显独特标记 token，断言气泡里出现**完整**标记（流式收尾不截断）、收尾后输入框恢复可用、两轮历史完整落盘。需要同时设置 `MIMIR_GW_URL` / `MIMIR_GW_KEY` / `MIMIR_GW_MODEL` 才运行，缺省整组跳过（CI 默认不跑真实模型）：

```bash
MIMIR_GW_URL=http://<host>:<port>/v1 MIMIR_GW_KEY=<key> MIMIR_GW_MODEL=<model> \
pnpm test:e2e -- -g 14-chat-real
```


#### 数据隔离（**改动前必读**）

E2E 会启动真实应用，若隔离失效就会把测试数据写进开发者的真实 `~/.mimir`（**含明文 API Key 与服务器密码**）。因此：

| 落盘位置 | 隔离手段 |
|---|---|
| 全局层 `<HOME>/.mimir/store.json` | 启动时注入 `HOME=<临时目录>` |
| 空间层 `<空间根>/.mimir/store.json` | seed 把空间根写在临时 HOME 内 |
| Electron userData | `--user-data-dir=<临时目录>` |

三条**实测得出**的纪律（2026-09-16，已固化进 `e2e/fixtures/launch.ts`）：

1. **`app.getPath('home')` 不跟随 `HOME`**（macOS 走 `NSHomeDirectory` 系统 API），而 `store.ts` 用的 `os.homedir()` **跟随**——两者行为不同，**隔离判据只能取后者对应的事实**。
2. **判据是「临时 HOME 下真的生成了 `.mimir/store.json`」这个落盘事实**，不是问应用要路径。未通过即抛错中止。
3. **路径比对前必须 `realpathSync` 归一化**：macOS `os.tmpdir()` 返回 `/var/folders/...`，Electron 报回 `/private/var/...`（同一目录的符号链接形态），不归一化会误判为隔离失效。

写新用例时**不要重复 `page.on('dialog')`**：page 是 worker 级共享的，重复注册会让多个 handler 抢答同一 dialog（第二个抛 `No dialog is showing`）。dialog handler 已在 `launchApp` 里注册一次，用例通过 `dialogs` fixture 拿到 recorder（含 `reset()`）。

#### 结构

```
e2e/
├── fixtures/     # app.ts（Playwright fixture）、launch.ts（启动 + 隔离守卫 + dialog）
│                 # seed.ts（绕过首启动向导）、fakeGateway.ts（对话用离线桩网关）
├── helpers/      # tempHome.ts（临时 HOME 生命周期）、nav.ts（模块切换）、confirm.ts（dialog 应答器）
└── specs/        # 00-smoke → 13-plugins（P0 冒烟 → P1 本地 CRUD → P2 半离线 → P3 安全关键路径 → 桩网关全链路）
```

**预置数据（seed）**：要让用例断言「有数据时」的行为（如文献库的条目展开），需在启动前把数据写进隔离 store。用 `makeTest({ transformSeed })`——`transformSeed` 在默认 seed **算好临时 HOME 路径之后**调用，可安全地往 `spaceData` 里塞空间层键（键名须对齐 `electron/library/*` 等模块的存储键）。**不要自建完整 seed**（会重复默认 seed 的路径拼接逻辑，易失配）。

**原生对话框**：Playwright 点不了 `dialog.showOpenDialog`（直接调 OS）。需要走「打开/新建项目」这类会先弹原生选择器的路径时，用 `makeTest({ openDialogPaths: [<已存在的目录>] })`——launch 会在主进程把原生 dialog 覆写为恒返回该路径。

#### 诊断一次 E2E 失败

```bash
npx playwright test 02-ledger          # 单文件
npx playwright test --grep "删除记录"   # 单用例
npx playwright show-trace test-results/<dir>/trace.zip
```

产物（`test-results/`、`playwright-report/`）已在 `.gitignore` 中。**不要用 `timeout` 掩盖慢**——曾有一个用例因用 `.click().catch()` 兜底而等待 30s 超时；正解是核对真实按钮文案。真实数据是否被污染，可在运行前后比对 `shasum ~/.mimir/store.json`。

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
`test/smoke/liveServerTool.test.ts` 是**生产同款装配**（`AgentService.initialize` + 真实 `server` 工具）
跑用户原话的端到端用例，用来验证「工具描述 + 能力域 guidance + 模型决策」三者合起来的行为——
这层是桩测覆盖不到的（桩测只能证明工具自身，证明不了模型被提示词引导着去追问）。

**写 live 用例的两条硬规矩**（都是踩坑换来的）：

1. **不要正则匹配模型措辞**。只断言两类稳定信号：
   - **落库/状态事实**（注册表字段的精确值）——不可辩驳；
   - **反向断言**（不许出现阻塞式追问）——语义精确、可穷举。
   反面教材：`已(新增|创建)` / `建上` 这类「正向措辞断言」被模型
   「先按你给的信息建上」→「把这台机器建到注册表里」→「服务器已经加好了」连续打脸。
   自然语言措辞是无穷集，用正则逮它 = 必然脆弱的用例。

2. **不要用 `if (x !== undefined) { assert(x) }` 做断言**。这等于给了后门：
   当被测行为**根本没发生**（如 agent 压根没建、没填 keyPath）时分支被跳过，用例还是绿的。
   真实例子：第一版只断言「keyPath 若存在则已展开」，而模型遇到「点名 id_rsa、目录里只有
   id_ed25519」时停下等用户拍板、没建服务器 → `added === undefined` → 用例假绿。
   合法分支要**显式二选一写死**（如 `if (kp === undefined) {...} else {...}`），
   让「什么都没发生」也落入某个必须成立的断言。

> 跑 live 用例会消耗真实额度（网关有 1 分钟 40 次的限流）。全量 `pnpm test` 前
> 确认环境里**没有** `MIMIR_GW_*`，否则全套 live 用例会被一并激活、互相抢配额并触发 429。

---

## Agent 工具清单

| 工具 | 说明 |
|---|---|
| `paper_search` | 检索学术论文：主源 OpenAlex；结果近期活跃时补 arXiv 最新预印本，空结果时 S2 语义检索兜底；`sortBy=submittedDate` 才走 arXiv 原生接口 |
| `arxiv_fetch_paper` | 按 arXiv id 读取单篇完整元数据（OpenAlex / S2 优先，不写入文献库） |
| `paper_fetch` | 按 arXiv id 或 DOI 获取并保存到文献库 |
| `library_search` | 检索文献库已收藏论文 |
| `wiki_search` / `wiki_note` | 检索 / 追加 Wiki 研究笔记（写操作需批准，并过权限矩阵与空间校验） |
| `web_search` | 网页搜索（只读） |
| `set_paper` | 更新文献库论文的标签、笔记、相关性评分 |
| `venue_search` | CCF 会议截稿与倒计时（本地缓存） |
| `experiment` | 实验模块 list / create / update / delete |
| `server` | GPU 服务器注册表 list / get / create / update / delete；**create 只有 `host` 必填** |
| `server_status` | GPU 服务器连通性 + nvidia-smi（只读） |
| `latex_compile` | 编译论文（latexmk / Tectonic，最长 120s） |
| `meeting_deck` | 生成组会 .pptx |
| `ledger` | 成长记录 list / create / delete |
| `figure` | 图表库 list / add / rename / remove |
| `load_memory` | 按需读取全局长期记忆 |

### 工具参数的「缺省代填」原则

用户口述的任务往往信息不全，但**不完整 ≠ 必须停下来追问**。判断标准是：
这个字段缺了之后，Agent 能否给出一个**可事后修正、且不影响正确性**的默认值？

- **能** → 直接代填并执行，在结果里说明用了什么默认值。典型：`server` 的
  `name`（缺省用 `user@host`）、`user`（缺省 `root`）、`port`（缺省 `22`）。
  `keyPath` 支持 `~` 写法并自动展开（`electron/agent/pathUtils.ts`）。
- **不能**（缺了会建立错误事实）→ 才询问。典型：`server` 的 `host`。

反例（真实事故）：用户说「ssh root@119.3.210.1，22 端口」，信息已足够建一条可用记录，
但 `create` 曾把展示用的 `name` 当必填硬性拒绝，Agent 只能回头问「显示名是什么」，
交互退化成「说一句做一句」。

> **副作用确认**：写盘 / 长耗时工具执行前推送「批准卡片」，拒绝或 120s 未响应自动取消。

## Agent 链路可观测性（OpenTelemetry）

Agent 的「模型层黑盒」问题（看不到每次模型请求实际收到的上下文、模型是否真发了 tool_call、
各次调用耗时与 token）由 **OpenTelemetry** 统一解决，见 `electron/agent/otelTrace.ts`。

**为什么是 OTel 而非某个厂商 SDK**：埋点只认「OTLP 端点」这一个出参，后端可换
（本地 Langfuse / 内网 Tempo / 其它 SaaS），埋点代码一行不改。

**埋点范围**：`@arizeai/openinference-instrumentation-langchain` 通过
`manuallyInstrument(CallbackManagerModule)` 钩住 LangChain 的 `CallbackManager.configure`，
因此**无需逐点埋桩**即覆盖 Agent 主循环、各增强子图、历史压缩、技能路由等全部模型与工具调用。
`agentService.streamMessage` 在外层开一根 `agent.turn` 根 span，一轮对话呈现为一棵树。

**默认后端是 Langfuse 而不是 Jaeger**：Jaeger 是「微服务调用链」工具，不懂 LLM —— prompt 原文
塞在 attribute 里不可读、没有「会话」概念、不做 token/成本聚合、不支持运行对比与标注。Langfuse
是专为 LLM 应用做观测的平台，OpenInference 的语义约定本就是喂给这类平台看的。

**配置**（优先级从高到低）：

1. 环境变量（开发用）：`MIMIR_OTEL_ENDPOINT` / `MIMIR_OTEL_HEADERS` / `MIMIR_OTEL_PUBLIC_KEY` /
   `MIMIR_OTEL_SECRET_KEY` / `MIMIR_OTEL_SERVICE_NAME` / `MIMIR_OTEL_ENVIRONMENT` /
   `MIMIR_OTEL_CAPTURE_CONTENT`；
2. 设置页「Agent → 可观测性」：`settings.otel`（`enabled` / `endpoint` / `publicKey` /
   `secretKey` / `serviceName` / `environment` / `headers`）；
3. 都不配置 → **完全不初始化 SDK**，零开销、零网络请求（默认态）。

**接 Langfuse 的两个硬性约束**（写错会「看起来没数据」）：

1. **必须带 `x-langfuse-ingestion-version: 4` 请求头** —— 不带的话 OTLP 直采数据延迟可达 10 分钟。
   该头由 `buildLangfuseHeaders()` 在 exporter 层**强制注入**，用户无需手填，填了 public/secret key 即自动带上。
2. **仅支持 OTLP over HTTP，不支持 gRPC**，且端点路径**不带** `/v1/traces`（即
   `http://localhost:3000/api/public/otel`）。故用 `exporter-trace-otlp-proto`（HTTP/protobuf）。

认证为 HTTP Basic：`base64(public_key:secret_key)`，由配置里的两个 key 自动生成，不让用户手写 base64。

**会话可过滤性**：Langfuse 只把 `langfuse.trace.metadata.*` / `langfuse.observation.metadata.*`
映射为**可过滤/可聚合**字段，未映射的 OTel 属性会落进不可查询的 `metadata.attributes`。因此根 span
除了打 OTel 约定的 `session.id`，还会同步打一份 `langfuse.trace.metadata.session_id`。

**prompt 版本 / 评测 / 成本走 SDK，不走 OTel**：Langfuse 官方立场是 OTLP 直推为「已有 OTel 环境」
的兼容入口，prompt 版本管理、数据集评测、分数标注应使用 **Langfuse SDK** 的显式 API。本模块只负责
自动链路观测；需要这些能力的点位按需引入 `langfuse` 包，二者共存互不冲突（当前尚未引入）。

**在 Docker 里跑**（按需启停，平时不占资源；官方推荐配置 4 核 / 16 GiB / 100 GiB）：

```bash
cp docker/langfuse.env.example docker/.env            # 首次：生成配置（默认值开箱即用）
cd docker && docker compose -f langfuse-compose.yml up -d   # UI: http://localhost:3000
cd docker && docker compose -f langfuse-compose.yml down    # 用完关掉
```

首次启动约 2-3 分钟（ClickHouse 建表 + 迁移），`logs -f langfuse-web` 出现 "Ready" 即可访问。
compose 用 `LANGFUSE_INIT_*` 自动建好组织/项目/API Key（默认 `pk-lf-mimir-local` /
`sk-lf-mimir-local`），无需去 UI 手动创建。已按「按需启动」口径**去掉官方 compose 的
`restart: always`**，并关闭匿名遥测（`TELEMETRY_ENABLED=false`）以守住数据不出境的口径。

**宿主端口（全部只绑 `127.0.0.1`，LAN 不可达）**：`3000` UI + OTLP、`6380` Redis、
`5432` Postgres、`9092` MinIO、`8123`/`9000` ClickHouse、`3030` worker、`9091` MinIO 控制台。
其中 **Redis 刻意用 6380 而非 6379** —— 宿主 6379 常被其它项目占用；容器间互访走 compose
内部网络（`redis:6379`），与宿主端口无关。**UI 只绑本机是硬性要求**：链路含 prompt 原文与
论文数据，不可被局域网访问。

**改密码后必须重建容器**：`.env` 里的 `POSTGRES_PASSWORD` / `CLICKHOUSE_PASSWORD` 只在
**数据目录为空时**用于初始化。卷里已有数据时这两个变量会被忽略，实际密码仍是旧的，必须
`docker compose up -d --force-recreate` 后进容器 `ALTER USER` 改（ClickHouse 例外：它在启动
时按 `CLICKHOUSE_PASSWORD` 自动重建用户）。另注意 `DATABASE_URL` 里的密码要与
`POSTGRES_PASSWORD` 保持一致。

**项目名**：compose 里显式写了 `name: langfuse`，否则 Docker 会用「文件所在目录名」推导，
在桌面端显示成一组叫 `docker` 的容器。改名后数据卷（`docker_langfuse_*`）以 `external` 方式
引用，故不丢数据。

**数据出境口径**：当前为**完整上报**（span 含模型收到的完整原文，包括论文与实验数据），
所以默认端点指向 localhost。是否出境取决于用户填的端点 —— 这是产品责任边界，代码层不做
截断/脱敏。仅保留 `captureContent` 开关以便将来切云后端时一键降级（UI 未暴露）。

**退出时 flush**：`NodeSDK` 的 batch processor 是异步批量上报，不 `shutdown()` 会丢最后几条
trace。`main.ts` 的 shutdown 链已调用 `shutdownOtel()`（带 3s 整体超时）。

> 已移除的自研设施：`electron/agent/trace.ts`（`[agent-trace]` 终端输出 +
> `~/.mimir/logs/agent-trace-*.jsonl` 同步落盘）。它仅覆盖约 15% 能力，且
> `appendFileSync` 会阻塞主进程。见 [docs/自研替换清单.md](./docs/自研替换清单.md)。

## 可观测性（统一日志）

主进程与渲染进程统一走 **electron-log**（社区事实标准，零依赖）：

- 主进程：`electron/logger.ts`（`log` / `streamLog` / `agentLog` / `ipcLog`），在 `main.ts` 启动早期初始化。
- 渲染进程：`src/lib/logger.ts` 经 preload 的 `window.mimirLog` 桥（`log:write` 通道）送主进程，
  **与主进程日志写同一文件、同一时间轴**（官方推荐做法，避免多进程争抢文件）。
- 落盘位置：macOS `~/Library/Logs/{appName}/main.log`；Windows `%APPDATA%\{appName}\logs\main.log`。
  超过 5MB 自动轮转；未处理异常由 `log.errorHandler` 兜底记录。
- 级别：开发 `debug`、生产 `info`，可用环境变量 `MIMIR_LOG_LEVEL` 覆盖。

### 流式链路埋点约定

「回复内容显示不全」这类问题横跨 `模型 → 主进程 → IPC → 渲染层`，靠单点日志无法定位。

**事件协议**：流式内容统一走 `electron/agent/streamProtocol.ts` 定义的**结构化事件**
（`text-delta` / `worker` / `end` / `error`），每个事件带单调 `seq` 与 `streamId`。
不再使用「不可见控制字符前缀 + JSON 字符串」的旧信封方案（该方案已删除）。

链路上固定打以下日志，**先看有无跳号，再看长度**即可收敛到具体环节：

| 日志 | 位置 | 含义 |
|---|---|---|
| `agent` `stream.end.emit` | `agentService.ts` 逐字流收尾 | 模型产出的全文长度（一手事实） |
| `stream` `stream.seq.gap` | `preload.ts` 事件监听 | **seq 跳号 = 确定性丢包**（含缺失量与事件类型） |
| `stream` `stream.evt.stale` | `preload.ts` 事件监听 | 陈旧流的迟到事件（按 `streamId` 丢弃） |
| `stream` `stream.end.out` | `ipc/index.ts` invoke 返回后 | 主进程实际转发的事件数 + 字符数 |
| `stream` `stream.end.in` | `ChatView.tsx` 收到结束事件 | 渲染层实际收到的字符数 |

判定规则：

1. **有 `stream.seq.gap`** → 传输丢包（IPC / 渲染层），日志直接给出丢在第几号、缺几个，无需再猜。
2. 无跳号，但 `stream.end.emit` 就偏少 → 问题在**模型 / 网关**，与前后端无关。
3. 无跳号，`emit` 正常但 `stream.end.in` 长度不符（`stream.end.mismatch`）→ 主进程转发环节。
4. 有 `stream.evt.stale` → 该内容属于**上一轮**的迟到事件被正确丢弃，不是 bug。
5. 另有 `stream.evt.drop`（渲染层，`ChatView.tsx`）：本会话被用户停止 / 被新一轮顶掉后的丢弃。

> 与旧方案的关键差别：旧方案只能靠「最终长度对不上」反推丢包，无法知道丢在第几个包；
> 现在 `seq` 跳号是丢包的**直接证据**，且 `streamId` 让「陈旧流串台」可判定。

## 渲染层运行态（「思考中」显示契约）

聊天区时间线是否显示「执行中 / 正在思考…」由 `isRunActive(run, isStreaming)` 决定，
**`run.status` 是权威终态**（由主进程 main task 事件驱动，见 `applyRunEvent`）。

- `run.status` 一旦离开 `running` 即为终态，任何外部标记都**不得**把它复活。
- `isStreaming` 是**会话级**辅助信号（`streamingConvIds`），仅作兜底，不参与终态判定。

> **历史缺陷（已修）**：时间线原先用 `run.status === 'running' || isStreaming === true`
> 判定，`||` 让一个**已结束**的 run 只要外部标记残留就继续显示「执行中」。而该标记的清理
> 曾被 epoch 守卫挡掉（旧回复被新流顶掉后永远不关灯）→ 界面永久「正在思考…」、输入区永久禁用。
> 回归用例：`test/unit/agentRun.test.ts` 的 `isRunActive` 分组（数据层契约）
> + `test/unit/agentTimelineStreaming.test.tsx`（渲染层 DOM，直接断言不再出现「正在思考…」）。

会话级运行态的**按归属关灯**：`ChatView` 持有 `ConvStreamingRegistry`
（`src/components/chat/convStreaming.ts`，纯数据、可单测），以 convId → sendId 登记当前
活跃回复。开场 `begin`，收尾统一走 `releaseConvStreaming(convId, sendId)` → `registry.release`
做 **compare-and-clear**：只有登记的活跃回复仍是自己时才关灯。停止时 `forget` 清掉归属，
让旧流之后迟到的 finally 认不出「自己」而保持沉默。

取「归属比较」而不是「无条件关灯」或「只用 epoch 判断」，是为同时避免两类错：

- 旧流迟到收尾**不能**关掉已经开场的新流（否则界面看着像结束了，实际还在跑）；
- 新流开场后，旧流被顶掉也**不会**导致没人关灯（那正是本次永久「正在思考…」的成因）。

回归用例：`test/unit/convStreaming.test.ts`（正常收尾 / 迟到收尾 / 停止后重发 / 多会话隔离）。

## 技能与指令

对话框输入 `/` 弹出「技能与指令」菜单（过滤 + 键盘补全），展开为任务提示注入 Agent（L0，无文件副作用）：

- **指令**：`/research-idea` `/research-plan` `/paper-write` `/paper-compile` `/research-review`
- **技能**：`/research-pipeline` `/research-lit-review` `/research-novelty-check` `/research-experiment-plan` `/research-result-to-claim` `/research-paper-drafting` `/research-paper-deai` `/research-citation-audit` `/research-rebuttal` `/research-figure-plan` `/research-meeting-deck`
- 输入 `/trigger 参数` 可调用自定义技能（覆盖 `{{args}}` 占位符）。

---

## 任务工作流（TaskFlow）

本仓库采用 [TaskFlow](https://github.com/hkwuks/TaskFlow) 约定管理开发任务的决策留痕。它**不是 Agent，也不是依赖包**，而是一套「任务事实放哪里、工作如何流转」的 Markdown 约定 + 一组显式调用的生命周期命令。

### 为什么用它

代码变更在 Git 里能看到，但**当初为什么这么决策看不到**。新开会话即失忆，需求一改就覆盖原方案。TaskFlow 让决策变成跟着仓库走的文件。

### 目录约定

| 路径 | 说明 | 进 git |
|---|---|---|
| `taskflow/` | TaskFlow 工具本体（Skill 定义 + hooks 脚本） | 是 |
| `TaskFlowDocs/todo.md` | 唯一待办收集箱，每个合格请求先在此建档 | 是 |
| `TaskFlowDocs/<YYYY-MM-DD-short-slug>/` | 单个任务的 `prd.md` / `spec.md` / `plan.md` | 是 |
| `TaskFlowDocs/achieved/` | 已完成任务（只读历史，不修改） | 是 |
| `TaskFlowDocs/repository-docs/index.md` | 仓库文档路由与检查记录 | 是 |
| `TaskFlowDocs/repository-docs/personal-*.md` | 个人规则 | **否**（已在 `.gitignore` 排除） |
| `TaskFlowDocs/_archive-from-docs/` | 原仓库根 `docs/` 的历史归档 | 是（只读，不再更新） |

### 生命周期

```
planning → ready → in_progress → checking → completed
    │                     │
    └──── blocked ◄────────┘
```

**`ready` 不等于批准**：`plan.md` 的 `## Approval` 未记录批准前，不得开始实施。

### 命令

CodeBuddy 没有 TaskFlow 的宿主 hooks 绑定，但 hooks 脚本是**显式命令**，可主动调用（已在本机 macOS + bash 3.2 验证通过，`./taskflow/hooks/smoke-test` 全绿）：

```bash
./taskflow/hooks/task intake "<目标>" [来源]                   # 建档，分配 Todo ID
./taskflow/hooks/task promote <todo-id> <task-id> small|large # 生成 prd.md/plan.md 骨架
./taskflow/hooks/task state <task-id> <状态>                   # 流转状态（in_progress 需已批准）
./taskflow/hooks/task progress <task-id> <step> <状态> [验证]  # 更新单个步骤
./taskflow/hooks/task complete <task-id> --user-accepted       # 完成并归档
./taskflow/hooks/archive <task-id>                             # 归档到 achieved/
./taskflow/hooks/reopen <task-id>                              # 取回已归档任务
./taskflow/hooks/version <task-id> <new-v>                     # 任务版本升级
./taskflow/hooks/summarize-state                               # 查看当前任务与下一步
```

### 在 CodeBuddy 中使用

技能入口：`.codebuddy/skills/taskflow/SKILL.md`（适配层，路由到 `taskflow/skills/taskflow/SKILL.md` 的权威定义）。开工前先读权威定义。

### 两条硬规矩

1. **变更分级**：措辞 / 实现方法 / 进度调整 = 工作修订，只追加 `## Change Log` 一行，版本不变；目标 / 需求 / 验收标准 / 范围 / 架构接口契约变更 = 任务版本变更，需归档旧版、全部核心文档升版、**重新批准**。
2. **语言边界**：正文写中文，但被 hooks 解析的结构行必须保持英文原样 —— `> Task version:`、`> Status:`、`## ` 标题、`## Approval` 字段、`### Step N`、`- Status:`、`- [ ]` / `- [x]`。这是唯一会让机械校验失效的地方。

### 来源与许可

TaskFlow 上游为 **AGPL-3.0**，副本见 `taskflow/LICENSE-TaskFlow`。本仓库仅在本地开发期作为工作流工具使用，未将其代码并入产品实现。

---

## 项目结构

```
├── electron/                      # Electron 主进程
│   ├── main.ts                    # 进程入口（mimir-pdf / mimir-tex / mimir-img 本地协议注册）
│   ├── preload.ts                 # 预加载脚本（IPC 桥接）
│   ├── safeUrl.ts                 # 外链协议白名单（窗口层与 IPC 层共用）
│   ├── logger.ts                  # 统一日志设施（electron-log；流式链路埋点作用域）
│   ├── latex.ts                   # LaTeX 编译引擎与日志解析
│   ├── ipc/                       # IPC 处理器（按域拆分，一个文件一个域）
│   │   ├── index.ts               # 注册入口 + 路径边界校验（assertRendererPath 等）
│   │   ├── guards.ts              # 边界校验函数类型（供子域模块依赖注入）
│   │   ├── latex.ts               # LaTeX 编译 + 论文项目文件（latex:*）
│   │   ├── library.ts             # 文献库 / 订阅 / Zotero / AI 相关性评分（library:*）
│   │   ├── meetings.ts            # 组会演示文稿（meetings:*）
│   │   ├── figures.ts             # 图表入库 / 删除 / 改名（figures:*）
│   │   ├── workspaces.ts          # 科研空间（workspaces:*）
│   │   ├── venues.ts              # 会议截稿（venues:*）
│   │   └── paper.ts               # 论文快照 / AI 修复 / Bib / 会议模板（snapshots:* + paper:*）
│   ├── library/                   # 文献库服务（论文 / 项目 / 订阅、BibTeX、Zotero）
│   ├── figures/                   # 图表管理
│   ├── paper/                     # 论文增强（快照 / AI 修复 / Bib / 会议模板）
│   ├── meetings/                  # 组会演示文稿
│   ├── venues/                    # 会议截稿
│   ├── servers/                   # 服务器（SSH / nvidia-smi / 终端）
│   ├── speech/                    # 语音识别（SenseVoice / sherpa-onnx）
│   ├── modelDiscovery.ts          # /v1/models 自动发现
│   ├── agent/                     # DeepAgents 集成（单 Agent + 能力域）
│   │   ├── agentService.ts        # Agent 服务（装配 / 技能路由 / runConversation 主循环）
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
│   │   ├── fsBackend.ts           # 磁盘文件后端（全部入口：读/写/改/删/列目录/检索/批量读写 均过权限矩阵）
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
├── e2e/                           # 端到端测试（Playwright + Electron 构建产物）
│   ├── fixtures/                  # 启动、隔离守卫、seed、Playwright fixture
│   ├── helpers/                   # 临时 HOME、模块导航、dialog 应答
│   └── specs/                     # P0 冒烟 → P1 本地 CRUD → P2 半离线 → P3 安全关键路径
├── src/                           # 渲染进程（React + Tailwind + Shadcn-UI）
│   ├── renderer/                  # 应用外壳（App.tsx、会话状态）
│   ├── components/
│   │   ├── chat/                  # 对话视图（消息流、时间线、批准卡）
│   │   ├── modules/               # 业务模块（文献库 / 图表 / 组会 / 设置等）
│   │   │   ├── Settings.tsx       # 设置页主组件（业务模块入口，扁平放置）
│   │   │   ├── settings/          # 设置页内聚子组件（各设置卡 + ModelDialog / SkillsDialogs）
│   │   │   ├── library/           # 文献库（主组件 Library.tsx + 卡片 / 阅读器 / 类型）
│   │   │   ├── meetings/          # 组会（主组件 Meetings.tsx + types.ts）
│   │   │   ├── paper/             # 论文增强弹窗（Bib / LaTeX / 快照 / 会议模板）
│   │   │   └── figures/           # 图表弹窗（导入 PDF / 重命名）
│   │   ├── layout/                # 布局骨架
│   │   └── ui/                    # Shadcn-UI 基础组件
│   └── lib/                       # 工具库（含 logger.ts 渲染层日志门面、slash/ 斜杠命令）
├── build/                         # electron-builder 资源（icon.png）
├── taskflow/                      # TaskFlow 工具（Skill 定义 + hooks，AGPL-3.0，仅开发期使用）
│   ├── skills/taskflow/           # 权威工作流定义（SKILL.md + references/）
│   └── hooks/                     # 显式生命周期命令（task / archive / version / smoke-test）
├── TaskFlowDocs/                  # 任务决策留痕（prd / spec / plan，随仓库走）
│   ├── todo.md                    # 唯一待办收集箱
│   ├── achieved/                  # 已完成任务（只读）
│   └── _archive-from-docs/        # 原仓库根 docs/ 的历史归档（只读）
└── .github/workflows/release.yml  # tag 触发的三平台构建发布
```

---

## License

MIT（见 `package.json` 的 `license` 字段）。功能与理念承自 [dsh-Mimir-Academic-research](https://github.com/1692775560/dsh-Mimir-Academic-research)（MIT）。
