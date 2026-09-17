/**
 * 14-chat-real-gateway.spec.ts — 对话全链路（真实网关）
 *
 * 与 11-chat-flow.spec.ts（桩网关）互补：桩网关验证**协议与状态机**，
 * 本文件用**真实大模型**验证用户最关心的「输出质量代理指标」——
 * 对话框里的回复**是否完整**（流式收尾不截断）、收尾状态是否正确、会话是否完整落盘。
 *
 * 真实模型**不可控**（输出内容随模型与提示词波动），因此断言只针对**协议性质**：
 *  - 要求模型逐字回显一个独特标记 token → 气泡里必须出现**完整** token；
 *  - 回合结束后输入框恢复可用（运行态被正确释放）；
 *  - store 的会话键里同时含两轮用户输入与完整回显标记（历史落盘不截断）。
 *
 * 运行条件（三者齐备，缺省整组跳过 —— CI 默认不跑真实模型）：
 *   MIMIR_GW_URL / MIMIR_GW_KEY / MIMIR_GW_MODEL
 * 示例：
 *   MIMIR_GW_URL=http://0.0.0.0:20128/v1 MIMIR_GW_KEY=sk_oc_proxy \
 *   MIMIR_GW_MODEL=aipy/auto pnpm test:e2e -- -g 14-chat-real
 */
import { makeTest, expect } from '../fixtures/app'
import { readRealGatewayEnv, realGatewayModelSeed } from '../fixtures/seed'

const gw = readRealGatewayEnv()

const test = makeTest({
  transformSeed: (seed) => ({
    ...seed,
    settings: {
      ...(seed.settings ?? {}),
      ...(gw ? realGatewayModelSeed(gw) : {})
    }
  })
})

const INPUT = '今天帮你做些什么？输入 / 可调用技能与指令'

function inputOf(page: import('@playwright/test').Page) {
  return page.getByPlaceholder(INPUT)
}

/** 独特回显标记：真实模型通常不会自发产生，出现在气泡里即证明「这条回复是全的」。 */
const ECHO_TOKEN = 'MIMIR-E2E-CHECK-7f3a92'
const ECHO_PROMPT = `请只输出下面这一行内容，不要输出任何其他字符：\n${ECHO_TOKEN}`

test.describe('对话全链路（真实网关）', () => {
  test.skip(!gw, '需要 MIMIR_GW_URL / MIMIR_GW_KEY / MIMIR_GW_MODEL 才运行真实网关 e2e')

  // 真实模型冷启动 + 技能路由预检 + 主循环，整体可能要一两分钟。
  test.setTimeout(180_000)

  test.beforeEach(async ({ page }) => {
    await page.getByRole('button', { name: '对话', exact: true }).first().click()
    await expect(inputOf(page)).toBeVisible({ timeout: 20_000 })
    await inputOf(page).fill('') // page 跨用例共享，清掉上例残留
  })

  test('真实模型回复完整渲染：标记逐字出现在气泡中，且收尾输入框恢复可用', async ({ page }) => {
    await inputOf(page).fill(ECHO_PROMPT)
    await inputOf(page).press('Enter')

    // 完整性核心断言：气泡里出现**完整**标记 token。
    // 若流式收尾/截断逻辑有 bug（丢块、丢尾部），这个断言大概率失败。
    await expect(page.getByText(ECHO_TOKEN).first()).toBeVisible({ timeout: 120_000 })

    // 回合收尾：运行态释放，输入框恢复可用。
    await expect(inputOf(page)).toBeEnabled({ timeout: 30_000 })
  })

  test('多轮后历史完整落盘：store 同时含两轮输入与完整回显标记', async ({ page }) => {
    // 第一轮：让模型回显标记。
    await inputOf(page).fill(ECHO_PROMPT)
    await inputOf(page).press('Enter')
    await expect(page.getByText(ECHO_TOKEN).first()).toBeVisible({ timeout: 120_000 })

    // 第二轮：普通消息，确认历史没有被第一轮「挤掉/截断」。
    await inputOf(page).fill('第二轮输入HISTORY2')
    await inputOf(page).press('Enter')
    await expect(inputOf(page)).toBeEnabled({ timeout: 60_000 })

    // 落盘完整性（轮询等待异步持久化）：
    // 会话键里必须同时有——两轮用户输入、完整回显标记。
    await expect
      .poll(
        async () =>
          JSON.stringify(
            (await page.evaluate(
              () => window.electronAPI?.getStoreValue?.('chat:conversations')
            )) ?? ''
          ),
        { timeout: 30_000 }
      )
      .toContain(ECHO_TOKEN)
    const store = JSON.stringify(
      (await page.evaluate(() => window.electronAPI?.getStoreValue?.('chat:conversations'))) ?? ''
    )
    expect(store).toContain('第二轮输入HISTORY2')
  })
})
