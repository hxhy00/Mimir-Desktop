/**
 * 渲染层回归：「回复完了还一直显示正在思考」。
 *
 * ── 为什么必须有这一层 ─────────────────────────────────────────────────────
 * 数据层单测（agentRun.test.ts）只能证明 `isRunActive` 这个**纯函数**的契约，
 * 证明不了「界面是否真的不再渲染『正在思考…』」—— 因为文案来自 AgentTimeline 组件，
 * 而组件拿到的 `isStreaming` 来自 ChatView 的会话级 `streamingConvIds`。
 * 事故正是这两个东西组合出来的：run 已经 done，但残留的会话级标记让组件继续报活跃。
 *
 * 因此这里挂载**真实组件**断言 DOM：
 *   - 残留标记不得让已 done 的 run 复活（不出现「执行中 / 正在思考…」）；
 *   - 仍在跑的 run 必须照常显示（防止修复过度把正常态也关掉）。
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { AgentTimeline } from '../../src/components/chat/AgentTimeline'
import { applyRunEvent, createRun, type AgentRun, type RunEvent } from '../../src/components/chat/agentRun'

afterEach(cleanup)

/** 自增 id 生成器（模拟 ChatView 里的序号 ref）。 */
function counter(): () => number {
  let n = 0
  return () => (n += 1)
}

/** 跑到整轮 done 的一条最小 run（模拟「模型回复完毕」）。 */
function doneRun(): AgentRun {
  const next = counter()
  let run = createRun()
  run = applyRunEvent(run, { taskId: 'main', title: 'Mimir', status: 'running', kind: 'task' }, next)
  run = applyRunEvent(run, { taskId: 'main', title: 'Mimir', status: 'done', kind: 'task' }, next)
  return run
}

/** 仍在跑的一条 run（含一段进行中的思考，复现「正在思考…」的真实来源）。 */
function runningThinkRun(): AgentRun {
  const next = counter()
  let run = createRun()
  const evt: RunEvent = { taskId: 'main', title: 'Mimir', status: 'running', kind: 'think-token', text: '先看文献库' }
  run = applyRunEvent(run, evt, next)
  return run
}

describe('AgentTimeline：会话级 isStreaming 残留不得让已结束的回复继续「正在思考」', () => {
  it('run 已 done 且收到残留 isStreaming=true 时：不渲染「执行中 / 正在思考…」（本次事故的直接回归）', () => {
    render(<AgentTimeline run={doneRun()} isStreaming={true} />)

    // 徽标不得是「执行中」，活动行不得出现 —— 这两处才是「一直显示思考中」的观感来源
    expect(screen.queryByText('执行中')).toBeNull()
    expect(screen.queryByText('正在思考…')).toBeNull()
    // 收尾后应当是「执行完成」
    expect(screen.getByText('执行完成')).toBeTruthy()
  })

  it('run 仍在跑时：照常显示「执行中」与「正在思考…」（防止修复过度把正常态也关掉）', () => {
    render(<AgentTimeline run={runningThinkRun()} isStreaming={true} />)

    expect(screen.getByText('执行中')).toBeTruthy()
    expect(screen.getByText('正在思考…')).toBeTruthy()
  })

  it('run 仍在跑但外部标记缺失时：以 run.status 为准，仍显示「执行中」', () => {
    // 参数缺省（isStreaming=undefined）也不该影响权威判据
    render(<AgentTimeline run={runningThinkRun()} />)

    expect(screen.getByText('执行中')).toBeTruthy()
  })
})
