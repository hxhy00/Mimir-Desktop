/**
 * 评测运行器（评测基础设施的「执行编排」层）。
 *
 * 职责边界（刻意收窄）：
 * - 本模块**不**知道 Agent 怎么跑、怎么调用模型。它只做：筛选用例 → 并发调度 →
 *   超时控制 → 调用注入的执行器 → 收集结果 → 交给 metrics 聚合。
 * - 「怎么跑一条用例」由 {@link CaseRunner} 注入（依赖倒置）。这样同一套评测可以接
 *   真实 Agent、mock、或未来的其它 Agent 实现，而评测逻辑本身零改动。
 *
 * 与 metrics.ts 的分工：
 * - runner.ts：有副作用（计时、落盘、并发）→ 不可单测纯函数部分，但接口可注入；
 * - metrics.ts：纯函数 → 单测覆盖。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import type { EvalCase, EvalCategory, EvalDifficulty } from './cases.ts'
import { EVAL_CASES } from './cases.ts'
import { compareRuns, formatCompareReport, checkCase, calledToolIds, summarize } from './metrics.ts'
import type { CompareResult, EvalRun, EvalSummary } from './metrics.ts'

/**
 * 执行器：跑一条用例，返回一次运行记录。这是唯一需要用户提供的接入点。
 *
 * `observe` 是可选的「先登记」通道：执行器在**任何可能超时的长操作之前**，把此刻已确定的
 * 字段（如实际采用的 Ultra 策略）登记进来。这样即便该用例最终超时、外层只能用兜底 run
 * 替代，这些字段也不会丢。
 *
 * 为什么需要它：超时用例恰恰最需要知道「这一轮用了什么增强」—— 若某策略把 token/时长
 * 烧爆导致超时，报告里却只显示一句「超时」，A/B 就无从归因。
 */
export type CaseRunner = (
  testCase: EvalCase,
  observe?: (patch: Partial<EvalRun>) => void,
  /**
   * 用例级取消信号：超时触发 abort。**执行器必须把它透传给底层模型/图调用**，
   * 否则超时只会 reject 外层 promise、底层 agent 继续跑（见 runEval 内的说明）。
   */
  signal?: AbortSignal
) => Promise<EvalRun> | EvalRun

/** runEvalSuite 的逐条结果。 */
export interface SuiteResult {
  results: {
    id: string
    name: string
    category: EvalCategory
    difficulty: EvalDifficulty
    success: boolean
    failures: string[]
    calledTools: string[]
    toolCalls: number
    tokens: number
    latencyMs: number
    approvalCount: number
    /** 本轮实际采用的 Ultra 策略（未开增强时为空串）。 */
    ultraStrategy: string
    run: EvalRun
  }[]
}

export interface RunEvalOptions {
  /** 待跑用例，默认 {@link EVAL_CASES}。 */
  cases?: readonly EvalCase[]
  /** 执行器（必填）。 */
  runner: CaseRunner
  /** 只跑这些能力域。 */
  categories?: readonly EvalCategory[]
  /** 只跑这些难度。 */
  difficulties?: readonly EvalDifficulty[]
  /** 只跑这些用例 id。 */
  ids?: readonly string[]
  /** 并发度，默认 1（串行，便于看日志）。 */
  concurrency?: number
  /** 单条用例超时（毫秒），默认 120_000。超时记为失败，不中断整轮。 */
  timeoutMs?: number
  /** 报告落盘目录，默认 `test/eval/results`。传 null 表示不落盘。 */
  resultsDir?: string | null
  /** 报告标签，用于区分「单 Agent」「单 Agent + Ultra」等版本。 */
  label?: string
  /** 进度回调（可注入 stdout 封装，便于测试捕获）。 */
  onProgress?: (info: { index: number; total: number; id: string; success: boolean }) => void
  /** 落盘文件的时间戳字符串（注入以便测试确定性）；默认用当前时间。 */
  timestamp?: string
  /** 当前时间源（注入以便测试确定性）。 */
  now?: () => number
  /** 本次用的执行器种类，写进报告防止有人拿 mock 结果当结论。默认 'mock'。 */
  runnerKind?: RunnerKind
  /**
   * 断点续跑文件（可选）：每条用例跑完就落盘一次；下次以**同一 label** 启动时跳过已完成用例。
   *
   * 为什么需要：真实评测真打网关、真花钱，而网关限流（429）与偶发崩溃会在一轮中途打断 ——
   * 没有断点就意味着一整轮已消耗的 token 全部白烧（本项目连续废过两轮）。
   * 文件按 label 区分，避免基线臂与对照臂互相污染；整轮跑完后自动删除。
   */
  checkpointFile?: string | null
}

