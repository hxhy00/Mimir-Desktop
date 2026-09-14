/**
 * 「执行过程」数据层单测。
 *
 * 这层是时间线 UI 的地基，且承担一条硬约束：**语义只从结构化字段读，不解析文案**。
 * 因此这里既测行为，也守住"不许回退到文案嗅探"（见「无 step 的工具事件」用例）。
 */
import { describe, expect, it } from 'vitest'
import {
  activityOf,
  applyRunEvent,
  cancelRun,
  createRun,
  fromLegacyTrace,
  summarizeRun,
  visibleSteps,
  type LegacyTraceNode,
  type RunEvent
} from '../../src/components/chat/agentRun'

/** 自增 id 生成器（模拟 ChatView 里的序号 ref）。 */
function counter(): () => number {
  let n = 0
  return () => (n += 1)
}

function toolEvent(
  callId: string,
  name: string,
  stage: 'call' | 'result' | 'error',
  extra: Partial<RunEvent> = {}
): RunEvent {
  const base: RunEvent = {
    taskId: 'main',
    title: 'Mimir',
    status: stage === 'call' ? 'running' : stage === 'error' ? 'error' : 'done',
    kind: 'tool',
    phase: 'main',
    step: {
      callId,
      name,
      stage,
      ...(stage === 'call' ? { argsSummary: '{"p":"a.md"}' } : { resultSummary: '写入完成' })
    }
  }
  return { ...base, ...extra }
}

describe('applyRunEvent：工具步骤按 callId 合并成一行', () => {
  it('调用 + 返回 → 同一行，状态与耗时合并', () => {
    const next = counter()
    let run = createRun()
    run = applyRunEvent(run, toolEvent('write_file#1', 'write_file', 'call'), next)
    run = applyRunEvent(run, toolEvent('write_file#1', 'write_file', 'result', { durationMs: 420 }), next)

    expect(run.steps).toHaveLength(1)
    expect(run.steps[0]).toMatchObject({
      id: 'write_file#1',
      kind: 'tool',
      title: 'write_file',
      status: 'done',
      durationMs: 420,
      argsSummary: '{"p":"a.md"}',
      resultSummary: '写入完成'
    })
  })

  it('同一工具多次调用 → 各自成行（callId 不同）', () => {
    const next = counter()
    let run = createRun()
    for (const id of ['paper_search#1', 'paper_search#2']) {
      run = applyRunEvent(run, toolEvent(id, 'paper_search', 'call'), next)
      run = applyRunEvent(run, toolEvent(id, 'paper_search', 'result'), next)
    }
    expect(run.steps.map((s) => s.id)).toEqual(['paper_search#1', 'paper_search#2'])
  })

  it('出错 → status=error，并保留出错文案', () => {
    const next = counter()
    let run = createRun()
    run = applyRunEvent(run, toolEvent('latex_compile#1', 'latex_compile', 'call'), next)
    run = applyRunEvent(
      run,
      toolEvent('latex_compile#1', 'latex_compile', 'error', {
        step: {
          callId: 'latex_compile#1',
          name: 'latex_compile',
          stage: 'error',
          resultSummary: '编译失败：第 12 行'
        }
      }),
      next
    )
    expect(run.steps[0].status).toBe('error')
    expect(run.steps[0].resultSummary).toContain('第 12 行')
  })

  it('缺调用事件的返回行 → 不凭空造行', () => {
    const next = counter()
    let run = createRun()
    run = applyRunEvent(run, toolEvent('ghost#1', 'ghost', 'result'), next)
    expect(run.steps).toHaveLength(0)
  })

  it('产物路径并入该步骤', () => {
    const next = counter()
    let run = createRun()
    run = applyRunEvent(run, toolEvent('write_file#1', 'write_file', 'call'), next)
    run = applyRunEvent(
      run,
      toolEvent('write_file#1', 'write_file', 'result', {
        artifacts: [{ path: '/tmp/a.md' }, { path: '/tmp/a.md' }, { path: '/tmp/b.md' }]
      }),
      next
    )
    expect(run.steps[0].artifacts).toEqual(['/tmp/a.md', '/tmp/a.md', '/tmp/b.md'])
  })
})

