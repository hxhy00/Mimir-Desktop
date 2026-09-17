/**
 * P2：研究总览模块。
 *
 * 此前**零覆盖**：`00-smoke.spec.ts` 只断言侧栏有「总览」按钮存在，模块本身从未进入。
 *
 * 本模块的价值在于「跨模块聚合 + 跳转」：把文献/实验/图表/组会等各模块的计数汇总成
 * 统计卡，并按数据状态给行动建议；点卡片会**跳到目标模块**。跳转链路最值得测——
 * 它是模块间的契约，接错不会报错，只会「点了没反应」。
 */
import { test, expect } from '../fixtures/app'
import { gotoModule, currentModuleTitle } from '../helpers/nav'

test.describe('研究总览', () => {
  test.beforeEach(async ({ page }) => {
    await gotoModule(page, 'overview')
  })

  test('标题与四张统计卡渲染', async ({ page }) => {
    expect(await currentModuleTitle(page)).toBe('研究总览')
    // 统计卡固定 4 张（Overview.tsx L167–172 的 setStats）。用「标题文本」而非数量断言：
    // `.metric-label` 也被行动卡复用（同为 6 个时数量断言会误判），按文本定位才准确。
    await expect(page.locator('.metric-value')).toHaveCount(4)
    for (const label of ['论文', '项目', '实验', '记录']) {
      await expect(page.locator('.metric-label').filter({ hasText: label }).first()).toBeVisible()
    }
  })

  test('快捷操作区渲染全部入口', async ({ page }) => {
    await expect(page.getByText('快捷操作')).toBeVisible()
    for (const label of ['管理文献', '记录实验', '生成 PPT', '管理图表', '添加服务器', '记录进展']) {
      await expect(page.getByRole('button', { name: new RegExp(label) }).first()).toBeVisible()
    }
  })

  test('点「管理文献」跳转到文献库', async ({ page }) => {
    await page.getByRole('button', { name: /管理文献/ }).first().click()
    // 跳转成功 = 主内容区标题变成文献库的标题（App.tsx 用 key 重挂载）
    await expect(page.locator('.module-title').first()).toContainText('文献库', { timeout: 10_000 })
  })

  test('点「记录实验」跳转到实验模块', async ({ page }) => {
    await page.getByRole('button', { name: /记录实验/ }).first().click()
    await expect(page.locator('.module-title').first()).toContainText('实验', { timeout: 10_000 })
  })
})
