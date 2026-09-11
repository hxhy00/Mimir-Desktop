/**
 * D1 子代理禁嵌套防火墙单元测试：委派工具不得落入子代理工具集。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  DELEGATION_TOOL_NAMES,
  isDelegationTool,
  assertNoDelegationTools,
  guardSubagentTools
} from '../../electron/agent/delegationFirewall'
import { WORKER_TOOL_CATALOG } from '../../electron/agent/subagentRegistry'

describe('delegationFirewall：D1 禁嵌套', () => {
  it('task（deepagents 委派工具）被识别为委派入口', () => {
    expect(isDelegationTool('task')).toBe(true)
    expect(isDelegationTool('arxiv_search')).toBe(false)
    expect(isDelegationTool('read_dir')).toBe(false)
  })

  it('工具集含委派工具时构建期抛错（Fail-Closed，不静默通过）', () => {
    expect(() =>
      assertNoDelegationTools('bad-worker', [{ name: 'arxiv_search' }, { name: 'task' }])
    ).toThrow(/嵌套委派|拓扑失控/)
    expect(() => assertNoDelegationTools('bad-worker', [{ name: 'task' }])).toThrow()
  })

  it('工具集不含委派工具时正常通过', () => {
    expect(() =>
      assertNoDelegationTools('ok-worker', [{ name: 'arxiv_search' }, { name: 'write_file' }])
    ).not.toThrow()
    expect(() => assertNoDelegationTools('empty', [])).not.toThrow()
  })

  it('运行期纵深防御：委派工具被包裹后调用返回拒绝文案、不真正执行', async () => {
    const realInvoke = vi.fn(async () => 'should-not-run')
    const fakeTask = { name: 'task', invoke: realInvoke }
    const normal = { name: 'arxiv_search', invoke: async () => 'results' }

    const [guardedTask, guardedNormal] = guardSubagentTools('lit', [fakeTask, normal])

    const rejected = await guardedTask.invoke({ description: 'x', subagent_type: 'paper' })
    expect(String(rejected)).toContain('禁止嵌套')
    expect(realInvoke).not.toHaveBeenCalled()
    expect(await guardedNormal.invoke({})).toBe('results')
  })

  it('生产白名单（WORKER_TOOL_CATALOG）不含任何委派工具（结构上无法嵌套）', () => {
    const offenders = WORKER_TOOL_CATALOG.filter((t) => isDelegationTool(t.id))
    expect(offenders).toEqual([])
  })

  it('委派工具名清单非空且包含 task（防止误删防护）', () => {
    expect(DELEGATION_TOOL_NAMES.length).toBeGreaterThan(0)
    expect(DELEGATION_TOOL_NAMES).toContain('task')
  })
})
