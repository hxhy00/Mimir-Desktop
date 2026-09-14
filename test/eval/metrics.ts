/**
 * 评测指标计算（纯函数）。
 *
 * 设计约束：
 * 1. **纯函数**：不读文件、不发网络、不依赖 Date.now/Math.random，输入输出确定 → 可单测、可复现。
 * 2. **依赖倒置**：只依赖 {@link EvalRun} 这一数据结构，不绑定具体 Agent 实现。
 * 3. **不判定「事实正确性」**：自动指标只覆盖「工具调用是否合规 + 成本/延迟」，
 *    产出质量由 `EvalCase.expected.rubric` 交人工/LLM 评审。
 */
import type { EvalCase, EvalCategory, EvalDifficulty } from './cases'

/** 单次工具调用记录（从 Agent 消息流中抽出，与具体 SDK 解耦）。 */
export interface ToolCallRecord {
  /** 工具 id，例如 `paper_search`。 */
  name: string
  /** 调用参数（可选，用于人工排查；不参与自动判定）。 */
  args?: unknown
  /** 该次调用的耗时（毫秒，可选）。 */
  durationMs?: number
  /** 是否因错误返回（可选，用于区分「调了但失败」）。 */
  error?: boolean
}

/** token 用量（字段与主流 SDK 命名对齐，缺失按 0 计）。 */
export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  /** 若上游只给总量，可直接填这里；否则由 input+output 推导。 */
  totalTokens?: number
}

/** 单次评测运行结果（由 runOne 适配器产出）。 */
export interface EvalRun {
  /** 对应的用例 id（适配器回填，便于校验）。 */
  caseId?: string
  /** 本轮完整消息序列（角色 + 内容），用于人工排查。 */
  messages: { role: 'system' | 'user' | 'assistant' | 'tool'; content: string }[]
  /** 本轮全部工具调用（顺序即真实调用顺序）。 */
  toolCalls: ToolCallRecord[]
  usage: TokenUsage
  /** 端到端耗时（毫秒）。 */
  durationMs: number
  /** 触发的批准卡次数（人工干预次数）。 */
  approvalCount: number
  /** Agent 的最终回复文本。 */
  finalOutput: string
  /**
   * 运行级错误（超时 / 执行器抛错）——由 runner 兜底填充，非空即判定失败。
   *
   * 为什么需要独立字段：兜底 run 的 `finalOutput` 是一段**非空**的说明文字（如
   * 「[评测运行失败] 用例 X 超时」），若判定只看工具调用，负例（期望不调用工具）
   * 会把「运行根本没跑起来」误判为通过。
   */
  runError?: string
  /**
   * 本轮实际采用的 Ultra 增强策略（未开启增强时缺省）。
   *
   * 记录它的唯一目的：让 A/B 报告能**自证增强真的生效了**。若两版都跑出空值，
   * 说明 Ultra 并未接入执行路径，此时的「无差异」结论无效（这正是本字段要防的坑）。
   */
  ultraStrategy?: string
  /**
   * 观测到的落盘产物路径（**observed-only，不参与 pass/fail 判定**）。
   *
   * 由适配器用 `extractArtifacts()` 从工具返回里解析后填入，报告只做展示供人工核对。
   * 原因：产物路径受模型措辞影响大（同级目录 / 相对路径 / 临时文件名都会变），
   * 做成硬判定会持续误杀好模型，把评测集变成噪声源。判定仍只由 mustCall/mustNotCall 决定。
   */
  artifacts?: string[]
}

/** 单条用例的一次运行记录（用例 + 运行 + 判定）。 */
export interface EvalResult {
  case: EvalCase
  run: EvalRun
  success: boolean
  /** 失败原因（success 为 true 时为空数组）。 */
  failures: string[]
  /** 本次调用到的工具 id（去重后按首次出现顺序）。 */
  calledTools: string[]
}

