/**
 * P2 —— 组会（Meetings）。
 *
 * ⚠️ 不触 AI、不落盘：绝不点最终「生成」（那会跑 pptxgenjs 落盘并可能调用模型）。
 * 覆盖「标题与计数 + 空态引导 + 生成按钮 + 对话框表单字段 + 必填校验（主题为空时禁用）」。
 *
 * seed 无演示文稿，故列表为空态；用例对空态与对话框分别断言。
 */
import { test, expect } from '../fixtures/app'
import { gotoModule } from '../helpers/nav'

test.describe('组会', () => {
  test.beforeEach(async ({ page }) => {
    await gotoModule(page, 'meetings')
  })

  test('标题与计数渲染', async ({ page }) => {
    await expect(page.locator('.module-title')).toHaveText('组会管理')
    await expect(page.getByText(/\d+ 份演示文稿/)).toBeVisible()
  })

  test('AI 要点徽章提示当前模型可用性', async ({ page }) => {
    // 头部恒有「AI 要点」徽章（Meetings.tsx L270–285），title 依配置分为两种
    const badge = page.getByText('AI 要点', { exact: true })
    await expect(badge).toBeVisible()
    await expect(badge).toHaveAttribute(
      'title',
      /已配置模型|未配置模型/
    )
  })

  test('空态：暂无演示文稿 + 内联生成入口', async ({ page }) => {
    // seed 无 deck，展示空态（Meetings.tsx L307–319）
    await expect(page.getByText('暂无演示文稿')).toBeVisible()
    await expect(page.getByText(/从文献库的项目论文与实验记录生成专业 16:9 PPT/)).toBeVisible()
    // 头部与空态各有一个「生成 PPT」按钮
    await expect(page.getByRole('button', { name: '生成 PPT' })).toHaveCount(2)
  })

  test('生成对话框：表单字段齐全', async ({ page }) => {
    await page.getByRole('button', { name: '生成 PPT' }).first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('生成组会 PPT')).toBeVisible()
    await expect(dialog.getByText('汇报主题 *')).toBeVisible()
    await expect(dialog.getByPlaceholder('如：VLM 研究进展汇报')).toBeVisible()
    await expect(dialog.getByPlaceholder('你的名字')).toBeVisible()
    await expect(dialog.getByText('日期', { exact: true })).toBeVisible()
    await expect(dialog.getByText('关联项目（可选，用于预选论文与相关度展示）')).toBeVisible()

    // 取消关闭，绝不点生成
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(dialog).toHaveCount(0)
  })

  test('必填校验：主题为空时「生成」禁用，填写后启用', async ({ page }) => {
    await page.getByRole('button', { name: '生成 PPT' }).first().click()
    const dialog = page.getByRole('dialog')
    const generate = dialog.getByRole('button', { name: '生成', exact: true })

    // 初始主题为空 → 生成禁用（Meetings.tsx L682：!formTitle.trim()）
    await expect(generate).toBeDisabled()

    // 仅输入空白字符仍禁用（trim 后为空）
    await dialog.getByPlaceholder('如：VLM 研究进展汇报').fill('   ')
    await expect(generate).toBeDisabled()

    // 填入有效主题后启用
    await dialog.getByPlaceholder('如：VLM 研究进展汇报').fill('E2E 组会汇报')
    await expect(generate).toBeEnabled()

    // 清空后再次禁用（覆盖反向）
    await dialog.getByPlaceholder('如：VLM 研究进展汇报').fill('')
    await expect(generate).toBeDisabled()

    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(dialog).toHaveCount(0)
  })
})
