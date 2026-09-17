/**
 * GPU 服务器记录（**持久化的连接配置**）。
 *
 * 设计边界（重要）：这里**只存连接配置**——用户在「GPU 服务器」界面填写、需要长期保存的字段。
 * 运行时探测结果（`status` / `gpus` / `lastChecked`）**不属于本类型**，它们由界面按需探测、
 * 只作展示，落盘没有意义，反而会让 agent 读到过期状态、并造成每次探测都写盘的噪音。
 *
 * 因此本类型刻意比界面层的展示类型窄，且**允许携带未知字段**：
 * 旧版本（本类型引入前）写进 `servers:list` 的记录带有 `status` / `gpus` / `notes` 等字段，
 * 读取时**必须原样保留**（见 serversService 的 merge 策略），否则用户升级一次就丢数据。
 */
export interface ServerRecord {
  id: string
  name: string
  host: string
  port: number
  user: string
  keyPath?: string
  gpuCount: number
  gpuModel: string
  password?: string
  notes?: string
  /** 允许旧字段存在：读写都原样透传，service 不解释、不丢弃。 */
  [extra: string]: unknown
}

/** 新建服务器时**必须**提供的字段（id 由 service 生成）。 */
export interface ServerDraft {
  name: string
  host: string
  port?: number
  user?: string
  keyPath?: string
  gpuCount?: number
  gpuModel?: string
  password?: string
  notes?: string
}

/** 更新服务器时**可选**修改的字段（未提供即保持原值）。 */
export type ServerPatch = Partial<ServerDraft>
