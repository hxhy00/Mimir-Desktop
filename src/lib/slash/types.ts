/**
 * 斜杠「技能与指令」注册表类型。
 *
 * 清单与语义照搬 Mimir（packages/mimir/src/commands|skills），但在 Mimir-Desktop
 * 以 L0 形态落地：输入 `/trigger 参数` 时把条目展开成一段结构化任务提示注入
 * Agent（不产生本地文件副作用）。引擎差异导致的工具引用差异在正文里适配：
 * - Mimir 的 `sxng`（外部技能）→ 本应用 `web_search` 工具
 * - Mimir 的 `latex_compile` / `figure_save` / `meeting_deck` 等主进程工具
 *   → 引导用户在「论文 / 图表 / 组会」模块执行，或要求粘贴内容供 Agent 处理
 */

export type SlashKind = 'command' | 'skill'

/** 客户端特殊动作标记（不走 Agent，由前端直接处理）。 */
export type ClientAction =
  /**
   * `reload`：重载渲染层（等同于开发者工具里的刷新）。
   *
   * 存在的理由：`main.ts` 里**同一窗口重新导航**（Cmd+R / F5）会触发 Electron 的
   * 主框架导航，销毁并重建 renderer —— 而 `mainWindow.on('closed')` 之外**没有任何**
   * 导航钩子在结束时中止在跑的 Agent 会话，于是「刷新一下」就会把正在生成的回复
   * 连同其 `AbortController` 一起丢在后台（见 `reloadRenderer()` 的说明）。
   * 提供一个显式入口，让用户能主动、可预期地重载，而不是去按 Cmd+R 踩坑。
   */
  'reload' | 'clear' | 'help'

/** 注册表条目：一条指令或一个技能。 */
export interface SlashEntry {
  /** 触发词（不含 `/`），如 research-lit-review */
  readonly trigger: string
  readonly kind: SlashKind
  /** 人类可读标题（中文）。 */
  readonly title: string
  /** 菜单与目录里的一句话说明。 */
  readonly description: string
  /** 该技能适合何时使用（Mimir whenToUse，适配本应用）。 */
  readonly whenToUse: string
  /** 参数占位提示，如 `<研究方向>`。 */
  readonly argsHint: string
  /** 完整用法示例。 */
  readonly usage: string
  /** 该条目是否必须有参数。 */
  readonly requiresArg: boolean
  /** 把本次参数展开成发给 Agent 的任务提示全文。 */
  readonly compose: (args: string) => string
  /** 标记为客户端命令时，ChatView 走对应分支处理而不发 Agent。 */
  readonly clientAction?: ClientAction
}

/** `/trigger 参数` 的解析结果；未命中任何条目时为 null。 */
export interface SlashMatch {
  readonly entry: SlashEntry
  /** 触发词之后的原始参数文本（可能为空）。 */
  readonly args: string
  /** 展开后真正发给 Agent 的消息。 */
  readonly expanded: string
}