/**
 * 运行有效性下限（floor）：返回失败原因；返回 null 表示这一轮确实产生了可判定的执行。
 *
 * ── 为什么必须有 ────────────────────────────────────────────────────────────
 * 负例只写 `mustNotCallTools`（期望「不调用某些工具」）。当模型彻底没响应时
 * （网关不可达 / 空回 / 运行超时），实际调用集合为空 —— **零调用自然满足「没有调用禁止的工具」**，
 * 于是负例全部假通过。后果有双重：
 * 1. 成功率被虚高，且**模型越坏、负例越好看**，方向是反的；
 * 2. A/B 会得出错误结论：若某版本更容易失败（如增强层把请求拖超时），它的负例反而「变好」。
 *
 * 判据（任一成立即视为「未执行」）：
 * - `runError` 非空（runner 兜底的超时 / 抛错）；
 * - 最终输出为空 **且** 没有任何工具调用（模型空回，或本轮什么都没做）。
 *
 * 注意这只做「有没有真跑」的下限判定，不涉及事实正确性（那仍归 `rubric` 人工评审）。
 */
export function runInvalidReason(run: EvalRun): string | null {
  const err = typeof run.runError === 'string' ? run.runError.trim() : ''
  if (err !== '') return `运行失败：${err}`
  const hasOutput = typeof run.finalOutput === 'string' && run.finalOutput.trim() !== ''
  const hasTools = Array.isArray(run.toolCalls) && run.toolCalls.length > 0
  if (!hasOutput && !hasTools) return '本轮未产出任何回答、也未调用任何工具（模型空回或网关不可达）'
  return null
}

/**
 * 任务成功判定：工具调用是否符合 mustCallTools / mustNotCallTools。
 *
 * 规则（按顺序）：
 * 0. **运行有效性下限**：见 {@link runInvalidReason}——没跑起来的运行一律失败；
 * 1. 任一 `mustCallTools` 未被调用 → 失败；
 * 2. 任一 `mustNotCallTools` 被调用 → 失败（含调用后报错的情况，因为「不该调」就是不该调）；
 * 3. 全部满足 → 成功。
 *
 * 注意：`expectedArtifacts` / `rubric` 不参与自动判定。
 */
export function taskSuccess(testCase: EvalCase, run: EvalRun): boolean {
  return checkCase(testCase, run).success
}

/** taskSuccess 的详细版：同时返回失败原因，供报告使用。 */
export function checkCase(testCase: EvalCase, run: EvalRun): { success: boolean; failures: string[] } {
  const called = collectCalledTools(run)
  const failures: string[] = []

  // 0) 先确认这一轮真的跑起来了，再看工具调用是否合规（见 runInvalidReason 的说明）。
  const invalid = runInvalidReason(run)
  if (invalid !== null) failures.push(invalid)

  for (const id of testCase.expected.mustCallTools ?? []) {
    if (!called.has(id)) failures.push(`缺少必需工具调用：${id}`)
  }
  for (const id of testCase.expected.mustNotCallTools ?? []) {
    if (called.has(id)) failures.push(`调用了禁止的工具：${id}`)
  }
  return { success: failures.length === 0, failures }
}

/** 把工具调用去重为 id 集合。 */
function collectCalledTools(run: EvalRun): Set<string> {
  const set = new Set<string>()
  for (const call of run.toolCalls) set.add(call.name)
  return set
}

/** 本次运行实际调用到的工具 id（去重，保留首次出现顺序）。 */
export function calledToolIds(run: EvalRun): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const call of run.toolCalls) {
    if (!seen.has(call.name)) {
      seen.add(call.name)
      out.push(call.name)
    }
  }
  return out
}

/** 工具调用精确率/召回率/F1（按「工具 id 集合」计算，与调用次数无关）。 */
export interface ToolPRF {
  /** 期望调用的工具集合（mustCallTools）。 */
  expected: string[]
  /** 实际调用的工具集合（去重）。 */
  actual: string[]
  /** 命中的期望工具。 */
  truePositives: string[]
  /** 调了但不在期望集合内的工具。 */
  unexpected: string[]
  /** 期望但没调的工具。 */
  missed: string[]
  precision: number
  recall: number
  f1: number
}

