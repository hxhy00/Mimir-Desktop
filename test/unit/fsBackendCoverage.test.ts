/**
 * 文件后端 / 只读目录工具 / wiki 笔记 的**权限收口**回归测试。
 *
 * 锁定的四类事故（都是「权限体系被绕过」而非功能缺陷）：
 *  1. MimirFsBackend 只重写了 5 个方法 —— ls / glob / grep / uploadFiles / downloadFiles
 *     直连基类，模型换个工具就能读写任意路径，权限矩阵形同虚设；
 *  2. write 在 authorize **之前**无条件 readFile —— 未授权路径（含控制平面）被先读一遍；
 *  3. read_dir 把 `deny` 当成放行 —— 只读工具反而成了绕过口；
 *  4. wiki_note 是唯一没有审批卡、没有空间校验、且直接 writeFile 的写工具。
 *
 * 这里不测「允许时能读到什么」（那是 happy path），只测**拒绝是否真的拦得住**：
 * 断言一律是「返回了可读的拒绝原因」+「底层磁盘/基类一次都没被调用」。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  /** 基类（deepagents FilesystemBackend）替身：被调用即代表「真的要碰磁盘了」。 */
  base: {
    ls: vi.fn(),
    glob: vi.fn(),
    grep: vi.fn(),
    uploadFiles: vi.fn(),
    downloadFiles: vi.fn(),
    read: vi.fn(),
    readRaw: vi.fn(),
    write: vi.fn(),
    edit: vi.fn(),
    delete: vi.fn(),
  },
  /** 策略判定结果（evaluate 的返回值），每个用例自行设置。 */
  perm: { decision: 'deny' as 'allow' | 'deny' | 'ask' },
  /** 批准卡结果。 */
  approval: { allow: false, remember: false },
  /** fs/promises 替身：readFile 是本文件的关键观察点（授权前是否被偷读）。 */
  fsp: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    readdir: vi.fn(),
  },
}))

vi.mock('fs/promises', () => h.fsp)

vi.mock('../../electron/agent/permissionService', () => ({
  // 判定口径集中在这一个开关上：allow / deny / ask
  evaluate: () => h.perm.decision,
  // 不做 realpath，测试里路径本身就是规范形式
  canonicalize: (p: string) => p,
  recordResolution: () => {},
  rememberRoot: () => ({ ok: true, message: 'ok' }),
  recordAudit: () => {},
  loadPolicy: () => ({
    sandbox: 'workspace-write',
    askInsideSpace: false,
    allowedWriteRoots: [],
    allowedReadRoots: [],
  }),
}))

vi.mock('../../electron/agent/approval', () => ({
  requireUserApprovalDetailed: async () => ({ allow: h.approval.allow, remember: h.approval.remember }),
  requireBusinessApproval: async () => h.approval.allow,
  withApprovalSource: (_source: unknown, fn: () => unknown) => fn(),
}))

// 把基类换成替身：只要某个方法没被 MimirFsBackend 覆盖，调用就会落到这里被记下来。
vi.mock('deepagents', () => ({
  FilesystemBackend: class {
    cwd = process.cwd()
    constructor(_options?: unknown) {}
    async ls(p: string) {
      h.base.ls(p)
      return { files: [{ path: `${p}/a.txt` }] }
    }
    async read(p: string) {
      h.base.read(p)
      return { content: 'x' }
    }
    async readRaw(p: string) {
      h.base.readRaw(p)
      return { content: 'x' }
    }
    async write(p: string, c: string) {
      h.base.write(p, c)
      return { path: p }
    }
    async edit(p: string) {
      h.base.edit(p)
      return { path: p }
    }
    async delete(p: string) {
      h.base.delete(p)
      return { ok: true }
    }
    async glob(pattern: string, p: string) {
      h.base.glob(pattern, p)
      return { files: [{ path: `${p}/a.txt` }] }
    }
    async grep(pattern: string, p: string) {
      h.base.grep(pattern, p)
      return { matches: [{ path: `${p}/a.txt`, line: 1, text: 'x' }] }
    }
    async uploadFiles(files: Array<[string, Uint8Array]>) {
      h.base.uploadFiles(files)
      return files.map(([path]) => ({ path, error: null }))
    }
    async downloadFiles(paths: string[]) {
      h.base.downloadFiles(paths)
      return paths.map((path) => ({ path, content: new Uint8Array([1]), error: null }))
    }
  },
}))

