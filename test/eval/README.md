# 科研 Agent 评测集（Eval Harness）

为 Mimir 科研 Agent 建立的**评测基础设施**：定义任务集 → 注入执行器 → 度量 → 落盘报告 → A/B 对比。

它解决的问题：没有评测就无法回答「某项增强到底有没有用」「架构改动是变好还是变坏」。

> 设计原则：**评测只做「定义 + 度量 + 对比」，不自研 Agent 执行逻辑。**
> 执行器由外部注入（依赖倒置），因此同一套评测可以接真实 Agent、mock、或任何其它实现。

---

## ⛔ 维护者须知（改动前必读）

> ### ① `realRunner.ts` 里的 electron 侧 import **必须保持惰性**（`await import()`），**不要改回静态 import**
>
> CLI 走 `node --experimental-strip-types`，而 Node 原生解析不了 electron 侧的**无扩展名导入**
> （如 `electron/library/store` → `ERR_MODULE_NOT_FOUND`）。一旦改成静态 import，
> **连 `npm run eval`（mock 模式）都起不来**，直接崩在启动阶段。
> 静态 `import type`（仅类型）不产生运行时代码，**可以**保留。详见下文「惰性 import 约定」。

> ### ② 不要拿 mock 结果当结论
>
> `mockRunner.ts` 的成功率**恒为 100%**（它按 `expected` 反推理想响应）。它是**链路校准基线**，
> **不是效果结论**。报告里认 `runner: "real"` 才算数。详见下文「关于 mock（重要）」。

> ### ③ `realRunner.ts` 尚未打过一次真实网络调用
>
> 当前环境**无网关凭据**，真实适配器只验证到「装配可加载 + 纯函数单测」。
> 配好凭据跑一次真实 run 前，**它的产出未经端到端验证**。详见下文「未验证声明」。

> ### ④ 真实评测**不要**走 `node test/eval/cli.ts --real-agent`，要走 vitest
>
> CLI 走 `node --experimental-strip-types`，而 Node 的 ESM 解析器要求**显式文件扩展名**；
> electron 侧模块内部全是无扩展名导入（`../library/store`、`./controlPlane` …），
> 因此真实装配在 CLI 下必然抛 `ERR_MODULE_NOT_FOUND`。mock 模式因为按设计惰性 import、
> 根本不加载这条依赖链，所以这个缺陷长期不可见。
>
> **可执行入口是 `test/eval/realAgentEval.test.ts`**（vitest 侧有 vite 解析器 + store 桩）。
> 该风险已由常驻回归测试 `test/unit/evalHarness.test.ts` 的「真实适配器：装配链路」守住 ——
> 它一旦变红，说明真实评测与 A/B 全都跑不起来了。

---

## 文件结构

| 文件 | 职责 | 是否有副作用 |
| --- | --- | --- |
| `cases.ts` | 评测任务集定义（26 条）+ `EvalCase` 类型 | 无（纯数据） |
| `metrics.ts` | 指标计算、聚合、A/B 对比、报告渲染 | 无（纯函数，可单测） |
| `runner.ts` | 编排：筛选 → 并发 → 超时 → 收集 → 落盘 | 有（计时 / 写文件） |
| `mockRunner.ts` | **未验证的 mock 执行器**（仅用于打通链路） | 无 |
| `realRunner.ts` | **真实 Agent 适配器**（唯一接线处，每轮装配单 Agent 实例；可选开启 Ultra） | 有（打真实网络） |
| `realAgentEval.test.ts` | **真实评测 / A/B 的可执行入口**（vitest；无凭据时整组跳过） | 有（打真实网络） |
| `cli.ts` | 命令行入口（参数解析 / 执行器选择 / 对比模式） | 有 |
| `results/` | 落盘报告目录（`<timestamp>.json`），已 `.gitignore` | — |

**两种执行器**（报告 JSON 里用 `runner` 字段记录，控制台抬头也会标注）：

| `runner` | 来源 | 成功率 | 用途 |
| --- | --- | --- | --- |
| `mock` | `mockRunner.ts` | **恒 100%** | 打通链路、校准指标。**不可作为效果结论** |
| `real` | `realRunner.ts` | 取决于模型 | 真实评测，结论有效 |

---

## 快速开始

```bash
# 跑全量评测（当前走 mock 执行器）
npm run eval -- --label mock-baseline

# 真实评测 —— 唯一可执行入口是 `eval:real`（vitest 跑 realAgentEval.test.ts，理由见「维护者须知 ④」）
MIMIR_GW_URL=... MIMIR_GW_KEY=... MIMIR_GW_MODEL=... \
  MIMIR_EVAL_LABEL=single-agent pnpm eval:real

# 按能力域 / 难度筛选
npm run eval -- --category literature --difficulty hard

# 提高并发 + 只跑指定用例 + 不落盘
npm run eval -- --concurrency 4 --id lit-01 --id srv-01 --no-save

# 单元测试
npm run test:eval
npx vitest run test/eval/            # 目录形式的等价写法
```

