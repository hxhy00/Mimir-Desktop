/**
 * 防嵌套防火墙单元测试（D1）。
 *
 * 架构：**主 Agent 允许持有 `task`**（自主决定是否委派给能力域子代理，对齐 WorkBuddy / Trae），
 * 但**子代理不得再持有 `task`** —— 否则会形成「主 → 子 → 孙 → …」的递归委派，拓扑与成本失控。
 *
 * 因此约束是「限制嵌套深度」（`DELEGATION_ALLOWED_DEPTH`）而非「一律禁止」：
 * 构建期校验（assertNoDelegationTools）与运行期包裹（guardSubagentTools）都按 depth 判定。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  DELEGATION_ALLOWED_DEPTH,
  DELEGATION_TOOL_NAMES,
  isDelegationTool,
  assertNoDelegationTools,
  guardSubagentTools
} from '../../electron/agent/delegationFirewall'
import {
  WORKER_TOOL_CATALOG,
  buildDomainSubagents,
  loadCapabilityDomains,
  type DomainRuntime
} from '../../electron/agent/capabilityDomains'

describe('delegationFirewall：限制嵌套深度（构建期 + 运行期）', () => {
  it('task（deepagents 内置任务工具）被识别为嵌套入口', () => {
    expect(isDelegationTool('task')).toBe(true)
    expect(isDelegationTool('paper_search')).toBe(false)
    expect(isDelegationTool('read_dir')).toBe(false)
  })

  it('主 Agent 层级（depth=0，默认）允许持有 task —— 这是委派入口', () => {
    expect(() =>
      assertNoDelegationTools('main-agent', [{ name: 'paper_search' }, { name: 'task' }])
    ).not.toThrow()
    expect(() => assertNoDelegationTools('main-agent', [{ name: 'task' }], { depth: 0 })).not.toThrow()
  })

  it('子代理层级（depth>=1）持有 task 时构建期抛错（Fail-Closed，点名归属与肇事工具）', () => {
    const build = (): void =>
      assertNoDelegationTools('bad-worker', [{ name: 'paper_search' }, { name: 'task' }], {
        depth: 1
      })
    expect(build).toThrow(/递归委派/)
    expect(build).toThrow(/bad-worker/)
    expect(() =>
      assertNoDelegationTools('bad-worker', [{ name: 'task' }], { depth: 1 })
    ).toThrow()
  })

  it('工具集不含嵌套入口时正常通过（任意深度）', () => {
    expect(() =>
      assertNoDelegationTools('ok-worker', [{ name: 'paper_search' }, { name: 'write_file' }], {
        depth: 1
      })
    ).not.toThrow()
    expect(() => assertNoDelegationTools('empty', [], { depth: 1 })).not.toThrow()
  })

  it('运行期兜底：子代理（depth>=1）的嵌套入口被包裹后调用被拒绝、不真正执行', async () => {
    const realInvoke = vi.fn(async () => 'should-not-run')
    const fakeTask = { name: 'task', invoke: realInvoke }
    const normal = { name: 'paper_search', invoke: async () => 'results' }

    const [guardedTask, guardedNormal] = guardSubagentTools('lit', [fakeTask, normal], { depth: 1 })

    const rejected = await guardedTask.invoke({ description: 'x', subagent_type: 'paper' })
    // 语义断言：返回的是「拒绝」口径、点名被拒归属，而非真实执行结果
    expect(String(rejected)).toMatch(/拒绝/)
    expect(String(rejected)).toContain('lit')
    expect(String(rejected)).not.toContain('should-not-run')
    // 拒绝发生在调用之前：原工具从未被真正触发
    expect(realInvoke).not.toHaveBeenCalled()
    // 普通工具完全不受影响
    expect(await guardedNormal.invoke({})).toBe('results')
  })

  it('运行期兜底：主 Agent 层级（depth=0）的 task 原样放行，不被拦截', async () => {
    const realInvoke = vi.fn(async () => 'delegated-result')
    const fakeTask = { name: 'task', invoke: realInvoke }

    const [guardedTask] = guardSubagentTools('main-agent', [fakeTask], { depth: 0 })
    const out = await guardedTask.invoke({ description: 'x', subagent_type: 'literature' })
    // 主 Agent 的委派工具必须真的执行（否则整个委派机制失效）
    expect(out).toBe('delegated-result')
    expect(realInvoke).toHaveBeenCalledTimes(1)
  })

  it('生产白名单（WORKER_TOOL_CATALOG）不含任何嵌套入口（结构上无法嵌套）', () => {
    const offenders = WORKER_TOOL_CATALOG.filter((t) => isDelegationTool(t.id))
    expect(offenders).toEqual([])
  })

  it('嵌套入口名清单非空且包含 task（防止误删防护）', () => {
    expect(DELEGATION_TOOL_NAMES.length).toBeGreaterThan(0)
    expect(DELEGATION_TOOL_NAMES).toContain('task')
  })

  it('唯一允许深度常量为 1（主 Agent 可委派、子代理不可再委派）', () => {
    expect(DELEGATION_ALLOWED_DEPTH).toBe(1)
  })

  // ── 回归守护：域白名单经 buildDomainSubagents 后必须按 depth=1 上防 ──────────────
  // 历史缺陷：子代理的工具集直接来自 d.tools，从未过防火墙；主 Agent 校验了、子代理却没有，
  // 构成单边防线。若某域白名单（或将来新增的域）混入了 `task`，就会形成递归委派。
  describe('buildDomainSubagents：子代理工具集必须按 depth≥1 上防（回归）', () => {
    const domainWith = (tools: unknown[]): DomainRuntime =>
      ({
        id: 'lit',
        label: '文献调研',
        role: '研究员',
        description: '负责文献检索与整理。',
        guidance: '检索时优先用 paper_search。',
        tools,
        builtin: true
      }) as DomainRuntime

    it('域白名单混入 task 时构建期抛错（Fail-Closed，点名该子代理）', () => {
      const bad = domainWith([{ name: 'task', invoke: async () => 'x' }])
      expect(() => buildDomainSubagents([bad])).toThrow(/subagent:lit/)
      expect(() => buildDomainSubagents([bad])).toThrow(/递归委派/)
    })

    it('子代理的 task 即便绕过构建期，运行期调用也被拒绝（纵深防御）', async () => {
      // 绕过构建期校验：直接构造一个「校验被绕过」的域（模拟工具运行期改名等场景）。
      // 这里手工走 guardSubagentTools(depth=1)，等价于 buildDomainSubagents 内部的包裹。
      const realInvoke = vi.fn(async () => 'should-not-run')
      const [guarded] = guardSubagentTools('subagent:lit', [{ name: 'task', invoke: realInvoke }], {
        depth: 1
      })
      const out = await guarded.invoke({})
      expect(String(out)).toMatch(/拒绝/)
      expect(realInvoke).not.toHaveBeenCalled()
    })

    it('正常域（不含嵌套入口）构建后工具原样可用、不被误伤', async () => {
      const invoke = vi.fn(async () => 'ok')
      const [spec] = buildDomainSubagents([domainWith([{ name: 'paper_search', invoke }])])
      expect(spec).toBeDefined()
      expect(spec.tools).toHaveLength(1)
      const out = await (spec.tools[0] as { invoke: (i: unknown) => Promise<unknown> }).invoke({})
      expect(out).toBe('ok')
    })

    it('生产内置域全部构建成功（说明真实域白名单不含嵌套入口）', () => {
      const { domains } = loadCapabilityDomains()
      expect(() => buildDomainSubagents(domains)).not.toThrow()
    })
  })
})
