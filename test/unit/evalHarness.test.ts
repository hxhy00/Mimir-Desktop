/**
 * 评测链路（harness）单元测试：不接真实 Agent，用 mock 执行器跑通
 *   cases → runEval → summarize → 报告结构 → 对比模式
 *
 * 同时校验用例集自身的质量：工具 id 与 WORKER_TOOL_CATALOG 一致、能力域覆盖、负例存在。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resetApprovalSender } from '../../electron/agent/approval'
import { BUILTIN_FS_TOOL_IDS, EVAL_CASES, KNOWN_TOOL_IDS, findUnknownToolIds } from '../../test/eval/cases'
import type { EvalCase } from '../../test/eval/cases'
import { createMockRunner } from '../../test/eval/mockRunner'
import {
  buildReport,
  filterCases,
  formatReportHeader,
  formatRunTable,
  formatSummary,
  readReport,
  runEval,
  writeReport
} from '../../test/eval/runner'
import { ULTRA_STRATEGY_CHOICES, parseArgs, resolveRunner, realAgentReady } from '../../test/eval/cli'
import {
  ToolCallTraceHandler,
  buildRealAgent,
  flattenMessages,
  hasGatewayCredentials,
  lastAssistantText,
  resolveGateway
} from '../../test/eval/realRunner'
import { WORKER_TOOL_CATALOG } from '../../electron/agent/capabilityDomains'
import { ULTRA_STRATEGY_IDS } from '../../electron/agent/ultra'

describe('用例集质量', () => {
  it('所有引用的工具 id 都在白名单内（能力域工具 ∪ 内置文件工具）', () => {
    const unknown = findUnknownToolIds(EVAL_CASES)
    expect(
      unknown,
      `以下工具 id 不在 KNOWN_TOOL_IDS ∪ BUILTIN_FS_TOOL_IDS 内：${unknown.join(', ')}。` +
        '若是拼写错误请改正；若是新增的上游工具，请先更新 WORKER_TOOL_CATALOG。'
    ).toEqual([])
  })

  it('KNOWN_TOOL_IDS 与 capabilityDomains 的 WORKER_TOOL_CATALOG 严格一致', () => {
    expect([...KNOWN_TOOL_IDS]).toEqual(WORKER_TOOL_CATALOG.map((t) => t.id))
  })

  it('用例数与能力域覆盖达标（≥20 条，6 个能力域全覆盖）', () => {
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(20)
    const cats = new Set(EVAL_CASES.map((c) => c.category))
    for (const need of ['literature', 'paper', 'experiment', 'meeting', 'server', 'files']) {
      expect(cats.has(need as EvalCase['category'])).toBe(true)
    }
  })

  it('id 唯一', () => {
    const ids = EVAL_CASES.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('含明确的负例（不调用工具的任务）', () => {
    const negative = EVAL_CASES.filter((c) => c.expected.mustNotCallTools && !c.expected.mustCallTools)
    expect(negative.length).toBeGreaterThanOrEqual(1)
  })

  it('不存在 must 与 mustNot 自相矛盾的用例', () => {
    for (const c of EVAL_CASES) {
      const mustNot = new Set(c.expected.mustNotCallTools ?? [])
      for (const id of c.expected.mustCallTools ?? []) {
        expect(mustNot.has(id), `${c.id} 同时要求调用与禁止调用 ${id}`).toBe(false)
      }
    }
  })

  it('内置文件工具不在 KNOWN_TOOL_IDS 快照里（守护 WORKER_TOOL_CATALOG 一致性不被污染）', () => {
    for (const id of BUILTIN_FS_TOOL_IDS) {
      expect((KNOWN_TOOL_IDS as readonly string[]).includes(id), `${id} 不应在 KNOWN_TOOL_IDS 内`).toBe(false)
    }
  })

  it('BUILTIN_FS_TOOL_IDS 与 WORKER_TOOL_CATALOG 的 id 交集为空（两套来源不得混淆）', () => {
    const catalogIds = new Set(WORKER_TOOL_CATALOG.map((t) => t.id))
    const overlap = BUILTIN_FS_TOOL_IDS.filter((id) => catalogIds.has(id))
    expect(overlap, `以下 id 同时出现在内置文件工具与能力域目录中，来源混淆：${overlap.join(', ')}`).toEqual([])
  })

  it('BUILTIN_FS_TOOL_IDS 与契约测试的 FILESYSTEM_TOOL_NAMES 保持一致（防止两处清单漂移）', () => {
    // 权威来源：deepagents 的 FILESYSTEM_TOOL_NAMES（见 test/contract/toolNames.test.ts）。
    // 这里只收录「文件类」的 7 个，不含 shell 执行工具 `execute`。
    const expected = ['ls', 'read_file', 'write_file', 'edit_file', 'delete', 'glob', 'grep']
    expect([...BUILTIN_FS_TOOL_IDS].sort()).toEqual([...expected].sort())
  })

  it('file-02 / file-03 已用内置文件工具约束业务行为', () => {
    const f2 = EVAL_CASES.find((c) => c.id === 'file-02')
    const f3 = EVAL_CASES.find((c) => c.id === 'file-03')
    expect(f2?.expected.mustCallTools).toEqual(['read_file'])
    expect(f2?.expected.mustNotCallTools).toContain('read_dir')
    expect(f3?.expected.mustCallTools).toEqual(['write_file'])
  })
})

describe('runEval 端到端（mock 执行器）', () => {
  let dir = ''
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mimir-eval-'))
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('mock 执行器下全量跑通，成功率 100%（上界基线）', async () => {
    const progress: number[] = []
    const report = await runEval({
      runner: createMockRunner(),
      resultsDir: null,
      label: 'mock-baseline',
      timestamp: '20260101-000000',
      onProgress: (info) => progress.push(info.index)
    })
    expect(report.results).toHaveLength(EVAL_CASES.length)
    expect(report.summary.successRate).toBe(1)
    expect(report.summary.total).toBe(EVAL_CASES.length)
    expect(progress).toHaveLength(EVAL_CASES.length)
    expect(report.label).toBe('mock-baseline')
  })

  it('落盘报告可被 readReport 读回，且结构完整', async () => {
    const report = await runEval({
      runner: createMockRunner(),
      resultsDir: dir,
      label: 'mock-save',
      timestamp: '20260102-000000'
    })
    const back = readReport(join(dir, '20260102-000000.json'))
    expect(back.timestamp).toBe('20260102-000000')
    expect(back.label).toBe('mock-save')
    expect(back.results).toHaveLength(report.results.length)
    expect(back.summary.successRate).toBe(1)
    expect(typeof back.generatedAt).toBe('string')
  })

  it('过滤：按能力域与难度筛选', async () => {
    const report = await runEval({
      runner: createMockRunner(),
      resultsDir: null,
      categories: ['server'],
      timestamp: '20260103-000000'
    })
    expect(report.results.length).toBeGreaterThan(0)
    expect(report.results.every((r) => r.category === 'server')).toBe(true)

    const hard = await runEval({
      runner: createMockRunner(),
      resultsDir: null,
      difficulties: ['hard'],
      timestamp: '20260103-000001'
    })
    expect(hard.results.every((r) => r.difficulty === 'hard')).toBe(true)
  })

  it('并发度不影响结果一致性', async () => {
    const serial = await runEval({ runner: createMockRunner(), resultsDir: null, concurrency: 1, timestamp: 'a' })
    const parallel = await runEval({ runner: createMockRunner(), resultsDir: null, concurrency: 4, timestamp: 'b' })
    expect(parallel.summary.successRate).toBe(serial.summary.successRate)
    expect(parallel.results.map((r) => r.id)).toEqual(serial.results.map((r) => r.id))
  })

  it('执行器抛错 → 记为失败但不中断整轮', async () => {
    const report = await runEval({
      runner: (c) => {
        if (c.id === 'lit-01') throw new Error('模拟执行器崩溃')
        return createMockRunner()(c)
      },
      resultsDir: null,
      timestamp: 'c'
    })
    const failed = report.results.find((r) => r.id === 'lit-01')
    expect(failed?.success).toBe(false)
    expect(failed?.run.finalOutput).toContain('模拟执行器崩溃')
    expect(report.summary.failed).toBe(1)
    expect(report.summary.total).toBe(EVAL_CASES.length)
  })

  it('超时 → 记为失败并带超时说明', async () => {
    const report = await runEval({
      runner: () => new Promise(() => {}), // 永不 resolve
      resultsDir: null,
      timeoutMs: 30,
      categories: ['server'],
      timestamp: 'd'
    })
    expect(report.summary.failed).toBe(report.summary.total)
    // 超时原因写在兜底 run 的 finalOutput / messages 里（failures 只反映工具调用不合规）。
    expect(report.results[0].run.finalOutput).toContain('超时')
    expect(report.results[0].failures.join()).toContain('缺少必需工具调用')
  })

  it('先登记通道：执行器 observe 过的字段会被超时兜底 run 继承', async () => {
    // 场景：Ultra 已选定策略并登记，随后 agent 调用超时。
    // 报告必须仍显示该策略 —— 否则无法归因「是不是增强把预算烧爆了」。
    const report = await runEval({
      runner: (_c, observe) => {
        observe?.({ ultraStrategy: 'multi_expert' })
        return new Promise(() => {}) // 永不 resolve → 走超时兜底
      },
      resultsDir: null,
      timeoutMs: 30,
      categories: ['server'],
      timestamp: 'obs'
    })
    expect(report.results.length).toBeGreaterThan(0)
    for (const r of report.results) {
      expect(r.run.runError).toContain('超时')
      expect(r.run.ultraStrategy).toBe('multi_expert')
      // 报告平铺字段也要带上（「增强」列据此出现）
      expect(r.ultraStrategy).toBe('multi_expert')
      // 权威字段不被 observed 污染
      expect(r.run.finalOutput).toContain('超时')
    }
    expect(formatRunTable(report)).toContain('增强')
  })

  it('断点续跑：跳过已完成用例、结果仍进报告，跑完清掉断点', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mimir-ckpt-'))
    const ckpt = join(dir, 'arm.partial.json')
    try {
      const seen1: string[] = []
      const r1 = await runEval({
        runner: (c) => {
          seen1.push(c.id)
          return createMockRunner()(c)
        },
        resultsDir: null,
        timestamp: 'k1',
        label: 'arm',
        categories: ['server'],
        checkpointFile: ckpt
      })
      // 正常跑完 → 断点被清理（否则下次同 label 会整轮跳过）
      expect(existsSync(ckpt)).toBe(false)
      expect(seen1.length).toBe(r1.results.length)
      expect(r1.results.length).toBeGreaterThan(1)

      // 手工造一个「只完成第一条」的断点，模拟中途被打断
      const first = r1.results[0]
      writeFileSync(ckpt, JSON.stringify({ timestamp: 'k2', label: 'arm', results: [first] }), 'utf8')

      const seen2: string[] = []
      const r2 = await runEval({
        runner: (c) => {
          seen2.push(c.id)
          return createMockRunner()(c)
        },
        resultsDir: null,
        timestamp: 'k2',
        label: 'arm',
        categories: ['server'],
        checkpointFile: ckpt
      })
      expect(seen2).not.toContain(first.id) // 已完成的不再重跑
      expect(seen2.length).toBe(r1.results.length - 1)
      expect(r2.results.map((r) => r.id)).toContain(first.id) // 但结果要并进最终报告
      expect(r2.results.length).toBe(r1.results.length)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('断点 label 不匹配则不采信（防止基线臂污染对照臂）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mimir-ckpt2-'))
    const ckpt = join(dir, 'arm.partial.json')
    try {
      // 断点里放一条「已完成」，但 label 属于另一个臂 —— 若校验失效，srv-01 会被误跳过。
      const foreign = {
        timestamp: 't',
        label: 'other-arm',
        results: [
          {
            id: 'srv-01',
            name: 'x',
            category: 'server',
            difficulty: 'easy',
            success: true,
            failures: [],
            calledTools: [],
            toolCalls: 0,
            tokens: 0,
            latencyMs: 0,
            approvalCount: 0,
            ultraStrategy: '',
            run: { messages: [], toolCalls: [], usage: {}, durationMs: 0, approvalCount: 0, finalOutput: 'x' }
          }
        ]
      }
      writeFileSync(ckpt, JSON.stringify(foreign), 'utf8')
      const seen: string[] = []
      await runEval({
        runner: (c) => {
          seen.push(c.id)
          return createMockRunner()(c)
        },
        resultsDir: null,
        timestamp: 't2',
        label: 'arm',
        categories: ['server'],
        checkpointFile: ckpt
      })
      expect(seen).toContain('srv-01')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('报告渲染与对比', () => {
  it('formatRunTable / formatSummary 输出含表头与摘要段', async () => {
    const report = await runEval({ runner: createMockRunner(), resultsDir: null, timestamp: 'e' })
    const table = formatRunTable(report)
    expect(table).toContain('状态')
    expect(table).toContain('lit-01')
    const summary = formatSummary(report.summary)
    expect(summary).toContain('评测摘要')
    expect(summary).toContain('按能力域')
    expect(summary).toContain('按难度')
  })

  it('formatRunTable 的「增强」列只在真的跑过 Ultra 时出现', async () => {
    // 该列的用途是自证增强已生效：A/B 两版都是「-」就说明 Ultra 没接上，结论无效。
    const plain = await runEval({ runner: createMockRunner(), resultsDir: null, timestamp: 'u1' })
    expect(formatRunTable(plain)).not.toContain('增强')

    const withUltra = await runEval({
      runner: (c) => ({ ...createMockRunner()(c), ultraStrategy: 'critique_reflect' }),
      resultsDir: null,
      timestamp: 'u2'
    })
    expect(formatRunTable(withUltra)).toContain('增强')
    expect(withUltra.results.every((r) => r.ultraStrategy === 'critique_reflect')).toBe(true)
  })

  it('buildReport 平铺报告与 runEval 结果一致', async () => {
    const report = await runEval({ runner: createMockRunner(), resultsDir: null, timestamp: 'f' })
    const rebuilt = buildReport({
      results: report.results.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category,
        difficulty: r.difficulty,
        success: r.success,
        failures: r.failures,
        calledTools: r.calledTools,
        toolCalls: r.run.toolCalls.length,
        tokens: 0,
        latencyMs: 0,
        approvalCount: 0,
        run: r.run
      })),
      label: 'rebuilt',
      timestamp: 'f',
      filter: { categories: [], difficulties: [], ids: [] }
    })
    expect(rebuilt.summary.successRate).toBe(report.summary.successRate)
    expect(rebuilt.results.map((r) => r.id)).toEqual(report.results.map((r) => r.id))
  })

  it('writeReport 与 readReport 往返一致', () => {
    const report = {
      timestamp: 'roundtrip',
      label: 'rt',
      generatedAt: '2026-01-01T00:00:00.000Z',
      filter: { categories: [], difficulties: [], ids: [] },
      summary: undefined as never,
      results: []
    }
    const dir = mkdtempSync(join(tmpdir(), 'mimir-eval-rt-'))
    try {
      const file = writeReport(report, dir)
      expect(readReport(file).label).toBe('rt')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('filterCases / parseArgs', () => {
  it('filterCases 无条件时返回全部', () => {
    expect(filterCases(EVAL_CASES, {}).length).toBe(EVAL_CASES.length)
  })

  it('parseArgs 解析常规参数', () => {
    const args = parseArgs([
      '--label',
      'single-agent-ultra',
      '--category',
      'literature',
      '--difficulty',
      'hard',
      '--concurrency',
      '4',
      '--timeout',
      '5000',
      '--no-save'
    ])
    expect(args.label).toBe('single-agent-ultra')
    expect(args.categories).toEqual(['literature'])
    expect(args.difficulties).toEqual(['hard'])
    expect(args.concurrency).toBe(4)
    expect(args.timeoutMs).toBe(5000)
    expect(args.resultsDir).toBeNull()
  })

  it('parseArgs 支持 --compare 双文件与 --id 重复', () => {
    const args = parseArgs(['--compare', 'a.json', 'b.json', '--id', 'lit-01', '--id', 'srv-01'])
    expect(args.compare).toEqual(['a.json', 'b.json'])
    expect(args.ids).toEqual(['lit-01', 'srv-01'])
  })

  it('parseArgs 对非法输入抛错', () => {
    expect(() => parseArgs(['--category', 'nope'])).toThrow(/未知能力域/)
    expect(() => parseArgs(['--concurrency', '0'])).toThrow(/正整数/)
    expect(() => parseArgs(['--unknown'])).toThrow(/未知参数/)
    expect(() => parseArgs(['--label'])).toThrow(/缺少取值/)
  })

  it('parseArgs 支持 --ultra / --ultra-strategy（指定策略隐含开启）', () => {
    const plain = parseArgs(['--real-agent', '--ultra'])
    expect(plain.ultra).toBe(true)
    expect(plain.ultraStrategy).toBe('auto')

    const withStrategy = parseArgs(['--real-agent', '--ultra-strategy', 'critique_reflect'])
    expect(withStrategy.ultra).toBe(true)
    expect(withStrategy.ultraStrategy).toBe('critique_reflect')

    expect(parseArgs(['--real-agent']).ultra).toBe(false)
  })

  it('parseArgs 拒绝误用：未知策略、以及未开 --real-agent 就开 --ultra', () => {
    expect(() => parseArgs(['--real-agent', '--ultra-strategy', 'nope'])).toThrow(/未知 Ultra 策略/)
    // mock 是理想化执行器，不经过增强层；静默忽略会让人拿 mock 结果当增强结论。
    expect(() => parseArgs(['--ultra'])).toThrow(/仅在 --real-agent 下有效/)
  })

  it('ULTRA_STRATEGY_CHOICES 与 electron 侧 ULTRA_STRATEGY_IDS 一致（防止两处清单漂移）', () => {
    // CLI 不能静态 import ultra.ts（依赖链会拖进 electron-store，node CLI 会崩），
    // 所以策略名在 cli.ts 里列了一份；这条断言就是那份副本的护栏。
    expect([...ULTRA_STRATEGY_CHOICES].sort()).toEqual(['auto', ...ULTRA_STRATEGY_IDS].sort())
  })
})

describe('执行器选择（mock / real）', () => {
  const fullEnv = { MIMIR_GW_URL: 'https://gw.example/v1', MIMIR_GW_KEY: 'k', MIMIR_GW_MODEL: 'm' }

  it('默认走 mock，kind=mock', () => {
    const { kind } = resolveRunner(false, {})
    expect(kind).toBe('mock')
  })

  it('--real-agent 且凭据齐备 → kind=real', () => {
    const { kind, runner } = resolveRunner(true, fullEnv)
    expect(kind).toBe('real')
    expect(typeof runner).toBe('function')
  })

  it('--real-agent 但缺凭据 → 抛错（绝不静默退化成 mock）', () => {
    expect(() => resolveRunner(true, {})).toThrow(/不会退化为 mock/)
    expect(() => resolveRunner(true, { MIMIR_GW_URL: 'u', MIMIR_GW_KEY: 'k' })).toThrow(/MIMIR_GW_MODEL/)
  })

  it('凭据判定：三个变量必须齐备', () => {
    expect(resolveGateway({})).toBeNull()
    expect(resolveGateway({ MIMIR_GW_URL: 'u', MIMIR_GW_KEY: 'k' })).toBeNull()
    expect(resolveGateway(fullEnv)).toEqual({ baseUrl: 'https://gw.example/v1', apiKey: 'k', model: 'm' })
    expect(hasGatewayCredentials(fullEnv)).toBe(true)
    expect(hasGatewayCredentials({})).toBe(false)
    expect(realAgentReady(fullEnv)).toBe(true)
  })
})

describe('报告中的 runner 标注（防止 mock 被当结论）', () => {
  it('mock 报告的 runner=mock，且抬头明确警告', async () => {
    const report = await runEval({ runner: createMockRunner(), resultsDir: null, timestamp: 'mk' })
    expect(report.runner).toBe('mock')
    const header = formatReportHeader(report)
    expect(header).toContain('runner=mock')
    expect(header).toContain('恒 100%')
  })

  it('real 报告抬头标注 runner=real', async () => {
    const report = await runEval({
      runner: createMockRunner(),
      runnerKind: 'real',
      resultsDir: null,
      timestamp: 'rl'
    })
    expect(report.runner).toBe('real')
    expect(formatReportHeader(report)).toContain('runner=real')
  })

  it('runEval 缺省 runnerKind 为 mock', async () => {
    const report = await runEval({ runner: createMockRunner(), resultsDir: null, timestamp: 'df' })
    expect(report.runner).toBe('mock')
  })
})

describe('真实适配器：装配链路（无需网关、不发网络请求）', () => {
  // ── 为什么这两条必须有 ────────────────────────────────────────────────────
  // 真实装配要跨过 electron 侧模块的**无扩展名导入**（`../library/store`、`./controlPlane`…）。
  // Node 的 ESM 解析器不认无扩展名，所以 `node test/eval/cli.ts --real-agent` 必然抛
  // ERR_MODULE_NOT_FOUND；只有 vitest 侧（vite 解析器 + store 桩）能装配成功。
  // 这个缺陷长期不可见，原因有二：mock 模式惰性 import、根本不加载这条链；且评测层当时
  // 还有「负例假通过」bug，把「运行报错」计成了 PASS。
  // 因此把「装配能否成功」固化成回归测试 —— 它挂了，真实评测与 A/B 就全都跑不起来。

  const fakeGateway = { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-test-not-used', model: 'test-model' }

  afterAll(() => {
    // buildRealAgent 会注册全局批准发送器；用完解绑，避免影响其它测试。
    resetApprovalSender()
  })

  it('buildRealAgent 能完成装配（不依赖真实网络）', async () => {
    const bundle = await buildRealAgent(fakeGateway)
    expect(typeof bundle.agent.invoke).toBe('function')
    expect(bundle.ultra).toBeNull()
  })

  it('开启 Ultra 时装配出控制器；无需增强时直接不介入（零模型调用）', async () => {
    const bundle = await buildRealAgent(fakeGateway, { ultra: { enabled: true } })
    expect(bundle.ultra).not.toBeNull()
    // 「你好」不含任何增强关键词 → 自动选型返回「不增强」：不注入内容、也不调用模型。
    // 因此这条断言在**无网络**下也能跑（plain 被移除后，已经没有「零成本策略」可用来做验证了）。
    const r = await bundle.ultra!.run({
      message: '你好',
      signal: new AbortController().signal,
      historyTokens: 0,
      routerMeta: null
    })
    expect(r.strategy).toBeNull()
    expect(r.output).toBe('')
    expect(r.degraded).toBe(false)
  })
})

describe('真实适配器的纯函数部分（无需网关即可测）', () => {
  it('ToolCallTraceHandler 累加 token（跨多次模型调用）', async () => {
    const h = new ToolCallTraceHandler()
    await h.handleLLMEnd({ llmOutput: { tokenUsage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } } } as never)
    await h.handleLLMEnd({ llmOutput: { tokenUsage: { promptTokens: 50, completionTokens: 10 } } } as never)
    expect(h.usage).toEqual({ inputTokens: 150, outputTokens: 30, totalTokens: 180 })
  })

  it('ToolCallTraceHandler 对缺失/脏 tokenUsage 不抛错且计 0', async () => {
    const h = new ToolCallTraceHandler()
    await h.handleLLMEnd({ llmOutput: {} } as never)
    await h.handleLLMEnd({ llmOutput: { tokenUsage: { promptTokens: Number.NaN, completionTokens: -1 } } } as never)
    await h.handleLLMEnd({} as never)
    expect(h.usage.inputTokens).toBe(0)
    expect(h.usage.outputTokens).toBe(0)
    expect(h.usage.totalTokens).toBe(0)
  })

  // ── 工具调用采集：名字/参数必须来自「模型返回的 tool_calls」──────────────────
  // 下面第一条锁住的正是**踩过的真坑**：先前实现从 handleToolStart 的首参取 `tool.name`，
  // 而 LangChain JS 传进来的是不含 name 的 Serialized 包装 → 采集到的名字恒为 "(?)"，
  // 导致所有 mustCallTools 用例假失败（报告看起来像「模型不会调工具」，其实是采集坏了）。
  // 被替换掉的那条旧用例是**按错误假设写的**，所以它一直是绿的 ——
  // 这种「测试固化实现假设而非现实」的情况比没有测试更危险。

  it('工具名/参数取自模型返回的 tool_calls（兼容两种形态）', async () => {
    const h = new ToolCallTraceHandler()
    // OpenAI 原生形态：message.tool_calls[].name / .args
    await h.handleLLMEnd({
      generations: [[{ message: { content: '', tool_calls: [{ name: 'paper_search', args: { query: 'x' } }] } }]]
    } as never)
    // chat-completions 形态：additional_kwargs.tool_calls[].function.name / .arguments
    await h.handleLLMEnd({
      generations: [
        [
          {
            message: {
              content: '',
              additional_kwargs: {
                tool_calls: [{ function: { name: 'write_file', arguments: '{"filePath":"/tmp/a.md"}' } }]
              }
            }
          }
        ]
      ]
    } as never)

    expect(h.toolCalls.map((c) => c.name)).toEqual(['paper_search', 'write_file'])
    expect(h.toolCalls[0].args).toEqual({ query: 'x' })
    expect(h.toolCalls[1].args).toEqual({ filePath: '/tmp/a.md' })
  })

  it('纯文本回复不产生工具调用记录', async () => {
    const h = new ToolCallTraceHandler()
    await h.handleLLMEnd({ generations: [[{ message: { content: '我无法访问你的服务器' } }]] } as never)
    expect(h.toolCalls).toEqual([])
  })

  it('handleToolStart 首参不含 name：它只记时刻，不产生调用记录（锁住该结论）', async () => {
    const h = new ToolCallTraceHandler()
    await h.handleToolStart({ name: 'paper_search' } as never, '{"query":"x"}', 'run-1')
    expect(h.toolCalls).toEqual([])
  })

  it('耗时按 runId 回填，工具报错标 error（名字仍来自模型返回）', async () => {
    const h = new ToolCallTraceHandler()
    await h.handleLLMEnd({
      generations: [[{ message: { tool_calls: [{ name: 'write_file', args: {} }] } }]]
    } as never)
    await h.handleToolStart(undefined, '{}', 'run-1')
    await h.handleToolError(new Error('permission denied'), 'run-1')
    expect(h.toolCalls).toHaveLength(1)
    expect(h.toolCalls[0].error).toBe(true)
    expect(typeof h.toolCalls[0].durationMs).toBe('number')
  })

  it('lastAssistantText 取最后一条非空 AI 消息', () => {
    const msgs = [
      { _getType: () => 'human', content: '问题' },
      { _getType: () => 'ai', content: '' },
      { _getType: () => 'ai', content: '这是答案' },
      { _getType: () => 'ai', content: '  ' }
    ]
    expect(lastAssistantText(msgs)).toBe('这是答案')
    expect(lastAssistantText([])).toBe('')
  })

  it('flattenMessages 映射 role 且非字符串 content 会序列化', () => {
    const flat = flattenMessages([
      { _getType: () => 'system', content: 'sys' },
      { _getType: () => 'human', content: 'hi' },
      { _getType: () => 'ai', content: [{ type: 'text', text: 'yo' }] },
      { _getType: () => 'tool', content: 'result' }
    ])
    expect(flat.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool'])
    expect(flat[2].content).toContain('yo')
  })
})