### 命令行参数

| 参数 | 说明 |
| --- | --- |
| `--label <name>` | 报告标签，用于区分版本（如 `single-agent` / `single-agent-ultra`） |
| `--category <cat>` | 只跑某能力域，可重复；可选 `literature/paper/experiment/meeting/server/files/other` |
| `--difficulty <level>` | 只跑某难度，可重复；`easy/medium/hard` |
| `--id <caseId>` | 只跑某用例，可重复 |
| `--concurrency <n>` | 并发度，默认 1 |
| `--timeout <ms>` | 单条用例超时，默认 120000（超时记为失败，不中断整轮） |
| `--out <dir>` | 报告输出目录，默认 `test/eval/results` |
| `--no-save` | 不落盘 |
| `--real-agent` | 使用真实 Agent（需网关凭据；缺凭据**跳过并退出码 2**，不降级为 mock）。⚠️ 见「维护者须知 ④」：CLI 下真实装配会因模块解析失败，请改用 vitest 入口 |
| `--ultra` | 开启 Ultra 增强层（仅 `--real-agent` 下有效；mock 下会直接报错） |
| `--ultra-strategy <name>` | 指定增强策略（隐含 `--ultra`）：`auto` / `multi_expert` / `critique_reflect` / `hybrid_mix` / `self_consistency_vote` |
| `--compare <a.json> <b.json>` | 对比两份报告并退出 |

---

## ⚠️ 关于 mock（重要）

**默认执行器是 `mockRunner.ts`，它是「未验证的 mock」。**

mock 的行为是**根据 `EvalCase.expected` 反推的理想化响应**（只调用 `mustCallTools`、绝不调用 `mustNotCallTools`），
因此它的成功率必然是 **100%**——这是刻意的**上界基线**，用于校准指标与验证链路，**绝不能用它判断某项增强有没有用**。

为此做了三重防呆，防止有人拿 mock 结果当结论：

1. 控制台抬头打印 `⚠️ runner=mock（…成功率恒 100%…不可作为效果结论）`；
2. 报告 JSON 里带 `runner` 字段（`"mock"` / `"real"`）；
3. 无凭据时 `--real-agent` **跳过并退出码 2**，**绝不静默降级为 mock**。

> 顺带说明：`file-02` / `file-03` 要求调用内置文件工具 `read_file` / `write_file`。
> mock 只认 `WORKER_TOOL_CATALOG` 里的工具，**所以这两条在 mock 下必然失败——这是预期行为**，
> 不是回归。真实适配器会映射内置文件工具，届时它们才应通过。

---

## 接入真实 Agent（`--real-agent`）

适配器实现在 **`realRunner.ts`**，装配范式照抄 `test/smoke/liveAgent.test.ts`：
**不依赖 `agentService`、不依赖 electron 的 `app.getPath`**，自己 `new ChatOpenAI` +
`createDeepAgent` + `MimirFsBackend` 组装一个真实的主 Agent 实例，并注册
`buildDomainSubagents(domains)` 能力域子代理——**与生产 `agentService` 装配对齐**
（主 Agent 直调全量工具，同时可通过 `task` 委派给域子代理）。若不注册子代理，
deepagents 会注入只含默认 `general-purpose` 的 `task` 工具，模型一旦委派
（如 `cross-01` 委派给 `literature`）会直接抛
`invoked agent of type ... only allowed types are general-purpose` 导致整条运行失败。

### 跑起来

```bash
export MIMIR_GW_URL=...      # 网关 baseURL
export MIMIR_GW_KEY=...      # API Key
export MIMIR_GW_MODEL=...    # 模型名
node --experimental-strip-types --no-warnings test/eval/cli.ts --real-agent --label real-baseline
```

凭据沿用 `liveAgent.test.ts` / `liveMatrix.test.ts` 的同一套变量约定，未自创。
**三个变量必须齐备**，缺任一个都会走跳过分支（退出码 2）。

### 四项指标的采集点（都在 `realRunner.ts` 内，未改任何生产代码）

| 指标 | 采集方式 | 位置 |
| --- | --- | --- |
| 工具调用序列 | `ToolCallTraceHandler`（LangChain `BaseCallbackHandler`）挂在 model 的 `callbacks` 上，监听 tool start/end/error | `realRunner.ts` |
| token 消耗 | 同一 handler 的 `handleLLMEnd`，累加 `llmOutput.tokenUsage`（读法与 `trace.ts` 的 `summarizeOutput()` 一致，但**不在那边增强**） | `realRunner.ts` |
| 人工干预次数 | `setApprovalSender` + `queueMicrotask(() => settleApproval(req.id, true))`，与 `liveAgent.test.ts` 的 `installAutoApprover` 完全一致 | `realRunner.ts` |
| 延迟 / 最终输出 | `performance.now()` 包住 `agent.invoke(...)`；最终文本取最后一条非空 AI 消息 | `realRunner.ts` |

### ⚠️ 必须自动批准

