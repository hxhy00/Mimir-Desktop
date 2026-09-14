/**
 * 评测指标单元测试。
 *
 * 覆盖点：
 * 1. checkCase / taskSuccess：缺 mustCallTools → 失败；命中 mustNotCallTools → 失败；
 * 2. toolPrecisionRecall：空期望集不许除零；precision/recall/F1 计算；
 * 3. countToolCalls / sumTokens / latencyMs / humanInterventions：脏数据兜底（负数/缺失/NaN）；
 * 4. summarize：分组统计与 P95；
 * 5. compareRuns：fixed / regressed / onlyInBaseline / onlyInCandidate / delta；
 * 6. percentile：空数组、单元素、插值。
 *
 * 全部使用构造的假数据，不依赖真实 Agent 与网络。
 */
import { describe, expect, it } from 'vitest'
import type { EvalCase } from '../../test/eval/cases'
import {
  checkCase,
  compareRuns,
  countToolCalls,
  formatCompareReport,
  humanInterventions,
  latencyMs,
  percentile,
  runInvalidReason,
  summarize,
  sumTokens,
  taskSuccess,
  toolPrecisionRecall
} from '../../test/eval/metrics'
import type { EvalResult, EvalRun, ToolCallRecord } from '../../test/eval/metrics'

/** 构造一个最小可用的 EvalCase。 */
function makeCase(over: Partial<EvalCase> & { id: string }): EvalCase {
  return {
    id: over.id,
    name: over.name ?? over.id,
    category: over.category ?? 'literature',
    input: over.input ?? '测试输入',
    expected: over.expected ?? {},
    difficulty: over.difficulty ?? 'easy',
    notes: over.notes ?? ''
  }
}

/** 构造一个最小可用的 EvalRun。 */
function makeRun(over: Partial<EvalRun> = {}): EvalRun {
  return {
    messages: [],
    toolCalls: [],
    usage: {},
    durationMs: 0,
    approvalCount: 0,
    finalOutput: '',
    ...over
  }
}

function calls(...names: string[]): ToolCallRecord[] {
  return names.map((name) => ({ name }))
}

describe('taskSuccess / checkCase', () => {
  it('全部 mustCallTools 命中 → 成功', () => {
    const c = makeCase({ id: 'a', expected: { mustCallTools: ['paper_search', 'paper_fetch'] } })
    const run = makeRun({ toolCalls: calls('paper_search', 'paper_fetch') })
    expect(taskSuccess(c, run)).toBe(true)
    expect(checkCase(c, run).failures).toEqual([])
  })

  it('缺少 mustCallTools → 失败，并给出具体原因', () => {
    const c = makeCase({ id: 'b', expected: { mustCallTools: ['paper_search', 'paper_fetch'] } })
    const run = makeRun({ toolCalls: calls('paper_search') })
    expect(taskSuccess(c, run)).toBe(false)
    expect(checkCase(c, run).failures).toEqual(['缺少必需工具调用：paper_fetch'])
  })

  it('命中 mustNotCallTools → 失败（即使必调工具都命中）', () => {
    const c = makeCase({
      id: 'c',
      expected: { mustCallTools: ['paper_search'], mustNotCallTools: ['paper_fetch'] }
    })
    const run = makeRun({ toolCalls: calls('paper_search', 'paper_fetch') })
    expect(taskSuccess(c, run)).toBe(false)
    expect(checkCase(c, run).failures).toEqual(['调用了禁止的工具：paper_fetch'])
  })

  it('不该调的工具即使调用后报错，也算违规', () => {
    const c = makeCase({ id: 'd', expected: { mustNotCallTools: ['latex_compile'] } })
    const run = makeRun({ toolCalls: [{ name: 'latex_compile', error: true }] })
    expect(taskSuccess(c, run)).toBe(false)
  })

  it('负例：模型正常作答且未调用工具 → 成功', () => {
    const c = makeCase({ id: 'e', expected: { mustNotCallTools: ['web_search'] } })
    const run = makeRun({ finalOutput: 'Transformer 是一种基于自注意力的序列建模架构……' })
    expect(taskSuccess(c, run)).toBe(true)
    expect(checkCase(c, run).failures).toEqual([])
  })

  it('负例：运行未发生（零输出零调用）→ 失败，不得假通过', () => {
    // 修复前的缺陷：负例只约束「不调用某些工具」，模型彻底没响应（网关不可达 / 空回）
    // 时零调用同样满足期望，于是负例全部假通过——模型越坏，负例越好看。
    const c = makeCase({ id: 'e2', expected: { mustNotCallTools: ['web_search'] } })
    expect(taskSuccess(c, makeRun())).toBe(false)
    expect(checkCase(c, makeRun()).failures).toEqual([
      '本轮未产出任何回答、也未调用任何工具（模型空回或网关不可达）'
    ])
  })

  it('重复调用同一必需工具只算一次命中', () => {
    const c = makeCase({ id: 'f', expected: { mustCallTools: ['paper_search'] } })
    expect(taskSuccess(c, makeRun({ toolCalls: calls('paper_search', 'paper_search') }))).toBe(true)
  })
})

