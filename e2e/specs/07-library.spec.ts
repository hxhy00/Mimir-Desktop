/**
 * P2 —— 文献库（Library）。
 *
 * ⚠️ 不触网络：arXiv / Web 搜索需联网（Library.tsx），失败仅显示错误文本。
 * 用 page.route() 拦截外部请求；覆盖「渲染 + 项目条 + 搜索面板 + 条目详情展开 + 空态 + Zotero」。
 *
 * ── 为什么要预置数据（seed）────────────────────────────────────────────────
 * 默认 seed 的文献库是空的，只能断言空态。要覆盖「条目展开详情」这类核心交互，
 * 必须让库里真的有一条论文，因此本文件用 makeTest({ transformSeed }) 注入一条论文 + 一个项目。
 * 这比「先点搜索再导入」更稳：导入依赖联网搜索，离线环境跑不了。
 */
import { makeTest, expect } from '../fixtures/app'
import { gotoModule } from '../helpers/nav'
import type { SeedData } from '../fixtures/seed'

/** 预置项目 id（与 seed 里论文的 projectIds 对应）。 */
const PROJECT_ID = 'e2e-project-0001'
const PROJECT_TITLE = 'E2E 预置项目'

/**
 * 项目条里的项目按钮。
 *
 * 为什么要带 title 定位：项目名会**二次出现**——条目展开后「关联项目」区也会渲染同名按钮
 * （PaperCard.tsx L318–332），全局按名字取会撞到两个元素（strict mode violation）。
 * 项目条上的按钮带 `title={project.paperDir ?? project.title}`（ProjectBar.tsx L105），
 * 故用 `[title]` 属性限定为项目条那个。
 */
function projectChip(page: import('@playwright/test').Page) {
  return page.locator(`button[title="${PROJECT_TITLE}"]`)
}

/** 预置论文标题（用于断言卡片、展开、标签）。 */
const PAPER_TITLE = 'E2E 预置论文：Vision Transformer 综述'

/**
 * 往默认 seed 的空间层注入 1 个项目 + 1 篇论文。
 *
 * 键名严格对齐 electron/library/libraryService.ts：`library:papers`（表，按 arxivId 索引）
 * 与 `library:projects`（数组）。字段名对齐 electron/library/types.ts 的 PaperRecord / ProjectRecord。
 */
function seedLibrary(seed: SeedData): SeedData {
  const now = '2026-01-02T00:00:00.000Z'
  const paper = {
    arxivId: 'e2e.0001',
    title: PAPER_TITLE,
    authors: ['张三', '李四'],
    summary: '这是一条 E2E 预置论文的摘要，用于验证详情展开。',
    url: 'https://arxiv.org/abs/e2e.0001',
    notes: '',
    tags: ['survey'],
    projectIds: [PROJECT_ID],
    addedAt: now
  }
  const project = {
    id: PROJECT_ID,
    title: PROJECT_TITLE,
    createdAt: now,
    updatedAt: now
  }
  return {
    ...seed,
    spaceData: {
      ...(seed.spaceData ?? {}),
      'library:papers': { [paper.arxivId]: paper },
      'library:projects': [project]
    }
  }
}

const test = makeTest({ transformSeed: seedLibrary })

