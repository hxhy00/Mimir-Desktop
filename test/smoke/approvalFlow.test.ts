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
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { MimirFsBackend } from '../../electron/agent/fsBackend'
import {
  setApprovalSender,
  settleApproval,
  type ApprovalRequest
} from '../../electron/agent/approval'
import { savePolicyFromRenderer } from '../../electron/agent/permissionService'
import { testRootPath } from '../stubs/store'

/**
 * 自动应答器：记录收到的批准请求，并按策略自动裁决。
 * 用 setApprovalSender 安装「假渲染层」，从而无需 GUI 即可跑通批准链路。
 * @param opts.remember 模拟用户点「允许并记住此目录」
 */
function installAutoResponder(
  policy: (req: ApprovalRequest) => boolean,
  opts?: { remember?: boolean }
): {
  seen: ApprovalRequest[]
  restore: () => void
} {
  const seen: ApprovalRequest[] = []
  setApprovalSender((req) => {
    seen.push(req)
    // 模拟渲染层异步回填（三态：拒绝 / 允许一次 / 允许并记住）
    queueMicrotask(() => settleApproval(req.id, policy(req), opts?.remember === true))
  })
  return {
    seen,
    restore: () => setApprovalSender(() => undefined as never)
  }
}

/** 把权限策略重置为默认档（避免用例之间互相污染允许列表）。 */
function resetPolicy(): void {
  savePolicyFromRenderer({
    sandbox: 'workspace-write',
    askInsideSpace: false,
    allowedWriteRoots: [],
    allowedReadRoots: []
  })
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
  // 权限策略在 store 里是持久的（含「允许并记住」攒下的目录），逐用例重置以免互相影响。
  resetPolicy()
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

  // 说明：这里曾有一条「用假定时器验证超时按拒绝」的用例，已删除。
  // 原因：它同时依赖**真实磁盘 I/O**（fsBackend.write 内部先读原文件）与**假定时器**，
  // 两套时钟的完成时机无法互相保证，容易挂到 testTimeout。
  // 该契约已由 `test/unit/approval.test.ts` 直接对 requireUserApproval 确定性覆盖：
  // `超时（${approvalTimeoutMs}ms）未回填 → 按拒绝处理，不永久挂死`。
  // 本文件保留上面那条「无人应答 → 请求送达且不落盘」，负责文件后端这一侧的集成验证。
  //
  // 订正（原注释曾把「全量跑红」归因于这条定时器用例，实为误判）：
  // 真正的「单文件跑绿、全量跑红」根因是**跨测试文件的策略泄漏** —— 内存 store 是模块级
  // 单例，本文件把 sandbox 抬到 danger-full-access 后，后续文件（liveAgent）会读到残留
  // 策略，导致空间外读取被静默放行。已由 test/setup/resetState.ts 全局 afterEach 收口，
  // 且本文件的控制平面用例用 try/finally 自行复原。

  // ── 权限矩阵（沙箱档位 + 允许列表）──────────────────────────────────────

  it('默认档：科研空间内写盘免批准（不再逐次打扰）', async () => {
    const inside = join(testRootPath(), 'space-note.md')
    const responder = installAutoResponder(() => false)
    await backend.write(inside, '内容')
    expect(responder.seen).toHaveLength(0)
    expect(readFileSync(inside, 'utf8')).toBe('内容')
    responder.restore()
    rmSync(inside, { force: true })
  })

  it('只读档：写盘被策略直接拒绝，且**不弹卡**（策略性拒绝不该打扰用户）', async () => {
    savePolicyFromRenderer({ sandbox: 'read-only' })
    const target = join(workDir, 'ro.md')
    const responder = installAutoResponder(() => true)
    const out = (await backend.write(target, 'x')) as unknown as { error?: string }
    expect(existsSync(target)).toBe(false)
    expect(out.error).toContain('只读档')
    expect(responder.seen).toHaveLength(0)
    responder.restore()
  })

  it('「允许并记住」→ 该目录后续写盘不再弹卡（批准疲劳的真正解法）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mimir-remember-'))
    try {
      const responder = installAutoResponder(() => true, { remember: true })
      const first = join(dir, 'a.md')
      await backend.write(first, 'x')
      expect(responder.seen).toHaveLength(1) // 第一次：弹卡
      expect(existsSync(first)).toBe(true)

      const second = join(dir, 'b.md')
      await backend.write(second, 'y')
      expect(responder.seen).toHaveLength(1) // 第二次：已记住该目录 → 不再弹卡
      expect(existsSync(second)).toBe(true)
      responder.restore()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('控制平面即使在全权档下也照样硬拒绝，且不弹卡（不给绕过机会）', async () => {
    // 本用例会把策略抬到全权档：必须自己收尾（不依赖「下一条用例的 beforeEach 会重置」），
    // 否则策略泄漏到后续测试文件 → 那里空间外的读会被全权档静默放行，断言莫名失败。
    savePolicyFromRenderer({ sandbox: 'danger-full-access' })
    try {
      const responder = installAutoResponder(() => true, { remember: true })
      const target = join(homedir(), '.mimir', 'tamper.json')
      const out = (await backend.write(target, 'x')) as unknown as { error?: string }
      expect(out.error).toContain('控制平面')
      expect(responder.seen).toHaveLength(0)
      responder.restore()
      expect(existsSync(target)).toBe(false)
    } finally {
      resetPolicy()
    }
  })
})
