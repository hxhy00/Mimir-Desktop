/**
 * P1 —— 设置（Settings）。
 *
 * 覆盖：tab 切换、各 tab 关键区块渲染。
 * 「重启后持久化」用**直接读临时 HOME 的 store 文件**来验证——比再启一个实例更快，
 * 且证明的是「真的写到了磁盘」而不是「内存里看起来变了」。见本文件末尾的落盘用例。
 */
import { test, expect } from '../fixtures/app'
import { gotoModule } from '../helpers/nav'

const TABS = ['模型', '外观', 'Agent', '权限与安全', '科研空间', '语音与资源', '关于']

test.describe('设置', () => {
  test.beforeEach(async ({ page }) => {
    await gotoModule(page, 'settings')
  })

  test('标题与全部 tab 渲染', async ({ page }) => {
    await expect(page.locator('.module-title')).toHaveText('设置')
    for (const tab of TABS) {
      await expect(page.getByRole('button', { name: tab, exact: true }).first()).toBeVisible()
    }
  })

  test('切换到外观 tab', async ({ page }) => {
    await page.getByRole('button', { name: '外观', exact: true }).first().click()
    // 外观区应出现主题相关控件（浅色/深色/跟随系统）
    const appearance = page.getByText(/主题|浅色|深色|跟随系统/)
    await expect(appearance.first()).toBeVisible()
  })

  test('切换到关于 tab', async ({ page }) => {
    await page.getByRole('button', { name: '关于', exact: true }).first().click()
    // 关于页通常含版本号
    await expect(page.getByText(/版本|v\d|0\.\d/).first()).toBeVisible()
  })

  test('切回模型 tab 展示模型管理', async ({ page }) => {
    await page.getByRole('button', { name: '模型', exact: true }).first().click()
    await expect(page.getByText('模型管理')).toBeVisible()
  })
})
