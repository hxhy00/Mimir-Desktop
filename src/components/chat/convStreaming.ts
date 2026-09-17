/**
 * 会话级「正在生成」状态的归属记账。
 *
 * ── 为什么需要它（真实事故）────────────────────────────────────────────────
 * 界面底部会挂一行「正在思考…」，输入区会禁用，侧栏会给该会话转圈 —— 三者都读同一个
 * 会话级标记（ChatView 的 `streamingConvIds`）。这个标记的**开场**很简单（发送时加入），
 * 但**收尾**在两处发生过：
 *   ① 该条回复的 finally（正常结束）；
 *   ② 用户点停止（handleStop）。
 * 而一次收尾可能**晚于下一次开场**：用户点停止后立刻重发、或快速连发时，旧流的 finally
 * 会排在新流开场之后执行。于是：
 *   - 旧实现用 `currentEpoch(convId) === sendId` 当唯一清理条件 → 旧流被新流顶掉后
 *     **永远没人关灯**，标记永久残留 → 界面永久停在「正在思考…」、输入区永久禁用；
 *   - 若改成无条件关灯，又会反过来把**新流**的标记误关（界面看起来已经结束，实际还在跑）。
 *
 * 根因是「关灯」缺少**归属**：必须知道这次收尾是不是当前活跃那一次的收尾。
 * 本模块把这份记账收敛成显式的「活跃回复登记表」，并用 compare-and-clear 统一关灯语义，
 * 让 ChatView 里不再散落各处手写纪元判断（那正是 bug 的滋生地）。
 *
 * ── 与「发送纪元（epoch）」的区别 ──────────────────────────────────────────
 * epoch 解决的是**数据层**问题：让旧流的 chunk / 事件 / 看门狗回调失效（丢弃迟到数据）。
 * 本模块解决的是**展示层**问题：谁有权把「正在生成」这盏灯关掉。
 * 两者同源（每次发送都取一个新号）但语义不同，所以必须分开存，不能互相顶替。
 */

/** 一次回复的标识：每次发送取一个新号（与发送纪元同源）。 */
export type SendId = number

/**
 * 按会话记录「当前活跃回复」的登记表。
 *
 * 用法：开场时 `begin(convId, sendId)`；收尾时 `release(convId, sendId)`，
 * 由返回值告诉调用方「这次收尾该不该真正关灯」。
 */
export class ConvStreamingRegistry {
  private active = new Map<string, SendId>()

  /** 开场：把该会话的活跃回复登记为 sendId。必须在标记「生成中」之前调用。 */
  begin(convId: string, sendId: SendId): void {
    this.active.set(convId, sendId)
  }

  /**
   * 收尾：仅当登记的活跃回复**仍是自己**时返回 true（调用方据此真正关灯）。
   *
   * 为什么不是无条件 true：收尾可能晚于下一次开场（见模块注释）。返回 false 表示
   * 「你已经被新流顶掉了，关灯的责任已移交给新流」，调用方必须**保持沉默**，
   * 否则会把新流的运行态误关。
   */
  release(convId: string, sendId: SendId): boolean {
    if (this.active.get(convId) !== sendId) return false
    this.active.delete(convId)
    return true
  }

  /**
   * 用户主动停止：直接清掉归属登记。
   *
   * 为什么必须清（而不是留给旧流的 finally 处理）：停止后旧流仍会在 finally 里
   * 拿自己的旧 sendId 调 `release`，若登记还在，比较会「恰好」通过并关灯 ——
   * 而此刻用户可能已经重发，新流刚点亮，于是这次关灯把新流误关。
   * 清掉登记 = 让旧流认不出「自己」，从而保持沉默。
   */
  forget(convId: string): void {
    this.active.delete(convId)
  }

  /** 当前活跃回复号（测试与诊断用）。 */
  current(convId: string): SendId | undefined {
    return this.active.get(convId)
  }
}
