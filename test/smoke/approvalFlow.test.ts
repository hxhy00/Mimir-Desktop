/**
 * 无头冒烟测试 ②：批准卡 + 文件后端全链路（不弹 GUI）。
 *
 * 覆盖用户真实路径：模型要写文件 → MimirFsBackend.write → requireUserApproval
 * → IPC 推给渲染层 → 用户批准/拒绝 → 工具继续或取消。
 *
 * 测试里把「渲染层」换成一个自动应答器（setApprovalSender），
 * 因此可以无 GUI 地验证：
 *   - 批准 → 文件真实落盘
 *   - 拒绝 → 不落盘，且返回可读的取消文案（而非抛错中断整条 agent 图）
 *   - 科研空间内只读免批准；空间外只读需批准
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MimirFsBackend } from '../../electron/agent/fsBackend'
import {
  setApprovalSender,
  settleApproval,
  approvalTimeoutMs,
  type ApprovalRequest
} from '../../electron/agent/approval'
import { testRootPath } from '../stubs/store'

/**
 * 自动应答器：记录收到的批准请求，并按策略自动裁决。
 * 用 setApprovalSender 安装「假渲染层」，从而无需 GUI 即可跑通批准链路。
 */
function installAutoResponder(policy: (req: ApprovalRequest) => boolean): {
  seen: ApprovalRequest[]
  restore: () => void
} {
  const seen: ApprovalRequest[] = []
  setApprovalSender((req) => {
    seen.push(req)
    // 模拟渲染层异步回填
    queueMicrotask(() => settleApproval(req.id, policy(req)))
  })
  return {
    seen,
    restore: () => setApprovalSender(() => undefined as never)
  }
}

/** 重新挂载 sender 并清空可能残留的 pending（跨用例隔离）。 */
function setSender(fn: (req: ApprovalRequest) => void): void {
  setApprovalSender(fn)
}

let workDir: string
let backend: MimirFsBackend

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'mimir-fs-'))
  backend = new MimirFsBackend()
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('无头冒烟：文件后端 + 批准卡全链路', () => {
  it('写入获批 → 文件真实落盘，内容正确', async () => {
    const target = join(workDir, 'report.md')
    const responder = installAutoResponder(() => true)

    await backend.write(target, '# 调研结论\n\n内容正文。')

    expect(responder.seen).toHaveLength(1)
    expect(responder.seen[0].tool).toBe('write_file')
    expect(responder.seen[0].summary).toContain('report.md')
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target, 'utf8')).toContain('调研结论')

    responder.restore()
  })

  it('写入被拒 → 不落盘，返回可读取消文案（不抛错）', async () => {
    const target = join(workDir, 'blocked.md')
    const responder = installAutoResponder(() => false)

    const result = (await backend.write(target, 'should not be written')) as unknown as { error?: string }

    expect(existsSync(target)).toBe(false)
    expect(result.error).toBeTruthy()
    expect(result.error).toContain('已取消')

    responder.restore()
  })

  it('覆盖已有文件时，批准卡的 detail 会提示「整篇覆盖」并附现有内容开头', async () => {
    const target = join(workDir, 'existing.md')
    writeFileSync(target, '原有内容 ABCDEFG')
    const responder = installAutoResponder(() => true)

    await backend.write(target, '新内容')

    expect(responder.seen[0].detail).toContain('整篇覆盖')
    expect(responder.seen[0].detail).toContain('ABCDEFG')
    expect(readFileSync(target, 'utf8')).toBe('新内容')

    responder.restore()
  })

  it('读取科研空间内的文件 → 免批准（不弹卡）', async () => {
    const inside = join(testRootPath(), 'inside.txt')
    writeFileSync(inside, 'space content')
    const responder = installAutoResponder(() => false)

    const out = await backend.read(inside)

    expect(responder.seen).toHaveLength(0)
    expect(JSON.stringify(out)).toContain('space content')

    responder.restore()
  })

  it('读取科研空间外的文件 → 需批准；拒绝则返回取消文案', async () => {
    const outside = join(workDir, 'outside.txt')
    writeFileSync(outside, 'sensitive')
    const responder = installAutoResponder(() => false)

    const out = (await backend.read(outside)) as unknown as { content?: string }

    expect(responder.seen).toHaveLength(1)
    expect(responder.seen[0].tool).toBe('read_file')
    expect(out.content).toContain('已取消')

    responder.restore()
  })

  it('删除被拒 → 文件仍在', async () => {
    const target = join(workDir, 'keep.md')
    writeFileSync(target, 'x')
    const responder = installAutoResponder(() => false)

    await backend.delete(target)

    expect(existsSync(target)).toBe(true)
    responder.restore()
  })

  it('无人应答时，请求会送达渲染层且不落盘（超时按拒绝）', async () => {
    const target = join(workDir, 'timeout.md')
    const seen: ApprovalRequest[] = []
    setSender((req) => seen.push(req))

    const pending = backend.write(target, 'x')
    // 等一个微任务让请求送达渲染层
    await new Promise((r) => setTimeout(r, 10))
    expect(seen).toHaveLength(1)
    expect(seen[0].tool).toBe('write_file')

    // 手动回填以结束等待（超时的精确行为由 unit/approval.test.ts 用假定时器覆盖）
    settleApproval(seen[0].id, false)
    const out = (await pending) as unknown as { error?: string }
    expect(out.error).toContain('已取消')
    expect(existsSync(target)).toBe(false)
  })

  it('超时后按拒绝：用假定时器验证不会永久挂死', async () => {
    vi.useFakeTimers()
    try {
      const target = join(workDir, 'timeout2.md')
      setSender(() => undefined) // 收到请求但永不回填
      const pending = backend.write(target, 'x')
      await vi.advanceTimersByTimeAsync(approvalTimeoutMs + 1)
      const out = (await pending) as unknown as { error?: string }
      expect(out.error).toContain('已取消')
      expect(existsSync(target)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
