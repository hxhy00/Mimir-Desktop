/**
 * P2 —— 论文编辑（Paper）。
 *
 * ⚠️ 严格不触发外部副作用：
 * - 不点「打开」（弹原生目录选择器，E2E 无法交互）；
 * - 不点「编译」（依赖本机 latex 引擎，且会跑真实编译）；
 * - 不点「创建」确认（会在磁盘建目录）。
 * 只覆盖「未打开项目时的欢迎页引导 + 工具栏按钮态 + 新建对话框表单校验」。
 *
 * worker 级实例共享 UI，本文件所有用例都在「未打开项目」状态下，无跨用例污染。
 */
import { makeTest, expect } from '../fixtures/app'
import { gotoModule } from '../helpers/nav'
import { repoRoot } from '../fixtures/launch'

/**
 * 「新建论文项目」在弹表单前，会先调 `api.showOpenDialog` 选存放位置（Paper.tsx L430–440）。
 * 原生目录选择器 Playwright 点不了，故在启动时把主进程 dialog 覆写为**恒返回仓库根目录**
 * （见 launch.ts 的 openDialogPaths）。此处只走到表单、点「取消」，不会真的建目录。
 */
const test = makeTest({ openDialogPaths: [repoRoot] })

test.describe('论文编辑', () => {
  test.beforeEach(async ({ page }) => {
    await gotoModule(page, 'paper')
  })

  test('标题渲染并常驻「打开」入口', async ({ page }) => {
    await expect(page.locator('.module-title')).toHaveText('论文编辑')
    // 「打开」按钮 title="打开论文文件夹"（Paper.tsx L746）
    await expect(page.getByTitle('打开论文文件夹').last()).toBeVisible()
  })

  test('欢迎页：引导标题与两个主行动按钮', async ({ page }) => {
    // renderWelcome（Paper.tsx L495–515）
    await expect(page.getByRole('heading', { name: 'LaTeX 论文工作区' })).toBeVisible()
    await expect(page.getByRole('button', { name: '打开论文文件夹' })).toBeVisible()
    await expect(page.getByRole('button', { name: '新建论文项目' })).toBeVisible()
  })

  test('未打开项目时：项目相关按钮禁用（Bib / 模板 / 快照 / 编译）', async ({ page }) => {
    // 这些按钮均 disabled={projectDir === null}（Paper.tsx L776/787/798/809）
    await expect(page.getByRole('button', { name: 'Bib', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '模板', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '快照', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '编译', exact: true })).toBeDisabled()
    // 保存按钮在无改动时禁用且文案为「已保存」（activeDirty=false，L765/769）
    await expect(page.getByRole('button', { name: '已保存' })).toBeDisabled()
  })

  test('未打开项目时不显示编辑器行号栏与 PDF 视图切换', async ({ page }) => {
    // 行号统计仅在 activeTab && view==='editor' 时出现；初始无项目应不可见
    await expect(page.getByText(/\d+ 行 · \d+:\d+/)).toHaveCount(0)
    // 视图切换按钮（编辑器 / PDF）同样只在有打开文件时出现
    await expect(page.getByRole('button', { name: '编辑器', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'PDF', exact: true })).toHaveCount(0)
  })

  test('新建项目对话框：标题、名称输入、空名校验', async ({ page }) => {
    // 通过欢迎页按钮打开对话框（不点「创建」，不落盘）
    await page.getByRole('button', { name: '新建论文项目' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('新建论文项目')).toBeVisible()
    await expect(dialog.getByText('项目名称')).toBeVisible()

    const nameInput = dialog.getByPlaceholder('my-paper')
    await expect(nameInput).toBeVisible()
    // 打开对话框时已预填默认名 'my-paper'（Paper.tsx L438），故「创建」初始可用
    await expect(nameInput).toHaveValue('my-paper')
    await expect(dialog.getByRole('button', { name: '创建' })).toBeEnabled()

    // 清空后「创建」禁用（Paper.tsx L1012：projectName.trim() === ''）
    await nameInput.fill('')
    await expect(dialog.getByRole('button', { name: '创建' })).toBeDisabled()

    // 输入含非法字符的名称会被替换为下划线（L998），随后「创建」恢复可用
    await nameInput.fill('e2e/paper')
    await expect(nameInput).toHaveValue('e2e_paper')
    await expect(dialog.getByRole('button', { name: '创建' })).toBeEnabled()

    // 取消关闭，不产生副作用
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(dialog).toHaveCount(0)
  })
})
