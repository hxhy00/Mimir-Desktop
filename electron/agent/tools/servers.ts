/**
 * GPU 服务器模块桥工具：
 * - `server_status`（只读）：列出已注册机器并探测实时 GPU 状态；
 * - `server`（读写）：对服务器注册表做 CRUD，与「GPU 服务器」界面同一份数据。
 *
 * 读写一律经 `serversService`（`servers:list` 的唯一入口），
 * 与界面走同一 service，因此「界面写入 → agent 立刻可见」，不存在整表覆盖竞态。
 *
 * 安全边界（务必保持）：
 * - **绝不接受 password 参数**，输出也**绝不回显** password —— 凭据不能进 agent 上下文；
 * - delete 需批准，且 summary 以「删除」开头（`isDestructiveApproval` 据此在全权档仍弹卡）；
 * - 不改变 `probeServer` 的只读定位。
 */
import { tool } from 'langchain/tools'
import { z } from 'zod'
import { listServers, createServer, updateServer, deleteServer, findServer } from '../../servers/serversService'
import type { ServerRecord } from '../../servers/types'
import { probeServer } from '../../servers/probe'
import { requireBusinessApproval } from '../approval'
import { expandHome } from '../pathUtils'

/**
 * 缺省显示名：用户只给了连接信息（host/user）时**由工具代填**，而不是回头问用户。
 *
 * 为什么必须代填（真实事故）：用户说「帮我加台服务器，ssh root@119.3.210.1，22 端口」，
 * 信息已足够建立一条可用记录；但 create 原先把 name 当必填硬性拒绝，agent 只能停下
 * 来问「显示名是什么」——用户体感就是「说一句做一句」。显示名是个**纯展示、可事后改**
 * 的字段（update 一条即可），拿它当阻塞条件是错误的产品判断。
 */
function defaultName(host: string, user: string): string {
  return `${user}@${host}`
}


function describeGpu(gpu: { name: string; utilizationPct: number; memoryUsedMb: number; memoryTotalMb: number }): string {
  return `    - ${gpu.name} · util ${gpu.utilizationPct}% · mem ${gpu.memoryUsedMb}/${gpu.memoryTotalMb} MB`
}

/**
 * 渲染一条服务器记录（**刻意不含 password**，只标注「已配置密码」的存在性）。
 * 任何面向 agent 的输出都必须走这个函数，避免将来有人顺手把整条记录序列化出去。
 */
function describe(server: ServerRecord): string {
  const key = server.keyPath ? ` · 密钥: ${server.keyPath}` : ''
  const pwd = server.password ? ' · 已配置密码' : ''
  const notes = server.notes ? ` · 备注: ${server.notes}` : ''
  return `${server.id} | ${server.name} | ${server.user}@${server.host}:${server.port} · ${server.gpuCount}x ${server.gpuModel || '未知'}${key}${pwd}${notes}`
}

function describeList(list: ServerRecord[]): string {
  if (list.length === 0) return '暂未注册任何 GPU 服务器。可用 server(action="create") 新建。'
  return `已注册 ${list.length} 台 GPU 服务器：\n${list.map((s) => `- ${describe(s)}`).join('\n')}`
}