const { MimirFsBackend } = await import('../../electron/agent/fsBackend')
const { readDirTool } = await import('../../electron/agent/tools/files')
const { wikiNoteTool } = await import('../../electron/agent/tools/wikiNote')

const backend = new MimirFsBackend()

beforeEach(() => {
  for (const fn of Object.values(h.base)) fn.mockReset()
  h.fsp.readFile.mockReset()
  h.fsp.writeFile.mockReset()
  h.fsp.mkdir.mockReset()
  h.fsp.readdir.mockReset()
  h.fsp.readFile.mockRejectedValue(new Error('ENOENT'))
  h.fsp.writeFile.mockResolvedValue(undefined)
  h.fsp.mkdir.mockResolvedValue(undefined)
  h.fsp.readdir.mockResolvedValue([])
  h.perm.decision = 'deny'
  h.approval.allow = false
  h.approval.remember = false
})

describe('MimirFsBackend：列举/检索/批量读写必须过权限（此前的绕过口）', () => {
  it('ls 被拒绝时不触达基类', async () => {
    const out = await backend.ls('/outside/dir')
    expect(out.error).toContain('已拒绝')
    expect(h.base.ls).not.toHaveBeenCalled()
  })

  it('glob 被拒绝时不触达基类（递归遍历的危害面更大）', async () => {
    const out = await backend.glob('**/*.ts', '/outside/dir')
    expect(out.error).toContain('已拒绝')
    expect(h.base.glob).not.toHaveBeenCalled()
  })

  it('grep 被拒绝时不触达基类（会读出整棵子树的文件内容）', async () => {
    const out = await backend.grep('secret', '/outside/dir')
    expect(out.error).toContain('已拒绝')
    expect(h.base.grep).not.toHaveBeenCalled()
  })

  it('grep 不传目录时仍按基类口径（默认 /）授权，不放任成免检', async () => {
    const out = await backend.grep('secret')
    expect(out.error).toContain('已拒绝')
    expect(h.base.grep).not.toHaveBeenCalled()
  })

  it('uploadFiles 被拒绝的文件不落盘，且逐项给出 permission_denied', async () => {
    const out = await backend.uploadFiles([
      ['/outside/a.txt', new Uint8Array([1])],
      ['/outside/b.txt', new Uint8Array([2])],
    ])
    expect(out).toHaveLength(2)
    expect(out.every((r) => r.error === 'permission_denied')).toBe(true)
    expect(h.base.uploadFiles).not.toHaveBeenCalled()
  })

  it('downloadFiles 被拒绝时返回空内容 + permission_denied，不读磁盘', async () => {
    const out = await backend.downloadFiles(['/outside/a.txt'])
    expect(out[0].content).toBeNull()
    expect(out[0].error).toBe('permission_denied')
    expect(h.base.downloadFiles).not.toHaveBeenCalled()
  })

  it('放行时确实落到基类（防止「为了拦住而把正常路径也一起关掉」）', async () => {
    h.perm.decision = 'allow'
    const ls = await backend.ls('/space/dir')
    expect(ls.error).toBeUndefined()
    expect(ls.files?.[0].path).toBe('/space/dir/a.txt')
    expect(h.base.ls).toHaveBeenCalledWith('/space/dir')

    const dl = await backend.downloadFiles(['/space/a.txt'])
    expect(dl[0].error).toBeNull()
    expect(h.base.downloadFiles).toHaveBeenCalledWith(['/space/a.txt'])
  })

  it('ask 被用户拒绝时同样不触达基类', async () => {
    h.perm.decision = 'ask'
    h.approval.allow = false
    const out = await backend.glob('**/*.md', '/outside/dir')
    expect(out.error).toContain('已取消')
    expect(h.base.glob).not.toHaveBeenCalled()
  })
})

