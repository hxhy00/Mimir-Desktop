/**
 * P0-3b 单测：GPU 服务器工具（`server` 读写 + `server_status` 只读）。
 *
 * 覆盖三类关键行为：
 * 1. **凭据边界**（本工具存在的首要安全约束）：工具的输入 schema 里**没有** password；
 *    即使调用方硬塞一个 password，输出中也绝不能出现密码明文，库里也不该被写入；
 * 2. **破坏性动作识别**：delete 的确认卡 summary 必须以「删除」开头，
 *    否则全权档下 `isDestructiveApproval` 认不出来，会被静默放行；
 * 3. **与界面同源**：工具写入后，直接经 `serversService.listServers()`（界面/agent 共用读路径）
 *    能立刻读到 —— 证明写路径统一，没有整表覆盖竞态。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { homedir } from 'os'
import { resolve } from 'path'
import { setApprovalSender, settleApproval, type ApprovalRequest } from '../../electron/agent/approval'
import { serverTool, serverStatusTool } from '../../electron/agent/tools/servers'
import { listServers, createServer } from '../../electron/servers/serversService'

/** 捕获批准卡并回填结果，返回 [工具输出, 收到的批准卡列表]。 */
async function runServer(
  args: Record<string, unknown>,
  approve = true,
): Promise<{ output: string; requests: ApprovalRequest[] }> {
  const requests: ApprovalRequest[] = []
  setApprovalSender((req) => requests.push(req))
  const promise = serverTool.invoke(args as never)
  await new Promise((r) => setTimeout(r, 0))
  for (const req of requests) settleApproval(req.id, approve)
  return { output: String(await promise), requests }
}

afterEach(() => {
  setApprovalSender(() => undefined as never)
})

describe('server 工具：读取', () => {
  it('list：空列表给出可继续的提示', async () => {
    const { output } = await runServer({ action: 'list' })
    expect(output).toContain('暂未注册')
    expect(output).toContain('create')
  })

  it('list：列出 id / 名称 / 连接信息 / GPU 配置', async () => {
    createServer({ name: 'A100 训练机', host: '10.0.0.21', user: 'ubuntu', gpuCount: 8, gpuModel: 'A100 80G' })
    const { output } = await runServer({ action: 'list' })

    expect(output).toContain('A100 训练机')
    expect(output).toContain('ubuntu@10.0.0.21:22')
    expect(output).toContain('8x A100 80G')
  })

  it('get：支持用名称指代（不只有 id）', async () => {
    createServer({ name: '实验室机器', host: '192.168.1.5' })
    const { output } = await runServer({ action: 'get', serverId: '实验室机器' })

    expect(output).toContain('实验室机器')
    expect(output).toContain('192.168.1.5')
  })

  it('get：找不到时列出候选，而不是报错', async () => {
    createServer({ name: '唯一机器', host: '10.1.1.1' })
    const { output } = await runServer({ action: 'get', serverId: 'no-such' })

    expect(output).toContain('未找到服务器')
    expect(output).toContain('唯一机器')
  })
})

