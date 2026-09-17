/**
 * P0 —— 骨架验证。
 *
 * 守护三件事：
 * 1. 应用能从构建产物启动、主界面渲染；
 * 2. 数据隔离真的生效（store / userData 落在临时目录）；
 * 3. 首启动向导**不出现**（seed 绕过有效）——否则其它用例都会被它堵在门口。
 */
import { test, expect } from '../fixtures/app'
import { join } from 'path'
import { existsSync } from 'fs'

test('应用从构建产物启动并渲染主界面', async ({ page }) => {
  await expect(page.locator('body')).toBeVisible()
  // 默认落在对话视图：输入框与助手欢迎消息都应渲染出来
  await expect(
    page.getByPlaceholder('今天帮你做些什么？输入 / 可调用技能与指令')
  ).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('你好，我是 Mimir，你的科研助手。')).toBeVisible()
})

test('数据隔离生效：store 与 userData 均落在临时目录', async ({ launched }) => {
  const { paths, tempHome } = launched

  expect(paths.userData).toContain(tempHome.root)
  expect(paths.home).toBe(tempHome.home)
  // 真实落盘证据：临时 HOME 下确实生成了 .mimir/store.json
  expect(existsSync(join(tempHome.home, '.mimir', 'store.json'))).toBe(true)
  // 反证：绝不等于开发者真实 HOME
  expect(paths.home).not.toBe(process.env.HOME)
})

test('首启动向导不出现（seed 绕过有效）', async ({ page }) => {
  await expect(page.getByRole('button', { name: '创建并进入' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '开始科研之旅' })).toHaveCount(0)
})

test('侧栏渲染出全部模块入口', async ({ page }) => {
  const modules = [
    '对话',
    '总览',
    '文献库',
    '论文',
    '实验',
    '图表',
    '组会',
    '会议',
    '服务器',
    '记录',
    '插件',
    '设置'
  ]
  for (const name of modules) {
    await expect(page.getByRole('button', { name, exact: true }).first()).toBeVisible()
  }
})
