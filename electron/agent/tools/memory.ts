/**
 * 长期记忆只读工具（治理 Phase 3）：读取用户的全局「记忆档案」（存于全局设置 settings.memoryProfile）。
 * 记忆默认不注入任何一轮 prompt；仅当任务与用户长期方向/偏好相关时，由 Supervisor 判定后调用本工具按需加载。
 * 档案在「设置 → 长期记忆」中维护，内容存在本机，不会随对话自动写入。
 */
import { tool } from 'langchain/tools'
import { z } from 'zod'
import { getStoreValue } from '../../library/store'

function readMemoryProfile(): Record<string, unknown> {
  try {
    const settings = (getStoreValue<Record<string, unknown>>('settings') ?? {}) as Record<string, unknown>
    const profile = (settings.memoryProfile ?? {}) as Record<string, unknown>
    return profile
  } catch {
    return {}
  }
}

export const loadMemoryTool = tool(
  async () => {
    const p = readMemoryProfile()
    const focus = typeof p.researchFocus === 'string' ? p.researchFocus.trim() : ''
    const constraints = typeof p.constraints === 'string' ? p.constraints.trim() : ''
    const facts = typeof p.commonFacts === 'string' ? p.commonFacts.trim() : ''
    if (focus === '' && constraints === '' && facts === '') {
      return (
        '用户的长期记忆档案为空（尚未在「设置 → 长期记忆」中填写）。' +
        '不要编造用户的研究方向或偏好；如需可引导用户去设置里补充。'
      )
    }
    const lines: string[] = []
    lines.push('用户长期记忆档案（按需参考，非本轮任务指令）：')
    if (focus !== '') lines.push(`- 研究方向/关注领域：${focus}`)
    if (constraints !== '') lines.push(`- 常用约束与偏好：${constraints}`)
    if (facts !== '') lines.push(`- 常用事实（项目路径/工具/协作等）：${facts}`)
    if (typeof p.updatedAt === 'string' && p.updatedAt !== '') {
      lines.push(`- 档案更新时间：${p.updatedAt.slice(0, 16).replace('T', ' ')}`)
    }
    return lines.join('\n')
  },
  {
    name: 'load_memory',
    description:
      '只读加载用户的长期记忆档案（研究方向/常用约束/常用事实，维护于「设置 → 长期记忆」）。' +
      '当用户的请求涉及其长期研究方向、偏好约束或已记录的常用项目/路径时，先用本工具核对，避免凭空假设。档案为空时也会如实说明。',
    schema: z.object({})
  }
)
