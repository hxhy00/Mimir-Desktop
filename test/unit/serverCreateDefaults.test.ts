/**
 * `server` 工具 create 的「不追问」契约回归。
 *
 * 事故：用户说「帮我加台服务器，ssh root@119.3.210.1，22 端口」——信息已足够建一条可用记录，
 * 但 create 原先把 name 当必填硬性拒绝，agent 只能停下来问「显示名是什么」，
 * 体感是「说一句做一句」。同时 keyPath 的 `~` 未展开会原样落库，导致 probeServer 读私钥
 * 必然失败、且失败延迟到探测时才暴露。
 *
 * 这里直接调用真实工具（不是 mock），断言：
 *   - 只给 host 也能建成，显示名自动为 user@host；
 *   - `~` 写法落库前已展开成真实主目录；
 *   - 真缺 host 时才允许要求补充。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { homedir } from 'os'

/** 捕获落库记录的内存实现，替换 serversService 以避免触碰真实配置文件。 */
const stored: Array<Record<string, unknown>> = []
let seq = 0

vi.mock('../../electron/servers/serversService', () => ({
  listServers: () => stored,
  findServer: (id: string) => stored.find((s) => s.id === id || s.name === id),
  createServer: (input: Record<string, unknown>) => {
    seq += 1
    const record = { id: `srv-${String(seq)}`, port: 22, user: 'root', ...input }
    stored.push(record)
    return record
  },
  updateServer: (id: string, patch: Record<string, unknown>) => {
    const idx = stored.findIndex((s) => s.id === id)
    const next = { ...stored[idx], ...patch }
    stored[idx] = next
    return next
  },
  deleteServer: (id: string) => {
    const idx = stored.findIndex((s) => s.id === id)
    stored.splice(idx, 1)
  },
}))

// 审批在测试里直接放行：本测试关注的是字段语义，不是审批卡（后者另有用例覆盖）。
vi.mock('../../electron/agent/approval', () => ({
  requireBusinessApproval: async () => true,
}))

import { serverTool } from '../../electron/agent/tools/servers'

beforeEach(() => {
  stored.length = 0
  seq = 0
})

describe('server 工具 create：能建就直接建，不因可选字段追问', () => {
  it('只给 host：成功创建，显示名自动为 user@host（不再要求用户补 name）', async () => {
    const result = await serverTool.invoke({ action: 'create', host: '119.3.210.1', user: 'root', port: 22 })

    expect(result).toContain('已新增服务器')
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ name: 'root@119.3.210.1', host: '119.3.210.1', user: 'root', port: 22 })
  })

  it('只给 host 且不带 user：user 缺省 root，显示名 root@host', async () => {
    const result = await serverTool.invoke({ action: 'create', host: '10.0.0.8' })

    expect(result).toContain('已新增服务器')
    expect(stored[0]).toMatchObject({ name: 'root@10.0.0.8', user: 'root', port: 22 })
  })

  it('keyPath 写 ~/.ssh/id_rsa：落库前已展开为真实主目录（避免探测时才发现读不到私钥）', async () => {
    await serverTool.invoke({ action: 'create', host: '119.3.210.1', keyPath: '~/.ssh/id_rsa' })

    expect(stored[0]?.keyPath).toBe(`${homedir()}/.ssh/id_rsa`)
    // 绝不能把 ~ 原样落库
    expect(String(stored[0]?.keyPath)).not.toContain('~')
  })

  it('真缺 host：才允许要求补充（host 是唯一真正的必填项）', async () => {
    const result = await serverTool.invoke({ action: 'create' })

    expect(result).toContain('host 不能为空')
    expect(stored).toHaveLength(0)
  })

  it('用户给了中文显示名：尊重用户输入，不覆盖成 user@host', async () => {
    await serverTool.invoke({ action: 'create', host: '119.3.210.1', name: '训练机' })

    expect(stored[0]?.name).toBe('训练机')
  })
})

describe('server 工具 update：keyPath 的 ~ 展开与清空语义', () => {
  it('update 传 ~ 路径：展开后落库', async () => {
    await serverTool.invoke({ action: 'create', host: '1.2.3.4' })
    await serverTool.invoke({ action: 'update', serverId: 'srv-1', keyPath: '~/.ssh/id_ed25519' })

    expect(stored[0]?.keyPath).toBe(`${homedir()}/.ssh/id_ed25519`)
  })

  it('update 传空串：是「清空」语义，不能被展开逻辑吃掉', async () => {
    await serverTool.invoke({ action: 'create', host: '1.2.3.4', keyPath: '~/.ssh/id_rsa' })
    await serverTool.invoke({ action: 'update', serverId: 'srv-1', keyPath: '' })

    expect(stored[0]?.keyPath).toBe('')
  })
})
