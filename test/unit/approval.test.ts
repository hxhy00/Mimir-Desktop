/**
 * 批准卡机制单元测试：无发送器时 Fail-Closed（默认拒绝）、回填生效、超时按拒绝、并发互不干扰、来源透传。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  requireUserApproval,
  setApprovalSender,
  resetApprovalSender,
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
  it('无发送器（无窗口/通道未注册）时 Fail-Closed：默认拒绝并告警', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    resetApprovalSender() // 确保回到「无通道」状态

    const allow = await requireUserApproval({ tool: 'write_file', summary: '写文件' })

    expect(allow).toBe(false)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('窗口销毁（resetApprovalSender）后，在途请求被拒绝而非放行', async () => {
    const seen = captureSender()
    const pending = requireUserApproval({ tool: 'write_file', summary: '写文件' })
    expect(seen).toHaveLength(1)

    resetApprovalSender()

    await expect(pending).resolves.toBe(false)
    restorers.pop()?.()
  })

  it('缺省来源视为主 agent；显式来源原样透传（C3）', async () => {
    const seen = captureSender()
    const a = requireUserApproval({ tool: 'write_file', summary: '主 agent 写盘' })
    const b = requireUserApproval({
      tool: 'write_file',
      summary: '子代理写盘',
      source: { origin: 'subagent', subagentId: 'paper-writer', subagentLabel: '论文写作员' }
    })
    expect(seen[0].source).toEqual({ origin: 'main' })
    expect(seen[1].source).toEqual({ origin: 'subagent', subagentId: 'paper-writer', subagentLabel: '论文写作员' })
    settleApproval(seen[0].id, true)
    settleApproval(seen[1].id, true)
    await Promise.all([a, b])
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
