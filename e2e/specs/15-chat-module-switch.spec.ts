/**
 * 15-chat-module-switch.spec.ts — 切换模块不打断对话状态
 *
 * 回归背景（真实缺陷）：App 的主内容区曾用 `key={activeModule}-{epoch}` 渲染，
 * 切换模块会把整棵子树**卸载重建** —— ChatView 连同正在生成的回复一起消失：
 * 重挂载的实例只从 store 读到**防抖窗口前的落盘快照**，`isStreaming` 运行态与流事件
 * 监听也一并丢失。用户侧表现就是「切到别的模块再切回来，回复被中止 / 内容残缺」。
 *
 * 修复：Chat 改为**常驻层**（始终挂载，切模块时 `hidden` 隐藏），见 `renderer/App.tsx`。
 *
 * ── 为什么用桩网关而不是真实模型 ─────────────────────────────────────────────
 * 要断言的是**卸载是否破坏流式状态机**，必须让「生成中」这个状态稳定存在足够久，
 * 且分块时序可精确控制。真实模型延迟不可控，反而测不稳这类竞态。真实模型的
 * 「输出完整性」由 `14-chat-real-gateway.spec.ts` 覆盖。
 *
 * ── 关键设计：断言「首段已到、尾段未到」这个**未完成**的中间态 ──────────────
 * 早期版本只等首段出现就切走、切回后等尾段 —— 结果**旧实现也能通过**，因为
 * 桩网关把整段在 2 秒内发完，等断言重试到时就早跑完了，卸载重建读到的是一个
 * **已完成**的回复（防抖 300ms 早已落盘），根本复现不出丢失。
 * 所以这里把流拉长到 ~15s（chunkSize=1、每字符 400ms），并在切回后**立刻**
 * 断言尾段**不在**场 —— 生成中的回复若被卸载，尾段永远不会自己补上。
 */
import { makeGatewayTest, expect } from '../fixtures/app'
import type { GatewayReply } from '../fixtures/fakeGateway'

const INPUT = '今天帮你做些什么？输入 / 可调用技能与指令'

/**
 * 用户消息与模型回复**用完全不同的字符集**，这是本用例能成立的关键。
 *
 * 踩过的坑：早期版本把同一串独特标记同时写进用户输入和模型回复，结果
 * `getByText(TAIL)` 命中的是**用户气泡里回显的自己的提示词**，于是「尾段尚未出现」
 * 的前置断言永远失败，「尾段最终出现」的断言也永远「通过」——测的其实是用户输入，
 * 而不是模型回复。现在两者用不同关键词，断言只会命中真正的助手气泡。
 */
const USER_TEXT = 'USERPROMPT切换模块状态测试'
/** 回复首段（出现即代表流已开始）。 */
const HEAD = 'REPLYHEAD_甲甲甲'
/** 回复尾段（只有整条流跑完才会出现）。 */
const TAIL = 'REPLYTAIL_亥亥亥'
const REPLY_TEXT = `${HEAD}${'乙'.repeat(20)}${TAIL}`

/**
 * 应答队列必须**为路由预检单独占一个槽**，否则本用例不成立。
 *
 * 一轮用户消息会触发两次模型调用（见 11-chat-flow.spec.ts 的 `mainLoopRequests` 说明）：
 *   #0 `stream:false` 技能路由预检（只吃 JSON 路由信号，非流式）；
 *   #1 `stream:true`  Agent 主循环（产出用户看到的正文）。
 * 桩网关按**调用次序**消耗应答队列（fakeGateway.ts L184）。若只给一条慢速应答，
 * 预检会把它整个吃掉，主循环只能拿到「用尽后重复的最后一条」——
 * 表现为回复**瞬时全文出现**，本用例赖以成立的「首段已到、尾段未到」中间态不复存在
 * （实测踩坑：前置断言 `toHaveCount(0)` 因尾段与首段同帧出现而必然失败）。
 * 因此第一条给预检（瞬时、内容不重要），第二条才是给主循环的慢速正文。
 */