describe('applyRunEvent：不解析文案（守住"语义只看结构化字段"）', () => {
  it('无 step 的工具事件不做调用/返回识别，降级为内部备注', () => {
    const next = counter()
    let run = createRun()
    // 文案长得"像调用"，但**没有结构化字段**：不得被当成工具步骤
    run = applyRunEvent(
      run,
      { taskId: 'main', title: 'Mimir', status: 'running', kind: 'tool', text: '调用 write_file：{"p":"a"}' },
      next
    )
    run = applyRunEvent(
      run,
      { taskId: 'main', title: 'Mimir', status: 'done', kind: 'tool', text: 'write_file 返回：ok' },
      next
    )
    expect(run.steps).toHaveLength(2)
    expect(run.steps.every((s) => s.kind === 'phase')).toBe(true)
    expect(run.steps.every((s) => s.internal === true)).toBe(true)
    // 默认视图里不出现（内部备注）
    expect(visibleSteps(run, false)).toHaveLength(0)
  })
})

describe('applyRunEvent：思考与整轮状态', () => {
  it('思考逐字合并到同一步骤', () => {
    const next = counter()
    let run = createRun()
    run = applyRunEvent(run, { taskId: 'main', title: 'Mimir', status: 'running', kind: 'think-token', text: '先看' }, next)
    run = applyRunEvent(run, { taskId: 'main', title: 'Mimir', status: 'running', kind: 'think-token', text: '文献库' }, next)
    expect(run.steps).toHaveLength(1)
    expect(run.steps[0].text).toBe('先看文献库')
    expect(run.steps[0].status).toBe('running')
  })

  it('思考默认隐藏（internal），逐字合并后仍保持标记', () => {
    const next = counter()
    let run = createRun()
    run = applyRunEvent(run, { taskId: 'main', title: 'Mimir', status: 'running', kind: 'think-token', text: '先看' }, next)
    run = applyRunEvent(run, { taskId: 'main', title: 'Mimir', status: 'running', kind: 'think-token', text: '文献库' }, next)
    run = applyRunEvent(run, toolEvent('a#1', 'a', 'call'), next)

    expect(run.steps[0].internal).toBe(true)
    // 默认视图只剩工具行；思考要展开才看得到
    expect(visibleSteps(run, false).map((s) => s.kind)).toEqual(['tool'])
    expect(visibleSteps(run, true).map((s) => s.kind)).toEqual(['think', 'tool'])
  })

  it('主流程 done → 整轮 done，且运行中的思考被收尾（不再转圈）', () => {
    const next = counter()
    let run = createRun()
    run = applyRunEvent(run, { taskId: 'main', title: 'Mimir', status: 'running', kind: 'think-token', text: '想' }, next)
    run = applyRunEvent(run, { taskId: 'main', title: 'Mimir', status: 'running', kind: 'task' }, next)
    expect(run.status).toBe('running')
    run = applyRunEvent(run, { taskId: 'main', title: 'Mimir', status: 'done', kind: 'task' }, next)
    expect(run.status).toBe('done')
    expect(run.steps[0].status).toBe('done')
  })

  it('回归：思考后的第一个工具调用即关闭思考行（此前「思考完了还在转圈」）', () => {
    const next = counter()
    let run = createRun()
    run = applyRunEvent(run, { taskId: 'main', title: 'Mimir', status: 'running', kind: 'think-token', text: '先看文献库' }, next)
    expect(run.steps[0].status).toBe('running')
    // 模型决定调工具 = 这段思考结束的一手信号
    run = applyRunEvent(run, toolEvent('paper_search#1', 'paper_search', 'call'), next)
    expect(run.steps[0].status).toBe('done')
    // 并回填该段思考的近似耗时
    expect(run.steps[0].thinkMs).toBeTypeOf('number')
    // 后续逐字继续流入时开新的 think 行，不误并进已收尾的行
    run = applyRunEvent(run, { taskId: 'main', title: 'Mimir', status: 'running', kind: 'think-token', text: '再读代码' }, next)
    expect(run.steps).toHaveLength(3)
    expect(run.steps[2].kind).toBe('think')
    expect(run.steps[2].text).toBe('再读代码')
  })

  it('回归：正文开始事件（content-start）关闭最后一段思考，且不产生多余步骤', () => {
    const next = counter()
    let run = createRun()
    run = applyRunEvent(run, { taskId: 'main', title: 'Mimir', status: 'running', kind: 'think-token', text: '总结要点' }, next)
    run = applyRunEvent(run, { taskId: 'content-start', title: 'Mimir', status: 'running' }, next)
    expect(run.steps).toHaveLength(1)
    expect(run.steps[0].status).toBe('done')
    // 无思考行在跑时也是无害空操作
    run = applyRunEvent(run, { taskId: 'content-start', title: 'Mimir', status: 'running' }, next)
    expect(run.steps).toHaveLength(1)
  })

  it('主流程 error → 整轮 error', () => {
    const next = counter()
    let run = applyRunEvent(createRun(), { taskId: 'main', title: 'Mimir', status: 'error', kind: 'task' }, next)
    expect(run.status).toBe('error')
  })

  it('cancelRun：运行中的步骤全部置为已取消，整轮 canceled', () => {
    const next = counter()
    let run = createRun()
    run = applyRunEvent(run, toolEvent('write_file#1', 'write_file', 'call'), next)
    run = applyRunEvent(run, toolEvent('write_file#0', 'write_file', 'call'), next)
    run = applyRunEvent(run, toolEvent('write_file#0', 'write_file', 'result'), next)
    const cancelled = cancelRun(run)
    expect(cancelled.status).toBe('canceled')
    expect(cancelled.steps[0].status).toBe('canceled')
    expect(cancelled.steps[1].status).toBe('done')
  })
})