/** 计算工具精确率/召回率（期望集为空时 precision/recall 定义为 1，避免除零）。 */
export function toolPrecisionRecall(testCase: EvalCase, run: EvalRun): ToolPRF {
  const expected = unique(testCase.expected.mustCallTools ?? [])
  const actual = calledToolIds(run)
  const actualSet = new Set(actual)
  const expectedSet = new Set(expected)

  const truePositives = expected.filter((id) => actualSet.has(id))
  const unexpected = actual.filter((id) => !expectedSet.has(id))
  const missed = expected.filter((id) => !actualSet.has(id))

  const precision = actual.length === 0 ? (expected.length === 0 ? 1 : 0) : truePositives.length / actual.length
  const recall = expected.length === 0 ? 1 : truePositives.length / expected.length
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)

  return { expected, actual, truePositives, unexpected, missed, precision, recall, f1 }
}

/** 本次运行的调用工具总次数（含重复调用）。 */
export function countToolCalls(run: EvalRun): number {
  return run.toolCalls.length
}

/** token 总量：优先用 totalTokens，否则 input+output（缺省按 0）。 */
export function sumTokens(run: EvalRun): number {
  const { inputTokens = 0, outputTokens = 0, totalTokens } = run.usage ?? {}
  if (typeof totalTokens === 'number') return totalTokens
  return inputTokens + outputTokens
}

/** 端到端延迟（毫秒）；负数/缺失归零，保证统计不产生脏数据。 */
export function latencyMs(run: EvalRun): number {
  const d = run.durationMs
  return typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : 0
}

/** 人工干预次数（批准卡触发次数）。 */
export function humanInterventions(run: EvalRun): number {
  const n = run.approvalCount
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0
}

/** 按分类维度的聚合统计。 */
export interface GroupStat {
  total: number
  passed: number
  successRate: number
}

/** 聚合报告。 */
export interface EvalSummary {
  total: number
  passed: number
  failed: number
  /** 成功率 [0,1]。 */
  successRate: number
  /** 平均工具调用次数。 */
  avgToolCalls: number
  /** 平均 token 用量。 */
  avgTokens: number
  /** 平均延迟（毫秒）。 */
  avgLatencyMs: number
  /** P95 延迟（毫秒）。 */
  p95LatencyMs: number
  /** 总人工干预次数。 */
  totalHumanInterventions: number
  /** 平均工具精确率 / 召回率。 */
  avgToolPrecision: number
  avgToolRecall: number
  /** 按能力域聚合。 */
  byCategory: Record<EvalCategory, GroupStat>
  /** 按难度聚合。 */
  byDifficulty: Record<EvalDifficulty, GroupStat>
  /** 失败用例清单（id + 原因）。 */
  failures: { id: string; name: string; failures: string[] }[]
}

/**
 * 聚合运行结果。
 *
 * 入参可以是 `EvalResult[]`（已判定）或 `{ case, run }[]`（未判定，内部现算）。
 */
export function summarize(runs: readonly EvalResultLike[]): EvalSummary {
  const results: EvalResult[] = runs.map(toResult)
  const total = results.length
  const passed = results.filter((r) => r.success).length

  const latencies = results.map((r) => latencyMs(r.run)).sort((a, b) => a - b)

  const sum = (fn: (r: EvalResult) => number): number => results.reduce((acc, r) => acc + fn(r), 0)
  const avg = (fn: (r: EvalResult) => number): number => (total === 0 ? 0 : round(sum(fn) / total))

  const byCategory = emptyCategoryRecord()
  const byDifficulty: Record<EvalDifficulty, GroupStat> = {
    easy: { total: 0, passed: 0, successRate: 0 },
    medium: { total: 0, passed: 0, successRate: 0 },
    hard: { total: 0, passed: 0, successRate: 0 }
  }
  for (const r of results) {
    bump(byCategory[r.case.category], r.success)
    bump(byDifficulty[r.case.difficulty], r.success)
  }
  for (const stat of [...Object.values(byCategory), ...Object.values(byDifficulty)]) {
    stat.successRate = stat.total === 0 ? 0 : round(stat.passed / stat.total, 4)
  }

  return {
    total,
    passed,
    failed: total - passed,
    successRate: total === 0 ? 0 : round(passed / total, 4),
    avgToolCalls: avg((r) => countToolCalls(r.run)),
    avgTokens: avg((r) => sumTokens(r.run)),
    avgLatencyMs: avg((r) => latencyMs(r.run)),
    p95LatencyMs: percentile(latencies, 0.95),
    totalHumanInterventions: sum((r) => humanInterventions(r.run)),
    avgToolPrecision: avg((r) => toolPrecisionRecall(r.case, r.run).precision),
    avgToolRecall: avg((r) => toolPrecisionRecall(r.case, r.run).recall),
    byCategory,
    byDifficulty,
    failures: results
      .filter((r) => !r.success)
      .map((r) => ({ id: r.case.id || (r.run.caseId ?? ''), name: r.case.name, failures: r.failures }))
  }
}