function slowReplies(): GatewayReply[] {
  // chunkSize=1 + 400ms/字符 → 约 13 秒，足够跨越「切走 → 停留 → 切回」全过程。
  return [
    { kind: 'text', text: '路由信号', chunkDelayMs: 0 },
    { kind: 'text', text: REPLY_TEXT, chunkSize: 1, chunkDelayMs: 400 }
  ]
}

const test = makeGatewayTest(slowReplies())

/** 切到对话模块。 */
async function gotoChat(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: '对话', exact: true }).first().click()
  await expect(page.getByPlaceholder(INPUT)).toBeVisible({ timeout: 20_000 })
}

test.describe('切换模块不打断对话状态', () => {
  test.setTimeout(180_000)

  test.beforeEach(async ({ page }) => {
    await gotoChat(page)
    await page.getByPlaceholder(INPUT).fill('')
  })

  test('生成中切走再切回：回复继续推进，且尾段不被吞掉', async ({ page, gateway }) => {
    gateway.resetRequests()

    await page.getByPlaceholder(INPUT).fill(USER_TEXT)
    await page.getByPlaceholder(INPUT).press('Enter')

    // 首段出现 = 流已开始（此时切走才是真正的「生成中切走」）。
    await expect(page.getByText(HEAD, { exact: false }).first()).toBeVisible({ timeout: 40_000 })

    // 前置校验：此刻尾段**尚未**出现，确认我们真的处在「未完成」的中间态。
    // （若这条失败，说明桩的时序没拉开，后面所有断言都会失去意义。）
    //
    // 注意不能用 `toHaveCount(0)`：Chat 已是**常驻层**（切模块只 hidden 不卸载），
    // 若尾段元素存在于其它（隐藏的）节点里，count 断言会把隐藏元素也算进去而误判。
    // 这里要表达的是「**可见的**尾段不存在」，故用 not.toBeVisible + count/isVisible 组合。
    await expect(page.getByText(TAIL, { exact: false })).toBeHidden()

    // ── 生成中切到别的模块，停留 3s（流在后台继续推进），再切回对话 ──
    await page.getByRole('button', { name: '服务器' }).first().click()
    await expect(page.getByPlaceholder(INPUT)).toBeHidden()
    await page.waitForTimeout(3000)
    await gotoChat(page)

    // 核心断言 ①：切回后**首段仍在场** —— 常驻层保留了已渲染的消息与状态。
    // 卸载重建的实现里，重挂载读的是落盘快照，尚能保住已 flush 的部分。
    await expect(page.getByText(HEAD, { exact: false }).first()).toBeVisible({ timeout: 20_000 })

    // 核心断言 ②（本用例的真正价值）：切回后**尾段也能自行补上**。
    // 这只有当「流事件监听」在模块切换期间**持续存活**时才可能 ——
    // 卸载重建的实例不会再收到旧流的 chunk，尾段永远缺失，本条必然超时。
    await expect(page.getByText(TAIL, { exact: false }).first()).toBeVisible({ timeout: 40_000 })

    // 核心断言 ③：回合正常收尾，输入框恢复可用（没有卡在「正在思考」）。
    await expect(page.getByPlaceholder(INPUT)).toBeEnabled({ timeout: 30_000 })
  })

  test('对话历史往返保留：已完成的回复在多次切换后仍在场', async ({ page, gateway }) => {
    gateway.resetRequests()

    await page.getByPlaceholder(INPUT).fill('USERPROMPT往返保留测试')
    await page.getByPlaceholder(INPUT).press('Enter')
    await expect(page.getByText(TAIL, { exact: false }).first()).toBeVisible({ timeout: 90_000 })
    await expect(page.getByPlaceholder(INPUT)).toBeEnabled({ timeout: 30_000 })

    // 收尾后反复往返：已完成的回复必须原样在场（验证常驻层不因模块切换丢状态）。
    for (const moduleName of ['服务器', '总览', '服务器']) {
      await page.getByRole('button', { name: moduleName }).first().click()
      await expect(page.getByPlaceholder(INPUT)).toBeHidden()
      await gotoChat(page)
      await expect(page.getByText(TAIL, { exact: false }).first()).toBeVisible({ timeout: 20_000 })
    }

    await expect(page.getByPlaceholder(INPUT)).toBeEnabled()
  })
})
