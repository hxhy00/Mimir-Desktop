# 代码风格

本文记录 Mimir-Desktop 的代码约定。本仓库**未引入 ESLint / Prettier**，风格靠约定与 Code Review 维持——因此这份文档是权威参考，新增代码请对齐。

> 架构分层与设计决策见 [DEVELOPMENT.md](./DEVELOPMENT.md)；提交规范见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

---

## 1. 基础格式

| 项 | 约定 | 示例 |
|---|---|---|
| 缩进 | **2 空格** | `  const x = 1` |
| 分号 | **不写**（行尾无 `;`） | `const x = 1` |
| 引号 | **单引号** | `import { ipcMain } from 'electron'` |
| 换行符 | LF | — |
| 尾随逗号 | 多行结构**不加**尾逗号 | 见下方 import 示例 |
| 行宽 | 约 120 字符，超出时优先拆参数而非硬折字符串 | — |

**导入语句**（多行时每个符号一行，最后一个不加逗号）：

```ts
import {
  listVenueDeadlines,
  refreshVenueDeadlines,
  setVenueWatch
} from '../venues/venuesService'
```

---

## 2. 注释：写「为什么」，不写「是什么」

本仓库注释密度较高，但**只解释非显然的部分**：设计意图、边界条件、反直觉行为、历史决策。不复述代码字面。

```ts
// 好：解释为什么这么做
// 用 SDK 的 `run.toolCalls` 而不是逐工具包装：它是唯一覆盖**全部**工具的出口，
// 包括 deepagents 内置文件工具（write_file/edit_file/...），无需任何文案嗅探。

// 差：复述代码
// 遍历 calls
for await (const call of calls) {
```

**文件级 / 组件级**用 JSDoc 块说明职责与关键约束：

```ts
/**
 * 「添加 / 编辑模型」弹窗。
 *
 * 这是一个**受控组件**：表单状态全部仍由 `Settings.tsx` 持有——
 * 因为它们同时被主组件的自动发现副作用、引导流程读写，下沉会引入双向耦合。
 */
```

**导出符号**用单行 JSDoc：`/** 会议截稿：目录 / 刷新 / 关注（`venues:*`）。 */`

中文标点与中英文之间加空格，代码标识符用反引号包裹。

---

## 3. 类型与命名

| 类别 | 约定 | 示例 |
|---|---|---|
| 类型 / 接口 | PascalCase | `ModelFormState`、`StreamRun` |
| 函数 / 变量 | camelCase | `registerLatexHandlers`、`assertRendererPath` |
| 常量 | UPPER_SNAKE_CASE | `LATEX_COMPILE_TIMEOUT_MS`、`TEXT_FLUSH_MS` |
| 文件名（模块） | camelCase | `agentService.ts`、`contextManager.ts` |
| 文件名（React 组件） | PascalCase | `Settings.tsx`、`ModelDialog.tsx` |

- **避免 `any`**：用 `unknown` + 收窄，或定义具名类型。
- **泛型复杂的返回值抽具名 interface**：如 `StreamRun`——让方法签名可独立阅读。
- 布尔变量用 `is` / `has` / `should` 前缀（`isInitialized`、`hasMore`）。

---

## 4. 主进程（`electron/`）

### IPC 通道契约

所有 `ipcMain.handle` 的返回值**统一为 `{ ok: boolean, ... }`**，不要抛异常给渲染层：

```ts
ipcMain.handle('venues:refresh', async () => {
  try {
    const fetchedAt = await refreshVenueDeadlines()
    return { ok: true, fetchedAt }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '刷新失败（旧缓存已保留）' }
  }
})
```

- 通道名格式：`<域>:<动作>`（如 `latex:compile`、`library:listPapers`）。
- **一个文件一个域**：按域拆分到 `electron/ipc/<domain>.ts`，导出 `registerXxxHandlers(deps)`。
- **失败兜底文案必须有意义**：说明后果与下一步（「旧缓存已保留」优于「刷新失败」）。

### 路径边界（安全底线）

**渲染进程不可信**。任何来自渲染层的路径 / 参数，进入主进程后必须过校验：

```ts
const dir = assertRendererPath(projectDir, 'write')   // 目录通道
const file = assertRendererFilePath(filePath, 'read') // 文件通道（更严格）
const dirs = assertProjectDirs(projectDirs)           // 目录数组
```

校验函数放 `try` **内部**——越界时也要走 `{ ok: false, message }` 契约，而不是把异常抛给渲染层。这些函数的实现集中在 `electron/ipc/index.ts`，类型在 `electron/ipc/guards.ts`。

---

## 5. 渲染进程（`src/`）

### 组件

- 函数组件 + Hooks，不用 class 组件。
- **受控优先**：弹窗等交互组件优先做成受控（状态留父组件），避免状态双写。
- 条件渲染用 `&&` / 三元，注意 `0` 与空字符串的假值陷阱（用 `length > 0` 而非 `length`）。
- 组件文件超过约 800 行考虑拆分：**按 Tab / 区块 / 弹窗**抽子组件到同级 `settings/` 之类目录。
- 样式用 Tailwind 原子类 + `cn()` 合并条件类，不写独立 CSS 文件。

```tsx
<div className={cn('base-class', isActive && 'active-class')}>
```

### 与其他层通信

- 只用 `window.api.*`（预加载脚本暴露的桥），**不直接 import 主进程模块**。
- 渲染层日志走 `src/lib/logger.ts` 门面，经 IPC 汇入主进程统一日志。

---

## 6. 测试

- 测试放 `test/` 下对应子目录：`unit/`（单元）、`contract/`（工具名契约）、`gateway/`（网关）、`smoke/`（无头冒烟）、`eval/`（评测集）。
- 命名 `*.test.ts` / `*.test.tsx`。
- **测试名写清「守护什么」**，例如：
  `run 已 done 且收到残留 isStreaming=true 时：不渲染「执行中 / 正在思考…」（本次事故的直接回归）`
- 断言聚焦行为与契约，不绑定内部实现细节。
- 运行：`pnpm test`（全量）、`pnpm test:watch`（监听）。

---

## 7. 反模式清单

以下做法在本仓库**明确禁止**：

| 反模式 | 替代做法 |
|---|---|
| 自研轮子（已有成熟方案） | 先调研成熟方案，Issue 说明后再定 |
| 渲染层直接信任路径参数 | 主进程侧过 `assertRendererPath` |
| 用 `any` 绕过类型 | 用 `unknown` + 收窄，或定义类型 |
| 把异常抛给渲染层 | 返回 `{ ok: false, message }` |
| 提交构建产物 | 确认 `.gitignore` 覆盖（`out/`、`*.tsbuildinfo` 等） |
| 巨型单文件（> 1500 行） | 按域 / 区块拆分到子模块 |
| 「假拆分」：为拆而传 20+ 无关 props | 先判断状态归属，受控组件或就近下沉 |