describe('MimirFsBackend.write：授权通过后才允许读磁盘现状', () => {
  it('写入被拒绝时一次都不读目标文件（原实现会先 readFile）', async () => {
    const out = await backend.write('/outside/a.md', 'NEW')
    expect(out.error).toContain('已拒绝')
    expect(h.fsp.readFile).not.toHaveBeenCalled()
    expect(h.base.write).not.toHaveBeenCalled()
  })

  it('授权通过后读到与待写内容一致时走幂等短路，不重复落盘', async () => {
    h.perm.decision = 'allow'
    h.fsp.readFile.mockResolvedValue('SAME')
    const out = await backend.write('/space/a.md', 'SAME')
    expect(out.path).toBe('/space/a.md')
    expect(h.fsp.readFile).toHaveBeenCalledTimes(1)
    expect(h.base.write).not.toHaveBeenCalled()
  })

  it('授权通过后内容不同则正常落盘', async () => {
    h.perm.decision = 'allow'
    h.fsp.readFile.mockResolvedValue('OLD')
    await backend.write('/space/a.md', 'NEW')
    expect(h.base.write).toHaveBeenCalledWith('/space/a.md', 'NEW')
  })
})

describe('read_dir：deny 必须拒绝而不是放行', () => {
  it('策略判定为 deny 时不列目录，并返回明确拒绝原因', async () => {
    h.perm.decision = 'deny'
    const out = String(await readDirTool.invoke({ dir: '/outside/dir' }))
    expect(out).toContain('已拒绝')
    expect(h.fsp.readdir).not.toHaveBeenCalled()
  })

  it('ask 被用户拒绝时也不列目录', async () => {
    h.perm.decision = 'ask'
    h.approval.allow = false
    const out = String(await readDirTool.invoke({ dir: '/outside/dir' }))
    expect(out).toContain('已取消')
    expect(h.fsp.readdir).not.toHaveBeenCalled()
  })

  it('放行时照常列出（防过度拦截）', async () => {
    h.perm.decision = 'allow'
    h.fsp.readdir.mockResolvedValue([{ name: 'a.md', isDirectory: () => false, isFile: () => true }])
    const out = String(await readDirTool.invoke({ dir: '/space/dir' }))
    expect(out).toContain('a.md')
    expect(h.fsp.readdir.mock.calls[0]?.[0]).toBe('/space/dir')
  })
})

describe('wiki_note：补上权限矩阵、审批卡与空间校验', () => {
  it('落盘权限被拒绝时不写文件', async () => {
    h.perm.decision = 'deny'
    h.approval.allow = true
    const out = String(await wikiNoteTool.invoke({ title: 'T', content: 'C' }))
    expect(out).toContain('已拒绝')
    expect(h.fsp.writeFile).not.toHaveBeenCalled()
  })

  it('审批卡被拒绝时不写文件', async () => {
    h.perm.decision = 'allow'
    h.approval.allow = false
    const out = String(await wikiNoteTool.invoke({ title: 'T', content: 'C' }))
    expect(out).toContain('已取消')
    expect(h.fsp.writeFile).not.toHaveBeenCalled()
  })

  it('权限放行且用户批准后写入空间 wiki 目录', async () => {
    h.perm.decision = 'allow'
    h.approval.allow = true
    const out = String(await wikiNoteTool.invoke({ title: 'T', content: 'C' }))
    expect(out).toContain('笔记已保存到')
    expect(h.fsp.writeFile).toHaveBeenCalledTimes(1)
    const [writtenPath] = h.fsp.writeFile.mock.calls[0] as unknown as [string, string]
    expect(writtenPath).toContain('wiki')
    expect(writtenPath.endsWith('T.md')).toBe(true)
  })
})
