/**
 * read_dir 的路径展开测试。
 *
 * 背景（真实事故）：用户说「私钥在我本地 ssh 文件夹中」，agent 调
 * `read_dir({ dir: '~/.ssh' })`，而工具当时用 `resolve(dir)` 直接解析，
 * 得到 `<cwd>/~/.ssh` → ENOENT。agent 把这次失败误判为「路径不精确」，
 * 于是后续轮次反复向用户索要绝对路径，交互退化成「说一句做一句」。
 *
 * 因此这里锁定两条不变量：
 *  1. `~` / `~/x` 必须展开为真实主目录，不得拼接当前工作目录；
 *  2. 相对路径仍按 cwd 解析（不改变既有语义）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { homedir } from 'os'
import { resolve } from 'path'

const readdirMock = vi.fn()
const approvalMock = vi.fn()

vi.mock('fs/promises', () => ({
  readdir: (...args: unknown[]) => readdirMock(...args),
}))
vi.mock('../../electron/agent/approval', () => ({
  requireUserApprovalDetailed: (...args: unknown[]) => approvalMock(...args),
}))
vi.mock('../../electron/agent/permissionService', () => ({
  evaluate: () => 'allow',
  recordResolution: () => {},
  rememberRoot: () => ({ ok: true }),
}))

const { readDirTool } = await import('../../electron/agent/tools/files')

/** 取本次 readdir 实际收到的目录参数。 */
function listedPath(): string {
  return String(readdirMock.mock.calls[0]?.[0])
}

describe('read_dir 路径展开', () => {
  beforeEach(() => {
    readdirMock.mockReset()
    approvalMock.mockReset()
    readdirMock.mockResolvedValue([])
  })

  it('~ 展开为主目录', async () => {
    await readDirTool.invoke({ dir: '~' })
    expect(listedPath()).toBe(resolve(homedir()))
    expect(listedPath()).not.toContain('~')
  })

  it('~/.ssh 展开为主目录下的 .ssh（本次事故的直接回归）', async () => {
    await readDirTool.invoke({ dir: '~/.ssh' })
    expect(listedPath()).toBe(resolve(homedir(), '.ssh'))
    // 关键回归点：绝不能再拼出 <cwd>/~/.ssh
    expect(listedPath()).not.toContain('~')
  })

  it('~ 后带多级子路径同样展开', async () => {
    await readDirTool.invoke({ dir: '~/a/b' })
    expect(listedPath()).toBe(resolve(homedir(), 'a', 'b'))
  })

  it('绝对路径原样解析，不受影响', async () => {
    await readDirTool.invoke({ dir: '/tmp/some-dir' })
    expect(listedPath()).toBe('/tmp/some-dir')
  })

  it('相对路径仍按 cwd 解析（既有语义不回归）', async () => {
    await readDirTool.invoke({ dir: 'some-dir' })
    expect(listedPath()).toBe(resolve('some-dir'))
  })

  it('返回列表时会回显展开后的真实目录', async () => {
    readdirMock.mockResolvedValue([
      { name: 'id_rsa', isDirectory: () => false, isFile: () => true },
      { name: 'config', isDirectory: () => false, isFile: () => true },
    ])
    const out = String(await readDirTool.invoke({ dir: '~/.ssh' }))
    expect(out).toContain(resolve(homedir(), '.ssh'))
    expect(out).toContain('id_rsa')
  })

  it('空 dir 仍然拒绝', async () => {
    const out = String(await readDirTool.invoke({ dir: '   ' }))
    expect(out).toContain('dir 不能为空')
    expect(readdirMock).not.toHaveBeenCalled()
  })
})