/** 执行器种类（写进报告，防止把 mock 的成功率当成真实结论）。 */
export type RunnerKind = 'mock' | 'real'

/** 落盘的评测报告结构。 */
export interface EvalReportFile {
  timestamp: string
  label: string
  /** 生成时间（ISO），便于人看。 */
  generatedAt: string
  /**
   * 执行器种类：`mock`（理想化响应，成功率恒 100%，只用于校准指标）
   * 或 `real`（真实模型，结论有效）。
   */
  runner: RunnerKind
  filter: { categories: string[]; difficulties: string[]; ids: string[] }
  summary: EvalSummary
  results: {
    id: string
    name: string
    category: EvalCategory
    difficulty: EvalDifficulty
    success: boolean
    failures: string[]
    calledTools: string[]
    toolCalls: number
    tokens: number
    latencyMs: number
    approvalCount: number
    /** 本轮实际采用的 Ultra 策略（未开增强时为空串）。 */
    ultraStrategy: string
    finalOutput: string
    /** 观测到的产物路径（observed-only，供人工核对，不参与判定）。 */
    artifacts: string[]
    /** 完整运行记录，供人工复盘与重新判定。 */
    run: EvalRun
  }[]
}

/**
 * 单条用例执行失败的兜底 EvalRun（超时/抛错时使用）。
 *
 * `observed` 是执行器在超时前通过 `observe` 登记过的字段（如实际采用的 Ultra 策略），
 * 先展开、再由下面的固定字段覆盖同名键，保证 runError / finalOutput 这类权威字段不被污染。
 */
function errorRun(
  caseId: string,
  reason: string,
  durationMs: number,
  observed: Partial<EvalRun> = {}
): EvalRun {
  return {
    ...observed,
    caseId,
    messages: [{ role: 'assistant', content: `[评测运行失败] ${reason}` }],
    toolCalls: [],
    usage: {},
    durationMs,
    approvalCount: 0,
    finalOutput: `[评测运行失败] ${reason}`,
    // 显式标记运行级错误：判定层据此把「没跑起来」判为失败。
    // 不依赖 finalOutput 的文案前缀去嗅探（文案会变，且那是展示用途）。
    runError: reason
  }
}

/** 按过滤条件筛选用例（顺序保持与 {@link EVAL_CASES} 一致）。 */
export function filterCases(
  cases: readonly EvalCase[],
  opts: Pick<RunEvalOptions, 'categories' | 'difficulties' | 'ids'>
): EvalCase[] {
  const catSet = opts.categories && opts.categories.length > 0 ? new Set(opts.categories) : undefined
  const diffSet = opts.difficulties && opts.difficulties.length > 0 ? new Set(opts.difficulties) : undefined
  const idSet = opts.ids && opts.ids.length > 0 ? new Set(opts.ids) : undefined
  return cases.filter(
    (c) =>
      (catSet === undefined || catSet.has(c.category)) &&
      (diffSet === undefined || diffSet.has(c.difficulty)) &&
      (idSet === undefined || idSet.has(c.id))
  )
}

/** 给一个 Promise 加超时：超时 reject，原 promise 继续跑但不影响结果。 */
function withTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return task
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`用例 ${label} 超时（>${timeoutMs}ms）`)), timeoutMs)
    task.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

/** 简单并发池：按 concurrency 分批执行（保持结果顺序与输入顺序一致）。 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const limit = Math.max(1, Math.floor(concurrency))
  const results = new Array<R>(items.length)
  let cursor = 0
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

/**
 * 跑一轮评测。
 *
 * @example 单测里用 mock 执行器跑全链路
 * const report = await runEval({ runner: fakeRunner, resultsDir: null })
 */
