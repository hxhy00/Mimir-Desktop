/**
 * 真实网关评测 —— **A/B 的唯一可执行入口**。
 *
 * ── 为什么必须用 vitest，而不是 `node test/eval/cli.ts --real-agent` ──────────
 * CLI 走 `node --experimental-strip-types`，Node 的 ESM 解析器要求**显式文件扩展名**；
 * 而 electron 侧模块内部全是无扩展名导入（`../library/store`、`./controlPlane` …），
 * 于是真实装配在 CLI 下必然抛 `ERR_MODULE_NOT_FOUND`。
 * mock 模式因为（按设计）惰性 import electron 依赖链、根本不加载它们，所以这个缺陷
 * 长期不可见 —— 它此前还被评测层的「负例假通过」bug 二次掩盖（运行报错被计成 PASS）。
 *
 * vitest 侧有 vite 解析器与 `../library/store` 的 store 桩，装配可以正常完成，
 * 因此**真实评测与 A/B 从这里跑**，CLI 的 `--ultra` 通道保留给将来解析问题解决后使用。
 *
 * ── 怎么跑 ─────────────────────────────────────────────────────────────────
 * ```bash
 * # 基线
 * MIMIR_GW_URL=... MIMIR_GW_KEY=... MIMIR_GW_MODEL=... \
 *   MIMIR_EVAL_LABEL=single-agent \
 *   pnpm vitest run test/eval/realAgentEval.test.ts
 *
 * # 对照（同一套用例，仅开启 Ultra）
 * MIMIR_GW_URL=... MIMIR_GW_KEY=... MIMIR_GW_MODEL=... \
 *   MIMIR_EVAL_LABEL=single-agent-ultra MIMIR_EVAL_ULTRA=auto \
 *   pnpm vitest run test/eval/realAgentEval.test.ts
 *
 * # 对比两份报告
 * pnpm eval:compare test/eval/results/<A>.json test/eval/results/<B>.json
 * ```
 *
 * 未设置凭据时整组跳过（**绝不退化为 mock** —— mock 成功率恒 100%，会把结论变成假的）。
 *
 * ── 环境变量 ───────────────────────────────────────────────────────────────
 * | 变量 | 说明 | 默认 |
 * | --- | --- | --- |
 * | `MIMIR_GW_URL` / `MIMIR_GW_KEY` / `MIMIR_GW_MODEL` | 网关凭据（三个齐备才跑） | 无（则跳过） |
 * | `MIMIR_EVAL_ULTRA` | `auto` 或具体策略名；设置即开启 Ultra | 不开启 |
 * | `MIMIR_EVAL_LABEL` | 报告标签（A/B 用不同标签区分版本） | `real` |
 * | `MIMIR_EVAL_IDS` | 只跑这些用例 id（逗号分隔，便于冒烟） | 全部 26 条 |
 * | `MIMIR_EVAL_TIMEOUT` | 单条用例超时（毫秒）；超时会**真正 abort** 该用例 | 120000 |
 * | `MIMIR_EVAL_CONCURRENCY` | 并发度；调高会放大网关限流风险 | 1 |
 */
import { describe, expect, it } from 'vitest'
import { EVAL_CASES } from '../../test/eval/cases'
import { createRealRunner, hasGatewayCredentials, resolveGateway } from '../../test/eval/realRunner'
import { join } from 'node:path'
import {
  defaultResultsDir,
  formatReportHeader,
  formatRunTable,
  formatSummary,
  runEval
} from '../../test/eval/runner'
import { ULTRA_STRATEGY_CHOICES, type UltraStrategyChoice } from '../../test/eval/cli'

/** 读取 Ultra 开关：未设置 → 不开启；设置为 `auto`/策略名 → 以该策略开启。 */
function readUltraOption(): { enabled: boolean; strategy: UltraStrategyChoice } | undefined {
  const raw = (process.env.MIMIR_EVAL_ULTRA ?? '').trim()
  if (raw === '') return undefined
  if (!(ULTRA_STRATEGY_CHOICES as readonly string[]).includes(raw)) {
    throw new Error(`MIMIR_EVAL_ULTRA 取值非法：${raw}（可选：${ULTRA_STRATEGY_CHOICES.join('/')}）`)
  }
  return { enabled: true, strategy: raw as UltraStrategyChoice }
}

/**
 * 是否**显式**要求跑真实评测。
 *
 * 为什么需要这道开关（不是多余的谨慎）：评测会真打网关、真花钱、真耗时（26 条 × 数十秒）。
 * 而「凭据存在」并不等于「用户此刻想花钱」—— 只要环境里恰好有 `MIMIR_GW_*`（例如开发者
 * 刚 export 过），`pnpm test` 就会**静默启动一轮完整付费评测**，同时还会顺带激活
 * `liveMatrix` / `liveAgent`。这个坑实际发生过一次。
 *
 * 判定：由 `pnpm eval:real` 调用时 `npm_lifecycle_event === 'eval:real'`，或显式
 * `MIMIR_EVAL_RUN=1`（给直接 `npx vitest run` 的场景用）。
 */