/** summarize 入参允许「已判定结果」或「裸的 case+run 对」。 */
export type EvalResultLike = EvalResult | { case: EvalCase; run: EvalRun }

function toResult(like: EvalResultLike): EvalResult {
  if ('success' in like && 'failures' in like && 'calledTools' in like) return like
  const { case: c, run } = like as { case: EvalCase; run: EvalRun }
  const { success, failures } = checkCase(c, run)
  return { case: c, run, success, failures, calledTools: calledToolIds(run) }
}

/** 某个分类的单个统计对象。 */
interface MutableStat {
  total: number
  passed: number
  successRate: number
}

function bump(stat: MutableStat, success: boolean): void {
  stat.total += 1
  if (success) stat.passed += 1
}

function emptyCategoryRecord(): Record<EvalCategory, GroupStat> {
  return {
    literature: { total: 0, passed: 0, successRate: 0 },
    paper: { total: 0, passed: 0, successRate: 0 },
    experiment: { total: 0, passed: 0, successRate: 0 },
    meeting: { total: 0, passed: 0, successRate: 0 },
    server: { total: 0, passed: 0, successRate: 0 },
    files: { total: 0, passed: 0, successRate: 0 },
    other: { total: 0, passed: 0, successRate: 0 }
  }
}

/**
 * 最近秩百分位（linear interpolation，n=1 时直接返回该值）。
 * 用最近秩而非「四舍五入取第 k 个」，样本很少时也稳定。
 */
export function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0
  if (sortedAsc.length === 1) return sortedAsc[0]
  const rank = p * (sortedAsc.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return sortedAsc[lo]
  const weight = rank - lo
  return round(sortedAsc[lo] * (1 - weight) + sortedAsc[hi] * weight)
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)]
}

function round(n: number, digits = 2): number {
  if (!Number.isFinite(n)) return 0
  const f = 10 ** digits
  return Math.round(n * f) / f
}

// ───────────────────────────── 对比模式（A/B） ─────────────────────────────

/** 单条用例在两个版本间的差异。 */
export interface CaseDiff {
  id: string
  name: string
  /** baseline 是否成功。 */
  baselineSuccess: boolean
  candidateSuccess: boolean
  /** 状态迁移类型，便于报告分组。 */
  transition: 'fixed' | 'regressed' | 'unchanged-pass' | 'unchanged-fail'
  /** candidate - baseline（正数=变多）。 */
  tokenDelta: number
  latencyDeltaMs: number
  toolCallDelta: number
  /** candidate 相对 baseline 新增调用的工具。 */
  addedTools: string[]
  /** candidate 相对 baseline 丢失的调用工具。 */
  removedTools: string[]
}

