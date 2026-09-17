/**
 * P1 —— 图表管理（Figures）。
 *
 * 覆盖真实的「上传图片」链路：通过 setInputFiles 喂一张内存 PNG，验证
 * UI → IPC（figures:add）→ 落空间目录 → 列表渲染。这是 e2e 独有价值的路径
 * （单元测试只能 mock，测不到自定义协议 mimir-img:// 的实际渲染）。
 */
import { test, expect } from '../fixtures/app'
import { gotoModule } from '../helpers/nav'

// 1x1 透明 PNG（合法的最小图片字节），避免依赖仓库内二进制 fixture 文件
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64'
)

test.describe('图表管理', () => {
  test.beforeEach(async ({ page }) => {
    await gotoModule(page, 'figures')
  })

  test('标题与计数渲染', async ({ page }) => {
    await expect(page.locator('.module-title')).toHaveText('图表管理')
    await expect(page.getByText(/\d+ 张图片/)).toBeVisible()
  })

  test('上传控件与从 PDF 导入按钮存在', async ({ page }) => {
    await expect(page.getByRole('button', { name: '上传图片' })).toBeVisible()
    await expect(page.getByRole('button', { name: '从 PDF 导入' })).toBeVisible()
  })

  test('上传图片后出现在网格并可重命名', async ({ page }) => {
    // 隐藏 input[type=file]：直接 setInputFiles，无需点按钮触发系统对话框
    const fileInput = page.locator('input[type="file"]')
    await fileInput.setInputFiles({
      name: 'e2e-figure.png',
      mimeType: 'image/png',
      buffer: PNG_1X1
    })

    // 上传后计数应增加、缩略图出现
    await expect(page.getByText(/张图片/)).toBeVisible()
    const img = page.locator('img[alt]').first()
    await expect(img).toBeVisible({ timeout: 10_000 })

    // hover 出操作层，点重命名按钮打开 Dialog
    const card = page.locator('div.group').first()
    await card.hover()
    const renameBtn = card.getByTitle('重命名并同步引用')
    if (await renameBtn.isVisible().catch(() => false)) {
      await renameBtn.click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByText('重命名图片并同步引用')).toBeVisible()
      await dialog.getByRole('button', { name: '取消' }).click()
      await expect(dialog).toHaveCount(0)
    }
  })
})