`installAutoApprover()` 会在无 GUI 环境下**立即放行每张批准卡**。
**不自动批准 = 卡死到超时**（评测无人值守，没人来点「同意」）。
注意：自动批准**不代表没人干预**——`approvalCount` 统计的是**批准卡触发次数**，即人工干预次数。

### 内置文件工具的映射（**已覆盖，依据见下**）

`read_file` / `write_file` / `edit_file` / `ls` / `glob` / `grep` / `delete` 由 deepagents 的
`FilesystemMiddleware` 经 `MimirFsBackend`（`FilesystemBackend` 子类）注入，
**不在 `WORKER_TOOL_CATALOG` 里**，也不在 `resolveAllWorkerTools()` 的返回里。

**它们仍然会被采集到，依据是采集点的选型**：

- `ToolCallTraceHandler` 是 `BaseCallbackHandler`，挂在 **`ChatOpenAI` 的 `callbacks`** 上，
  实现的是 `handleToolStart` / `handleToolEnd` / `handleToolError`；
- 这是 **model 回调层**，只要模型发起了一次工具调用，无论该工具来自
  `resolveAllWorkerTools()` 还是 `FilesystemMiddleware` 注入的内置工具，**都会触发**；
- 因此内置文件工具**一并进入 `EvalRun.toolCalls`**——这正是 `file-02` / `file-03` 能写
  `mustCallTools: ['read_file']` / `['write_file']` 的前提。

> 为什么不用「测试侧包装每个工具实例」的方案：内置工具由 `FilesystemMiddleware.wrapModelCall()`
> 注入，名字固定且**不透出实例**（LangChain v1 禁止「同名换实例」，见 `test/contract/toolNames.test.ts`），
> 拿不到实例去包。回调层选型绕开了这个限制，且覆盖范围更大（连中间件自己发起的调用也覆盖）。

> ⚠️ **诚实声明（可证伪）**：本仓库无网关凭据，**尚无一次真实 run 的 `file-02` 通过记录**。
> 但上述覆盖**不是猜测**，有两条独立依据：
>
> 1. **生产先例（同一机制已在 electron 侧依赖）**：`electron/agent/trace.ts` 的 `handleToolStart`
>    （约 L201-203）**就是用同一套 `BaseCallbackHandler` 回调**来观测工具调用，其注释明写
>    「与 `withToolTrace` 互补，能捕获 deepagents 内部（含 Agent 主循环直接发起）的每次工具」。
>    换言之：**若该回调机制对本项目的工具调用不生效，坏掉的将不只是本评测——生产执行轨迹（事件树）本身早已是坏的**。
>    这条声明因此是「生产已依赖 + 本评测单测复核」的双重支撑，而非 50/50 的赌注。
> 2. **契约依据**：`test/contract/toolNames.test.ts` 已确认 deepagents 经 `FilesystemMiddleware`
>    注入的文件系统工具名**固定为那 7 个**，且 LangChain v1 禁止「同名换实例」，所以名字稳定、可断言。
>    本文件用例引用的正是这 7 个名字。
>
> **怎么把它变成「已验证」（下一步，可执行）**：配上凭据后跑
> `node --experimental-strip-types --no-warnings test/eval/cli.ts --real-agent --id file-02 --no-save`，
> 然后看报告 / 控制台里该用例的**「工具数」列 > 0** —— 即证明内置文件工具已进入 `toolCalls`，声明转为已验证。
>
> **若证伪**（首次真实 run 发现内置工具未进 `toolCalls`）：把 `file-02` / `file-03` 的 `mustCallTools`
> 回退为纯 `mustNotCallTools`，并在本文件 TODO 记录——**不要留一条红的 mustCall 断言**。

### ⛔ 惰性 import 约定（**硬约束：别改回静态 import**）

> 见文首「维护者须知 ①」。这条不是风格偏好，是**启动成败问题**。

`realRunner.ts` 对 electron 侧模块（`approval` / `artifactExtract` / `capabilityDomains` / `fsBackend`）
以及 `@langchain/openai` / `deepagents` **一律用惰性 `import()`**。原因：

- CLI 走 `node --experimental-strip-types`，Node 原生解析不了 electron 侧的**无扩展名导入**（`electron/library/store` → `ERR_MODULE_NOT_FOUND`），会直接崩在启动阶段；
- vitest 里虽然有 alias 兜底，但惰性化对单测无害，且能保证「mock 跑评测不加载 electron 依赖链」。

静态 type-only import（`import type`）不产生运行时代码，可以保留。

### 未验证声明

当前仓库环境**没有网关凭据**（`MIMIR_GW_URL/KEY/MODEL` 均未设置），因此
**`realRunner.ts` 尚未打过一次真实网络调用**——它只通过了「装配依赖可加载 + 纯函数单测」的验证。
这正是为什么 `--real-agent` 走的是**显式跳过**而不是静默降级。

复现命令（配上凭据后即可验证）：

```bash
MIMIR_GW_URL=... MIMIR_GW_KEY=... MIMIR_GW_MODEL=... \
  MIMIR_EVAL_IDS=lit-01 pnpm vitest run test/eval/realAgentEval.test.ts
```

