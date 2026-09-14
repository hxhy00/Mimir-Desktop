/**
 * Mock 执行器（**未验证的 mock，仅用于打通评测链路**）。
 *
 * ⚠️ 重要声明（项目规则：未验证的 mock 必须写文档记录）：
 * 这里的「Agent 行为」是根据 {@link EvalCase.expected} 反推的**理想化响应**，
 * 它不代表真实 Agent 的实际表现，也**绝不能**用来判断某项增强有没有用。
 * 它的唯一用途是：
 * 1. 在没有真实模型/网关的情况下，验证 runner → metrics → report 全链路可跑通；
 * 2. 作为「完美上界基线」，与真实 Agent 报告做 A/B 时用于校准指标（成功率应为 100%）。
 *
 * 真实接入点见 `test/eval/cli.ts` 顶部注释与 `test/eval/README.md`。
 */
import type { EvalCase } from './cases.ts'
import type { EvalRun, ToolCallRecord } from './metrics.ts'

/** mock 的确定性伪随机（避免测试结果抖动）。 */
function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

export interface MockRunnerOptions {
  /** 模拟「偶尔失败」的比例（0~1，默认 0，即完美响应）。 */
  failureRate?: number
  /** 每条用例模拟的延迟基准（毫秒，默认 0，避免拖慢测试）。 */
  baseLatencyMs?: number
  /** 覆盖某条用例的行为（返回 null 表示走默认逻辑）。 */
  override?: (c: EvalCase) => EvalRun | null
}

/**
 * 生成一个 mock 执行器。
 *
 * 默认策略：对每条用例**只调用 mustCallTools 里的工具**、绝不调用 mustNotCallTools，
 * 因此 `summary.successRate` 应为 1（这是刻意的「上界基线」）。
 */
export function createMockRunner(opts: MockRunnerOptions = {}): (c: EvalCase) => EvalRun {
  const failureRate = clamp01(opts.failureRate ?? 0)
  const baseLatency = Math.max(0, opts.baseLatencyMs ?? 0)

  return (c: EvalCase): EvalRun => {
    const overridden = opts.override?.(c)
    if (overridden) return overridden

    const seed = hash(c.id)
    // 确定性「失败」：按 id 哈希决定，保证同一用例每次结果一致。
    const shouldFail = failureRate > 0 && (seed % 1000) / 1000 < failureRate
    const must = c.expected.mustCallTools ?? []
    const toolCalls: ToolCallRecord[] = (shouldFail ? must.slice(1) : must).map((name, i) => ({
      name,
      args: { _mock: true },
      durationMs: 10 + ((seed + i) % 40)
    }))

    const latency = baseLatency + (seed % 50)
    return {
      caseId: c.id,
      messages: [
        { role: 'user', content: c.input },
        { role: 'assistant', content: `（mock）已处理用例 ${c.id}：${c.name}` }
      ],
      toolCalls,
      usage: {
        inputTokens: 800 + (seed % 400),
        outputTokens: 200 + (seed % 150)
      },
      durationMs: latency,
      approvalCount: estimateApprovals(toolCalls),
      finalOutput: `（mock 输出）${c.name}：任务已按预期工具路径完成。`
    }
  }
}

/** 需要批准卡的工具（与 capabilityDomains 里标注「写操作/需批准」的工具一致）。 */
const APPROVAL_TOOLS = new Set(['paper_fetch', 'set_paper', 'latex_compile', 'figure', 'wiki_note', 'experiment', 'ledger', 'meeting_deck'])

function estimateApprovals(calls: readonly ToolCallRecord[]): number {
  return calls.filter((c) => APPROVAL_TOOLS.has(c.name)).length
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}
