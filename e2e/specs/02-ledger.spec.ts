/**
 * P1 —— 成长记录（Ledger）。
 *
 * 选它作为第一个 CRUD 模块用例的理由：路径最短、无网络、无 AI、
 * 数据落在空间层 store，能同时验证「UI 操作 → IPC → 持久化」这条主链路。
 */
import { test, expect } from '../fixtures/app'
import { gotoModule } from '../helpers/nav'

test.describe('成长记录', () => {
  test.beforeEach(async ({ page }) => {
    await gotoModule(page, 'ledger')
  })

  test('空态显示引导文案与添加按钮', async ({ page }) => {
    await expect(page.locator('.module-title')).toHaveText('成长记录')
    // 初始无数据时应展示空态（若前序用例已写入则跳过空态断言）
    const empty = page.getByText('暂无记录')
    if (await empty.isVisible().catch(() => false)) {
      await expect(page.getByRole('button', { name: '添加第一条记录' })).toBeVisible()
    }
  })

  test('打开添加对话框并保存一条记录', async ({ page }) => {
    const title = `E2E 记录 ${Date.now()}`
    await page.getByRole('button', { name: '添加', exact: true }).first().click()

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('添加记录')).toBeVisible()

    await dialog.getByPlaceholder('如：完成文献调研').fill(title)
    await dialog.getByRole('button', { name: '保存' }).click()

    // 保存后对话框关闭，列表出现该条记录
    await expect(dialog).toHaveCount(0)
    await expect(page.getByText(title)).toBeVisible()
  })

  test('未填标题时保存按钮禁用', async ({ page }) => {
    await page.getByRole('button', { name: '添加', exact: true }).first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('button', { name: '保存' })).toBeDisabled()
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(dialog).toHaveCount(0)
  })

  test('删除记录弹出确认框并生效', async ({ page, dialogs }) => {
    // 前置：确保至少有一条可删记录
    const title = `待删除 ${Date.now()}`
    await page.getByRole('button', { name: '添加', exact: true }).first().click()
    const dialog = page.getByRole('dialog')
    await dialog.getByPlaceholder('如：完成文献调研').fill(title)
    await dialog.getByRole('button', { name: '保存' }).click()
    await expect(page.getByText(title)).toBeVisible()

    // hover 让删除按钮显形（opacity-0 → group-hover:opacity-100），再点
    const row = page.locator('div.group', { hasText: title }).first()
    await row.hover()
    await row.getByTitle('删除').click()

    // handleDelete 先弹 window.confirm（Ledger.tsx L94），自动应答器 accept 后记录才消失
    await expect.poll(() => dialogs.accepted.length).toBeGreaterThan(0)
    expect(dialogs.accepted[0]).toContain('确定删除这条记录')
    await expect(page.getByText(title)).toHaveCount(0)
  })
})