### 尚未完成（诚实清单）

- [ ] `rubric` 只做记录，未接 LLM judge（质量维度仍需人工评审）。
- [ ] 真实适配器未打过一次真实网络（见上方「未验证声明」）。
- [ ] **Ultra 的 A/B 从未跑过**。增强层现在已可被评测（`MIMIR_EVAL_ULTRA`，实现见
      `electron/agent/ultra.ts`，生产与评测共用同一份代码），但仍缺一次带真实凭据的对照结论。
      在此之前，「Ultra 有没有用」属于**未验证假设**，不应据此增删功能。
- [ ] 内置文件工具进 `toolCalls` **尚缺一次真实 run 记录**。依据充分（生产先例 `electron/agent/trace.ts`
      `handleToolStart` 依赖同一回调 + 契约测试 `test/contract/toolNames.test.ts`），
      验证方法：跑 `--id file-02` 后看该用例「工具数」列 **> 0** 即为已验证；
      若证伪，按上文「诚实声明（可证伪）」回退 `file-02` / `file-03` 的 `mustCallTools`。

---

## 评测任务集

共 **26 条**，覆盖 6 个能力域 + 跨域 + 负例：

| 能力域 | 条数 | 示例用例 |
| --- | --- | --- |
| `literature`（文献，含 1 条跨域） | 8 | `lit-01` 检索 diffusion policy 论文并入库；`lit-06` 查 NeurIPS 截稿 |
| `paper`（论文） | 5 | `paper-01` 编译 LaTeX 并解释报错；`paper-05` 先查笔记再追加 |
| `experiment`（实验） | 3 | `exp-02` 创建实验并记录基线指标 |
| `meeting`（组会） | 3 | `meet-01` 本周实验进展整理成 PPT |
| `server`（服务器） | 2 | `srv-01` 查询 GPU 服务器状态 |
| `files`（文件） | 3 | `file-01` 列目录；`file-03` 把结论写成文档（`read_file` / `write_file` 是内置工具） |
| `other`（负例） | 2 | `neg-01` 解释 Transformer（**不该调用工具**） |

工具 id 全部取自 `electron/agent/capabilityDomains.ts` 的 `WORKER_TOOL_CATALOG`（16 个），
并由单测 `evalHarness.test.ts` 强制校验一致性（主 Agent 直调全量工具；`task` 委派工具
也可用，委派给域子代理时其内部工具调用同样计入 trace，见 `realRunner.ts` 装配说明）。
`file-02` / `file-03` 额外引用内置文件工具 `read_file` / `write_file`，走 `BUILTIN_FS_TOOL_IDS` 白名单（见上文「判定规则」）。

### 用例字段

| 字段 | 说明 |
| --- | --- |
| `id` / `name` / `category` / `difficulty` / `notes` | 标识与分类 |
| `input` | 用户消息（直接作为一轮输入） |
| `expected.mustCallTools` | 必须调用的工具 id（缺一即失败） |
| `expected.mustNotCallTools` | 明确不该调用的工具 id（出现即失败） |
| `expected.expectedArtifacts` | 期望产物的文件名/扩展名（**observed-only，人工核对，不参与判定**） |
| `expected.rubric` | 质量评分要点（**人工/LLM 评审**，不参与自动判定） |

### 判定规则（唯一权威）

**`pass` / `fail` 由「运行有效性下限 + 工具调用合规」共同决定**，别的字段都不参与。

**第 0 步：运行有效性下限（`runInvalidReason`）** —— 先确认这一轮真的跑起来了：

- `runError` 非空（runner 兜底的超时 / 抛错）→ 失败；
- 最终输出为空 **且** 没有任何工具调用（模型空回 / 网关不可达）→ 失败。

> 为什么必须有：负例只写 `mustNotCallTools`（期望「不调用某些工具」）。当模型彻底没响应时，
> 实际调用集合为空 —— **零调用同样满足「没有调用禁止的工具」**，于是负例全部假通过，
> 且方向是反的（模型越坏、负例越好看）。A/B 也会被带偏：若某版本更容易失败（如增强层把请求拖超时），
> 它的负例反而「变好」。这个缺陷曾长期掩盖了「CLI 真实装配报错」，见「维护者须知 ④」。

**第 1 步：工具调用合规**（判定主体，刻意收窄，越宽越容易误杀好模型）：

- 任一 `mustCallTools` 未命中 → 失败；
- 任一 `mustNotCallTools` 被调用 → 失败（含调用后报错的情况，因为「不该调」就是不该调）。

工具 id 白名单分两层：

| 层 | 内容 | 来源 | 可否进 `mustCallTools` |
| --- | --- | --- | --- |
| 业务工具 | `KNOWN_TOOL_IDS`（16 个） | `WORKER_TOOL_CATALOG` 快照，**单测强制一致** | 可 |
| 内置文件工具 | `BUILTIN_FS_TOOL_IDS`（7 个）：`read_file` / `write_file` / `edit_file` / `ls` / `glob` / `grep` / `delete` | deepagents `FilesystemMiddleware` 经 `MimirFsBackend` 注入 | 可（前提：真实适配器映射，见上文） |

