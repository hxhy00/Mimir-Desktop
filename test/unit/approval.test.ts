/**
 * 批准卡机制单元测试：无发送器时 Fail-Closed（默认拒绝）、回填生效、超时按拒绝、并发互不干扰、来源透传。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  requireUserApproval,
  requireUserApprovalDetailed,
  setApprovalDecider,
  setApprovalSender,
  resetApprovalSender,
  settleApproval,
  approvalTimeoutMs,
  isDestructiveApproval,
  wouldAutoApproveUnderFullAccess,
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

/**
 * 三态裁决（拒绝 / 允许一次 / 允许并记住）。
 *
 * 「记住」是解决**批准疲劳**的关键：只给「允许一次」会让同类动作反复弹卡，
 * 最终把人训练成无脑点是。因此这几条断言要守住两件事：
 * 1. `remember` 默认必须为 false（不能默默记忆，那等于偷偷放宽权限）；
 * 2. `remember` **不能在没有 allow 的情况下生效**（拒绝就是拒绝）。
 */
describe('approval：三态裁决', () => {
  it('允许一次 → allow=true 且 remember=false（默认不记忆）', async () => {
    const seen = captureSender()
    const p = requireUserApprovalDetailed({ tool: 'write_file', summary: 'x' })
    settleApproval(seen[0].id, true)
    await expect(p).resolves.toEqual({ allow: true, remember: false })
  })

  it('允许并记住 → allow=true 且 remember=true', async () => {
    const seen = captureSender()
    const p = requireUserApprovalDetailed({ tool: 'write_file', summary: 'x', rememberable: true })
    expect(seen[0].rememberable).toBe(true)
    settleApproval(seen[0].id, true, true)
    await expect(p).resolves.toEqual({ allow: true, remember: true })
  })

  it('拒绝时 remember 恒为 false（不能「拒绝但记住」）', async () => {
    const seen = captureSender()
    const p = requireUserApprovalDetailed({ tool: 'write_file', summary: 'x' })
    settleApproval(seen[0].id, false, true)
    await expect(p).resolves.toEqual({ allow: false, remember: false })
  })

  it('超时按拒绝，且不带 remember（Fail-Closed 在三态下同样成立）', async () => {
    vi.useFakeTimers()
    const seen = captureSender()
    const p = requireUserApprovalDetailed({ tool: 'write_file', summary: 'x' })
    expect(seen).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(approvalTimeoutMs + 1)
    await expect(p).resolves.toEqual({ allow: false, remember: false })
  })

  it('布尔便捷版只透出 allow（既有工具调用点无需改动）', async () => {
    const seen = captureSender()
    const p = requireUserApproval({ tool: 'write_file', summary: 'x' })
    settleApproval(seen[0].id, true, true)
    await expect(p).resolves.toBe(true)
  })

  it('setApprovalDecider：无人值守裁决器会真正结掉 pending（而不是只调用回调）', async () => {
    // 历史实现的缺陷：它只调用 fn、从不 settle → 请求一直挂到 120s 超时。
    // 这里用「不依赖假定时器」的方式断言它当场就返回。
    setApprovalDecider(() => true)
    restorers.push(() => setApprovalSender(() => undefined as never))
    await expect(requireUserApproval({ tool: 'write_file', summary: 'x' })).resolves.toBe(true)
  })
})

/**
 * 业务动作批准卡的档位感知（修复「设了全权档还反复弹卡」）。
 *
 * 背景：权限矩阵落地时只接管了文件读写，文献入库 / PPT 生成 / LaTeX 编译这类
 * 「业务副作用卡」在各工具里硬编码为无条件弹卡，完全不看沙箱档位——用户设全权档后
 * 仍被反复打断，档位形同虚设。
 *
 * 口径（对齐 Codex 的 danger-full-access：「除自我提权外不问」）：
 * - 全权档 + 非破坏性 → 自动放行（不弹卡）；
 * - 全权档 + 破坏性（删除/移除/清空）→ 照常弹卡（误删没有后悔药，风险不对称）；
 * - 其余档位 → 照常弹卡。
 */
describe('approval：业务卡的档位感知（全权档放行、删除除外）', () => {
  it('破坏性判定只看 summary 前缀：删除/移除/清空 为真，普通写盘为假', () => {
    expect(isDestructiveApproval({ tool: 'x', summary: '删除实验记录「A」' })).toBe(true)
    expect(isDestructiveApproval({ tool: 'x', summary: '移除图片附件' })).toBe(true)
    expect(isDestructiveApproval({ tool: 'x', summary: '清空该项目的标签' })).toBe(true)
    expect(isDestructiveApproval({ tool: 'paper_fetch', summary: '保存论文「X」到文献库' })).toBe(false)
  })

  it('破坏性判定不因 detail 里的解释性文字而误判（detail 提到"删除"不算）', () => {
    // 真实场景：latex 编译卡在 detail 里说明「不删除你的源文件」，
    // 若做全文关键词匹配就会把非破坏动作误判成破坏、错误地保留弹卡。
    expect(
      isDestructiveApproval({
        tool: 'latex_compile',
        summary: '编译论文为 PDF',
        detail: '将生成产物文件；不会删除或覆盖你的源文件。'
      })
    ).toBe(false)
  })

  it('wouldAutoApproveUnderFullAccess：全权档 + 非破坏性 → 自动放行', () => {
    expect(
      wouldAutoApproveUnderFullAccess(
        { tool: 'paper_fetch', summary: '保存论文「X」到文献库' },
        { sandbox: 'danger-full-access' }
      )
    ).toBe(true)
  })

  it('wouldAutoApproveUnderFullAccess：全权档 + 破坏性 → 不放行（仍弹卡）', () => {
    expect(
      wouldAutoApproveUnderFullAccess({ tool: 'x', summary: '删除论文「X」' }, { sandbox: 'danger-full-access' })
    ).toBe(false)
  })

  it('wouldAutoApproveUnderFullAccess：非全权档 + 非破坏性 → 不放行（仍弹卡）', () => {
    expect(
      wouldAutoApproveUnderFullAccess(
        { tool: 'paper_fetch', summary: '保存论文「X」到文献库' },
        { sandbox: 'workspace-write' }
      )
    ).toBe(false)
    expect(
      wouldAutoApproveUnderFullAccess({ tool: 'paper_fetch', summary: '保存论文' }, { sandbox: 'read-only' })
    ).toBe(false)
  })
})
