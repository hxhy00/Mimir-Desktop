import { describe, expect, it } from 'vitest'
import { checkSeq, createSequencer, newStreamId } from '../../electron/agent/streamProtocol'

/**
 * 流式事件协议（`electron/agent/streamProtocol.ts`）的回归守护。
 *
 * 这组用例锁住的是**「丢包必须可确定」**这一核心契约：旧的前缀字符串信封方案
 * 无序号，丢包只能靠最终长度反推、无法知道丢在第几号，是「内容显示不全」类
 * 问题长期难定位的根因之一。以下用例保证：
 *   ① seq 严格单调从 0 起（接收端据此对账）
 *   ② 跳号被识别为**确定性丢包**并给出缺失量
 *   ③ 重复 / 迟到事件不被误判为丢包，也不会让进度回退
 *   ④ streamId 让不同回复流可区分（陈旧事件可判）
 */

describe('createSequencer：事件编排', () => {
  it('seq 从 0 起严格单调递增，且所有事件共享同一 streamId', () => {
    const seq = createSequencer('s-test')
    const e0 = seq.next({ type: 'text-delta', delta: '你' })
    const e1 = seq.next({ type: 'text-delta', delta: '好' })
    const e2 = seq.next({ type: 'end', finalLength: 2 })

    expect(e0.seq).toBe(0)
    expect(e1.seq).toBe(1)
    expect(e2.seq).toBe(2)
    expect([e0.streamId, e1.streamId, e2.streamId]).toEqual(['s-test', 's-test', 's-test'])
    // count 反映已编排事件数，供主进程落盘对账（stream.end.out events=N）
    expect(seq.count).toBe(3)
  })

  it('事件类型与负载原样保留（不做前缀拼接等有损包装）', () => {
    const seq = createSequencer('s-types')
    const worker = seq.next({ type: 'worker', payload: { taskId: 't1', status: 'running' } })
    const err = seq.next({ type: 'error', message: 'boom' })

    expect(worker).toMatchObject({ type: 'worker', payload: { taskId: 't1', status: 'running' } })
    expect(err).toMatchObject({ type: 'error', message: 'boom' })
  })

  it('两次独立回复流不复用 streamId（陈旧流据此可判）', () => {
    const a = createSequencer()
    const b = createSequencer()
    expect(a.streamId).not.toBe(b.streamId)
  })
})

describe('checkSeq：跳号 = 确定性丢包', () => {
  it('连续事件不报丢包', () => {
    expect(checkSeq(-1, 0)).toEqual({ skipped: false, missing: 0, expected: 0 })
    expect(checkSeq(0, 1)).toEqual({ skipped: false, missing: 0, expected: 1 })
    expect(checkSeq(7, 8)).toEqual({ skipped: false, missing: 0, expected: 8 })
  })

  it('跳号被识别为丢包，并给出缺失量（旧方案无法得到这个事实）', () => {
    // 收到 0 后直接收到 3：中间 1、2 丢了
    expect(checkSeq(0, 3)).toEqual({ skipped: true, missing: 2, expected: 1 })
    // 首个事件就不是 0：前面全丢
    expect(checkSeq(-1, 5)).toEqual({ skipped: true, missing: 5, expected: 0 })
  })

  it('重复 / 迟到事件不算丢包，且不让接收进度回退', () => {
    // 已收到 4，又收到 4（重复）或 2（迟到）：都按「无缺失」处理
    expect(checkSeq(4, 4)).toEqual({ skipped: false, missing: 0, expected: 5 })
    expect(checkSeq(4, 2)).toEqual({ skipped: false, missing: 0, expected: 5 })
  })
})

describe('newStreamId：唯一性', () => {
  it('高频生成不重复（时间戳 + 随机后缀）', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newStreamId()))
    expect(ids.size).toBe(2000)
  })
})