两层**分开存放**：内置文件工具**不能**放进 `KNOWN_TOOL_IDS`，否则会破坏
「上游改了 `WORKER_TOOL_CATALOG` 就红灯」的保护。

**白名单校验规则**：用例引用的 id 必须 ⊆ `KNOWN_TOOL_IDS ∪ BUILTIN_FS_TOOL_IDS`。
另有两条**反向护栏**（`evalHarness.test.ts`）：

1. `BUILTIN_FS_TOOL_IDS` 与 `WORKER_TOOL_CATALOG` 的 id **交集必须为空**——
   防止有人把内置工具又登记进能力域目录，造成两套来源混淆；
2. `BUILTIN_FS_TOOL_IDS` 与契约测试 `test/contract/toolNames.test.ts` 的
   `FILESYSTEM_TOOL_NAMES`（源自 deepagents 的 `FILESYSTEM_TOOL_NAMES` 常量，1.13.3）
   **保持同步**——防止两处清单漂移。
   （本白名单只收录**文件类** 7 个；`execute` 是 shell 执行工具，与文件读写无关，未收录。）

### 为什么 `expectedArtifacts` 不做自动判定

产物路径受模型措辞影响极大（`./out.md`、`/tmp/out.md`、`survey.md` 都可能正确），
做成硬约束会**持续误杀好模型**，把评测集变成噪声源。
正确用法：适配器把观测到的产物填进 `EvalRun.artifacts`，报告里展示供人工核对。

---

## 指标

自动指标（`metrics.ts`，纯函数）：

| 指标 | 函数 | 说明 |
| --- | --- | --- |
| 任务成功 | `taskSuccess` / `checkCase` | 工具调用是否符合 must / mustNot |
| 工具精确率 / 召回率 / F1 | `toolPrecisionRecall` | 期望工具集合 vs 实际调用集合（空期望集不除零） |
| 工具调用次数 | `countToolCalls` | 含重复调用 |
| token 总量 | `sumTokens` | 优先 `totalTokens`，否则 input+output |
| 端到端延迟 | `latencyMs` | 脏数据（负数 / NaN）归零 |
| 人工干预次数 | `humanInterventions` | 批准卡触发次数 |
| Ultra 策略 | `EvalRun.ultraStrategy` | 每条用例实际采用的增强策略；报告里若全为 `-`，说明增强**未生效**，此时 A/B 的「无差异」结论无效 |
| 观测产物 | `EvalRun.artifacts` | **observed-only**，展示用，不参与判定 |
| 聚合报告 | `summarize` | 成功率、平均工具数 / token、P95 延迟、按能力域 / 难度分组、失败明细 |
| A/B 对比 | `compareRuns` | fixed / regressed / onlyInBaseline / onlyInCandidate + delta |
| 对比渲染 | `formatCompareReport` | 纯文本报告 |

`rubric` 覆盖的质量维度（人工评审）：结果正确性、是否臆造路径/日志、是否遵守检索纪律、是否如实说明失败原因。

---

## 报告格式契约（改落盘结构前必读）

每次 `runEval` 会落盘到 `test/eval/results/<timestamp>.json`：

```jsonc
{
  "timestamp": "20260914-110000",
  "label": "single-agent",
  "generatedAt": "2026-09-14T03:00:00.000Z",
  "runner": "real",                  // "mock" | "real" —— 防止拿 mock 结论当真实
  "filter": { "categories": [], "difficulties": [], "ids": [] },
  "summary": { "total": 26, "passed": 24, "successRate": 0.923, "p95LatencyMs": 12345, "...": "..." },
  "results": [
    {
      "id": "lit-01", "name": "...", "category": "literature", "difficulty": "easy",
      "success": true, "failures": [], "calledTools": ["paper_search"],
      "toolCalls": 2, "tokens": 1400, "latencyMs": 3200, "approvalCount": 0,
      "ultraStrategy": "plain",      // 未开增强时为空串
      "finalOutput": "...", "artifacts": [],
      "run": { "...": "..." }
    }
  ]
}
```

### 契约要点（`compareRuns` 依赖这些，改动会踩坑）

1. **报告里不序列化 `EvalCase` 对象**（省体积）。`case` 是可选的，
   取而代之的是平铺的 `id` / `name` / `category` / `difficulty` / `success` / `failures`。
2. **`compareRuns` 采信报告内的 `success` 字段**（而不是拿 `expected` 现算），
   因为落盘报告里根本没有 `expected`。
3. **对缺失字段不抛错**：缺 `case` 就用平铺字段重建一个最小 case；
   缺 `name` / `category` / `difficulty` 时分别回落到 `id` / `other` / `easy`。
4. 若要新增/改名落盘字段，**必须同时更新** `test/eval/runner.ts` 的 `buildReport()`、
   `test/eval/metrics.ts` 的 `normalize()`，以及 `evalMetrics.test.ts` 里
   「接受落盘的平铺报告」那条回归测试。

