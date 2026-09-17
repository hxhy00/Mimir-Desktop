/**
 * P0-1 单测：`notes` / `tags` 的写入模式参数（消除同名相反语义的静默覆盖）。
 *
 * 历史问题：`paper_fetch` 的 notes 是「追加」、tags 是「合并」，而 `set_paper` 两者都是
 * 「整体替换」——同名参数相反语义，且两边 description 各自准确描述了相反的语义，
 * 模型读了文档照样会踩。本组用例锁定新契约：
 *
 * 1. **默认保守**：不传 mode 时，都是「追加笔记 / 合并标签」，不丢原有内容；
 * 2. **显式覆盖**：mode='replace' 才整体替换，且原值非空时输出里出现「已覆盖原有…」提示；
 * 3. **默认路径的拼接格式不稳定项被锁住**：`\n\n` 分隔、去重、trim。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { setApprovalSender, settleApproval, type ApprovalRequest } from '../../electron/agent/approval'
import { setPaperTool } from '../../electron/agent/tools/paperTools'
import { getStoreValue, setStoreValue } from '../../electron/library/store'

interface PaperRow {
  id: string
  title: string
  tags: string[]
  notes: string
  authors: string[]
  projectIds: string[]
  relevance?: Record<string, { score: number; reason: string; at: string }>
}

/** 预置一条已存在的论文记录（绕过 importPaper 的网络路径）。 */
function seedPaper(overrides: Partial<PaperRow> = {}): void {
  const row: PaperRow = {
    id: '1512.03385',
    title: 'Deep Residual Learning for Image Recognition',
    tags: ['cv'],
    notes: '原始笔记',
    authors: ['Kaiming He'],
    projectIds: [],
    ...overrides
  }
  const table = getStoreValue<Record<string, PaperRow>>('library:papers') ?? {}
  table[row.id] = row
  setStoreValue('library:papers', table)
}

function readPaper(id = '1512.03385'): PaperRow {
  const table = getStoreValue<Record<string, PaperRow>>('library:papers') ?? {}
  return table[id]!
}

/**
 * 调用 set_paper 并自动放行批准卡，返回工具输出文本。
 *
 * 时序：sender 把请求收进数组 → 工具在 await 批准时空出事件循环 → 测试回填 settleApproval。
 */
async function runSetPaper(args: Record<string, unknown>): Promise<string> {
  const seen: ApprovalRequest[] = []
  setApprovalSender((req) => seen.push(req))
  const promise = setPaperTool.invoke({ arxivId: '1512.03385', ...args } as never)
  // 给工具一点时间把批准请求发出来
  await new Promise((r) => setTimeout(r, 0))
  if (seen.length === 0) {
    const early = await promise
    throw new Error(`批准卡未发出，工具提前返回: ${String(early)}`)
  }
  for (const req of seen) settleApproval(req.id, true)
  return String(await promise)
}

afterEach(() => {
  // 解绑假渲染层；store 由 test/setup/resetState.ts 统一清空
  setApprovalSender(() => undefined as never)
})

describe('set_paper：notes/tags 写入模式（P0-1）', () => {
  it('默认不传 mode：笔记追加到原有笔记之后（\\n\\n 分隔）', async () => {
    seedPaper()
    await runSetPaper({ notes: '新增笔记' })

    expect(readPaper().notes).toBe('原始笔记\n\n新增笔记')
  })

  it('默认不传 mode：标签与原标签取并集（不丢原有）', async () => {
    seedPaper()
    await runSetPaper({ tags: ['dl'] })

    expect([...readPaper().tags].sort()).toEqual(['cv', 'dl'])
  })

  it("notesMode='replace'：整体替换，且输出提示已覆盖", async () => {
    seedPaper()
    const output = await runSetPaper({ notes: '全新笔记', notesMode: 'replace' })

    expect(readPaper().notes).toBe('全新笔记')
    expect(output).toContain('已覆盖原有')
  })

  it("tagsMode='replace'：整体替换，且输出提示已覆盖", async () => {
    seedPaper()
    const output = await runSetPaper({ tags: ['nlp'], tagsMode: 'replace' })

    expect(readPaper().tags).toEqual(['nlp'])
    expect(output).toContain('已覆盖原有')
  })

  it('默认合并时去重：重复标签不产生重复项', async () => {
    seedPaper({ tags: ['cv', 'dl'] })
    await runSetPaper({ tags: ['dl', 'transformer'] })

    expect([...readPaper().tags].sort()).toEqual(['cv', 'dl', 'transformer'])
  })

  it('原有值为空时，replace 不误报覆盖提示', async () => {
    seedPaper({ notes: '', tags: [] })
    const output = await runSetPaper({ notes: '首次笔记', notesMode: 'replace', tags: ['new'], tagsMode: 'replace' })

    expect(readPaper().notes).toBe('首次笔记')
    expect(output).not.toContain('已覆盖原有')
  })
})
