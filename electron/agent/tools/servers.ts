/**
 * GPU 服务器模块桥工具（只读）：列出「服务器」模块已注册的机器，
 * 并对目标执行 TCP + SSH nvidia-smi 探测，返回实时 GPU 状态。
 */
import { tool } from 'langchain/tools'
import { z } from 'zod'
import { getStoreValue } from '../../library/store'
import { probeServer } from '../../servers/probe'

const SERVERS_KEY = 'servers:list'

interface ServerRecord {
  id: string
  name: string
  host: string
  port: number
  user: string
  keyPath?: string
  gpuCount: number
  gpuModel: string
}

function loadServers(): ServerRecord[] {
  const raw = getStoreValue<unknown>(SERVERS_KEY)
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (item): item is ServerRecord =>
      typeof item === 'object' && item !== null &&
      typeof (item as { id?: unknown }).id === 'string' &&
      typeof (item as { host?: unknown }).host === 'string',
  )
}

function describeGpu(gpu: { name: string; utilizationPct: number; memoryUsedMb: number; memoryTotalMb: number }): string {
  return `    - ${gpu.name} · util ${gpu.utilizationPct}% · mem ${gpu.memoryUsedMb}/${gpu.memoryTotalMb} MB`
}

export const serverStatusTool = tool(
  async ({ serverId }) => {
    try {
      const list = loadServers()
      if (list.length === 0) return '「服务器」模块尚未注册任何 GPU 服务器。'
      const targets = serverId === undefined || serverId === ''
        ? list
        : list.filter((server) => server.id === serverId || server.name === serverId)
      if (targets.length === 0) return `未找到服务器 id/名称「${serverId}」。可用：${list.map((s) => `${s.id}(${s.name})`).join('、')}`

      const lines: string[] = []
      for (const server of targets) {
        lines.push(`## ${server.name} (${server.id})`)
        lines.push(`  ${server.host}:${String(server.port)} · user ${server.user || '(未配置，仅探测连通性)'} · ${server.gpuCount}x ${server.gpuModel || '未知型号'}`)
        try {
          const result = await probeServer({
            host: server.host,
            port: server.port,
            user: server.user,
            gpuCount: server.gpuCount,
            ...(server.keyPath ? { keyPath: server.keyPath } : {}),
          })
          if (result.status === 'offline') {
            lines.push(`  状态：离线（${result.message ?? '无法连接'}）`)
            continue
          }
          lines.push(`  状态：在线（TCP ${String(result.tcpLatencyMs ?? 0)}ms${result.stage === 'gpu' ? ' · SSH GPU 已连通' : ' · 未配置 SSH 用户名'}` +
            (result.message ? ` · ${result.message}` : '') + '）')
          if (result.gpus.length > 0) {
            lines.push('  GPU 实时状态：')
            lines.push(...result.gpus.map(describeGpu))
          }
        } catch (error) {
          lines.push(`  探测异常：${error instanceof Error ? error.message : '未知错误'}`)
        }
      }
      return lines.join('\n')
    } catch (error) {
      return `服务器查询失败：${error instanceof Error ? error.message : '未知错误'}`
    }
  },
  {
    name: 'server_status',
    description:
      '查询当前注册的 GPU 服务器及其实时状态（只读）：TCP 连通性 + SSH nvidia-smi 的 GPU 利用率/显存。' +
      '不带参数时探测全部服务器，带 serverId 或名称时只探测目标。探测每台最长约 8 秒。',
    schema: z.object({
      serverId: z.string().optional().describe('服务器 id 或名称；缺省探测全部'),
    }),
  },
)