> 历史坑：早期 `compareRuns` 直接读 `r.case.expected`，一读落盘 JSON 就崩
> （`case` 未序列化）。修法是上面第 2、3 条，并补了回归测试守住。

### 做 A/B

先把两个版本各自跑一遍（用 label 区分），再对比。**走 vitest 入口**（CLI 下真实装配会失败，见「维护者须知 ④」）：

```bash
# 基线
MIMIR_GW_URL=... MIMIR_GW_KEY=... MIMIR_GW_MODEL=... \
  MIMIR_EVAL_LABEL=single-agent pnpm eval:real

# 对照：只多开增强（Strategy=auto 即生产默认的自动选型；也可指定具体策略）
MIMIR_GW_URL=... MIMIR_GW_KEY=... MIMIR_GW_MODEL=... \
  MIMIR_EVAL_LABEL=single-agent-ultra MIMIR_EVAL_ULTRA=auto pnpm eval:real

pnpm eval:compare test/eval/results/A.json test/eval/results/B.json
```

> **跑完先看「增强」列，再看差异。** 两版都是 `-` 就说明增强根本没生效，
> 此时报告里的「成功率无变化」是假的（两版跑的是同一套代码）。`realAgentEval.test.ts`
> 在开启增强时会对这条做断言，缺失即测试失败。
>
> 超时的用例**也**会带上策略：执行器通过 `CaseRunner.observe` 在调用 agent **之前**就登记
> 策略，超时兜底 run 会继承它。这样「某策略把预算烧爆导致超时」可以从报告里直接看出来，
> 而不是只留一句「超时」。

> ⚠️ **别用 `pnpm test` 跑基线**：一旦环境里设置了 `MIMIR_GW_*`，`test/gateway/liveMatrix.test.ts`
> 与 `test/smoke/liveAgent.test.ts` 也会被激活并真打网关，既拖慢整轮、又会混进无关失败。
> 基线请始终用 `pnpm eval:real`（只跑评测文件）。

输出示例：

```
=== A/B 对比报告 ===
成功率：88.5% → 96.2% (+7.7pp)
平均 token：4200 → 3800 (-400)
平均延迟：9800ms → 8400ms (-1400ms)
人工干预总数：12 → 9 (-3)

转成功 (2)：lit-07, meet-02
转失败 (0)：无

逐条差异：
  [fixed]  lit-07  token -300  工具调用 -1
  [unchanged-pass]  paper-01  token -120
```

**当前可对照的维度**（Supervisor 架构已移除，不再作为对照项）：

- **单 Agent vs 单 Agent + Ultra**（`MIMIR_EVAL_ULTRA=auto|<策略>`）—— **已接线可跑**：
  评测与生产共用 `electron/agent/ultra.ts` 同一份实现，不再存在「跑两次是同一套代码」的假对照。
- **压缩开关 开 vs 关**（上下文压缩策略）
- **检索纪律改动前后**（`paper_search` 调用次数、token）

---

## 基线记录（2026-09-14 · 模型 deepseek-v4-flash · 26 条）

各轮报告在 `test/eval/results/`（未纳入版本控制）。**所有数字都必须连同「被限流 / 超时污染」的说明一起读。**

| 轮次 | label | 并发 | 结果 | 说明 |
| --- | --- | --- | --- | --- |
| 基线 v1（无门禁） | `single-agent` | 2 | 15/26 = 57.7% | 4 条被 429 / 超时污染 → **有效 22 条 = 68.2%** |
| 对照（Ultra=plain） | `single-agent-ultra` | 1 | 13/26 = 50.0% | 5 条超时中止 |
| 基线 v2（含「交付门禁」） | `single-agent-v2` | 2 | **作废** | 并发 2 触发限流，中段起连续 429 |
| 基线 v2 重跑（含「交付门禁」） | `single-agent-v2-c1` | 1 | 15/26 = 57.7% | **完全干净**（0×429、0×超时） |
| 基线 v3（门禁 + `web_search` 定向修补） | `single-agent-v3` | 1 | 17/26 = 65.4% | `cross-01` 撞 120s 超时 → **有效 22 条 = 77.3%** |

### 配对分析（只比两臂都干净执行的 18 条）

| | 基线 | Ultra(plain) |
| --- | --- | --- |
| 成功率 | 77.8%（14/18） | 72.2%（13/18） |
| 平均 token | 18810 | 26969（**+43.4%**） |
| 平均工具调用 | 1.94 | 3.61（**+85.7%**） |
| 修复 / 回归 | — | **0 / 1**（`paper-04`） |

**结论：Ultra(plain) 是负资产，已从策略库删除。** 依据同时写在根 `README.md` 与
`electron/agent/ultra.ts` 的类型注释里（那里是策略语义的定义处，改代码的人一定会看到）。

### 配对分析②：「交付门禁」提示词的作用（v1 vs v2-c1，22 条两臂都干净）