describe('server 工具：写入需批准', () => {
  it('create：用户拒绝时不落库', async () => {
    const { output } = await runServer({ action: 'create', name: '不该建的', host: '10.2.2.2' }, false)

    expect(output).toContain('已取消')
    expect(listServers()).toHaveLength(0)
  })

  it('create：批准后落库，能被 service 立刻读到（与界面同源）', async () => {
    const { output } = await runServer({ action: 'create', name: '新机器', host: '10.3.3.3', user: 'ubuntu' })

    expect(output).toContain('已新增服务器')
    const list = listServers()
    expect(list).toHaveLength(1)
    expect(list[0]!.name).toBe('新机器')
    expect(list[0]!.host).toBe('10.3.3.3')
  })

  it('create：缺少 host 时明确拒绝（host 是唯一真正的必填项）', async () => {
    expect((await runServer({ action: 'create', name: 'X' })).output).toContain('host 不能为空')
    expect(listServers()).toHaveLength(0)
  })

  it('create：只给 host 也能建（缺省 user=root / port=22 / 显示名自动生成）', async () => {
    // 本次事故的直接回归：用户只说「ssh root@119.3.210.1，22 端口」，
    // 信息已足够建一条可用记录，工具**不得**因为没有显示名而拒绝，
    // 否则 agent 只能回头追问「显示名是什么」——就是用户抱怨的「说一句做一句」。
    const { output } = await runServer({ action: 'create', host: '119.3.210.1' })

    expect(output).toContain('已新增服务器')
    const created = listServers()[0]!
    expect(created.host).toBe('119.3.210.1')
    expect(created.user).toBe('root')
    expect(created.port).toBe(22)
    // 缺省名由 user@host 生成，可事后 update 改名
    expect(created.name).toBe('root@119.3.210.1')
  })

  it('create：用户给了显示名就用用户的，不被缺省覆盖', async () => {
    await runServer({ action: 'create', host: '10.5.5.5', name: 'A100 训练机' })
    expect(listServers()[0]!.name).toBe('A100 训练机')
  })

  it('create：keyPath 的 ~ 展开为主目录（不得原样落库）', async () => {
    // 用户常说「私钥在我本地 ssh 文件夹」，agent 会填 ~/.ssh/id_rsa。
    // 原样落库会让后续 probeServer 读私钥失败，且失败要等到探测时才暴露。
    const { output } = await runServer({
      action: 'create',
      host: '10.6.6.6',
      keyPath: '~/.ssh/id_rsa',
    })

    expect(output).toContain('已新增服务器')
    const stored = listServers()[0]!.keyPath!
    expect(stored).toBe(resolve(homedir(), '.ssh/id_rsa'))
    expect(stored).not.toContain('~')
  })

  it('update：keyPath 同样展开 ~；空串仍是「清空」语义（不被展开吃掉）', async () => {
    const s = createServer({ name: '改密钥', host: '10.7.7.7' })

    await runServer({ action: 'update', serverId: s.id, keyPath: '~/.ssh/id_ed25519' })
    expect(listServers()[0]!.keyPath).toBe(resolve(homedir(), '.ssh/id_ed25519'))

    await runServer({ action: 'update', serverId: s.id, keyPath: '' })
    expect(listServers()[0]!.keyPath).toBeUndefined()
  })

  it('update：改名称与端口', async () => {
    const s = createServer({ name: '旧名', host: '10.0.0.9' })
    await runServer({ action: 'update', serverId: s.id, name: '新名', port: 2222 })

    const updated = listServers()[0]!
    expect(updated.name).toBe('新名')
    expect(updated.port).toBe(2222)
  })

  it('update：不提供任何字段时明确拒绝，不产生空写', async () => {
    const s = createServer({ name: '原样', host: '10.0.0.9' })
    const { output } = await runServer({ action: 'update', serverId: s.id })

    expect(output).toContain('至少提供')
    expect(listServers()[0]!.name).toBe('原样')
  })
})

describe('server 工具：删除（破坏性动作）', () => {
  it('确认卡 summary 必须以「删除」开头（全权档下才不会被静默放行）', async () => {
    const s = createServer({ name: '待删机器', host: '10.0.0.7' })
    const { requests } = await runServer({ action: 'delete', serverId: s.id }, false)

    expect(requests).toHaveLength(1)
    expect(requests[0]!.summary.startsWith('删除')).toBe(true)
  })

  it('拒绝时服务器保留', async () => {
    const s = createServer({ name: '保留机器', host: '10.0.0.7' })
    await runServer({ action: 'delete', serverId: s.id }, false)

    expect(listServers()).toHaveLength(1)
  })

  it('批准后从 service 中移除', async () => {
    const s = createServer({ name: '会被删的', host: '10.0.0.7' })
    const keep = createServer({ name: '留下的', host: '10.0.0.8' })

    await runServer({ action: 'delete', serverId: s.id })

    expect(listServers().map((x) => x.id)).toEqual([keep.id])
  })
})

describe('server 工具：凭据边界（安全约束）', () => {
  it('输入 schema 不接受 password —— 凭据不能进 agent 上下文', () => {
    // zod schema 的 shape 里不应存在 password 字段
    const shape = (serverTool as unknown as { schema: { shape: Record<string, unknown> } }).schema.shape
    expect(shape.password).toBeUndefined()
  })

  it('即使硬塞 password，也不会写进库、也不在输出里回显', async () => {
    const { output } = await runServer({
      action: 'create',
      name: '带密码的',
      host: '10.9.9.9',
      password: 'super-secret-123',
    })

    expect(output).not.toContain('super-secret-123')
    expect(listServers()[0]!.password).toBeUndefined()
  })

  it('list 输出不回显已配置的密码明文，只标注存在性', async () => {
    createServer({ name: '有密码的', host: '10.9.9.10', password: 'p@ssw0rd' })
    const { output } = await runServer({ action: 'list' })

    expect(output).not.toContain('p@ssw0rd')
    expect(output).toContain('已配置密码')
  })

  it('get 输出同样不回显密码明文', async () => {
    const s = createServer({ name: '有密码的2', host: '10.9.9.11', password: 'secret-xyz' })
    const { output } = await runServer({ action: 'get', serverId: s.id })

    expect(output).not.toContain('secret-xyz')
  })
})

describe('server_status 工具：只读探测', () => {
  it('无服务器时给出明确提示', async () => {
    const output = String(await serverStatusTool.invoke({} as never))
    expect(output).toContain('尚未注册')
  })

  it('指定不存在的 serverId 时列出可用项', async () => {
    createServer({ name: '某机器', host: '10.4.4.4' })
    const output = String(await serverStatusTool.invoke({ serverId: '不存在' } as never))

    expect(output).toContain('未找到服务器')
    expect(output).toContain('某机器')
  })
})