export async function runEval(opts: RunEvalOptions): Promise<EvalReportFile> {
  const {
    cases = EVAL_CASES,
    runner,
    concurrency = 1,
    timeoutMs = 120_000,
    resultsDir = defaultResultsDir(),
    label = 'unlabeled',
    onProgress,
    timestamp = defaultTimestamp(),
    now = () => Date.now(),
    runnerKind = 'mock'
  } = opts

  const checkpointFile = opts.checkpointFile ?? null
  // 断点续跑：同 label 的断点文件里已完成的用例直接跳过（省 token，也少一次被限流的机会）。
  const resumed = checkpointFile !== null ? readCheckpoint(checkpointFile, label) : []
  const resumedIds = new Set(resumed.map((r) => r.id))
  const selected = filterCases(cases, opts).filter((c) => !resumedIds.has(c.id))
  /** 本轮累计结果（断点载入 + 本次新跑）——最终报告由它构建。 */
  const accumulated: SuiteResult['results'] = [...resumed]
  if (resumed.length > 0) {
    process.stdout.write(
      `⏩ 断点续跑：载入 ${resumed.length} 条已完成用例（${[...resumedIds].join(', ')}），本次跳过。\n`
    )
  }
  const buildNow = (): EvalReportFile =>
    buildReport({
      results: sortByCaseOrder(accumulated, cases),
      label,
      timestamp,
      runner: runnerKind,
      filter: { categories: opts.categories ?? [], difficulties: opts.difficulties ?? [], ids: opts.ids ?? [] }
    })
  const persistCheckpoint = (): void => {
    if (checkpointFile === null) return
    try {
      writeCheckpoint(checkpointFile, buildNow())
    } catch (error) {
      // 断点是尽力而为：写不进去不该影响本轮评测。
      console.warn('[eval] 写断点失败（不影响本轮）：', error)
    }
  }

  const results = await mapWithConcurrency(selected, concurrency, async (testCase, index) => {
    const started = now()
    let run: EvalRun
    // 「先登记」通道：执行器可在长操作（模型调用）之前登记已确定字段；
    // 用例超时时由 errorRun 继承，避免「超时了但不知道为什么贵」。
    const observed: Partial<EvalRun> = {}
    const observe = (patch: Partial<EvalRun>): void => {
      Object.assign(observed, patch)
    }
    // ── 超时必须**真的取消**底层工作 ────────────────────────────────────────
    // `withTimeout` 只 reject 外层 promise，底层 agent 不会停：它会继续跑完、继续烧 token，
    // 并且每个超时用例都留下一个仍在运行的图实例。实测后果：26 条用例跑到第 6 条之后
    // 进程被静默杀死（内存持续增长，且失败用例多为联网/耗时工具，超时集中发生）。
    // 因此这里给每条用例配一个 AbortController，超时即 abort，并把 signal 透传给执行器。
    const controller = new AbortController()
    const abortTimer =
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null
    try {
      run = await withTimeout(Promise.resolve(runner(testCase, observe, controller.signal)), timeoutMs, testCase.id)
    } catch (err) {
      run = errorRun(
        testCase.id,
        err instanceof Error ? err.message : String(err),
        Math.max(0, now() - started),
        observed
      )
    } finally {
      if (abortTimer !== null) clearTimeout(abortTimer)
    }
    const { success, failures } = checkCase(testCase, run)
    onProgress?.({ index: index + 1, total: selected.length, id: testCase.id, success })
    const entry: SuiteResult['results'][number] = {
      id: testCase.id,
      name: testCase.name,
      category: testCase.category,
      difficulty: testCase.difficulty,
      success,
      failures,
      calledTools: calledToolIds(run),
      toolCalls: run.toolCalls.length,
      tokens: 0,
      latencyMs: 0,
      approvalCount: 0,
      ultraStrategy: run.ultraStrategy ?? '',
      run
    }
    // 跑一条存一条：中途被限流/崩溃时，已完成的用例不会白跑。
    accumulated.push(entry)
    persistCheckpoint()
    return entry
  })

  const report = buildNow()

  if (resultsDir !== null) writeReport(report, resultsDir)
  // 整轮跑完即清断点：否则下次以同 label 启动会被误判为「全部已完成」而整轮跳过。
  if (checkpointFile !== null) {
    try {
      rmSync(checkpointFile, { force: true })
    } catch {
      // 清理失败无伤：下次续跑会走「跳过已完成」的分支，行为仍正确（只是白跳过一轮）。
    }
  }
  return report
}

/** 把断点文件写成一个**合法报告**（便于人肉查看，也能直接喂给 compareRuns 调试）。 */
function writeCheckpoint(file: string, report: EvalReportFile): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(report, null, 2), 'utf8')
}

/**
 * 读取断点文件里的已完成用例；文件不存在 / label 不匹配 / 解析失败都返回空数组。
 *
 * label 必须校验：基线臂与对照臂共用同一 results 目录，若不校验就会把「基线已完成」
 * 误当成「对照也已完成」，直接跳过对照臂 —— 那会产出一个假 A/B。
 */
