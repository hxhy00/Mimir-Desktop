/**
 * P0-2 单测：研究项目工具（一个工具 + action 枚举）。
 *
 * 覆盖：list / get / create / update / delete 五个 action，以及两条关键安全性：
 * 1. **delete 的确认卡 summary 以「删除」开头** —— 否则全权档下 `isDestructiveApproval`
 *    认不出来，会被静默放行（见 approval.ts 的破坏性动作识别）；
 * 2. **delete 级联清理** —— 项目被删后，论文的 projectIds 里不应残留该 id。
 *
 * 另覆盖 guidance 里承诺的行为：id 不存在时给出候选列表而不是抛错。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { setApprovalSender, settleApproval, type ApprovalRequest } from '../../electron/agent/approval'
import { projectTool } from '../../electron/agent/tools/projects'
import { getStoreValue, setStoreValue } from '../../electron/library/store'
import { createProject } from '../../electron/library/libraryService'
import type { PaperRecord, ProjectRecord } from '../../electron/library/types'

const PROJECTS_KEY = 'library:projects'
const PAPERS_KEY = 'library:papers'

/** 捕获批准卡并回填结果，返回 [工具输出, 收到的批准卡列表]。 */
async function runProject(
  args: Record<string, unknown>,
  approve = true,
): Promise<{ output: string; requests: ApprovalRequest[] }> {
  const requests: ApprovalRequest[] = []
  setApprovalSender((req) => requests.push(req))
  const promise = projectTool.invoke(args as never)
  await new Promise((r) => setTimeout(r, 0))
  for (const req of requests) settleApproval(req.id, approve)
  return { output: String(await promise), requests }
}

function seedPaper(id: string, projectIds: string[]): void {
  const table = getStoreValue<Record<string, PaperRecord>>(PAPERS_KEY) ?? {}
  table[id] = {
    id,
    title: `论文 ${id}`,
    authors: [],
    tags: [],
    notes: '',
    projectIds,
    addedAt: new Date().toISOString(),
  } as PaperRecord
  setStoreValue(PAPERS_KEY, table)
}

function readProjects(): ProjectRecord[] {
  return getStoreValue<ProjectRecord[]>(PROJECTS_KEY) ?? []
}

afterEach(() => {
  setApprovalSender(() => undefined as never)
})

describe('project 工具：读取', () => {
  it('list：空空间给出可继续的提示而非空字符串', async () => {
    const { output } = await runProject({ action: 'list' })
    expect(output).toContain('暂无研究项目')
    expect(output).toContain('create')
  })

  it('list：按 updatedAt 倒序', async () => {
    const a = createProject('较早的项目')
    await new Promise((r) => setTimeout(r, 5))
    const b = createProject('较晚的项目')

    const { output } = await runProject({ action: 'list' })
    expect(output.indexOf(b.title)).toBeLessThan(output.indexOf(a.title))
  })

  it('get：返回 id / 标题 / 论文目录', async () => {
    const p = createProject('扩散模型', '/tmp/papers')
    const { output } = await runProject({ action: 'get', projectId: p.id })

    expect(output).toContain(p.id)
    expect(output).toContain('扩散模型')
    expect(output).toContain('/tmp/papers')
  })

  it('get：id 不存在时列出候选，而不是报错', async () => {
    createProject('唯一项目')
    const { output } = await runProject({ action: 'get', projectId: 'no-such-id' })

    expect(output).toContain('找不到项目')
    expect(output).toContain('唯一项目')
  })
})

describe('project 工具：写入需批准', () => {
  it('create：用户拒绝时不得落库', async () => {
    const { output } = await runProject({ action: 'create', title: '不该被创建' }, false)

    expect(output).toContain('已取消')
    expect(readProjects()).toHaveLength(0)
  })

  it('create：批准后落库，且 title 前后空格被裁剪', async () => {
    const { output } = await runProject({ action: 'create', title: '  带空格  ' })

    expect(output).toContain('已创建项目')
    expect(readProjects()[0]!.title).toBe('带空格')
  })

  it('update：改标题与论文目录', async () => {
    const p = createProject('旧标题')
    await runProject({ action: 'update', projectId: p.id, title: '新标题', paperDir: '/tmp/new' })

    const updated = readProjects().find((x) => x.id === p.id)!
    expect(updated.title).toBe('新标题')
    expect(updated.paperDir).toBe('/tmp/new')
  })

  it('update：不提供任何字段时明确拒绝，不产生空写', async () => {
    const p = createProject('项目')
    const { output } = await runProject({ action: 'update', projectId: p.id })

    expect(output).toContain('至少提供')
    expect(readProjects()[0]!.title).toBe('项目')
  })
})

describe('project 工具：删除（破坏性动作）', () => {
  it('确认卡 summary 必须以「删除」开头（全权档下才不会被静默放行）', async () => {
    const p = createProject('待删项目')
    const { requests } = await runProject({ action: 'delete', projectId: p.id }, false)

    expect(requests).toHaveLength(1)
    expect(requests[0]!.summary.startsWith('删除')).toBe(true)
  })

  it('拒绝时项目保留', async () => {
    const p = createProject('保留项目')
    await runProject({ action: 'delete', projectId: p.id }, false)

    expect(readProjects()).toHaveLength(1)
  })

  it('批准后删除项目，并级联清理论文中的 projectIds', async () => {
    const p = createProject('会被删的项目')
    const other = createProject('无关项目')
    seedPaper('1512.03385', [p.id, other.id])

    await runProject({ action: 'delete', projectId: p.id })

    expect(readProjects().map((x) => x.id)).toEqual([other.id])
    const paper = getStoreValue<Record<string, PaperRecord>>(PAPERS_KEY)!['1512.03385']!
    expect(paper.projectIds).toEqual([other.id])
  })
})
