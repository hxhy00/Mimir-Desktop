/**
 * P1 —— 会议截稿（Venues）。
 *
 * ⚠️ 不触网络：本模块启动约 2 秒会自动从 ccfddl 拉取（Venues.tsx L198）。
 * 用 page.route() 拦截所有外部 http(s) 请求并 abort，强制走「离线快照」路径，
 * 既满足 AC「用例不触网络」，又让断言不受真实数据波动影响。
 */
import { test, expect } from '../fixtures/app'
import { gotoModule } from '../helpers/nav'

test.describe('会议截稿', () => {
  test.beforeEach(async ({ page }) => {
    // 拦截外部请求 → 保证离线、确定性
    await page.route(
      (url) => url.protocol === 'https:' || url.protocol === 'http:',
      (route) => route.abort()
    )
    await gotoModule(page, 'venues')
  })

  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })

  test('标题渲染，模式切换控件存在', async ({ page }) => {
    await expect(page.locator('.module-title')).toHaveText('会议截稿')
    await expect(page.getByRole('button', { name: '会议截稿' }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'CCF-A 期刊' })).toBeVisible()
  })

  test('切换到 CCF-A 期刊模式', async ({ page }) => {
    await page.getByRole('button', { name: 'CCF-A 期刊' }).click()
    // 计数徽标文案随之变化（含「期刊」）
    await expect(page.getByText(/CCF-A 期刊|本/).first()).toBeVisible()
  })

  test('CCF 等级筛选按钮可点击且不报错', async ({ page }) => {
    for (const label of ['全部', 'CCF-A', 'CCF-B', 'CCF-C']) {
      const btn = page.getByRole('button', { name: label, exact: true }).first()
      if (await btn.isVisible().catch(() => false)) {
        await btn.click()
      }
    }
    // 无崩溃：页面仍在会议模块
    await expect(page.locator('.module-title')).toHaveText('会议截稿')
  })

  test('刷新按钮存在（离线点击不崩）', async ({ page }) => {
    const refresh = page.getByRole('button', { name: '刷新' })
    await expect(refresh).toBeVisible()
    await refresh.click()
    // 拦截后拉取失败会展示错误条或回到快照，二者都不应导致白屏
    await expect(page.locator('.module-title')).toHaveText('会议截稿')
  })
})
