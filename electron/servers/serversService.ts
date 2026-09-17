/**
 * GPU 服务器统一 service：`servers:list` 这个全局 store key 的**唯一写入口**。
 *
 * 为什么必须收敛（原状态的问题）：界面 `Servers.tsx` 把组件内存里的整份数组
 * 直接 `setStoreValue('servers:list', next)` 覆盖。一旦同时有第二个写入方
 * （agent 工具），就会「后写者用旧快照覆盖先写者」——典型竞态，用户会看到
 * 「刚加的服务器没了」或「改了的名字又变回去」。
 *
 * 收敛规则：
 * 1. **所有写操作在这里完成读-改-写**，每次都从 store 重新读最新列表，
 *    不接收调用方传入的旧数组（这是消除竞态的关键，别改成接收整表）；
 * 2. service 只管连接配置；运行时探测结果不落盘（见 types.ts 的类型注释）；
 * 3. 读取时**保留未知/旧字段**，保证老数据不因升级而丢失。
 *
 * IPC 与 Agent 工具都经本 service 访问，不再各写各的。
 */
import { randomUUID } from 'node:crypto'
import { getStoreValue, setStoreValue } from '../library/store'
import type { ServerDraft, ServerPatch, ServerRecord } from './types'

/** `servers:list` 存于全局层（跨科研空间共享），见 library/store.ts 的 GLOBAL_KEYS。 */
const SERVERS_KEY = 'servers:list'

const DEFAULT_PORT = 22
const DEFAULT_GPU_COUNT = 1

/**
 * 把 store 里的原始值规范成 `ServerRecord[]`。
 *
 * 只做**最低限度的形状校验**（id 与 host 必须是字符串），其余字段原样带过——
 * 过严的校验会在升级时把用户数据吞掉，而这里的目标恰恰是「一个都不丢」。
 */
function normalize(raw: unknown): ServerRecord[] {
  if (!Array.isArray(raw)) return []
  const out: ServerRecord[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    if (typeof rec.id !== 'string' || typeof rec.host !== 'string') continue
    out.push({ ...(rec as ServerRecord) })
  }
  return out
}

/** 读取全部服务器（每次实时读 store，不使用任何缓存）。 */
export function listServers(): ServerRecord[] {
  return normalize(getStoreValue<unknown>(SERVERS_KEY))
}

/** 内部：写回整个列表。只允许本文件调用，保证「唯一写入口」。 */
function persist(list: ServerRecord[]): void {
  setStoreValue(SERVERS_KEY, list)
}

function requireNonEmpty(value: string | undefined, field: string): string {
  const trimmed = (value ?? '').trim()
  if (trimmed === '') throw new Error(`server ${field} must be non-empty`)
  return trimmed
}

/** 新建服务器。id 由 service 生成，调用方不得指定（避免重复 id）。 */
export function createServer(draft: ServerDraft): ServerRecord {
  const name = requireNonEmpty(draft.name, 'name')
  const host = requireNonEmpty(draft.host, 'host')
  const record: ServerRecord = {
    id: `srv-${randomUUID()}`,
    name,
    host,
    port: draft.port ?? DEFAULT_PORT,
    user: draft.user ?? 'root',
    gpuCount: draft.gpuCount ?? DEFAULT_GPU_COUNT,
    gpuModel: draft.gpuModel ?? '未知',
    ...(draft.keyPath !== undefined && draft.keyPath.trim() !== '' ? { keyPath: draft.keyPath.trim() } : {}),
    ...(draft.password !== undefined && draft.password !== '' ? { password: draft.password } : {}),
    ...(draft.notes !== undefined ? { notes: draft.notes } : {}),
  }
  // 读-改-写一次性完成：基于**刚读到的最新列表**追加
  persist([...listServers(), record])
  return record
}

/**
 * 更新服务器。未提供的字段保持原值。
 *
 * `keyPath` / `password` 传空串表示**清空**（与「未提供」区分开）——这与界面表单
 * 「留空则使用密钥」的语义一致。
 */
export function updateServer(id: string, patch: ServerPatch): ServerRecord {
  const list = listServers()
  const index = list.findIndex((s) => s.id === id)
  if (index === -1) throw new Error(`server-not-found: ${id}`)
  const current = list[index]!

  const next: ServerRecord = { ...current }
  if (patch.name !== undefined) next.name = requireNonEmpty(patch.name, 'name')
  if (patch.host !== undefined) next.host = requireNonEmpty(patch.host, 'host')
  if (patch.port !== undefined) next.port = patch.port
  if (patch.user !== undefined) next.user = patch.user
  if (patch.gpuCount !== undefined) next.gpuCount = patch.gpuCount
  if (patch.gpuModel !== undefined) next.gpuModel = patch.gpuModel
  if (patch.notes !== undefined) next.notes = patch.notes
  if (patch.keyPath !== undefined) {
    if (patch.keyPath.trim() === '') delete next.keyPath
    else next.keyPath = patch.keyPath.trim()
  }
  if (patch.password !== undefined) {
    if (patch.password === '') delete next.password
    else next.password = patch.password
  }

  list[index] = next
  persist(list)
  return next
}

/** 删除服务器。不存在时静默成功（幂等，便于 agent 重试）。 */
export function deleteServer(id: string): void {
  persist(listServers().filter((s) => s.id !== id))
}

/** 按 id 或名称查一台（agent 工具允许用户用名称指代）。 */
export function findServer(idOrName: string): ServerRecord | undefined {
  const key = idOrName.trim()
  if (key === '') return undefined
  const list = listServers()
  return list.find((s) => s.id === key) ?? list.find((s) => s.name === key)
}