describe('文件动作：按「动作 + 文件名 + 增删行数」展示', () => {
  it('write_file 的 file 信息并入步骤（供时间线显示「写入 model.py +387」）', () => {
    const next = counter()
    let run = createRun()
    run = applyRunEvent(
      run,
      {
        taskId: 'main',
        title: 'Mimir',
        status: 'running',
        kind: 'tool',
        step: {
          callId: 'write_file#1',
          name: 'write_file',
          stage: 'call',
          argsSummary: '{"file_path":"/x/model.py"}',
          file: { path: '/x/model.py', action: 'write', added: 387 }
        }
      },
      next
    )
    expect(run.steps[0].file).toEqual({ path: '/x/model.py', action: 'write', added: 387 })
  })

  it('返回阶段也带 file 时不丢（edit 的 +N/−M）', () => {
    const next = counter()
    let run = createRun()
    run = applyRunEvent(
      run,
      {
        taskId: 'main',
        title: 'Mimir',
        status: 'running',
        kind: 'tool',
        step: {
          callId: 'edit_file#1',
          name: 'edit_file',
          stage: 'call',
          file: { path: '/x/a.py', action: 'edit', added: 12, removed: 3 }
        }
      },
      next
    )
    run = applyRunEvent(
      run,
      {
        taskId: 'main',
        title: 'Mimir',
        status: 'done',
        kind: 'tool',
        durationMs: 50,
        step: {
          callId: 'edit_file#1',
          name: 'edit_file',
          stage: 'result',
          resultSummary: 'ok',
          file: { path: '/x/a.py', action: 'edit', added: 12, removed: 3 }
        }
      },
      next
    )
    expect(run.steps[0].file).toMatchObject({ action: 'edit', added: 12, removed: 3 })
  })
})

describe('activityOf：当前活动行（等待要有活动感）', () => {
  it('有待批准 → 等待你的批准（waiting=true）', () => {
    const act = activityOf(createRun(), 'write_file')
    expect(act.waiting).toBe(true)
    expect(act.text).toContain('write_file')
  })

  it('有运行中的工具 → 正在执行该工具', () => {
    const next = counter()
    const run = applyRunEvent(createRun(), toolEvent('write_file#1', 'write_file', 'call'), next)
    expect(activityOf(run).text).toBe('正在执行 write_file…')
  })

  it('一步都没有（模型正在生成）→ 正在思考', () => {
    expect(activityOf(createRun()).text).toBe('正在思考…')
  })

  it('待批准优先于运行中的工具', () => {
    const next = counter()
    const run = applyRunEvent(createRun(), toolEvent('write_file#1', 'write_file', 'call'), next)
    expect(activityOf(run, 'write_file').waiting).toBe(true)
  })
})

describe('内部阶段默认隐藏', () => {
  it('context / routing / ultra 标记为 internal，visibleSteps 默认滤掉', () => {
    const next = counter()
    let run = createRun()
    run = applyRunEvent(
      run,
      { taskId: 'phase:context', title: '上下文治理', status: 'done', kind: 'phase', phase: 'context', text: '已压缩' },
      next
    )
    run = applyRunEvent(
      run,
      { taskId: 'router', title: '技能路由', status: 'running', kind: 'phase', phase: 'routing' },
      next
    )
    run = applyRunEvent(run, toolEvent('paper_search#1', 'paper_search', 'call'), next)

    expect(run.steps).toHaveLength(3)
    expect(visibleSteps(run, false).map((s) => s.title)).toEqual(['paper_search'])
    expect(visibleSteps(run, true)).toHaveLength(3)
  })

  it('技能路由的两种 taskId（phase:routing / router）合并成一行', () => {
    const next = counter()
    let run = createRun()
    run = applyRunEvent(
      run,
      { taskId: 'phase:routing', title: '技能路由', status: 'running', kind: 'phase', phase: 'routing' },
      next
    )
    run = applyRunEvent(
      run,
      { taskId: 'router', title: '技能路由', status: 'done', kind: 'phase', phase: 'routing', text: '命中 2 个' },
      next
    )
    expect(run.steps.filter((s) => s.kind === 'phase')).toHaveLength(1)
    expect(run.steps[0].status).toBe('done')
    expect(run.steps[0].resultSummary).toBe('命中 2 个')
  })
})