function readCheckpoint(file: string, label: string): SuiteResult['results'] {
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as EvalReportFile
    if (parsed.label !== label) return []
    return (parsed.results ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      category: r.category,
      difficulty: r.difficulty,
      success: r.success,
      failures: r.failures ?? [],
      calledTools: r.calledTools ?? [],
      toolCalls: r.run?.toolCalls?.length ?? 0,
      tokens: r.tokens ?? 0,
      latencyMs: r.latencyMs ?? 0,
      approvalCount: r.approvalCount ?? 0,
      ultraStrategy: r.ultraStrategy ?? '',
      run: r.run
    }))
  } catch (error) {
    console.warn(`[eval] 断点文件解析失败，按「无断点」继续：${file}`, error)
    return []
  }
}

/** 按用例集原始顺序排列结果（并发/续跑都会打乱顺序，报告需要稳定排序才可对比）。 */
function sortByCaseOrder(
  results: SuiteResult['results'],
  cases: readonly EvalCase[]
): SuiteResult['results'] {
  const order = new Map(cases.map((c, i) => [c.id, i]))
  return [...results].sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER))
}

/** 从 runEval 的中间结果构建落盘报告（含 summary）。纯函数，便于测试。 */
export function buildReport(input: {
  results: SuiteResult['results']
  label: string
  timestamp: string
  runner?: RunnerKind
  filter: { categories: string[]; difficulties: string[]; ids: string[] }
}): EvalReportFile {
  const summary = summarize(input.results.map((r) => ({ case: findCase(r.id), run: r.run })))
  return {
    timestamp: input.timestamp,
    label: input.label,
    generatedAt: new Date().toISOString(),
    runner: input.runner ?? 'mock',
    filter: input.filter,
    summary,
    results: input.results.map((r) => ({
      id: r.id,
      name: r.name,
      category: r.category,
      difficulty: r.difficulty,
      success: r.success,
      failures: r.failures,
      calledTools: r.calledTools,
      toolCalls: r.run.toolCalls.length,
      tokens: tokenTotal(r.run),
      latencyMs: r.run.durationMs,
      approvalCount: r.run.approvalCount,
      ultraStrategy: r.run.ultraStrategy ?? '',
      finalOutput: r.run.finalOutput,
      artifacts: r.run.artifacts ?? [],
      run: r.run
    }))
  }
}

function tokenTotal(run: EvalRun): number {
  const u = run.usage ?? {}
  return typeof u.totalTokens === 'number' ? u.totalTokens : (u.inputTokens ?? 0) + (u.outputTokens ?? 0)
}

/** 从待跑用例里回查 case 对象（报告里需要它来判定）。 */
function findCase(id: string): EvalCase {
  const found = EVAL_CASES.find((c) => c.id === id)
  if (found) return found
  // 非内置用例（调用方传入自定义 cases 时）——用最小占位，判定已在 runEval 内完成。
  return { id, name: id, category: 'other', input: '', expected: {}, difficulty: 'easy', notes: '' }
}

/** 把报告写成 JSON 文件，返回文件绝对路径。 */
export function writeReport(report: EvalReportFile, resultsDir: string): string {
  mkdirSync(resultsDir, { recursive: true })
  const file = join(resultsDir, `${report.timestamp}.json`)
  writeFileSync(file, JSON.stringify(report, null, 2), 'utf8')
  return file
}

/** 读取落盘报告（用于对比模式）。 */
export function readReport(file: string): EvalReportFile {
  return JSON.parse(readFileSync(file, 'utf8')) as EvalReportFile
}

/**
 * 对比两份报告并返回结果（不打印，便于测试）。
 * 「单 Agent vs 单 Agent + Ultra」「压缩开关开 vs 关」都用它做 A/B。
 */
export function compareReportFiles(baselineFile: string, candidateFile: string): CompareResult {
  return compareRuns(readReport(baselineFile), readReport(candidateFile))
}

/**
 * 渲染控制台表格（对齐列宽，不依赖第三方表格库）。
 *
 * 「增强」列只在有任意用例真的跑过 Ultra 时才出现——它存在的意义是让人一眼看出
 * A/B 的 candidate 版**增强到底有没有生效**（两版都是 `-` 就说明 Ultra 没接上，
 * 此时的「无差异」结论无效）。
 */
