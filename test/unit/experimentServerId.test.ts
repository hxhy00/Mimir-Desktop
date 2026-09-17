/**
 * P0-4 单测：实验工具对 `serverId` 的外键校验。
 *
 * 背景（同一套系统两种标准的修正）：`libraryService.updatePaper` 会校验 projectId 是否存在，
 * 而 `experiments.ts` 原先对 serverId **不校验**——随便传一个不存在的 id 都照写，
 * 造成「论文的 projectIds 有外键约束、实验的 serverId 没有」的双标准。
 *
 * 本文件锁定修正后的行为：
 * 1. create / update 传不存在的 serverId → 被拒，并列出可用服务器；
 * 2. create / update 传存在的 serverId（id 或名称均可）→ 正常写入；
 * 3. 不传 serverId / 传空串（update 清空）→ 不受影响，仍可正常写入。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { setApprovalSender, settleApproval, type ApprovalRequest } from '../../electron/agent/approval'
import { experimentTool } from '../../electron/agent/tools/experiments'
import { createServer, listServers } from '../../electron/servers/serversService'
import { getStoreValue } from '../../electron/library/store'

const EXPERIMENTS_KEY = 'experiments:list'

interface ExpRow {
  id: string
  name: string
  serverId?: string
}

function readExperiments(): ExpRow[] {
  return getStoreValue<ExpRow[]>(EXPERIMENTS_KEY) ?? []
}

/** 捕获批准卡并放行，返回工具输出。 */
async function runExperiment(args: Record<string, unknown>): Promise<string> {
  const requests: ApprovalRequest[] = []
  setApprovalSender((req) => requests.push(req))
  const promise = experimentTool.invoke(args as never)
  await new Promise((r) => setTimeout(r, 0))
  for (const req of requests) settleApproval(req.id, true)
  return String(await promise)
}

afterEach(() => {
  setApprovalSender(() => undefined as never)
})

describe('experiment 工具：serverId 外键校验（create）', () => {
  it('传不存在的 serverId 被拒，并列出可用服务器', async () => {
    createServer({ name: 'A100 训练机', host: '10.0.0.21' })

    const output = await runExperiment({ action: 'create', name: '实验甲', serverId: 'no-such-server' })

    expect(output).toContain('关联服务器')
    expect(output).toContain('不存在')
    expect(output).toContain('A100 训练机')
    expect(readExperiments()).toHaveLength(0)
  })

  it('没有任何服务器时，错误文案给出可操作指引', async () => {
    const output = await runExperiment({ action: 'create', name: '实验乙', serverId: 'whatever' })

    expect(output).toContain('不存在')
    expect(output).toContain('尚未注册任何服务器')
    expect(readExperiments()).toHaveLength(0)
  })

  it('传存在的 serverId（用 id）正常写入', async () => {
    const s = createServer({ name: '目标机器', host: '10.0.0.22' })

    const output = await runExperiment({ action: 'create', name: '实验丙', serverId: s.id })

    expect(output).toContain('已创建实验')
    expect(readExperiments()[0]!.serverId).toBe(s.id)
  })

  it('传存在的服务器名称同样被接受（与 server 工具一致的指代语义）', async () => {
    createServer({ name: '按名称指代的机器', host: '10.0.0.23' })

    const output = await runExperiment({ action: 'create', name: '实验丁', serverId: '按名称指代的机器' })

    expect(output).toContain('已创建实验')
    const created = readExperiments().find((e) => e.name === '实验丁')!
    // findServer 命中后按名称原样写入（保持与用户输入一致）
    expect(created.serverId).toBe('按名称指代的机器')
  })

  it('不传 serverId 时照常创建（校验不应误伤可选字段）', async () => {
    const output = await runExperiment({ action: 'create', name: '无关联实验' })

    expect(output).toContain('已创建实验')
    expect(readExperiments()[0]!.serverId).toBeUndefined()
  })
})

describe('experiment 工具：serverId 外键校验（update）', () => {
  it('update 传不存在的 serverId 被拒，原记录不变', async () => {
    createServer({ name: '存在的机器', host: '10.0.0.30' })
    await runExperiment({ action: 'create', name: '待更新实验' })
    const target = readExperiments()[0]!

    const output = await runExperiment({ action: 'update', id: target.id, serverId: 'ghost-server' })

    expect(output).toContain('不存在')
    expect(readExperiments()[0]!.serverId).toBeUndefined()
  })

  it('update 传存在的 serverId 正常写入', async () => {
    const s = createServer({ name: '新绑机器', host: '10.0.0.31' })
    await runExperiment({ action: 'create', name: '待绑实验' })
    const target = readExperiments()[0]!

    const output = await runExperiment({ action: 'update', id: target.id, serverId: s.id })

    expect(output).toContain('已更新实验')
    expect(readExperiments()[0]!.serverId).toBe(s.id)
  })

  it('update 传空串表示清空关联，不走存在性校验', async () => {
    const s = createServer({ name: '将被解绑', host: '10.0.0.32' })
    await runExperiment({ action: 'create', name: '解绑实验', serverId: s.id })
    const target = readExperiments()[0]!
    expect(target.serverId).toBe(s.id)

    const output = await runExperiment({ action: 'update', id: target.id, serverId: '' })

    expect(output).toContain('已更新实验')
    expect(readExperiments()[0]!.serverId).toBeUndefined()
  })
})

describe('experiment 工具：与服务器注册表同源', () => {
  it('界面/agent 新增服务器后，实验立刻能用它做关联（读路径统一）', async () => {
    createServer({ name: '后加进来的机器', host: '10.0.0.40' })
    expect(listServers()).toHaveLength(1)

    const output = await runExperiment({ action: 'create', name: '同源验证实验', serverId: '后加进来的机器' })

    expect(output).toContain('已创建实验')
  })
})