describe('summarizeRun：收据', () => {
  it('统计工具数 / 失败数 / 产物去重 / 内部阶段数；完成后耗时为各步之和', () => {
    const next = counter()
    let run = createRun()
    run = applyRunEvent(run, toolEvent('a#1', 'a', 'call'), next)
    run = applyRunEvent(run, toolEvent('a#1', 'a', 'result', { durationMs: 100 }), next)
    run = applyRunEvent(run, toolEvent('b#1', 'b', 'call'), next)
    run = applyRunEvent(
      run,
      toolEvent('b#1', 'b', 'error', {
        durationMs: 50,
        artifacts: [{ path: '/x.md' }, { path: '/x.md' }]
      }),
      next
    )
    run = applyRunEvent(run, { taskId: 'router', title: '技能路由', status: 'done', kind: 'phase', phase: 'routing' }, next)
    run = applyRunEvent(run, { taskId: 'main', title: 'Mimir', status: 'done', kind: 'task' }, next)

    const receipt = summarizeRun(run, 0)
    expect(receipt.tools).toBe(2)
    expect(receipt.failed).toBe(1)
    expect(receipt.artifacts).toBe(1) // 同一路径去重
    expect(receipt.internal).toBe(1)
    expect(receipt.thoughts).toBe(0)
    expect(receipt.durationMs).toBe(150) // 100 + 50
  })

  it('思考与内部阶段分开计数（底部开关要分别报数）', () => {
    const next = counter()
    let run = createRun()
    run = applyRunEvent(run, { taskId: 'main', title: 'Mimir', status: 'running', kind: 'think-token', text: '想' }, next)
    run = applyRunEvent(run, { taskId: 'router', title: '技能路由', status: 'done', kind: 'phase', phase: 'routing' }, next)

    const receipt = summarizeRun(run, 0)
    expect(receipt.thoughts).toBe(1)
    expect(receipt.internal).toBe(1)
  })

  it('运行中耗时为当前时间差', () => {
    const run = { ...createRun(1000), status: 'running' as const }
    expect(summarizeRun(run, 3500).durationMs).toBe(2500)
  })
})

describe('fromLegacyTrace：旧数据适配（唯一允许解析文案的地方）', () => {
  const legacy: LegacyTraceNode = {
    node: { key: 'trace:run', kind: 'run', title: 'Agent 执行过程', status: 'done' },
    children: [
      {
        node: { key: 'main', kind: 'task', title: 'Mimir' },
        children: [
          {
            node: {
              key: 'main:e:1',
              kind: 'tool',
              title: '工具调用',
              text: '[文献] 调用 paper_search：{"query":"VLA"}',
              durationMs: undefined
            },
            children: []
          },
          {
            node: { key: 'main:e:2', kind: 'tool', title: '工具返回', text: 'paper_search 返回：命中 3 篇', durationMs: 210 },
            children: []
          },
          { node: { key: 'main:think:3', kind: 'think', title: '思考', status: 'done', text: '先检索' }, children: [] }
        ]
      },
      { node: { key: 'phase:routing', kind: 'phase', title: '技能路由', status: 'done', text: '命中 1 个' }, children: [] }
    ]
  }

  it('把旧树的调用/返回配对成一行，思考与阶段各自成行', () => {
    const run = fromLegacyTrace(legacy, 0)
    expect(run.status).toBe('done')
    const tools = run.steps.filter((s) => s.kind === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({
      title: 'paper_search',
      label: '文献',
      status: 'done',
      argsSummary: '{"query":"VLA"}',
      resultSummary: '命中 3 篇',
      durationMs: 210
    })
    expect(run.steps.some((s) => s.kind === 'think' && s.text === '先检索')).toBe(true)
    expect(run.steps.some((s) => s.kind === 'phase' && s.internal === true)).toBe(true)
    // 默认视图里只剩工具（思考与阶段都是内部步骤，被隐藏）
    expect(visibleSteps(run, false).map((s) => s.kind)).toEqual(['tool'])
    // 展开「显示思考过程 / 内部步骤」后各自回来（顺序按旧树遍历：
    // 顶层阶段 → 主流程(task 也归 phase) → 工具 → 思考）
    expect(visibleSteps(run, true).map((s) => s.kind)).toEqual(['phase', 'tool', 'think', 'phase'])
  })
})