export function formatRunTable(report: EvalReportFile): string {
  const hasUltra = report.results.some((r) => (r.ultraStrategy ?? '') !== '')
  const rows = report.results.map((r) => [
    r.success ? 'PASS' : 'FAIL',
    r.id,
    r.category,
    r.difficulty,
    String(r.toolCalls),
    String(r.tokens),
    `${r.latencyMs}ms`,
    r.artifacts.length > 0 ? r.artifacts.map((p) => p.split('/').pop() ?? p).join(',') : '-',
    ...(hasUltra ? [(r.ultraStrategy ?? '') !== '' ? r.ultraStrategy : '-'] : []),
    r.failures.join('; ')
  ])
  const headers = [
    '状态',
    'id',
    '能力域',
    '难度',
    '工具数',
    'token',
    '延迟',
    '产物(观测)',
    ...(hasUltra ? ['增强'] : []),
    '失败原因'
  ]
  return renderTable(headers, rows)
}

/**
 * 报告抬头：明确本次跑的是 mock 还是真实 Agent。
 * mock 的成功率恒为 100%（理想化响应），必须在最显眼处标注，防止被当成结论。
 */
export function formatReportHeader(report: EvalReportFile): string {
  if (report.runner === 'mock') {
    return (
      `⚠️  runner=mock（未验证的理想化执行器，成功率恒 100%，仅用于打通链路/校准指标，` +
      `不可作为效果结论）｜ label=${report.label} ｜ ${report.timestamp}`
    )
  }
  return `✅ runner=real（真实模型）｜ label=${report.label} ｜ ${report.timestamp}`
}

/** 渲染聚合摘要（成功率 / 分组 / P95）。 */
export function formatSummary(summary: EvalSummary): string {
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`
  const lines: string[] = []
  lines.push('=== 评测摘要 ===')
  lines.push(
    `用例数 ${summary.total} ｜ 通过 ${summary.passed} ｜ 失败 ${summary.failed} ｜ 成功率 ${pct(summary.successRate)}`
  )
  lines.push(
    `平均工具调用 ${summary.avgToolCalls} ｜ 平均 token ${summary.avgTokens} ｜ 平均延迟 ${summary.avgLatencyMs}ms ｜ P95 延迟 ${summary.p95LatencyMs}ms`
  )
  lines.push(
    `工具精确率 ${pct(summary.avgToolPrecision)} ｜ 工具召回率 ${pct(summary.avgToolRecall)} ｜ 人工干预合计 ${summary.totalHumanInterventions}`
  )
  lines.push('')
  lines.push('按能力域：')
  for (const [key, stat] of Object.entries(summary.byCategory)) {
    if (stat.total === 0) continue
    lines.push(`  ${key.padEnd(12)} ${stat.passed}/${stat.total}  ${pct(stat.successRate)}`)
  }
  lines.push('按难度：')
  for (const [key, stat] of Object.entries(summary.byDifficulty)) {
    if (stat.total === 0) continue
    lines.push(`  ${key.padEnd(12)} ${stat.passed}/${stat.total}  ${pct(stat.successRate)}`)
  }
  if (summary.failures.length > 0) {
    lines.push('')
    lines.push('失败明细：')
    for (const f of summary.failures) lines.push(`  ${f.id} (${f.name})：${f.failures.join('; ')}`)
  }
  return lines.join('\n')
}

/**
 * 把一行行数据渲染成等宽表格。
 * 中文按 2 列宽估算，保证控制台对齐（不引第三方依赖）。
 */
function renderTable(headers: string[], rows: string[][]): string {
  const width = (s: string): number => [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)
  const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - width(s)))
  const all = [headers, ...rows]
  const colWidths = headers.map((_, i) => Math.max(...all.map((row) => width(row[i] ?? ''))))
  const line = (row: string[]): string =>
    row.map((cell, i) => pad(cell ?? '', colWidths[i])).join('  ').trimEnd()
  return [line(headers), line(headers.map((_, i) => '-'.repeat(colWidths[i]))), ...rows.map(line)].join('\n')
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

/** 默认报告目录：`test/eval/results`（相对本文件定位，避免受 cwd 影响）。 */
export function defaultResultsDir(): string {
  return join(MODULE_DIR, 'results')
}

/** 默认时间戳：`YYYYMMDD-HHmmss`，可直接作为文件名。 */
export function defaultTimestamp(date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  )
}

export { compareRuns, formatCompareReport, summarize }
