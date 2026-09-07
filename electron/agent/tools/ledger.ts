/**
 * 成长记录模块桥工具：读写 store key `ledger:entries`，与「记录」模块同一份数据。
 * 条目类型：milestone(里程碑)/progress(进展)/paper(论文)/experiment(实验)，date 为 YYYY-MM-DD。
 */
import { tool } from 'langchain/tools'
import { z } from 'zod'
import { getStoreValue, setStoreValue, currentSpaceEpoch, assertSpaceUnchanged } from '../../library/store'
import { requireUserApproval } from '../approval'

const LEDGER_KEY = 'ledger:entries'

type LedgerType = 'milestone' | 'progress' | 'paper' | 'experiment'

interface LedgerEntry {
  readonly id: string
  readonly title: string
  readonly content: string
  readonly type: LedgerType
  readonly date: string
}

const TYPE_LABEL: Record<LedgerType, string> = {
  milestone: '里程碑',
  progress: '进展',
  paper: '论文',
  experiment: '实验',
}

function load(): LedgerEntry[] {
  const raw = getStoreValue<unknown>(LEDGER_KEY)
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (item): item is LedgerEntry =>
      typeof item === 'object' && item !== null &&
      typeof (item as { id?: unknown }).id === 'string' &&
      typeof (item as { title?: unknown }).title === 'string',
  )
}

function describe(list: LedgerEntry[]): string {
  if (list.length === 0) return '暂无成长记录。'
  const lines = list.map((entry) => `- ${entry.id} | [${TYPE_LABEL[entry.type]}] ${entry.date} ${entry.title}` +
    (entry.content === '' ? '' : `\n  ${entry.content.slice(0, 200)}${entry.content.length > 200 ? '…' : ''}`))
  return `当前空间共 ${list.length} 条记录：\n${lines.join('\n')}`
}

export const ledgerTool = tool(
  async ({ action, id, title, content, type, date }) => {
    try {
      const epoch = currentSpaceEpoch()
      const list = load()
      if (action === 'list') return describe(list)

      // 副作用确认：create / delete 需用户放行
      const confirm =
        action === 'create'
          ? { summary: `新增成长记录「${title?.trim() ?? ''}」`, detail: `类型：${TYPE_LABEL[type ?? 'progress']}${date ? `；日期：${date}` : '；日期：今天'}` }
          : action === 'delete'
            ? { summary: `删除成长记录 id=${id ?? ''}`, detail: '删除不可撤销。' }
            : null
      if (confirm !== null) {
        const allowed = await requireUserApproval({ tool: 'ledger', summary: confirm.summary, detail: confirm.detail })
        if (!allowed) return '已取消：该记录操作未获得用户确认（或等待超时）。请先向用户说明并再次发起。'
      }

      if (action === 'create') {
        if (!title || title.trim() === '') return '创建失败：title 不能为空。'
        const entry: LedgerEntry = {
          id: `entry-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          title: title.trim(),
          content: content ?? '',
          type: type ?? 'progress',
          date: date ?? (() => new Date().toISOString().slice(0, 10))(),
        }
        assertSpaceUnchanged(epoch)
        saveList([entry, ...list])
        return `已添加记录 ${entry.id}「${entry.title}」[${TYPE_LABEL[entry.type]}] ${entry.date}。`
      }

      if (action === 'delete') {
        const target = list.find((entry) => entry.id === id)
        if (target === undefined) return `删除失败：找不到记录 id「${id}」。先用 action=list 查看可用 id。`
        assertSpaceUnchanged(epoch)
        saveList(list.filter((entry) => entry.id !== id))
        return `已删除记录 ${target.id}「${target.title}」。`
      }

      return '未知 action（可选：list / create / delete）。'
    } catch (error) {
      return `成长记录工具执行失败：${error instanceof Error ? error.message : '未知错误'}`
    }
  },
  {
    name: 'ledger',
    description:
      '操作当前科研空间的成长记录（与「记录」模块同一份数据）。action=list 查看全部；create 新增（title 必填，type 可选 milestone/progress/paper/experiment，content 可选，date 可选 YYYY-MM-DD，缺省今天）；delete 按 id 删除。写入前请先与用户确认。',
    schema: z.object({
      action: z.enum(['list', 'create', 'delete']),
      id: z.string().optional().describe('delete 时的记录 id'),
      title: z.string().optional().describe('记录标题（create 必填）'),
      content: z.string().optional(),
      type: z.enum(['milestone', 'progress', 'paper', 'experiment']).optional(),
      date: z.string().optional().describe('YYYY-MM-DD，缺省今天'),
    }),
  },
)

/** 供内部使用：写入列表。 */
function saveList(list: LedgerEntry[]): void {
  setStoreValue(LEDGER_KEY, list)
}
