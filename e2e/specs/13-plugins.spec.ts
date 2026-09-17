/**
 * P2：插件模块（技能 / 指令 / 能力域 / 插件 / Hooks 五个 tab）。
 *
 * 此前**零覆盖**。这是产品里结构最复杂的模块（1400+ 行，五个 tab，各自有增删改查），
 * 且它承载「用户自定义能力」这一核心扩展点——用户在这里配的技能/指令，会在对话输入框
 * 用 `/触发词` 调用，因此配置写坏会直接影响对话。
 *
 * 本 spec 优先覆盖三类风险，全部可离线验证（不依赖模型）：
 *  1. 结构风险：五个 tab 是否都能打开、各自渲染正确（tab 接错会白屏或串内容）；
 *  2. 数据风险：新增/删除是否真的落盘并回读（这是模块的存在意义）；
 *  3. 输入风险：导入表单对坏输入的处理（导入坏数据会污染对话的 `/` 菜单）。
 *
 * 纪律：**不触网络、不触模型**。所有断言只看 UI 与隔离 store。
 */
import { test, expect } from '../fixtures/app'
import { gotoModule, currentModuleTitle } from '../helpers/nav'

/** 五个 tab 的标签（Plugins.tsx L1340–1345 的 TABS，顺序即渲染顺序）。 */
const TABS = ['指令', '技能', '能力域', '插件', 'Hooks'] as const

/**
 * tab 行容器。
 *
 * 为什么要先锁定容器：标签文本会与**侧栏项**重名（「插件」既是侧栏项也是 tab），
 * 全局 `getByRole('button', { name: '插件' }).first()` 会命中侧栏项——点它不会切 tab，
 * 只会重新进入模块（实测：以为切了 tab，实际仍在技能面板，导致后续全都找不到元素）。
 * tab 行是模块标题下方的 `.no-drag` 横条（Plugins.tsx L1357）。
 */
function tabRow(page: import('@playwright/test').Page) {
  return page.locator('.no-drag')
}

/** tab 行里的某个 tab 按钮（按标签文本，锚定开头以避免命中「指令」说明等）。 */
function tabButton(page: import('@playwright/test').Page, label: string) {
  return tabRow(page).getByRole('button', { name: new RegExp(`^${label}`) })
}

/** 点开某个 tab。 */
async function openTab(page: import('@playwright/test').Page, label: string): Promise<void> {
  await tabButton(page, label).first().click()
}

/**
 * 某个面板里的「新增」按钮，用该面板的**说明文字**定位。
 *
 * 为什么不能用 `getByRole('button', { name: /新增/ }).first()`：多个 tab 都含「新增」，
 * 且「新增」还会作为对话框标题出现，全局 `.first()` 会命中非预期元素（实测 30s 超时）。
 * 为什么不用面板标题：插件面板的 title 正好也是「插件」，与 tab 同名，不具唯一性；
 * 而 description（每个 CollectionPanel 独有）唯一，故用它锁定面板容器再取按钮。
 */
function addButtonIn(page: import('@playwright/test').Page, descriptionPart: string) {
  return page
    .locator('div.rounded-lg.border')
    .filter({ hasText: descriptionPart })
    .getByRole('button', { name: '新增' })
    .last()
}

/** 插件面板的说明文字前缀（Plugins.tsx L1387）。 */
const PLUGINS_PANEL_DESC = '注册可插拔能力'

test.describe('插件模块', () => {
  test.beforeEach(async ({ page }) => {
    await gotoModule(page, 'plugins')
  })

  test('标题与五个 tab 都渲染', async ({ page }) => {
    expect(await currentModuleTitle(page)).toBe('插件')
    for (const label of TABS) {
      await expect(tabButton(page, label).first()).toBeVisible()
    }
  })

  test('逐个切换五个 tab：都能打开且不白屏', async ({ page }) => {
    for (const label of TABS) {
      await openTab(page, label)
      // 每个 tab 都有说明文字（TABS[].desc 渲染在 tab 行下方）：用它证明内容已切换
      await expect(page.locator('p.text-\\[10px\\].text-muted-foreground').first()).toBeVisible()
      // 且各 tab 的主入口都在（技能/指令是「导入」，其余是「新增」）
      await expect(page.getByRole('button', { name: /新增|克隆|导入/ }).first()).toBeVisible()
    }
  })

  test('插件 tab：新增一条并落盘回读', async ({ page, launched }) => {
    await openTab(page, '插件')
    await addButtonIn(page, PLUGINS_PANEL_DESC).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    // 名称是必填项（fields 里 label 为「名称 *」，placeholder 为「插件名」）
    await dialog.getByPlaceholder('插件名').fill('E2E 插件甲')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    // UI 回读
    await expect(page.getByText('E2E 插件甲')).toBeVisible()

    // 落盘回读：读隔离 store 的 plugins:plugins 键（证明真的持久化，不只是内存态）
    const raw = await page.evaluate(() => window.electronAPI?.getStoreValue?.('plugins:plugins'))
    expect(JSON.stringify(raw ?? '')).toContain('E2E 插件甲')
    // 隔离断言：数据落在临时 HOME 下，未写真实磁盘
    expect(launched.paths.home).toContain('mimir-e2e')
  })

  test('插件 tab：删除已添加条目', async ({ page }) => {
    await openTab(page, '插件')
    await addButtonIn(page, PLUGINS_PANEL_DESC).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByPlaceholder('插件名').fill('E2E 待删除插件')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    // 定位该条目的行：含名字的最小容器，删除按钮是行内最后一个按钮（Pencil 在前、Trash2 在后）
    const row = page
      .locator('div.rounded-lg.border')
      .filter({ hasText: 'E2E 待删除插件' })
      .last()
    await expect(row).toBeVisible()
    // dialogs fixture 默认 accept，删除的 confirm 会自动通过
    await row.getByRole('button').last().click()
    await expect(page.getByText('E2E 待删除插件')).toHaveCount(0, { timeout: 10_000 })
  })

  test('技能 tab：导入坏输入会给出错误提示且不落盘', async ({ page }) => {
    await openTab(page, '技能')
    await page.getByRole('button', { name: /^导入技能/ }).first().click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    // 切到「粘贴 JSON」页签，坏的 JSON 才能触发 JSON.parse 分支的错误提示
    await dialog.getByRole('button', { name: /粘贴 JSON/ }).click()
    await dialog.locator('textarea').first().fill('这不是 JSON')
    await dialog.getByRole('button', { name: '导入', exact: true }).click()

    // 关键：给出错误提示，而不是静默吞掉或崩溃（提示渲染在 DialogFooter 上方）
    await expect(dialog.getByText(/JSON 格式不正确/).first()).toBeVisible({ timeout: 10_000 })
    // 且不应把坏数据写进技能库（键名见 src/lib/slash/userSkills.ts:17）
    const raw = await page.evaluate(() => window.electronAPI?.getStoreValue?.('mimir:user-skills'))
    expect(JSON.stringify(raw ?? '')).not.toContain('这不是 JSON')
  })
})