| | 无门禁 v1 | 交付门禁 v2-c1 | 变化 |
| --- | --- | --- | --- |
| 成功率 | 68.2%（15/22） | 68.2%（15/22） | **0.0pp** |
| 平均 token | 22847 | 17655 | **−22.7%** |
| 平均工具调用 | 2.91 | 1.95 | **−32.8%** |
| 修复 / 回归 | — | — | `lit-06` / `lit-05` |

**结论：门禁是「成本优化」，不是「正确性优化」。** 机制由一对互补用例暴露得很清楚：

| 用例 | 期望 | v1 | v2-c1 |
| --- | --- | --- | --- |
| `lit-06` 查 NeurIPS 截稿时间 | 必须 `venue_search`，**禁止** `web_search` | FAIL（改用 web_search 猜） | **PASS** |
| `lit-05` 「帮我在**网上**找…只要链接和摘要」 | **必须** `web_search`，禁止 `paper_fetch` | PASS | **FAIL**（不敢用 web_search） |

门禁里「禁止用通用网页检索去猜或兜底」被模型**一律执行**了 —— 禁止条款压过了同一段里的
明确许可条款（用户点名要网上资料），于是该用的时候也不敢用。**这是「禁止式规则」的典型过度纠正：
写"禁止"会稳定生效，写"允许"会被忽略。**

侧写：成功率 1 修 1 损（n=22，单样本）落在噪声内，所以严谨表述是「**没有可测量的正确性变化**」；
而 token −22.7% / 工具调用 −32.8% 是跨 22 条的聚合量，是可靠信号。

### 配对分析③：把「该用 web_search」写进工具描述（v2-c1 → v3）

配对分析②给出了一个**可证伪的预测**：不加规则条文，而是把正向触发语写进 `web_search` 的
**工具描述**（模型选工具那一刻读的是它），并把 `capabilityDomains` 里那条禁令的作用域收窄到
「顶替 arXiv 检索」。预测：`lit-05` 修好、`lit-06` 不回归、成本基本不变。

| | v1 无门禁 | v2 交付门禁 | v3 门禁 + 定向修补 |
| --- | --- | --- | --- |
| 成功率 | 68.2%（15/22） | 68.2%（15/22） | **77.3%（17/22）** |
| 平均 token | 22847 | 17655 | 21668 |
| 平均工具调用 | 2.91 | 1.95 | 2.64 |
| 相对 v1 的累计变化 | — | −22.7% token | **+9.1pp / −5.2% token** |
| 平均延迟（全量 26 条） | — | 7482ms | 15234ms |
| P95 延迟（全量 26 条） | — | 21279ms | 61315ms |

靶点用例的预测 vs 实测：

| 用例 | 预测 | 实测 | 判定 |
| --- | --- | --- | --- |
| `lit-05` 「在网上找…只要链接」必须 `web_search` | 修好 | FAIL → **PASS** | ✅ 命中 |
| `lit-06` 必须 `venue_search` 且禁用 `web_search` | 不回归 | PASS → **PASS** | ✅ 命中 |
| `lit-04` 更新已有论文（非靶点） | — | FAIL → **PASS** | 额外修复，**不可归因**（见下） |

改动共 3 处，**全部是文本、零逻辑**：

1. `electron/agent/tools/webSearch.ts` —— 工具描述加入正向触发条件，并显式覆盖
   「即便话题是学术主题（例：在网上找 2025 年 VLA 综述）」这个最容易误判的场景；
2. `electron/agent/capabilityDomains.ts` —— 禁令改写为「**检索 arXiv 论文时**不要用 web_search
   顶替 paper_search」，并补一句「用户点名要网页资料时它就是正确工具，不要因这条纪律而回避」；
3. `electron/agent/subagentResult.ts` —— 交付门禁第 3 条的反向条款从附注式（「反向同样成立」）
   改为并列的硬要求，并点明「本条约束的是『不要用网页检索替代结构化数据』，**不是**『不要用网页检索』」。

**结论：门禁（省成本）与工具描述（修正确性）互补，v3 相对 v1 是 Pareto 改进** ——
比无门禁更省 token（−5.2%）且成功率更高（+9.1pp）。这坐实了那条规律：
**压成本靠规则，修工具选择靠工具描述。**

**代价在延迟，不在 token**：v3 相对 v2-c1 平均延迟 +104%、P95 +188%、
`cross-01` 从「6 次调用后失败」变成「撞满 120s 超时中止」；`lit-04` 通过时用了 9 次调用 / 66s / 70k token
（v2 只用了 1 次）。**「不要因这条纪律而回避」这类"别怯手"的指令，有被概括成"多做一点"的迹象** ——
与配对分析②的过度纠正恰好是同一机制的两面。

⚠️ **`lit-04` 的修复不可归因于本次修补**：它在三臂里的工具调用数是 7(FAIL) / 1(FAIL) / 9(PASS)，
离散度极大，更像运行间方差（也可能因为「交付门禁」段变长后，同段的第 2 条「更新≠新建」获得了
更多注意力 —— 这只是假设，未验证）。**因此本次可靠的因果证据只有 `lit-05` / `lit-06` 这两个机制靶点；
成功率 68.2% → 77.3% 这个数里，有一个用例的功劳不属于本改动。**

