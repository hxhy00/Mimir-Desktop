/**
 * P1：对话全链路（离线桩网关）。
 *
 * 覆盖此前零覆盖的核心链路：发消息 → 流式正文渲染 → 多轮上下文 → 停止生成 → 持久化。
 *
 * ── 为什么能离线跑 ──────────────────────────────────────────────────────────
 * 桩网关（e2e/fixtures/fakeGateway.ts）顶替真实模型端点：seed 里写入一条指向它的模型
 * 配置，应用启动时 `initAgentFromSettings()` 自动连上它（产品代码零改动）。
 * 因此本 spec **不触真实网络、不触真实模型**，却覆盖了最核心的功能。
 *
 * ── 断言的依据 ─────────────────────────────────────────────────────────────
 * 两类证据并用：
 * - UI 证据：气泡、流式状态、按钮可用性——证明「用户看得见的结果正确」；
 * - 协议证据：`gateway.requests` 里的请求体——证明「送进模型的东西正确」。
 *   后者不可省：UI 上看到两轮对话，**不能**证明历史真的进了请求体。
 *
 * ── 用例隔离 ───────────────────────────────────────────────────────────────
 * worker 级单实例（见 fixtures/app.ts 的代价说明）：用例共享 UI 与桩。
 * 因此每例前重置桩的请求记录，并各自使用**互不重复**的文案，避免命中前例残留的气泡。
 */
import { makeGatewayTest, expect } from '../fixtures/app'

const test = makeGatewayTest([{ kind: 'text', text: '桩回复：收到你的消息。' }])

const INPUT = '今天帮你做些什么？输入 / 可调用技能与指令'

/** 取输入框（每例都重新取，避免持有旧引用）。 */
function inputOf(page: import('@playwright/test').Page) {
  return page.getByPlaceholder(INPUT)
}

/**
 * 取「Agent 主循环」的请求：`stream:true` 且带工具定义的那一条。
 *
 * 为什么不能直接用 `requests[0]`：一轮用户消息会触发**两次**模型调用
 * （实测，2026-09-16）——
 *   #0 `stream:false`、tools=1：技能路由的预检（只输出 JSON 路由信号）；
 *   #1 `stream:true`、tools=27：真正的 Agent 主循环，产出的才是用户看到的回复。
 * 断言上下文/流式必须落在 #1 上，否则会对着路由预检的内容做错误结论。
 */
function mainLoopRequests(gateway: { requests: Array<{ stream: boolean; toolCount: number }> }) {
  return gateway.requests.filter((r) => r.stream && r.toolCount > 1)
}

test.describe('对话全链路（桩网关）', () => {
  test.beforeEach(async ({ page, gateway }) => {
    gateway.resetRequests()
    // 对话视图不是标准模块页（没有 .module-title，见 10-chat-approval.spec.ts 说明），
    // 故用输入框作为「就绪」标志，不用 gotoModule。
    await page.getByRole('button', { name: '对话', exact: true }).first().click()
    await expect(inputOf(page)).toBeVisible({ timeout: 20_000 })
    await inputOf(page).fill('') // page 跨用例共享，清掉上例残留
  })

  test('发消息后流式渲染出桩回复全文', async ({ page, gateway }) => {
    await inputOf(page).fill('你好')
    await inputOf(page).press('Enter')

    await expect(page.getByText('你好', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('桩回复：收到你的消息。')).toBeVisible({ timeout: 15_000 })

    // 协议证据：Agent 主循环请求确实到达，且请求体里带上了用户输入。
    const loop = mainLoopRequests(gateway)
    expect(loop.length).toBeGreaterThan(0)
    expect(JSON.stringify(loop[0].messages)).toContain('你好')
  })

  test('多轮对话：第二轮请求体带上第一轮历史', async ({ page, gateway }) => {
    await inputOf(page).fill('第一个问题AAA')
    await inputOf(page).press('Enter')
    await expect(page.getByText('桩回复：收到你的消息。').first()).toBeVisible({ timeout: 15_000 })
    await expect(inputOf(page)).toBeEnabled({ timeout: 15_000 })

    await inputOf(page).fill('第二个问题BBB')
    await inputOf(page).press('Enter')
    // 等第二轮的主循环请求到达（用轮询而非固定等待，避免竞态）
    await expect.poll(() => mainLoopRequests(gateway).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(2)

    // 关键断言：第二轮请求体同时含两轮用户输入 —— 历史确实送进了模型。
    const second = mainLoopRequests(gateway)[1]
    const body = JSON.stringify(second.messages)
    expect(body).toContain('第一个问题AAA')
    expect(body).toContain('第二个问题BBB')
  })

  test('停止生成：运行态被释放，输入框恢复可用', async ({ page, gateway }) => {
    // 关键：让流**慢下来**（每块 50ms、共约 3 秒），否则默认毫秒级发完，
    // 「流式中」这个状态根本来不及被观察到（见 GatewayReply.chunkDelayMs 说明）。
    // 注意：技能路由预检也是 text 应答，会先消耗一次；它非流式，不受 delay 影响。
    gateway.setReplies([
      { kind: 'text', text: '路由信号', chunkDelayMs: 0 },
      { kind: 'text', text: 'B'.repeat(60), chunkSize: 1, chunkDelayMs: 50 }
    ])

    await inputOf(page).fill('请给一段较长的回复')
    await inputOf(page).press('Enter')

    // 流式期间出现「停止生成」按钮（文案来自 ChatInput 的 title）。
    const stop = page.getByRole('button', { name: '停止生成' })
    await expect(stop).toBeVisible({ timeout: 10_000 })
    await stop.click()

    // 停止后：运行态释放 → 输入框可用、停止按钮消失。
    await expect(inputOf(page)).toBeEnabled({ timeout: 10_000 })
    await expect(stop).toHaveCount(0)

    // 收尾：恢复默认应答（共享实例，避免影响后续用例）
    gateway.setReplies([{ kind: 'text', text: '桩回复：收到你的消息。' }])
  })

  test('会话历史落盘：store 里出现本轮对话', async ({ page, launched }) => {
    await inputOf(page).fill('这条要落盘PERSIST')
    await inputOf(page).press('Enter')
    await expect(page.getByText('桩回复：收到你的消息。').last()).toBeVisible({ timeout: 15_000 })

    // 读隔离 store（空间层）里的会话键，确认已持久化。
    // 用轮询：落盘是异步的，不能假定点完立即写完。
    await expect
      .poll(
        async () =>
          JSON.stringify(
            (await page.evaluate(
              () => window.electronAPI?.getStoreValue?.('chat:conversations')
            )) ?? ''
          ),
        { timeout: 15_000 }
      )
      .toContain('这条要落盘PERSIST')

    // 隔离断言：数据落在临时 HOME 下，未写真实磁盘。
    expect(launched.paths.home).toContain('mimir-e2e')
  })
})