describe('runInvalidReason（运行有效性下限）', () => {
  it('runError 非空 → 判为运行失败（超时 / 抛错的兜底 run）', () => {
    expect(runInvalidReason(makeRun({ runError: '用例 lit-01 超时（>30000ms）' }))).toBe(
      '运行失败：用例 lit-01 超时（>30000ms）'
    )
  })

  it('runError 优先于「有输出」：兜底说明文字不算正常作答', () => {
    const run = makeRun({ finalOutput: '[评测运行失败] 用例 lit-01 超时', runError: '用例 lit-01 超时' })
    expect(runInvalidReason(run)).toBe('运行失败：用例 lit-01 超时')
  })

  it('有最终输出 → 视为已执行', () => {
    expect(runInvalidReason(makeRun({ finalOutput: '有回答' }))).toBeNull()
  })

  it('调用过工具（即使输出为空）→ 视为已执行（已有工具证据）', () => {
    expect(runInvalidReason(makeRun({ toolCalls: calls('server_status') }))).toBeNull()
  })

  it('空白输出等同于无输出', () => {
    expect(runInvalidReason(makeRun({ finalOutput: '   \n  ' }))).toContain('未产出任何回答')
  })
})

describe('toolPrecisionRecall', () => {
  it('期望集为空时 precision/recall 定义为 1，不除零', () => {
    const c = makeCase({ id: 'p0', expected: {} })
    const r = toolPrecisionRecall(c, makeRun())
    expect(r.precision).toBe(1)
    expect(r.recall).toBe(1)
    expect(r.f1).toBe(1)
    expect(Number.isNaN(r.f1)).toBe(false)
  })

  it('空期望集但调了工具 → precision=0，recall=1', () => {
    const c = makeCase({ id: 'p1', expected: {} })
    const r = toolPrecisionRecall(c, makeRun({ toolCalls: calls('web_search') }))
    expect(r.precision).toBe(0)
    expect(r.recall).toBe(1)
    expect(r.unexpected).toEqual(['web_search'])
  })

  it('部分命中：precision/recall/f1 计算正确', () => {
    const c = makeCase({ id: 'p2', expected: { mustCallTools: ['a', 'b', 'c', 'd'] } })
    const run = makeRun({ toolCalls: calls('a', 'b', 'x', 'y') })
    const r = toolPrecisionRecall(c, run)
    expect(r.truePositives).toEqual(['a', 'b'])
    expect(r.missed).toEqual(['c', 'd'])
    expect(r.unexpected).toEqual(['x', 'y'])
    expect(r.precision).toBeCloseTo(0.5)
    expect(r.recall).toBeCloseTo(0.5)
    expect(r.f1).toBeCloseTo(0.5)
  })

  it('全命中 → precision=recall=f1=1', () => {
    const c = makeCase({ id: 'p3', expected: { mustCallTools: ['a', 'b'] } })
    const r = toolPrecisionRecall(c, makeRun({ toolCalls: calls('a', 'b') }))
    expect(r.precision).toBe(1)
    expect(r.recall).toBe(1)
    expect(r.f1).toBe(1)
  })

  it('期望集非空但零调用 → precision=0（定义），recall=0', () => {
    const c = makeCase({ id: 'p4', expected: { mustCallTools: ['a'] } })
    const r = toolPrecisionRecall(c, makeRun())
    expect(r.precision).toBe(0)
    expect(r.recall).toBe(0)
    expect(r.f1).toBe(0)
  })

  it('重复调用不抬高 precision 分母之外的分值', () => {
    const c = makeCase({ id: 'p5', expected: { mustCallTools: ['a'] } })
    const r = toolPrecisionRecall(c, makeRun({ toolCalls: calls('a', 'a', 'a') }))
    expect(r.actual).toEqual(['a'])
    expect(r.precision).toBe(1)
  })
})

