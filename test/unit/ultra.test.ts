/**
 * Ultra 增强层单元测试（只覆盖**纯函数**部分：策略选型与策略库自身完整性）。
 *
 * 子图（合议 / 批判迭代 / 混合）需要真实模型，不在单测里跑——它们的价值要用
 * `test/eval` 的 A/B 来验证（`--real-agent --ultra` vs 不开增强）。
 *
 * 这些用例的意义：`pickUltraStrategy` 决定了「什么任务花多少钱」。
 * 它是「哪个任务走哪条高开销路径」的唯一开关，回归了会直接烧用户的 token。
 */
import { describe, expect, it } from 'vitest'
import { ULTRA_STRATEGY_IDS, ULTRA_STRATEGY_META, pickUltraStrategy } from '../../electron/agent/ultra'

describe('pickUltraStrategy（无路由画像时的关键词兜底）', () => {
  it('含权衡/评估类关键词 → 多专家合议', () => {
    expect(pickUltraStrategy('帮我评估一下这两个方案哪个更好').strategy).toBe('multi_expert')
  })

  it('含撰写/报告类关键词 → 批判迭代', () => {
    expect(pickUltraStrategy('帮我写一份论文提纲').strategy).toBe('critique_reflect')
  })

  it('两类都不命中 → 不增强（返回 null，而不是塞一段规划提示词）', () => {
    expect(pickUltraStrategy('你好').strategy).toBeNull()
  })
})

describe('pickUltraStrategy（有路由画像时按复杂度与意图选型）', () => {
  const meta = (
    intents: string[],
    categories: string[],
    complexity: 'low' | 'medium' | 'high'
  ): { intents: string[]; categories: string[]; complexity: 'low' | 'medium' | 'high' } => ({
    intents,
    categories,
    complexity
  })

  it('低复杂度一律不增强（不烧高开销策略）', () => {
    expect(pickUltraStrategy('润色这句话', meta(['writing_polish'], ['paper'], 'low')).strategy).toBeNull()
  })

  it('高复杂度 + 方案评估/结论研判 → 多专家合议', () => {
    expect(pickUltraStrategy('x', meta(['scheme_evaluation'], ['analysis'], 'high')).strategy).toBe('multi_expert')
  })

  it('高复杂度长交付（写作/综述）→ 批判迭代', () => {
    expect(pickUltraStrategy('x', meta(['paper_writing'], ['paper'], 'high')).strategy).toBe('critique_reflect')
  })

  it('高复杂度其它综合任务 → 混合增强', () => {
    expect(pickUltraStrategy('x', meta([], ['meeting'], 'high')).strategy).toBe('hybrid_mix')
  })

  it('中等权衡/判断型 → 轻量一致性投票', () => {
    expect(pickUltraStrategy('x', meta(['rebuttal'], ['paper'], 'medium')).strategy).toBe(
      'self_consistency_vote'
    )
  })

  it('中等常规任务 → 不增强', () => {
    expect(pickUltraStrategy('x', meta(['meeting_prep'], ['meeting'], 'medium')).strategy).toBeNull()
  })
})

describe('策略库自身完整性', () => {
  it('每个策略都有 label / desc / cost，且 cost 取值合法', () => {
    for (const id of ULTRA_STRATEGY_IDS) {
      const m = ULTRA_STRATEGY_META[id]
      expect(m, `策略 ${id} 缺少元数据`).toBeDefined()
      expect(m.label).not.toBe('')
      expect(m.desc).not.toBe('')
      expect(['low', 'medium', 'high']).toContain(m.cost)
    }
  })

  it('策略库里**不再有** low 成本策略（low 成本的 plain 已被 A/B 证伪移除）', () => {
    // 锁住这次删除的意图：不得有人为了「有个便宜的兜底」再把纯提示词策略加回来。
    // 需要「不花钱」时正确做法是返回 null（不增强），不是注入一段规划约束去多调工具。
    const lowCost = ULTRA_STRATEGY_IDS.filter((id) => ULTRA_STRATEGY_META[id].cost === 'low')
    expect(lowCost).toEqual([])
  })

  it('每个策略都会真的调用模型（不存在「零成本策略」的假象）', () => {
    for (const id of ULTRA_STRATEGY_IDS) {
      expect(ULTRA_STRATEGY_META[id].cost).not.toBe('low')
    }
  })
})
