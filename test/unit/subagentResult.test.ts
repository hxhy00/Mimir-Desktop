/**
 * 工具结果消费纪律 + 执行纪律（原「D2 子代理结构化返回契约」）。
 *
 * 当前架构为「单 Agent + 可选委派（双轨）」：主 Agent 持有全部工具可直调，也可用 `task`
 * 把某能力域内的整块多步工作委派给子代理。因此纪律要同时管住两条路径：
 *   1. 工具结果消费纪律（{@link SUBAGENT_RETURN_CONTRACT}）：证据 ≠ 结论，必须区分
 *      「已确认的事实 / 你的推断 / 失败或未执行」，注明来源、标注推断、失败不美化；
 *   2. 执行纪律（{@link SINGLE_AGENT_EXECUTION_DISCIPLINE}）：需要时直接调用工具，
 *      只有「可独立交付的整块多步工作」才委派；决定不委派就直接做、不要只说不动手；
 *      自己整合最终答复；被拒或缺少必要信息时停下追问而非反复绕路。
 *
 * 这两个常量是注入 systemPrompt 的自然语言约束，因此断言按「纪律是否在场」编写：
 * 每条纪律给出若干同义表述做「或」匹配，命中任一即视为该纪律未被删除。这样既能拦住
 * 「整条纪律被删掉」的回归，又不会因措辞微调而误报，比逐字包含断言更稳。
 */
import { describe, expect, it } from 'vitest'
import {
  SUBAGENT_RETURN_CONTRACT,
  SINGLE_AGENT_EXECUTION_DISCIPLINE
} from '../../electron/agent/subagentResult'

/** 断言 text 至少命中 alternatives 中的一种表述；label 用于失败时指明缺失的纪律。 */
function expectDiscipline(text: string, label: string, alternatives: RegExp[]): void {
  const hit = alternatives.some((re) => re.test(text))
  expect(hit, `缺少纪律「${label}」，应命中 ${alternatives.map(String).join(' | ')} 之一`).toBe(true)
}

describe('subagentResult：工具结果消费纪律（SUBAGENT_RETURN_CONTRACT）', () => {
  it('要求把工具返回分成「已确认的事实 / 你的推断 / 失败或未执行」三类', () => {
    expectDiscipline(SUBAGENT_RETURN_CONTRACT, '已确认的事实', [/已确认的事实/, /确认的事实/])
    expectDiscipline(SUBAGENT_RETURN_CONTRACT, '你的推断', [/你的推断/, /推断/])
    expectDiscipline(SUBAGENT_RETURN_CONTRACT, '失败或未执行', [/失败或未执行/, /未执行/, /失败/])
  })

  it('要求引用事实时注明来源', () => {
    expectDiscipline(SUBAGENT_RETURN_CONTRACT, '注明来源', [/注明来源/, /来源/])
  })

  it('要求推断显式标注，不得写成既定事实', () => {
    expectDiscipline(SUBAGENT_RETURN_CONTRACT, '推断需标注', [/标注为推断/, /标注.*推断/, /推测/])
    expectDiscipline(SUBAGENT_RETURN_CONTRACT, '推断不得当事实', [
      /不得写成既定事实/,
      /不得.*既定事实/,
      /不.*当.*事实/
    ])
  })

  it('要求失败/未执行如实说明，不得替代为成功口径', () => {
    expectDiscipline(SUBAGENT_RETURN_CONTRACT, '失败如实说明', [
      /不要替代为成功口径/,
      /替代为成功/,
      /不要声称执行了未执行/
    ])
  })
})

describe('subagentResult：执行纪律（SINGLE_AGENT_EXECUTION_DISCIPLINE）', () => {
  it('要求直接调用工具（能力域外的任务自己直调，不绕委派）', () => {
    expectDiscipline(SINGLE_AGENT_EXECUTION_DISCIPLINE, '直接调用工具', [/直接调用/])
  })

  it('委派纪律：仅「能力域内可独立交付的整块多步工作」才委派；决定不委派就直接动手', () => {
    expectDiscipline(SINGLE_AGENT_EXECUTION_DISCIPLINE, '限定委派适用面', [
      /只有.*才用 task 委派/,
      /才用 task 委派/,
      /独立完成的多步整块工作/
    ])
    expectDiscipline(SINGLE_AGENT_EXECUTION_DISCIPLINE, '不委派就直接做', [
      /决定不委派就直接做/,
      /不要描述了却不动手/
    ])
  })

  it('要求最终答复由自己整合：不直接粘贴工具原始返回、不省略关键来源与未决风险', () => {
    expectDiscipline(SINGLE_AGENT_EXECUTION_DISCIPLINE, '自己整合最终答复', [
      /最终答复由你自己整合/,
      /自己整合/
    ])
    expectDiscipline(SINGLE_AGENT_EXECUTION_DISCIPLINE, '不直接粘贴工具原始返回', [
      /不直接粘贴工具原始返回/,
      /不.*粘贴.*原始返回/
    ])
    expectDiscipline(SINGLE_AGENT_EXECUTION_DISCIPLINE, '不省略关键来源与未决风险', [
      /不省略关键来源/,
      /未决风险/
    ])
  })

  it('要求批准卡被拒或缺少必要信息时停下追问，不反复重试或绕路', () => {
    expectDiscipline(SINGLE_AGENT_EXECUTION_DISCIPLINE, '被拒/缺信息时停下说明', [
      /拒绝了批准卡/,
      /缺少必要信息/,
      /停下/
    ])
    expectDiscipline(SINGLE_AGENT_EXECUTION_DISCIPLINE, '向用户追问', [/追问/, /向用户说明/])
    expectDiscipline(SINGLE_AGENT_EXECUTION_DISCIPLINE, '不反复重试或绕路', [
      /不要反复重试/,
      /反复重试/,
      /绕路/
    ])
  })
})
