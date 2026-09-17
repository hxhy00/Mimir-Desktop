/**
 * 导航与模块断言 helper。
 *
 * 定位策略（实测得出）：
 * - 侧栏项：原生 `<button>` + 可见中文文本，无 testid → 用 `getByRole('button', { name, exact: true })`。
 *   `exact: true` 必要，否则「会议」会同时命中「组会」相关文案。
 * - 模块标题：所有模块统一用 `.module-title` 类（见各模块 header），是最稳的锚点，
 *   不依赖具体文案改动 → 用 `page.locator('.module-title')` 拿当前模块标题文本。
 */
import { expect, type Page } from '@playwright/test'

/** ModuleId → 侧栏可见文案（对照 src/components/layout/Sidebar.tsx navGroups）。 */
export const MODULE_LABELS = {
  chat: '对话',
  overview: '总览',
  library: '文献库',
  paper: '论文',
  experiments: '实验',
  figures: '图表',
  meetings: '组会',
  venues: '会议',
  servers: '服务器',
  ledger: '记录',
  plugins: '插件',
  settings: '设置'
} as const

export type ModuleKey = keyof typeof MODULE_LABELS

/** 点击侧栏进入某模块，并等待其标题渲染完成。 */
export async function gotoModule(page: Page, module: ModuleKey): Promise<void> {
  await page.getByRole('button', { name: MODULE_LABELS[module], exact: true }).first().click()
  // 等模块标题出现即视为切换完成（App.tsx 用 key 重挂载主内容）
  await expect(page.locator('.module-title').first()).toBeVisible()
}

/** 读取当前模块标题文本（.module-title），用于断言落在了正确的模块。 */
export async function currentModuleTitle(page: Page): Promise<string> {
  return (await page.locator('.module-title').first().innerText()).trim()
}

/** 断言当前处于某模块（按标题文本匹配）。 */
export async function expectModule(page: Page, titleContains: string): Promise<void> {
  await expect(page.locator('.module-title').first()).toContainText(titleContains)
}