/** 两版评测报告的对比结果。 */
export interface CompareResult {
  /** baseline / candidate 各自的聚合摘要。 */
  baseline: EvalSummary
  candidate: EvalSummary
  /** 只出现在其中一版的用例 id。 */
  onlyInBaseline: string[]
  onlyInCandidate: string[]
  /** 逐条差异（两版都有的用例）。 */
  diffs: CaseDiff[]
  /** 由失败转成功的用例 id —— A/B 最重要的信号。 */
  fixed: string[]
  /** 由成功转失败的用例 id。 */
  regressed: string[]
  /** 整体变化量。 */
  delta: {
    successRate: number
    avgTokens: number
    avgLatencyMs: number
    totalHumanInterventions: number
    avgToolCalls: number
  }
}

/**
 * compareRuns 的评价单位（一次运行的完整报告）。
 *
 * `case` 是可选的：runner 落盘的 JSON 出于体积考虑**不序列化 case 对象**，
 * 而是平铺 `id`/`name`/`category`/`difficulty`/`success`/`failures`。
 * 因此这里把两者都视为合法输入，normalize 时按需重建最小 case。
 */
export interface EvalReport {
  timestamp?: string
  label?: string
  results: {
    id?: string
    name?: string
    category?: EvalCategory
    difficulty?: EvalDifficulty
    success?: boolean
    failures?: string[]
    case?: EvalCase
    run: EvalRun
  }[]
  summary?: EvalSummary
}

/**
 * 对比两版评测结果（baseline 与 candidate）。
 *
 * 入参支持两种形态：
 * - `EvalReport`（runner 落盘的 JSON 结构，含 `results`）；
 * - `EvalResultLike[]`（内存中的结果数组）。
 *
 * 不抛异常：缺失的字段按「缺失即 0 / 不存在」处理，保证对比脚本不会因脏数据崩溃。
 */
export function compareRuns(baseline: EvalReport | EvalResultLike[], candidate: EvalReport | EvalResultLike[]): CompareResult {
  const baseResults = normalize(baseline)
  const candResults = normalize(candidate)
  const baseMap = new Map(baseResults.map((r) => [r.case.id, r]))
  const candMap = new Map(candResults.map((r) => [r.case.id, r]))

  const onlyInBaseline = [...baseMap.keys()].filter((id) => !candMap.has(id))
  const onlyInCandidate = [...candMap.keys()].filter((id) => !baseMap.has(id))

  const diffs: CaseDiff[] = []
  const fixed: string[] = []
  const regressed: string[] = []

  for (const [id, b] of baseMap) {
    const c = candMap.get(id)
    if (!c) continue
    const bTools = calledToolIds(b.run)
    const cTools = calledToolIds(c.run)
    const bSet = new Set(bTools)
    const cSet = new Set(cTools)
    const transition: CaseDiff['transition'] =
      !b.success && c.success
        ? 'fixed'
        : b.success && !c.success
          ? 'regressed'
          : b.success
            ? 'unchanged-pass'
            : 'unchanged-fail'
    if (transition === 'fixed') fixed.push(id)
    if (transition === 'regressed') regressed.push(id)

    diffs.push({
      id,
      name: c.case.name,
      baselineSuccess: b.success,
      candidateSuccess: c.success,
      transition,
      tokenDelta: sumTokens(c.run) - sumTokens(b.run),
      latencyDeltaMs: latencyMs(c.run) - latencyMs(b.run),
      toolCallDelta: countToolCalls(c.run) - countToolCalls(b.run),
      addedTools: cTools.filter((t) => !bSet.has(t)),
      removedTools: bTools.filter((t) => !cSet.has(t))
    })
  }

  const baseSummary = summarizeEvalResults(baseResults)
  const candSummary = summarizeEvalResults(candResults)

  return {
    baseline: baseSummary,
    candidate: candSummary,
    onlyInBaseline,
    onlyInCandidate,
    diffs,
    fixed,
    regressed,
    delta: {
      successRate: round(candSummary.successRate - baseSummary.successRate, 4),
      avgTokens: round(candSummary.avgTokens - baseSummary.avgTokens),
      avgLatencyMs: round(candSummary.avgLatencyMs - baseSummary.avgLatencyMs),
      totalHumanInterventions: candSummary.totalHumanInterventions - baseSummary.totalHumanInterventions,
      avgToolCalls: round(candSummary.avgToolCalls - baseSummary.avgToolCalls)
    }
  }
}

