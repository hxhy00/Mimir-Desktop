/**
 * 批准卡机制单元测试：无发送器时保守放行、回填生效、超时按拒绝、并发互不干扰。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  requireUserApproval,
  setApprovalSender,
  settleApproval,
  approvalTimeoutMs,
  type ApprovalRequest
} from '../../electron/agent/approval'

const restorers: Array<() => void> = []

afterEach(() => {
  while (restorers.length > 0) restorers.pop()?.()
  vi.useRealTimers()
})

/** 安装一个捕获请求的 sender（不回填，由测试手动控制）。 */
function captureSender(): ApprovalRequest[] {
  const seen: ApprovalRequest[] = []
  setApprovalSender((req) => seen.push(req))
  restorers.push(() => setApprovalSender(() => undefined as never))
  return seen
}

describe('approval：副作用工具的用户确认握手', () => {
  it('无发送器（默认状态，无窗口）时保守放行，避免阻塞 Agent', async () => {
    // 初始 sender 为 null（模块级默认）——本用例不调用 setApprovalSender
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const allow = await requireUserApproval({ tool: 'write_file', summary: '写文件' })

    expect(allow).toBe(true)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('回填 true → 放行', async () => {
    const seen = captureSender()
    const pending = requireUserApproval({ tool: 'write_file', summary: '写文件' })
    expect(seen).toHaveLength(1)
    settleApproval(seen[0].id, true)
    await expect(pending).resolves.toBe(true)
  })

  it('回填 false → 拒绝', async () => {
    const seen = captureSender()
    const pending = requireUserApproval({ tool: 'delete', summary: '删除' })
    settleApproval(seen[0].id, false)
    await expect(pending).resolves.toBe(false)
  })

  it(`超时（${approvalTimeoutMs}ms）未回填 → 按拒绝处理，不永久挂死`, async () => {
    vi.useFakeTimers()
    const seen = captureSender()
    const pending = requireUserApproval({ tool: 'write_file', summary: '写文件' })
    expect(seen).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(approvalTimeoutMs + 1)
    await expect(pending).resolves.toBe(false)
  })

  it('并发多个 pending 各自独立裁决', async () => {
    const seen = captureSender()
    const a = requireUserApproval({ tool: 'write_file', summary: 'A' })
    const b = requireUserApproval({ tool: 'delete', summary: 'B' })
    expect(seen).toHaveLength(2)

    settleApproval(seen[0].id, true)
    settleApproval(seen[1].id, false)

    await expect(a).resolves.toBe(true)
    await expect(b).resolves.toBe(false)
  })

  it('对未知 id 回填是安全的（不抛错、不影响其它请求）', async () => {
    const seen = captureSender()
    const pending = requireUserApproval({ tool: 'write_file', summary: 'X' })
    expect(() => settleApproval('not-a-real-id', true)).not.toThrow()
    settleApproval(seen[0].id, true)
    await expect(pending).resolves.toBe(true)
  })

  it('请求带有唯一 id 与时间戳（供渲染层去重/排序）', async () => {
    const seen = captureSender()
    const p1 = requireUserApproval({ tool: 'a', summary: '1' })
    const p2 = requireUserApproval({ tool: 'b', summary: '2' })
    expect(seen[0].id).not.toBe(seen[1].id)
    expect(seen[0].at).toBeGreaterThan(0)
    settleApproval(seen[0].id, true)
    settleApproval(seen[1].id, true)
    await Promise.all([p1, p2])
  })
})