### 跨实验规律：成本与延迟是两条轴，工具选择靠工具描述

| 实验 | 工具调用 | token | 成功率 | 延迟 |
| --- | --- | --- | --- | --- |
| Ultra(plain)：**增加**探索 | +85.7% | +43.4% | −5.6pp | — |
| 交付门禁：**减少**探索 | −32.8% | −22.7% | 0.0pp | — |
| 门禁 + 定向修补：精准补回必需调用 | −9.4%※ | −5.2%※ | **+9.1pp**※ | **+104%**† |

※ 相对 v1（无门禁）；† 相对 v2-c1（门禁）。

在这套模型上，「探索量」与成功率**几乎不相关**，却同时决定成本和延迟。因此：
- 该被约束的是**成本与延迟**，不是探索量本身；
- **「该调哪个工具」应交给工具描述去回答**（模型选工具时真正读的是工具名与描述），
  而不是靠全局规则去拧 —— 规则能稳定压住成本，却会顺带压掉必需调用；
- **延迟是独立的一条轴**：v3 证明了"正确性可以靠工具描述买回来"，但买它的方式是让模型多做几步，
  于是延迟翻倍。任何后续优化都要同时看 token / 延迟 / 成功率三个数，只看 token 会得出错误结论。

### 基线暴露的产品问题（与增强层无关）

7 条真实失败（非环境原因）集中在两类，是**工具纪律**问题而非编排问题：

| 症状 | 用例 |
| --- | --- |
| 多步任务只做第一步（检索到了不落库 / 不交付产物） | `lit-01` `lit-07` 漏 `paper_fetch`；`paper-05` 漏 `wiki_note`；`meet-02` 漏 `meeting_deck`；`file-03` 漏 `write_file` |
| 就近选错工具 | `lit-04` 该 `set_paper` 更新却 `paper_fetch` 重复入库；`lit-06` 该 `venue_search` 却用 `web_search` 猜 |

针对这两类已写入 `subagentResult.ts` 的「交付门禁」与 `capabilityDomains.ts` 的文献域反例。
实测（见「配对分析②」）的收益是**成本**（token −22.7%、工具调用 −32.8%），正确性没有可测量变化，
且暴露了「禁止式规则被一律执行、许可条款被忽略」的过度纠正。

**下一步不该继续加规则文本**，而应改工具描述 —— 这一步已执行并**验证有效**（见「配对分析③」：
`lit-05` / `lit-06` 两个机制靶点全部命中，零回归）。

**仍待解决（按优先级）：**

1. **压回延迟**。v3 的 P95 延迟 61s、`cross-01` 撞满 120s 超时中止，是当前最伤体感的一项。
   先查 `cross-01`：它在四轮里三次中止、一次 12s 完成 —— 需要分辨是**这条用例本身过重**
   （跨文献 + 论文 + 笔记三域的链条），还是模型在长链条里打转（v3 的 `lit-07` 用了 12 次调用、
   `lit-04` 用了 9 次，都指向后者）。若是后者，应从**工具返回文案**入手
   （让工具在返回里明确"本步已完成、下一步是 X"），而不是继续加规则。
2. **重复实验以分离方差**。`lit-04` 在三臂里的工具调用数是 7 / 1 / 9，单样本不足以支撑结论。
   在对外说"某改动提升 X pp"之前，靶点用例至少要跑 3 次重复。
3. **成功率的结构性问题未变**：v3 的 8 条真实失败仍全部落在「多步链条没走完」
   （`lit-01` `lit-07` `paper-02` `paper-03` `paper-05` `meet-02` `file-03`）与「就近选错工具」
   （`file-02` `file-03`）两类，**与编排层无关** —— 这一判断在四轮里都成立。

### 运维结论（下次跑评测前必读）

1. **必须用并发 1**。该网关限流「40 请求/分钟」。已两次验证：并发 2 跑到中段后开始连续 429
   （整轮作废），并发 1 则 **0 次 429**（`single-agent-ultra` 与 `single-agent-v2-c1` 两轮）。
2. **被限流 / 中断的运行不要解读**：限流守卫会把它判为无效；有断点续跑兜底，重跑会跳过已完成用例。
3. 单条用例的失败原因要先分流「环境（429 / 超时 / 工具侧网络）」与「产品（漏调 / 误调工具）」，
   否则会把环境问题误读成模型变笨。

---

## 目录约定

- 只读评测：不修改 `electron/` 与 `src/` 下任何文件。
- `results/` 为运行产物，可按需清理；如需纳入版本控制请先在 `.gitignore` 中确认。
- 新增工具时：同步更新 `capabilityDomains.ts` 的 `WORKER_TOOL_CATALOG` 与 `cases.ts` 的 `KNOWN_TOOL_IDS`，
  `evalHarness.test.ts` 会守住两者一致。