function normalize(input: EvalReport | EvalResultLike[]): EvalResult[] {
  if (Array.isArray(input)) return input.map(toResult)
  const raw = (input as EvalReport).results ?? []
  return raw.map((r) => {
    // 优先用报告内嵌的 case；落盘报告不含 case 时，用平铺字段重建一个最小 case。
    const testCase: EvalCase =
      r.case ??
      ({
        id: r.id ?? r.run.caseId ?? '?',
        name: r.name ?? r.id ?? '?',
        category: r.category ?? 'other',
        input: '',
        expected: {},
        difficulty: r.difficulty ?? 'easy',
        notes: ''
      } satisfies EvalCase)

    // 报告里已带 success 就采信它（落盘报告不含 expected，无法重新判定）；
    // 否则用 case.expected 现算。
    const judged = checkCase(testCase, r.run)
    const success = typeof r.success === 'boolean' ? r.success : judged.success
    const failures =
      typeof r.success === 'boolean'
        ? (r.failures ?? judged.failures)
        : judged.failures

    return {
      case: testCase,
      run: r.run,
      success,
      failures,
      calledTools: calledToolIds(r.run)
    }
  })
}

function summarizeEvalResults(results: EvalResult[]): EvalSummary {
  return summarize(results)
}

/** 把对比结果渲染成可读的纯文本（供 CLI 输出，不依赖任何表格库）。 */
export function formatCompareReport(result: CompareResult): string {
  const lines: string[] = []
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`
  const signed = (n: number): string => (n > 0 ? `+${n}` : String(n))

  lines.push('=== A/B 对比报告 ===')
  lines.push(
    `成功率：${pct(result.baseline.successRate)} → ${pct(result.candidate.successRate)} (${signed(
      round(result.delta.successRate * 100, 1)
    )}pp)`
  )
  lines.push(`平均 token：${result.baseline.avgTokens} → ${result.candidate.avgTokens} (${signed(result.delta.avgTokens)})`)
  lines.push(
    `平均延迟：${result.baseline.avgLatencyMs}ms → ${result.candidate.avgLatencyMs}ms (${signed(
      result.delta.avgLatencyMs
    )}ms)`
  )
  lines.push(
    `人工干预总数：${result.baseline.totalHumanInterventions} → ${result.candidate.totalHumanInterventions} (${signed(
      result.delta.totalHumanInterventions
    )})`
  )
  lines.push('')
  lines.push(`转成功 (${result.fixed.length})：${result.fixed.join(', ') || '无'}`)
  lines.push(`转失败 (${result.regressed.length})：${result.regressed.join(', ') || '无'}`)
  if (result.onlyInBaseline.length > 0) lines.push(`仅 baseline 有：${result.onlyInBaseline.join(', ')}`)
  if (result.onlyInCandidate.length > 0) lines.push(`仅 candidate 有：${result.onlyInCandidate.join(', ')}`)

  const changed = result.diffs.filter(
    (d) => d.transition === 'fixed' || d.transition === 'regressed' || d.tokenDelta !== 0 || d.toolCallDelta !== 0
  )
  if (changed.length > 0) {
    lines.push('')
    lines.push('逐条差异：')
    for (const d of changed) {
      const parts = [`[${d.transition}]`, d.id]
      if (d.tokenDelta !== 0) parts.push(`token ${signed(d.tokenDelta)}`)
      if (d.latencyDeltaMs !== 0) parts.push(`延迟 ${signed(d.latencyDeltaMs)}ms`)
      if (d.toolCallDelta !== 0) parts.push(`工具调用 ${signed(d.toolCallDelta)}`)
      if (d.addedTools.length > 0) parts.push(`新增工具 ${d.addedTools.join('|')}`)
      if (d.removedTools.length > 0) parts.push(`丢失工具 ${d.removedTools.join('|')}`)
      lines.push(`  ${parts.join('  ')}`)
    }
  }
  return lines.join('\n')
}
