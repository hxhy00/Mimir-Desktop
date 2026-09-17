/**
 * P1 —— GPU 服务器注册表。
 *
 * ⚠️ 不点「保存」：保存会自动发起 SSH 连通性检测（Servers.tsx L635），
 * e2e 环境没有真实服务器，会走网络且超时。因此本文件只覆盖
 * 「列表渲染 + 打开对话框 + 表单校验 + 取消」这些纯本地路径。
 */
import { test, expect } from '../fixtures/app'
import { gotoModule } from '../helpers/nav'

test.describe('GPU 服务器', () => {
  test.beforeEach(async ({ page }) => {
    await gotoModule(page, 'servers')
  })

  test('标题与计数徽标渲染', async ({ page }) => {
    await expect(page.locator('.module-title')).toHaveText('GPU 服务器')
    // 形如「N 台 · M 在线」
    await expect(page.getByText(/\d+ 台 · \d+ 在线/)).toBeVisible()
  })

  test('空态显示引导文案', async ({ page }) => {
    const empty = page.getByText('暂无服务器')
    if (await empty.isVisible().catch(() => false)) {
      await expect(page.getByText('点击右上角添加 GPU 服务器')).toBeVisible()
    }
  })

  test('打开添加对话框展示完整表单字段', async ({ page }) => {
    await page.getByRole('button', { name: '添加服务器' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('添加 GPU 服务器')).toBeVisible()
    // label 文本带必填星号（如「名称 *」），用包含匹配而非 exact
    for (const label of ['名称', '主机地址', '端口', '用户名']) {
      await expect(dialog.getByText(label)).toBeVisible()
    }
    await dialog.getByPlaceholder('实验室服务器').fill('E2E 测试机')
    await dialog.getByPlaceholder('192.168.1.100').fill('10.0.0.1')
    // 取消关闭，绝不触发保存（避免真实 SSH 探测）
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(dialog).toHaveCount(0)
  })

  test('必填缺失时不写入列表（取消即无副作用）', async ({ page }) => {
    const before = await page.getByText(/\d+ 台/).innerText()
    await page.getByRole('button', { name: '添加服务器' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: '取消' }).click()
    // 计数不变
    await expect(page.getByText(/\d+ 台/)).toHaveText(before)
  })
})
