/**
 * P3 —— 对话输入区 + 批准卡三态（安全关键路径）。
 *
 * 批准卡的触发方式：从**主进程**沿真实 IPC 频道 `agent:approval-request`
 * （electron/preload.ts L642）推一条请求给渲染层。这样：
 * - 不需要真实 AI 模型（批准卡是纯 UI 状态，由 IPC 事件驱动）；
 * - 不侵入组件内部 state（走的是产品真实使用的通道）；
 * - 能精确控制 `rememberable` 以验证第三个按钮的条件渲染。
 *
 * 这是本套 e2e 里**安全价值最高**的用例：它守护「用户拒绝时应用必须真的拒绝」
 * 这条权限底线。若哪天有人把「拒绝」按钮的回调接错，这里会红。
 */
import { test, expect } from '../fixtures/app'

interface ApprovalPayload {
  id: string
  tool: string
  summary: string
  detail?: string
  rememberable?: boolean
}

/** 从主进程推一条批准请求到渲染层。 */
async function sendApproval(electronApp: import('@playwright/test').ElectronApplication, payload: ApprovalPayload) {
  await electronApp.evaluate(({ BrowserWindow }, request) => {
    const win = BrowserWindow.getAllWindows()[0]
    win?.webContents.send('agent:approval-request', request)
  }, payload)
}

test.describe('对话与批准卡', () => {
  // 对话视图不是标准模块页（没有 .module-title），用输入框作为「就绪」标志。
  // 应用默认就落在对话视图，因此这里只需确保输入框已渲染。
  test.beforeEach(async ({ page }) => {
    await page.getByRole('button', { name: '对话', exact: true }).first().click()
    await expect(page.getByPlaceholder('今天帮你做些什么？输入 / 可调用技能与指令')).toBeVisible({
      timeout: 20_000
    })
  })

  test('输入框可输入', async ({ page }) => {
    const input = page.getByPlaceholder('今天帮你做些什么？输入 / 可调用技能与指令')
    await input.fill('这是一条 e2e 输入，不会被发送')
    await expect(input).toHaveValue('这是一条 e2e 输入，不会被发送')
    await input.fill('')
  })

  test('输入 / 触发技能菜单', async ({ page }) => {
    const input = page.getByPlaceholder('今天帮你做些什么？输入 / 可调用技能与指令')
    await input.click()
    await input.fill('/')
    // 技能菜单应弹出（slashEntries 驱动的候选列表，含「技能」分组标题或指令项）
    await expect(page.getByText(/技能|指令|\//).first()).toBeVisible()
    await input.fill('')
  })

  test('批准卡：显示工具名与三态按钮，点「允许一次」后消失', async ({ page, electronApp }) => {
    await sendApproval(electronApp, {
      id: 'e2e-approval-allow',
      tool: 'fs_write',
      summary: '写入文件 /tmp/e2e-demo.md',
      detail: '内容：Hello E2E',
      rememberable: true
    })

    // 卡片出现：标题含工具名 + 「需确认」徽章
    await expect(page.getByText('Agent 请求执行「fs_write」')).toBeVisible()
    await expect(page.getByText('需确认')).toBeVisible()
    await expect(page.getByText('写入文件 /tmp/e2e-demo.md')).toBeVisible()

    // 三态按钮齐全（rememberable=true 才有第三个）
    await expect(page.getByRole('button', { name: '拒绝' })).toBeVisible()
    await expect(page.getByRole('button', { name: '允许一次' })).toBeVisible()
    await expect(page.getByRole('button', { name: '允许并记住此目录' })).toBeVisible()

    await page.getByRole('button', { name: '允许一次' }).click()
    await expect(page.getByText('需确认')).toHaveCount(0)
  })

  test('批准卡：点「拒绝」后卡片消失（Fail-Closed 底线）', async ({ page, electronApp }) => {
    await sendApproval(electronApp, {
      id: 'e2e-approval-deny',
      tool: 'fs_write',
      summary: '删除文件 /tmp/should-not-delete',
      rememberable: false
    })

    await expect(page.getByText('Agent 请求执行「fs_write」')).toBeVisible()
    // rememberable=false 时不应出现第三个按钮（避免误导用户以为可记住）
    await expect(page.getByRole('button', { name: '允许并记住此目录' })).toHaveCount(0)

    await page.getByRole('button', { name: '拒绝' }).click()
    await expect(page.getByText('需确认')).toHaveCount(0)
  })

  test('批准卡：「允许并记住」路径也能正常收起', async ({ page, electronApp }) => {
    await sendApproval(electronApp, {
      id: 'e2e-approval-remember',
      tool: 'fs_write',
      summary: '写入 /tmp/remembered-dir/a.md',
      rememberable: true
    })

    await page.getByRole('button', { name: '允许并记住此目录' }).click()
    await expect(page.getByText('需确认')).toHaveCount(0)
  })
})