describe('countToolCalls / sumTokens / latencyMs / humanInterventions 脏数据兜底', () => {
  it('countToolCalls 计重复调用', () => {
    expect(countToolCalls(makeRun({ toolCalls: calls('a', 'a', 'b') }))).toBe(3)
    expect(countToolCalls(makeRun())).toBe(0)
  })

  it('sumTokens 优先 totalTokens，否则 input+output，缺失按 0', () => {
    expect(sumTokens(makeRun({ usage: { totalTokens: 123 } }))).toBe(123)
    expect(sumTokens(makeRun({ usage: { inputTokens: 10, outputTokens: 5 } }))).toBe(15)
    expect(sumTokens(makeRun({ usage: {} }))).toBe(0)
    expect(sumTokens(makeRun({ usage: { inputTokens: 10 } }))).toBe(10)
  })

  it('sumTokens 的 totalTokens 优先于 input/output 之和', () => {
    expect(sumTokens(makeRun({ usage: { totalTokens: 7, inputTokens: 100, outputTokens: 100 } }))).toBe(7)
  })

  it('latencyMs 对负数/NaN/缺失归零', () => {
    expect(latencyMs(makeRun({ durationMs: 150 }))).toBe(150)
    expect(latencyMs(makeRun({ durationMs: -5 }))).toBe(0)
    expect(latencyMs(makeRun({ durationMs: Number.NaN }))).toBe(0)
    expect(latencyMs(makeRun({ durationMs: Number.POSITIVE_INFINITY }))).toBe(0)
    expect(latencyMs(makeRun())).toBe(0)
  })

  it('humanInterventions 对负数/NaN/缺失归零', () => {
    expect(humanInterventions(makeRun({ approvalCount: 3 }))).toBe(3)
    expect(humanInterventions(makeRun({ approvalCount: -1 }))).toBe(0)
    expect(humanInterventions(makeRun({ approvalCount: Number.NaN }))).toBe(0)
    expect(humanInterventions(makeRun())).toBe(0)
  })
})

describe('percentile', () => {
  it('空数组 → 0', () => {
    expect(percentile([], 0.95)).toBe(0)
  })

  it('单元素 → 该值（与 p 无关）', () => {
    expect(percentile([42], 0.95)).toBe(42)
    expect(percentile([42], 0)).toBe(42)
  })

  it('线性插值：1..10 的 P95', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBeCloseTo(9.55)
  })

  it('p=0 取最小值，p=1 取最大值', () => {
    const arr = [5, 10, 15]
    expect(percentile(arr, 0)).toBe(5)
    expect(percentile(arr, 1)).toBe(15)
  })
})

describe('summarize', () => {
  function result(id: string, success: boolean, over: Partial<EvalRun> = {}, category: EvalCase['category'] = 'literature', difficulty: EvalCase['difficulty'] = 'easy'): EvalResult {
    const c = makeCase({
      id,
      category,
      difficulty,
      expected: { mustCallTools: ['paper_search'] }
    })
    return {
      case: c,
      run: makeRun({ toolCalls: calls('paper_search'), ...over }),
      success,
      failures: success ? [] : ['构造的失败'],
      calledTools: ['paper_search']
    }
  }

  it('聚合成功率、平均工具数/token、P95 延迟与人工干预合计', () => {
    const results: EvalResult[] = [
      result('s1', true, { durationMs: 100, usage: { inputTokens: 100, outputTokens: 50 }, approvalCount: 1 }),
      result('s2', true, { durationMs: 200, usage: { inputTokens: 200, outputTokens: 100 }, approvalCount: 0 }),
      result('s3', false, { durationMs: 300, usage: { inputTokens: 300, outputTokens: 150 }, approvalCount: 2 }),
      result('s4', true, { durationMs: 400, usage: { inputTokens: 400, outputTokens: 200 }, approvalCount: 0 })
    ]
    const s = summarize(results)
    expect(s.total).toBe(4)
    expect(s.passed).toBe(3)
    expect(s.failed).toBe(1)
    expect(s.successRate).toBeCloseTo(0.75)
    expect(s.avgToolCalls).toBe(1)
    expect(s.avgTokens).toBeCloseTo((150 + 300 + 450 + 600) / 4)
    expect(s.avgLatencyMs).toBeCloseTo(250)
    expect(s.p95LatencyMs).toBeGreaterThanOrEqual(380)
    expect(s.totalHumanInterventions).toBe(3)
    expect(s.failures.map((f) => f.id)).toEqual(['s3'])
  })

  it('按能力域与难度分组统计', () => {
    const results: EvalResult[] = [
      result('g1', true, {}, 'literature', 'easy'),
      result('g2', false, {}, 'literature', 'hard'),
      result('g3', true, {}, 'server', 'easy')
    ]
    const s = summarize(results)
    expect(s.byCategory.literature).toEqual({ total: 2, passed: 1, successRate: 0.5 })
    expect(s.byCategory.server).toEqual({ total: 1, passed: 1, successRate: 1 })
    expect(s.byCategory.meeting).toEqual({ total: 0, passed: 0, successRate: 0 })
    expect(s.byDifficulty.easy).toEqual({ total: 2, passed: 2, successRate: 1 })
    expect(s.byDifficulty.hard).toEqual({ total: 1, passed: 0, successRate: 0 })
  })

  it('空输入不崩，全部归零', () => {
    const s = summarize([])
    expect(s.total).toBe(0)
    expect(s.successRate).toBe(0)
    expect(s.p95LatencyMs).toBe(0)
    expect(s.avgTokens).toBe(0)
  })

  it('接受未判定的 { case, run } 输入并内部判定', () => {
    const c = makeCase({ id: 'raw', expected: { mustCallTools: ['paper_search'] } })
    const s = summarize([{ case: c, run: makeRun({ toolCalls: calls('paper_search') }) }])
    expect(s.passed).toBe(1)
  })
})

