/**
 * P1 —— 实验管理。
 *
 * 覆盖：列表渲染、新建对话框、表单校验（保存需名称）、创建后落列表、删除走 confirm。
 * 注意：新建实验会「自动沉淀」一条成长记录（Experiments.tsx L177–189），
 * 属预期副作用，本文件不额外断言它（那是 Ledger 的职责）。
 */
import { test, expect } from '../fixtures/app'
import { gotoModule } from '../helpers/nav'

test.describe('实验管理', () => {
  test.beforeEach(async ({ page }) => {
    await gotoModule(page, 'experiments')
  })

  test('标题与计数渲染', async ({ page }) => {
    await expect(page.locator('.module-title')).toHaveText('实验管理')
    await expect(page.getByText(/\d+ 个实验 · \d+ 训练中/)).toBeVisible()
  })

  test('空态显示引导文案', async ({ page }) => {
    const empty = page.getByText('暂无实验')
    if (await empty.isVisible().catch(() => false)) {
      await expect(page.getByText('点击右上角新建实验，记录训练指标与结果')).toBeVisible()
    }
  })

  test('未填名称时不能创建', async ({ page }) => {
    await page.getByRole('button', { name: '新建实验' }).first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('新建实验')).toBeVisible()
    // 名称为空 → 保存按钮禁用或点击后仍停留在对话框
    const saveBtn = dialog.getByRole('button', { name: /保存|创建/ }).last()
    const disabled = await saveBtn.isDisabled().catch(() => false)
    if (disabled) {
      await expect(saveBtn).toBeDisabled()
    } else {
      await saveBtn.click()
      await expect(dialog).toBeVisible() // 未关闭 = 校验拦截
    }
    await dialog.getByRole('button', { name: '取消' }).click()
  })

  test('创建实验后出现在列表并可删除', async ({ page, dialogs }) => {
    const name = `E2E 实验 ${Date.now()}`
    await page.getByRole('button', { name: '新建实验' }).first().click()
    const dialog = page.getByRole('dialog')
    await dialog.getByPlaceholder('如：ResNet-50 Fine-tuning').fill(name)
    await dialog.getByRole('button', { name: /保存|创建/ }).last().click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByText(name)).toBeVisible()

    // 删除按钮 title="删除"，常驻卡片右侧操作区（Experiments.tsx L429–438），无需 hover
    const card = page.locator('div.rounded-lg.border', { hasText: name }).first()
    await card.getByTitle('删除').click()
    await expect.poll(() => dialogs.accepted.length).toBeGreaterThan(0)
    await expect(page.getByText(name)).toHaveCount(0)
  })
})
