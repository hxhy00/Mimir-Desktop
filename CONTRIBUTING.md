# 贡献指南

感谢你对 Mimir-Desktop 的关注。本文说明如何提交问题与代码，以及合并前需要满足的检查。

> 想先跑起来看效果？见 [README.md](./README.md)。想了解架构与设计决策？见 [DEVELOPMENT.md](./DEVELOPMENT.md)。

---

## 环境准备

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 20 | 开发与构建 |
| pnpm | ≥ 9 | 本仓库**只使用 pnpm**（存在 `pnpm-lock.yaml`，不要用 npm/yarn 生成其他锁文件） |
| LaTeX | 可选 | 论文编译功能需要；也可在应用内「设置 → 资源下载」安装内置 Tectonic |

```bash
pnpm install
pnpm dev          # 启动开发模式（热重载）
```

若依赖下载缓慢，可切换国内镜像（本仓库推荐）：

```bash
pnpm config set registry https://registry.npmmirror.com
```

---

## 提交前必做

每个 PR 合并前**必须**通过以下三项，本地先跑一遍可避免 CI 往返：

```bash
pnpm typecheck    # TypeScript 类型检查（主进程 + 渲染进程）
pnpm test         # 单元 / 契约 / 冒烟测试（vitest）
pnpm build        # 完整构建（主进程 + preload + 渲染进程）
```

涉及 Agent 对话链路的改动，建议额外做一次**启动验证**：

```bash
pnpm start        # 构建后启动应用，确认「Agent 已从保存的设置初始化」
```

---

## 提交信息规范

本仓库使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/) 风格，格式为：

```
<type>(<scope>): <简要描述>
```

**type** 取值：

| type | 用途 |
|---|---|
| `feat` | 新增功能 |
| `fix` | 修复缺陷 |
| `refactor` | 重构（不改变外部行为） |
| `docs` | 文档变更 |
| `test` | 测试相关 |
| `build` | 构建 / 依赖 / 打包配置 |
| `chore` | 其他杂项 |
| `perf` | 性能优化 |

**scope** 常用模块名，例如 `agent`、`library`、`settings`、`chat`、`ipc`、`build` 等。

真实示例（取自本仓库历史）：

```
feat(settings): 模型发现结果支持多选批量添加
fix(agent,build): arXiv 限流加固，修复 dmg「已损坏」与 Dock 图标偏大
refactor(agent): 落地单引擎架构，新增能力域/上下文治理/评测集与安全收口
docs: README 同步 Harness 层 / 模型自动发现 / 插件桥接三项能力
```

多个 scope 用逗号分隔；描述使用中文，聚焦「做了什么」而非「改了哪个文件」。

---

## 代码风格

本仓库**未配置 ESLint / Prettier**，风格靠约定与 Code Review 维持。提交前请确认：

- **注释写「为什么」**：本仓库注释较密，但只解释非显然的决策、边界与反直觉行为，不复述代码字面。
- **保持模块边界**：主进程（`electron/`）与渲染进程（`src/`）严格分离，跨进程只走预加载脚本暴露的 IPC 通道。
- **渲染层不可信**：任何来自渲染进程的路径 / 参数，必须在主进程侧过边界校验（见 `electron/ipc/index.ts` 的 `assertRendererPath` 系列）。
- **不要自研轮子**：优先使用成熟方案。若确实需要自研，先在 Issue 中说明理由。
- **不提交构建产物**：`out/`、`node_modules/`、`*.tsbuildinfo` 等已在 `.gitignore` 中。

更详细的架构约定（分层、禁改文件、失败模式）见 [DEVELOPMENT.md](./DEVELOPMENT.md)。

---

## 提交 PR

1. **先开 Issue 讨论**（涉及架构调整或大范围重构时）。
2. **从 `main` 切出特性分支**，分支名建议 `feat/xxx`、`fix/xxx`。
3. **保持改动聚焦**：一个 PR 解决一件事，便于审查与回滚。
4. **本地跑通上述三项检查**后再推送。
5. 在 PR 描述中说明：**改了什么**、**为什么改**、**如何验证**。

> 注意：仓库维护者会手动执行 commit 与 push，请勿直接向 `main` 强推。

---

## 安全问题

若发现安全漏洞（如密钥泄露、路径穿越、任意代码执行），**请勿直接开公开 Issue**，先通过私下渠道联系维护者。

---

## License

贡献的代码将按本仓库的 [MIT License](./LICENSE) 授权。