describe('compareRuns', () => {
  /**
   * 构造一条「已判定」结果：
   * - expectedTools 是该用例的期望工具集（用于判定 success）；
   * - calledTools 是实际调用（默认等于期望，即成功）。
   */
  function mk(
    id: string,
    expectedTools: string[],
    tokens: number,
    latency: number,
    calledTools: string[] = expectedTools
  ): EvalResult {
    const c = makeCase({ id, expected: { mustCallTools: expectedTools } })
    const run = makeRun({
      toolCalls: calledTools.map((name) => ({ name })),
      durationMs: latency,
      usage: { totalTokens: tokens }
    })
    const { success, failures } = checkCase(c, run)
    return { case: c, run, success, failures, calledTools: [...new Set(calledTools)] }
  }

  it('识别 fixed / regressed / unchanged', () => {
    // 核心行为：expected 集合在两版间不变（同一条用例），变化的只是「实际调没调到」
    // baseline：b1 漏调 → 失败；b2 全调 → 成功；b3 全调 → 成功；b4 漏调 → 失败
    const baseline = [
      mk('b1', ['a'], 100, 10, []),
      mk('b2', ['b', 'c'], 200, 20),
      mk('b3', ['d'], 300, 30),
      mk('b4', ['e'], 400, 40, [])
    ]
    // b1 修复、b3 回归（漏调）、b2/b4 不变
    const candidate = [
      mk('b1', ['a'], 120, 12),
      mk('b2', ['b', 'c'], 210, 22),
      mk('b3', ['d'], 300, 30, []),
      mk('b4', ['e'], 400, 40, [])
    ]
    const cmp = compareRuns(baseline, candidate)
    expect(cmp.fixed).toEqual(['b1'])
    expect(cmp.regressed).toEqual(['b3'])
    expect(cmp.diffs).toHaveLength(4)
    expect(cmp.diffs.find((d) => d.id === 'b1')?.transition).toBe('fixed')
    expect(cmp.diffs.find((d) => d.id === 'b3')?.transition).toBe('regressed')
    expect(cmp.diffs.find((d) => d.id === 'b2')?.transition).toBe('unchanged-pass')
    expect(cmp.diffs.find((d) => d.id === 'b4')?.transition).toBe('unchanged-fail')
  })

  it('识别 onlyInBaseline / onlyInCandidate', () => {
    const cmp = compareRuns([mk('x', ['a'], 10, 1)], [mk('y', ['a'], 10, 1)])
    expect(cmp.onlyInBaseline).toEqual(['x'])
    expect(cmp.onlyInCandidate).toEqual(['y'])
    expect(cmp.diffs).toHaveLength(0)
  })

  it('delta 计算：成功率、token、延迟、工具调用、人工干预', () => {
    // 两版用例集相同、期望工具相同；只有成本/延迟/干预数变化。
    const baseline = [
      mk('d1', ['a'], 1000, 100),
      mk('d2', ['a'], 1000, 100)
    ].map((r, i) => ({ ...r, run: { ...r.run, approvalCount: i === 0 ? 2 : 0 } }))
    const candidate = [
      mk('d1', ['a'], 600, 80),
      mk('d2', ['a'], 600, 80)
    ].map((r) => ({ ...r, run: { ...r.run, approvalCount: 0 } }))
    const cmp = compareRuns(baseline, candidate)
    expect(cmp.delta.successRate).toBe(0)
    expect(cmp.delta.avgTokens).toBe(-400)
    expect(cmp.delta.avgLatencyMs).toBe(-20)
    expect(cmp.delta.totalHumanInterventions).toBe(-2)
    expect(cmp.delta.avgToolCalls).toBe(0)
  })

  it('delta 计算：多调用工具会抬高平均工具调用数', () => {
    // 期望集在两个版本间一致（candidate 额外多调一个未期望工具 → 精确率下降、调用数上升）
    const baseline = [mk('m1', ['a'], 500, 50), mk('m2', ['a'], 500, 50)]
    const candidate = [
      mk('m1', ['a'], 500, 50, ['a', 'b']),
      mk('m2', ['a'], 500, 50, ['a', 'b'])
    ]
    const cmp = compareRuns(baseline, candidate)
    expect(cmp.delta.avgToolCalls).toBe(1)
    expect(cmp.delta.successRate).toBe(0)
  })

  it('addedTools / removedTools 与 token/延迟差异', () => {
    const baseline = [mk('t1', ['a', 'b'], 500, 50)]
    const candidate = [mk('t1', ['a', 'b'], 700, 70, ['a', 'c'])]
    const diff = compareRuns(baseline, candidate).diffs[0]
    expect(diff.addedTools).toEqual(['c'])
    expect(diff.removedTools).toEqual(['b'])
    expect(diff.tokenDelta).toBe(200)
    expect(diff.latencyDeltaMs).toBe(20)
    expect(diff.toolCallDelta).toBe(0)
  })

  it('接受 EvalReport 形态（含 results 字段）', () => {
    const asReport = (results: EvalResult[]) => ({
      timestamp: '20260101-000000',
      label: 'test',
      results: results.map((r) => ({ id: r.case.id, case: r.case, run: r.run, success: r.success }))
    })
    // baseline 漏调 → 失败；candidate 补上 → 成功
    const cmp = compareRuns(asReport([mk('r1', ['a'], 100, 10, [])]), asReport([mk('r1', ['a'], 100, 10)]))
    expect(cmp.fixed).toEqual(['r1'])
  })

  it('接受落盘的「平铺」报告（不含 case 对象，只有 id/name/category/success）', () => {
    // runner.writeReport 出于体积考虑不序列化 case；compare 必须仍能工作。
    const flat = (success: boolean, tokens: number) => ({
      timestamp: 't',
      label: 'l',
      results: [
        {
          id: 'flat-1',
          name: '平铺用例',
          category: 'literature' as EvalCase['category'],
          difficulty: 'hard' as EvalCase['difficulty'],
          success,
          failures: success ? [] : ['构造失败'],
          run: makeRun({ usage: { totalTokens: tokens }, durationMs: 10, toolCalls: calls('a') })
        }
      ]
    })
    const cmp = compareRuns(flat(false, 100), flat(true, 80))
    expect(cmp.onlyInBaseline).toEqual([])
    expect(cmp.onlyInCandidate).toEqual([])
    expect(cmp.diffs[0].id).toBe('flat-1')
    expect(cmp.diffs[0].name).toBe('平铺用例')
    expect(cmp.diffs[0].transition).toBe('fixed')
    expect(cmp.fixed).toEqual(['flat-1'])
    // 分组统计也要能拿到 category/difficulty
    expect(cmp.baseline.byCategory.literature.total).toBe(1)
    expect(cmp.baseline.byDifficulty.hard.total).toBe(1)
    expect(cmp.delta.avgTokens).toBe(-20)
  })

  it('formatCompareReport 输出含关键段落', () => {
    const text = formatCompareReport(
      compareRuns([mk('z1', ['a'], 100, 10, [])], [mk('z1', ['a'], 120, 12)])
    )
    expect(text).toContain('A/B 对比报告')
    expect(text).toContain('转成功')
    expect(text).toContain('z1')
  })
})
