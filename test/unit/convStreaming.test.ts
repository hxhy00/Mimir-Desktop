/**
 * 「正在生成」收尾时序的回归测试。
 *
 * 这是本次事故（回复结束后界面仍显示「正在思考…」、输入区永久禁用）真正的根因所在，
 * 因此这里把三种真实时序钉死，防止回归：
 *   ① 正常收尾 —— 该谁关灯就谁关；
 *   ② 旧流收尾晚于新流开场（停止后立刻重发）—— 旧流必须**不能**跑到新流前面关灯；
 *   ③ 用户停止 —— 必须清掉归属，让旧流的 finally 认不出自己而保持沉默。
 */
import { describe, expect, it } from 'vitest'
import { ConvStreamingRegistry } from '../../src/components/chat/convStreaming'

describe('ConvStreamingRegistry：关灯必须带归属', () => {
  it('正常收尾：登记者本人收尾时可以关灯', () => {
    const reg = new ConvStreamingRegistry()
    reg.begin('c1', 1)

    expect(reg.release('c1', 1)).toBe(true)
    // 关灯后登记应被清掉，避免陈旧记录让下一次比较误判
    expect(reg.current('c1')).toBeUndefined()
  })

  it('迟到收尾：旧流（sendId=1）晚于新流（sendId=2）开场时，旧流不得关灯', () => {
    // 事故场景：用户点停止后立刻重发 —— 旧流的 finally 排在新流开场之后。
    const reg = new ConvStreamingRegistry()
    reg.begin('c1', 1)
    reg.begin('c1', 2) // 新流开场，顶掉旧流的归属

    // 旧流的 finally 此刻才执行：必须返回 false（保持沉默），否则新流被误关
    expect(reg.release('c1', 1)).toBe(false)
    // 新流仍在跑，登记必须完好
    expect(reg.current('c1')).toBe(2)
    // 新流自己的收尾照常生效
    expect(reg.release('c1', 2)).toBe(true)
  })

  it('用户停止：forget 后旧流的 finally 必须认不出自己（返回 false），不误关后续新流', () => {
    const reg = new ConvStreamingRegistry()
    reg.begin('c1', 1)
    reg.forget('c1') // 用户点停止

    expect(reg.current('c1')).toBeUndefined()

    // 旧流 finally 迟到：归属已被清，必须保持沉默
    expect(reg.release('c1', 1)).toBe(false)

    // 且此后重发（sendId=2）不会被上一个 tick 的残留影响
    reg.begin('c1', 2)
    expect(reg.current('c1')).toBe(2)
    expect(reg.release('c1', 1)).toBe(false)
    expect(reg.release('c1', 2)).toBe(true)
  })

  it('多会话互不干扰：一个会话的收尾不影响另一个会话的登记', () => {
    const reg = new ConvStreamingRegistry()
    reg.begin('c1', 1)
    reg.begin('c2', 2)

    expect(reg.release('c1', 1)).toBe(true)
    // c2 仍在跑
    expect(reg.current('c2')).toBe(2)
    expect(reg.release('c2', 2)).toBe(true)
  })
})