test.describe('文献库', () => {
  test.beforeEach(async ({ page }) => {
    await page.route(
      (url) => url.protocol === 'https:' || url.protocol === 'http:',
      (route) => route.abort()
    )
    await gotoModule(page, 'library')
  })

  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })

  test('标题与论文计数渲染', async ({ page }) => {
    await expect(page.locator('.module-title')).toHaveText('文献库')
    // 预置 1 篇，计数应为「1 篇论文」（全局计数，不随筛选变化）
    await expect(page.getByText('1 篇论文')).toBeVisible()
  })

  test('搜索面板：输入框、来源切换、排序、搜索按钮', async ({ page }) => {
    // 输入框可见（arXiv 来源时的 placeholder，SearchPanel.tsx L62）
    const search = page.getByPlaceholder('搜索 arXiv 论文...')
    await expect(search).toBeVisible()

    // 输入后搜索按钮变为可用（disabled 条件：isSearching || !query.trim()）
    const searchBtn = page.getByRole('button', { name: '搜索', exact: true })
    await expect(searchBtn).toBeDisabled()
    await search.fill('transformer')
    await expect(search).toHaveValue('transformer')
    await expect(searchBtn).toBeEnabled()

    // 排序下拉：arXiv 来源下才有，含「相关度」「最新」（SearchPanel.tsx L70–77）
    const sort = page.locator('select').first()
    await expect(sort).toBeVisible()
    await expect(sort.locator('option')).toHaveText(['相关度', '最新'])

    // 来源切换：切到 Web 后 placeholder 变化，排序下拉消失（L69 条件）
    await page.getByRole('button', { name: 'Web', exact: true }).click()
    await expect(page.getByPlaceholder('搜索网页文献...')).toBeVisible()
    await expect(page.locator('select')).toHaveCount(0)
  })

  test('项目条：预置项目出现，可切换筛选', async ({ page }) => {
    // 项目条渲染了预置项目（ProjectBar.tsx）
    await expect(projectChip(page)).toBeVisible()
    await projectChip(page).click()
    // 选中后头部出现「N 篇 · 项目名」的筛选计数（Library.tsx L382–386）
    await expect(page.getByText(`1 篇 · ${PROJECT_TITLE}`)).toBeVisible()

    // 收尾：重置回「全部」（共享实例，避免影响后续用例）
    await page.getByRole('button', { name: '全部', exact: true }).click()
  })

  test('条目展开：点击标题展开详情（摘要 / 标签 / 关联项目 / 笔记入口）', async ({ page }) => {
    // 折叠态显示摘要预览（line-clamp），展开后出现「标签」「阅读笔记」等分区标题
    const title = page.getByRole('heading', { name: PAPER_TITLE })
    await expect(title).toBeVisible()

    // 展开前不显示「阅读笔记」分区（PaperCard.tsx L336–374 仅在 expanded 下渲染）
    await expect(page.getByText('阅读笔记')).toHaveCount(0)

    // 点标题所在的可点击区展开（PaperCard.tsx L129–133 onClick toggles expanded）
    await title.click()

    await expect(page.getByText('标签', { exact: true })).toBeVisible()
    await expect(page.getByText('关联项目', { exact: true })).toBeVisible()
    await expect(page.getByText('阅读笔记', { exact: true })).toBeVisible()
    // 预置标签渲染（折叠预览与展开标签区各有一个，故取首个）
    await expect(page.getByText('survey', { exact: true }).first()).toBeVisible()
  })

  test('未选项目时 AI 评分 / BibTeX 按钮禁用（依赖当前项目）', async ({ page }) => {
    // worker 级实例共享 UI：先把筛选重置回「全部」，确保从「未选项目」开始。
    await page.getByRole('button', { name: '全部', exact: true }).click()

    // PaperCard.tsx L243–264：disabled={!selectedProjectId}
    const scoreBtn = page.getByRole('button', { name: /AI 评分/ }).first()
    const bibBtn = page.getByRole('button', { name: /BibTeX/ }).first()
    await expect(scoreBtn).toBeDisabled()
    await expect(bibBtn).toBeDisabled()

    // 选中项目后恢复可用
    await projectChip(page).click()
    await expect(scoreBtn).toBeEnabled()
    await expect(bibBtn).toBeEnabled()

    // 收尾：重置回「全部」（共享实例，避免影响后续用例）
    await page.getByRole('button', { name: '全部', exact: true }).click()
  })

  test('Zotero 集成按钮打开对话框', async ({ page }) => {
    await page.getByRole('button', { name: 'Zotero' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Zotero 集成')).toBeVisible()
    await expect(dialog.getByPlaceholder('Zotero API Key')).toBeVisible()
    await expect(dialog.getByPlaceholder('Zotero User ID（数字）')).toBeVisible()
    // 关闭：底部按钮文案是「关闭」（Library.tsx L558–560），不写入凭据
    await dialog.getByRole('button', { name: '关闭' }).click()
    await expect(dialog).toHaveCount(0)
  })
})

/**
 * 空态：单独用一个**空文献库**的实例验证（默认 seed 无预置数据）。
 * 与上面的文件不共享实例（另起一个 Electron），因为「空态」与「有数据」互斥。
 */
const emptyTest = makeTest()

emptyTest.describe('文献库（空态）', () => {
  emptyTest.beforeEach(async ({ page }) => {
    await page.route(
      (url) => url.protocol === 'https:' || url.protocol === 'http:',
      (route) => route.abort()
    )
    await gotoModule(page, 'library')
  })

  emptyTest.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })

  emptyTest('无数据时展示空态文案', async ({ page }) => {
    await expect(page.getByText('0 篇论文')).toBeVisible()
    await expect(page.getByText('文献库为空')).toBeVisible()
    await expect(page.getByText('搜索 arXiv / Web 并导入论文')).toBeVisible()
  })
})
