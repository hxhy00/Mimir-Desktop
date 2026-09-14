/**
 * 评测 CLI 入口。
 *
 * 用法：
 *   node --experimental-strip-types test/eval/cli.ts --label mock-baseline
 *   node --experimental-strip-types test/eval/cli.ts --category literature --difficulty hard --concurrency 4
 *   node --experimental-strip-types test/eval/cli.ts --compare results/A.json results/B.json
 *
 *   # 真实 Agent（需网关凭据，见 README）
 *   MIMIR_GW_URL=... MIMIR_GW_KEY=... MIMIR_GW_MODEL=... \
 *     node --experimental-strip-types test/eval/cli.ts --real-agent --label real-baseline
 *
 * ── 两种执行器 ─────────────────────────────────────────────────────────────
 * - 默认（无 `--real-agent`）：{@link createMockRunner} 理想化响应，成功率恒 100%，
 *   只用于打通链路 / 校准指标。**不能作为效果结论**（报告里会打 ⚠️ 标注）。
 * - `--real-agent`：{@link createRealRunner} 装配真实单 Agent 实例。
 *   **无凭据时明确报错退出，绝不静默退化成 mock。**
 */
import { createMockRunner } from './mockRunner.ts'
import { createRealRunner, hasGatewayCredentials, resolveGateway } from './realRunner.ts'
// 说明：`realRunner.ts` 内部对 electron 侧模块一律**惰性 import**，
// 因此这里静态引入它是安全的——mock 跑评测不会碰 electron 依赖链。
import { defaultResultsDir, formatReportHeader, formatRunTable, formatSummary, runEval, compareReportFiles } from './runner.ts'
import { formatCompareReport } from './metrics.ts'
import type { EvalCategory, EvalDifficulty } from './cases.ts'
import type { CaseRunner, RealRunnerOptions, RunnerKind } from './runner.ts'

interface CliArgs {
  label: string
  categories: EvalCategory[]
  difficulties: EvalDifficulty[]
  ids: string[]
  concurrency: number
  timeoutMs: number
  resultsDir: string | null
  compare: [string, string] | null
  useRealAgent: boolean
  /** 是否开启 Ultra 增强层（仅 `--real-agent` 下有效）。 */
  ultra: boolean
  /** Ultra 策略：auto 走自动选型，其余为手动指定。 */
  ultraStrategy: UltraStrategyChoice
}

const CATEGORIES: EvalCategory[] = ['literature', 'paper', 'experiment', 'meeting', 'server', 'files', 'other']
const DIFFICULTIES: EvalDifficulty[] = ['easy', 'medium', 'hard']

/**
 * 允许的 Ultra 策略名（含 `auto`）。
 *
 * ⚠️ 为什么在这里列一份而不 import `ULTRA_STRATEGY_IDS`：`electron/agent/ultra.ts` 的依赖链
 * 是 `ultra → contextManager → library/store → electron-store`，而本 CLI 走
 * `node --experimental-strip-types`，Node 原生解析不了这条链（会直接崩在启动阶段，
 * 连 mock 模式都起不来）。因此 electron 侧模块在此只能以 **type-only** 形式出现。
 * 两份清单的一致性由 `test/unit/evalHarness.test.ts` 对 `ULTRA_STRATEGY_IDS` 做等值断言守住。
 */
export const ULTRA_STRATEGY_CHOICES = [
  'auto',
  'multi_expert',
  'critique_reflect',
  'hybrid_mix',
  'self_consistency_vote'
] as const

export type UltraStrategyChoice = (typeof ULTRA_STRATEGY_CHOICES)[number]