function evalExplicitlyRequested(): boolean {
  return process.env.MIMIR_EVAL_RUN === '1' || process.env.npm_lifecycle_event === 'eval:real'
}

const canRunRealEval = hasGatewayCredentials() && evalExplicitlyRequested()

if (hasGatewayCredentials() && !evalExplicitlyRequested()) {
  // 有凭据但没被显式要求 → 跳过，并说明怎么跑（不静默，避免「以为跑了其实没跑」）。
  process.stdout.write(
    '⏭️  真实评测已跳过：检测到网关凭据，但本次不是显式要求（避免被 pnpm test 顺带跑掉）。\n' +
      '   要跑请用：pnpm eval:real（或 MIMIR_EVAL_RUN=1 npx vitest run test/eval/realAgentEval.test.ts）\n'
  )
}

describe.skipIf(!canRunRealEval)('真实网关评测（需 MIMIR_GW_URL/KEY/MODEL + 显式要求）', () => {
  it('跑一轮真实评测并落盘报告（Enhance 列自证增强是否生效）', async () => {
    const gateway = resolveGateway()
    expect(gateway, '凭据校验：三个变量必须齐备').not.toBeNull()
    const ultra = readUltraOption()
    const ids = (process.env.MIMIR_EVAL_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
    const timeoutMs = Number(process.env.MIMIR_EVAL_TIMEOUT ?? '') || 120_000
    // 并发档位：默认 1（最省额度、最稳）。调高会成倍放大网关限流（429）风险，
    // 一旦被限流本轮数据即作废（见下方限流守卫），所以只在对额度有把握时调高。
    const concurrency = Number(process.env.MIMIR_EVAL_CONCURRENCY ?? '') || 1
    const label = process.env.MIMIR_EVAL_LABEL ?? 'real'

    const report = await runEval({
      runner: createRealRunner(gateway!, ultra !== undefined ? { ultra } : {}),
      runnerKind: 'real',
      label,
      ...(ids.length > 0 ? { ids } : {}),
      concurrency,
      timeoutMs,
      // 断点续跑：中途被限流 / 崩溃时，已完成的用例不会白跑（按 label 隔离两臂）。
      checkpointFile: join(defaultResultsDir(), `${label}.partial.json`),
      onProgress: ({ index, total, id, success }) => {
        process.stdout.write(`[${index}/${total}] ${id} ${success ? 'PASS' : 'FAIL'}\n`)
      }
    })

    process.stdout.write('\n' + formatReportHeader(report) + '\n\n')
    process.stdout.write(formatRunTable(report) + '\n\n')
    process.stdout.write(formatSummary(report.summary) + '\n')

    // ── 结构性断言（不评判成功率：那是测量结果，不是门禁）──────────────────
    expect(report.results.length).toBe(ids.length > 0 ? ids.length : EVAL_CASES.length)
    expect(report.runner).toBe('real')

    // ── 限流守卫：被 429 / rate limit 打断的运行**不能**作为 A/B 依据 ──────────
    // 理由：限流会让成功率假性下降，且两臂受影响的程度不同（谁多调了几次模型谁更惨），
    // 对比出来的差异是「谁更费额度」而不是「谁更好」。这类数据必须显式作废，不能混进结论。
    const throttled = report.results
      .filter((r) => /429|rate.?limit|FreeUsageLimit|quota/i.test(r.run.runError ?? ''))
      .map((r) => r.id)
    expect(
      throttled,
      `以下用例被网关限流（429 / rate limit），本次运行不可用于 A/B：${throttled.join(', ')}。` +
        '请更换有余量的模型，或等额度恢复后重跑。'
    ).toEqual([])

    // 增强自证：开启 Ultra 后，每条**真正执行完**的用例都必须记录到实际策略。
    // 若这里为空，说明增强根本没接进执行路径 —— 此时 A/B 的「无差异」结论无效。
    //
    // 只看「执行完」的用例：超时/报错的用例由 runner 的兜底 run 代表，其字段来自
    // 执行器的「先登记」通道（`observe`）。若跑完一个能执行的都没有，说明网关或超时
    // 配置有问题，这时不该给出「增强正常」的假绿。
    if (ultra !== undefined) {
      const executed = report.results.filter((r) => (r.run.runError ?? '') === '')
      expect(
        executed.length,
        '没有任何用例真正执行完（全部超时/报错）—— 无法验证增强是否生效，请先排查网关与超时配置'
      ).toBeGreaterThan(0)
      const missing = executed.filter((r) => (r.ultraStrategy ?? '') === '').map((r) => r.id)
      expect(missing, `以下用例未记录到 Ultra 策略，增强可能未生效：${missing.join(', ')}`).toEqual([])
    }
  }, 3_600_000)
})
