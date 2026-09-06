/**
 * 实验模块桥工具：Agent 可直接读写当前科研空间的实验记录
 * （store key `experiments:list`，与「实验」模块同一份数据）。
 * 结构与 src/lib/experiments.ts / electron/meetings/types.ts 保持一致。
 */
import { tool } from 'langchain/tools'
import { z } from 'zod'
import { getStoreValue, setStoreValue } from '../../library/store'
import { requireUserApproval } from '../approval'

export type ExperimentStatus = 'running' | 'success' | 'failed'

interface ExperimentRecord {
  readonly id: string
  readonly name: string
  readonly status: ExperimentStatus
  readonly metrics: Record<string, number | string>
  readonly serverId?: string | undefined
  readonly updatedAt: string
}

const EXPERIMENTS_KEY = 'experiments:list'

const STATUS_LABEL: Record<ExperimentStatus, string> = {
  running: '训练中',
  success: '已完成',
  failed: '失败',
}

function load(): ExperimentRecord[] {
  const raw = getStoreValue<unknown>(EXPERIMENTS_KEY)
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (item): item is ExperimentRecord =>
      typeof item === 'object' && item !== null &&
      typeof (item as { id?: unknown }).id === 'string' &&
      typeof (item as { name?: unknown }).name === 'string',
  )
}

function save(list: ExperimentRecord[]): void {
  setStoreValue(EXPERIMENTS_KEY, list)
}

function describe(list: ExperimentRecord[]): string {
  if (list.length === 0) return '暂无实验记录。'
  const lines = list.map((exp) => {
    const metrics = Object.entries(exp.metrics)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(', ')
    return `- ${exp.id} | ${exp.name} [${STATUS_LABEL[exp.status]}] 更新于 ${exp.updatedAt}` +
      (metrics === '' ? '' : `\n  metrics: ${metrics}`) +
      (exp.serverId === undefined ? '' : `\n  serverId: ${exp.serverId}`)
  })
  return `当前空间共 ${list.length} 条实验：\n${lines.join('\n')}`
}

/**
 * experiment 工具：查看/记录/更新/删除实验。
 * 写入会立即反映到「实验」模块与指标对比图。副作用操作（create/update/delete）
 * 请先取得用户确认再执行。
 */
export const experimentTool = tool(
  async ({ action, name, status, metrics, serverId, id }) => {
    try {
      const list = load()
      if (action === 'list') return describe(list)

      // 副作用确认：create / update / delete 需用户放行
      const confirm = (() => {
        switch (action) {
          case 'create':
            return {
              summary: `新建实验「${name?.trim() ?? ''}」`,
              detail: `状态：${STATUS_LABEL[status ?? 'running']}${metrics ? `；指标：${Object.entries(metrics).map(([k, v]) => `${k}=${String(v)}`).join(', ')}` : ''}${serverId ? `；关联服务器：${serverId}` : ''}`,
            }
          case 'update':
            return { summary: `更新实验 id=${id ?? ''}`, detail: `${name ? `新名称：${name}；` : ''}${status ? `新状态：${STATUS_LABEL[status]}` : ''}` }
          case 'delete':
            return { summary: `删除实验 id=${id ?? ''}`, detail: '删除不可撤销。' }
          default:
            return null
        }
      })()
      if (confirm !== null) {
        const allowed = await requireUserApproval({ tool: 'experiment', summary: confirm.summary, detail: confirm.detail })
        if (!allowed) return '已取消：该实验操作未获得用户确认（或等待超时）。请先向用户说明并再次发起。'
      }

      if (action === 'create') {
        if (!name || name.trim() === '') return '创建失败：name 不能为空。'
        if (list.some((exp) => exp.name === name.trim())) {
          return `创建失败：已存在同名实验「${name.trim()}」。若要记录新一轮运行，请改为 update 并明确目标 id，或在 name 中加入运行标记（种子/日期）。`
        }
        const now = new Date().toISOString()
        const record: ExperimentRecord = {
          id: `exp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          name: name.trim(),
          status: status ?? 'running',
          metrics: metrics ?? {},
          ...(serverId ? { serverId } : {}),
          updatedAt: now,
        }
        save([record, ...list])
        return `已创建实验 ${record.id}「${record.name}」。`
      }

      if (action === 'update') {
        const target = list.find((exp) => exp.id === id)
        if (target === undefined) return `更新失败：找不到实验 id「${id}」。先用 action=list 查看可用 id。`
        if (name !== undefined && name.trim() !== '' && name.trim() !== target.name && list.some((exp) => exp.name === name.trim())) {
          return `更新失败：已存在同名实验「${name.trim()}」。`
        }
        const next: ExperimentRecord = {
          ...target,
          name: name !== undefined && name.trim() !== '' ? name.trim() : target.name,
          status: status ?? target.status,
          metrics: metrics ?? target.metrics,
          serverId: serverId === undefined ? target.serverId : (serverId === '' ? undefined : serverId),
          updatedAt: new Date().toISOString(),
        }
        save(list.map((exp) => (exp.id === id ? next : exp)))
        return `已更新实验 ${next.id}「${next.name}」→ [${STATUS_LABEL[next.status]}]。`
      }

      if (action === 'delete') {
        const target = list.find((exp) => exp.id === id)
        if (target === undefined) return `删除失败：找不到实验 id「${id}」。`
        save(list.filter((exp) => exp.id !== id))
        return `已删除实验 ${target.id}「${target.name}」。`
      }

      return '未知 action（可选：list / create / update / delete）。'
    } catch (error) {
      return `实验工具执行失败：${error instanceof Error ? error.message : '未知错误'}`
    }
  },
  {
    name: 'experiment',
    description:
      '操作当前科研空间的实验记录（与「实验」模块同一份数据）。' +
      'action=list 查看全部；create 新建（name 必填，status 可选 running/success/failed，metrics 为 key→数值/字符串 映射，serverId 可选）；update 按 id 更新（可改 name/status/metrics/serverId，清空 serverId 传空串）；delete 按 id 删除。写入前请先与用户确认。',
    schema: z.object({
      action: z.enum(['list', 'create', 'update', 'delete']),
      id: z.string().optional().describe('update/delete 时的实验 id'),
      name: z.string().optional().describe('实验名称（create 必填）'),
      status: z.enum(['running', 'success', 'failed']).optional(),
      metrics: z.record(z.union([z.string(), z.number()])).optional().describe('指标：accuracy=0.92、loss=0.13 …'),
      serverId: z.string().optional().describe('关联服务器 id；清空传空字符串'),
    }),
  },
)