/** 解析 CLI 参数（纯函数，便于测试）。未知参数抛错，避免静默跑错配置。 */
export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    label: 'unlabeled',
    categories: [],
    difficulties: [],
    ids: [],
    concurrency: 1,
    timeoutMs: 120_000,
    resultsDir: defaultResultsDir(),
    compare: null,
    useRealAgent: false,
    ultra: false,
    ultraStrategy: 'auto'
  }

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    const next = (): string => {
      const v = argv[i + 1]
      if (v === undefined) throw new Error(`参数 ${token} 缺少取值`)
      i += 1
      return v
    }
    switch (token) {
      case '--label':
        args.label = next()
        break
      case '--category': {
        const v = next() as EvalCategory
        if (!CATEGORIES.includes(v)) throw new Error(`未知能力域：${v}（可选：${CATEGORIES.join('/')}）`)
        args.categories.push(v)
        break
      }
      case '--difficulty': {
        const v = next() as EvalDifficulty
        if (!DIFFICULTIES.includes(v)) throw new Error(`未知难度：${v}（可选：${DIFFICULTIES.join('/')}）`)
        args.difficulties.push(v)
        break
      }
      case '--id':
        args.ids.push(next())
        break
      case '--concurrency':
        args.concurrency = positiveInt(next(), 'concurrency')
        break
      case '--timeout':
        args.timeoutMs = positiveInt(next(), 'timeout')
        break
      case '--out':
        args.resultsDir = next()
        break
      case '--no-save':
        args.resultsDir = null
        break
      case '--real-agent':
        args.useRealAgent = true
        break
      case '--ultra':
        args.ultra = true
        break
      case '--ultra-strategy': {
        const v = next()
        if (!(ULTRA_STRATEGY_CHOICES as readonly string[]).includes(v)) {
          throw new Error(`未知 Ultra 策略：${v}（可选：${ULTRA_STRATEGY_CHOICES.join('/')}）`)
        }
        args.ultraStrategy = v as UltraStrategyChoice
        // 指定策略隐含开启增强（避免「设了策略却没生效」的静默错误）
        args.ultra = true
        break
      }
      case '--compare': {
        const a = next()
        const b = next()
        args.compare = [a, b]
        break
      }
      case '--help':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`未知参数：${token}（用 --help 查看用法）`)
    }
  }
  // Ultra 只挂在真实执行器上：mock 是理想化响应，开了也没有任何意义，
  // 静默忽略会让人拿着 label=single-agent-ultra 的 mock 报告当增强结论。
  if (args.ultra && !args.useRealAgent) {
    throw new Error('--ultra 仅在 --real-agent 下有效（mock 为理想化执行器，不经过增强层）')
  }
  return args
}

function positiveInt(v: string, name: string): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`参数 ${name} 需为正整数，收到：${v}`)
  return Math.floor(n)
}

/**
 * 选择执行器。
 *
 * `--real-agent` 走 {@link createRealRunner}（装配真实单 Agent 实例）。
 * 没有网关凭据时**抛错退出**：绝不能静默退化成 mock —— mock 成功率恒 100%，
 * 退化成 mock 会把评测结论变成假的（这是本项目的硬约束）。
 */
export function resolveRunner(
  useRealAgent: boolean,
  env: NodeJS.ProcessEnv = process.env,
  ultraOptions?: RealRunnerOptions['ultra']
): { runner: CaseRunner; kind: RunnerKind } {
  if (!useRealAgent) return { runner: createMockRunner(), kind: 'mock' }

  const gateway = resolveGateway(env)
  if (gateway === null) {
    throw new Error(
      '--real-agent 需要网关凭据，但 MIMIR_GW_URL / MIMIR_GW_KEY / MIMIR_GW_MODEL 未齐备。\n' +
        '请先设置环境变量（见 test/eval/README.md「接入真实 Agent」），本命令不会退化为 mock。'
    )
  }
  return {
    runner: createRealRunner(gateway, ultraOptions !== undefined ? { ultra: ultraOptions } : {}),
    kind: 'real'
  }
}

/** 仅判断（不抛错），供 main 里给出更友好的退出提示。 */
export function realAgentReady(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasGatewayCredentials(env)
}