/** 服务器连接配置位于全局层，跨科研空间共享，因此不做空间切换校验（与 project 工具不同）。 */
export const serverTool = tool(
  async ({ action, serverId, name, host, port, user, keyPath, gpuCount, gpuModel, notes }) => {
    try {
      if (action === 'list') {
        return describeList(listServers())
      }

      if (action === 'get') {
        if (!serverId) return '读取失败：需要 serverId。先用 action="list" 查看可用服务器。'
        const target = findServer(serverId)
        if (target === undefined) {
          return `未找到服务器「${serverId}」。可用：${listServers().map((s) => `${s.id}(${s.name})`).join('、') || '(无)'}`
        }
        return `服务器详情：\n- ${describe(target)}`
      }

      if (action === 'create') {
        // host 是**唯一真正的必填项**：没有它就建立不了一条可用记录。
        if (!host || host.trim() === '') {
          return '创建失败：host 不能为空（例如 host="119.3.210.1"）。若用户还未提供主机地址，可先询问。'
        }
        const resolvedHost = host.trim()
        const resolvedUser = (user ?? 'root').trim() || 'root'
        // 只在用户**没给**显示名时才代填；给了就用用户的（可能是中文别名）。
        const resolvedName = (name ?? '').trim() || defaultName(resolvedHost, resolvedUser)
        const resolvedPort = port ?? 22
        // keyPath 支持 ~ 写法（用户常说「私钥在我本地 ssh 文件夹」）：落库前展开成真实路径，
        // 否则 probeServer 读私钥必然失败，且失败要等到探测时才暴露（更难定位）。
        const resolvedKeyPath = keyPath !== undefined && keyPath.trim() !== '' ? expandHome(keyPath.trim()) : undefined

        const allowed = await requireBusinessApproval({
          tool: 'server',
          summary: `新增 GPU 服务器「${resolvedName}」`,
          detail: `${resolvedUser}@${resolvedHost}:${String(resolvedPort)}${resolvedKeyPath !== undefined ? `\n密钥: ${resolvedKeyPath}` : ''}`,
        })
        if (!allowed) return '已取消：新增服务器操作未获得用户确认。'
        // 刻意不透传 password：agent 上下文里不该出现凭据。
        const created = createServer({
          name: resolvedName,
          host: resolvedHost,
          port: resolvedPort,
          user: resolvedUser,
          ...(resolvedKeyPath !== undefined ? { keyPath: resolvedKeyPath } : {}),
          ...(gpuCount !== undefined ? { gpuCount } : {}),
          ...(gpuModel !== undefined ? { gpuModel } : {}),
          ...(notes !== undefined ? { notes } : {}),
        })
        return `已新增服务器 ${created.id}（${created.name}）→ ${created.user}@${created.host}:${String(created.port)}。\n注意：密码字段未由本工具写入，如需密码登录请在「GPU 服务器」界面补充。`
      }

      if (action === 'update') {
        if (!serverId) return '更新失败：需要 serverId。先用 action="list" 查看可用服务器。'
        const current = findServer(serverId)
        if (current === undefined) {
          return `未找到服务器「${serverId}」。可用：${listServers().map((s) => `${s.id}(${s.name})`).join('、') || '(无)'}`
        }
        const patch = {
          ...(name !== undefined ? { name } : {}),
          ...(host !== undefined ? { host } : {}),
          ...(port !== undefined ? { port } : {}),
          ...(user !== undefined ? { user } : {}),
          // 与 create 一致：~ 写法落库前展开。注意空串是「清空」的语义，不能被展开逻辑吃掉。
          ...(keyPath !== undefined ? { keyPath: keyPath.trim() === '' ? '' : expandHome(keyPath.trim()) } : {}),
          ...(gpuCount !== undefined ? { gpuCount } : {}),
          ...(gpuModel !== undefined ? { gpuModel } : {}),
          ...(notes !== undefined ? { notes } : {}),
        }
        if (Object.keys(patch).length === 0) {
          return '更新失败：至少提供一个可修改字段（name / host / port / user / keyPath / gpuCount / gpuModel / notes）。'
        }
        const allowed = await requireBusinessApproval({
          tool: 'server',
          summary: `更新 GPU 服务器「${current.name}」`,
          detail: Object.entries(patch).map(([k, v]) => `${k}: ${String(v)}`).join('\n'),
        })
        if (!allowed) return '已取消：更新服务器操作未获得用户确认。'
        const updated = updateServer(current.id, patch)
        return `已更新服务器 ${updated.id}「${updated.name}」。`
      }

      if (action === 'delete') {
        if (!serverId) return '删除失败：需要 serverId。先用 action="list" 查看可用服务器。'
        const target = findServer(serverId)
        if (target === undefined) {
          return `未找到服务器「${serverId}」。可用：${listServers().map((s) => `${s.id}(${s.name})`).join('、') || '(无)'}`
        }
        // summary 以「删除」开头 —— isDestructiveApproval 据此判定，保证全权档下仍弹卡
        const allowed = await requireBusinessApproval({
          tool: 'server',
          summary: `删除 GPU 服务器「${target.name}」`,
          detail: `${target.user}@${target.host}:${String(target.port)}\n注意：仅移除本机注册记录，不会改动远端机器，且不可撤销。`,
        })
        if (!allowed) return '已取消：删除服务器操作未获得用户确认。'
        deleteServer(target.id)
        return `已删除服务器 ${target.id}「${target.name}」。`
      }

      return '未知 action（可选：list / get / create / update / delete）。'
    } catch (error) {
      return `服务器工具执行失败：${error instanceof Error ? error.message : '未知错误'}`
    }
  },
  {
    name: 'server',
    description:
      '管理当前注册的 GPU 服务器（与「GPU 服务器」界面同一份数据）。' +
      'action=list 列出全部（含 id / 连接信息 / GPU 配置）；get 读单台；' +
      'create 新增（**只有 host 必填**：name 缺省自动用 "user@host"、user 缺省 root、port 缺省 22，' +
      'keyPath/gpuCount/gpuModel/notes 可选）；update 修改（serverId 必填，其余字段按需给）；' +
      'delete 删除（需批准，不可撤销）。' +
      '**拿到 host（以及可选的 user/port/私钥）就应当直接 create，不要因为缺少显示名等可选字段而停下来追问用户**——' +
      '显示名只是个可事后 update 的展示字段（缺省自动用 "user@host"）。keyPath 支持 ~ 写法（如 ~/.ssh/id_rsa，会自动展开为主目录）。' +
      '**若用户指定的私钥文件并不存在（先用 read_dir 确认），仍然要先把服务器建上**：' +
      'keyPath 改填目录里实际存在的私钥，或干脆留空 —— 连同「你要的 X 没找到」一起在结果里说明，' +
      '**不要停下等用户拍板**；密钥是随时可 update 的字段，不构成阻塞创建的理由。' +
      '出于安全考虑本工具不接受也不回显密码，需要密码请在界面填写。' +
      '要探测实时 GPU 状态请改用 server_status。',
    schema: z.object({
      action: z.enum(['list', 'get', 'create', 'update', 'delete']),
      serverId: z.string().optional().describe('服务器 id 或名称（get / update / delete 必填）'),
      name: z.string().optional().describe('服务器显示名；create 时缺省自动生成 "user@host"，无需为此追问用户'),
      host: z.string().optional().describe('主机地址（create 必填）'),
      port: z.number().int().min(1).max(65535).optional().describe('SSH 端口，默认 22'),
      user: z.string().optional().describe('SSH 用户名，默认 root'),
      keyPath: z.string().optional().describe('SSH 私钥路径，支持 ~ 写法（如 ~/.ssh/id_rsa）；update 时传空串表示清空'),
      gpuCount: z.number().int().min(0).optional().describe('GPU 数量'),
      gpuModel: z.string().optional().describe('GPU 型号'),
      notes: z.string().optional().describe('备注'),
    }),
  },
)

export const serverStatusTool = tool(
  async ({ serverId }) => {
    try {
      const list = listServers()
      if (list.length === 0) return '「服务器」模块尚未注册任何 GPU 服务器。'
      const targets = serverId === undefined || serverId === ''
        ? list
        : (() => {
            const hit = findServer(serverId)
            return hit ? [hit] : []
          })()
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
