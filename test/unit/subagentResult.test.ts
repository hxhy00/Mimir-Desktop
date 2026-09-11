/**
 * D2 子代理结构化返回契约单元测试：报告分节、主管消费约束。
 */
import { describe, expect, it } from 'vitest'
import {
  SUBAGENT_RETURN_CONTRACT,
  SUPERVISOR_DELEGATION_CONSUMPTION
} from '../../electron/agent/subagentResult'

describe('subagentResult：D2 结构化返回契约', () => {
  it('子代理返回契约要求分四节，含「未决与风险」「需主管决策」', () => {
    expect(SUBAGENT_RETURN_CONTRACT).toContain('结论')
    expect(SUBAGENT_RETURN_CONTRACT).toContain('依据与来源')
    expect(SUBAGENT_RETURN_CONTRACT).toContain('未决与风险')
    expect(SUBAGENT_RETURN_CONTRACT).toContain('需主管决策')
  })

  it('返回契约明确「不是给用户的答复」，避免主管误当最终答复', () => {
    expect(SUBAGENT_RETURN_CONTRACT).toContain('不是给用户的答复')
  })

  it('主管消费指令声明子代理返回是「工具结果」而非用户消息', () => {
    expect(SUPERVISOR_DELEGATION_CONSUMPTION).toContain('工具结果')
    expect(SUPERVISOR_DELEGATION_CONSUMPTION).toContain('不是用户消息')
  })

  it('主管消费指令要求：不把未决项当事实、失败不替代为成功口径', () => {
    expect(SUPERVISOR_DELEGATION_CONSUMPTION).toContain('不得被当作已确认的事实')
    expect(SUPERVISOR_DELEGATION_CONSUMPTION).toContain('失败')
  })
})