function printHelp(): void {
  process.stdout.write(
    [
      'Mimir 评测 CLI',
      '',
      '用法：node --experimental-strip-types test/eval/cli.ts [options]',
      '',
      '选项：',
      '  --label <name>          报告标签（如 single-agent / single-agent-ultra）',
      '  --category <cat>        只跑某能力域（可重复）',
      '  --difficulty <level>    只跑某难度（可重复）',
      '  --id <caseId>           只跑某用例（可重复）',
      '  --concurrency <n>       并发度，默认 1',
      '  --timeout <ms>          单条超时，默认 120000',
      '  --out <dir>             报告输出目录，默认 test/eval/results',
      '  --no-save               不落盘',
      '  --real-agent            使用真实 Agent（需 MIMIR_GW_URL/KEY/MODEL；缺凭据会报错退出）',
      '  --ultra                 开启 Ultra 增强层（仅 --real-agent 下有效；用于 A/B 对照）',
      `  --ultra-strategy <name> 指定增强策略（隐含 --ultra）：${ULTRA_STRATEGY_CHOICES.join(' / ')}`,
      '  --compare <a.json> <b.json>  对比两份报告并退出',
      '  --help                  显示本帮助',
      '',
      '默认执行器是 mock（理想化响应，成功率恒 100%，仅用于校准指标，不可作结论）。',
      ''
    ].join('\n')
  )
}

/** 无凭据时的跳过提示（对照 vitest 的 `describe.skipIf` 语义：跳过并说明，不静默降级）。 */
export const NO_CREDENTIALS_HINT = [
  '⏭️  跳过：--real-agent 需要网关凭据，但以下环境变量未齐备。',
  '    MIMIR_GW_URL / MIMIR_GW_KEY / MIMIR_GW_MODEL',
  '',
  '    请先设置（见 test/eval/README.md「接入真实 Agent」）：',
  '      export MIMIR_GW_URL=... MIMIR_GW_KEY=... MIMIR_GW_MODEL=...',
  '',
  '    本命令不会退化为 mock —— mock 成功率恒 100%，会把评测结论变成假的。'
].join('\n')

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (args.compare) {
    const [baseline, candidate] = args.compare
    process.stdout.write(formatCompareReport(compareReportFiles(baseline, candidate)) + '\n')
    return
  }

  // 无凭据 → 跳过语义（对照 describe.skipIf），不静默降级为 mock。
  if (args.useRealAgent && !realAgentReady()) {
    process.stdout.write(NO_CREDENTIALS_HINT + '\n')
    process.exitCode = 2 // 与「真的跑失败」区分：2 = 跳过
    return
  }

  const ultraOptions: RealRunnerOptions['ultra'] | undefined = args.ultra
    ? { enabled: true, strategy: args.ultraStrategy }
    : undefined
  const { runner, kind } = resolveRunner(args.useRealAgent, process.env, ultraOptions)
  const report = await runEval({
    runner,
    runnerKind: kind,
    label: args.label,
    categories: args.categories,
    difficulties: args.difficulties,
    ids: args.ids,
    concurrency: args.concurrency,
    timeoutMs: args.timeoutMs,
    resultsDir: args.resultsDir,
    onProgress: ({ index, total, id, success }) => {
      process.stdout.write(`[${index}/${total}] ${id} ${success ? 'PASS' : 'FAIL'}\n`)
    }
  })

  process.stdout.write('\n' + formatReportHeader(report) + '\n\n')
  if (args.ultra) {
    process.stdout.write(
      `Ultra 增强：已开启（策略 ${args.ultraStrategy}）——表格「增强」列为每条用例实际采用的策略；` +
        `若全为「-」说明增强未生效，本次 A/B 结论无效。\n\n`
    )
  }
  process.stdout.write(formatRunTable(report) + '\n\n')
  process.stdout.write(formatSummary(report.summary) + '\n')
  if (args.resultsDir !== null) {
    process.stdout.write(`\n报告已写入：${args.resultsDir}/${report.timestamp}.json\n`)
  }
}

// 仅在被直接执行时运行 main（被 import 时不执行，便于单测 parseArgs）。
const isDirectRun =
  process.argv[1] !== undefined && /cli\.(ts|js|mts|mjs)$/.test(process.argv[1].replace(/\\/g, '/'))

if (isDirectRun) {
  main().catch((err: unknown) => {
    process.stderr.write(`评测失败：${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  })
}
