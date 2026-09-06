/**
 * 双层持久化核心。
 *
 * - 全局层：`~/.mimir/store.json` —— 基础设置（settings）、服务器（servers:list）、
 *   科研空间注册表与「默认空间 / 激活空间」指针。跨空间共享。
 * - 空间层：`<科研空间根>/.mimir/store.json` —— 该空间的业务数据
 *   （文献库、实验、成长记录、图表索引、组会索引、对话历史…）。仅当该空间被激活时读写。
 *
 * 首次启动时若旧版本全局文件（`userData/store.json`）存在而 `~/.mimir/store.json`
 * 不存在，会把旧全局文件原样迁移到 `~/.mimir/`（旧文件保留作备份，不再读写）。
 * 再早的旧版单目录数据（业务键 + userData/{papers,figures,meetings,wiki,projects}）
 * 在创建默认科研空间时一次性迁入空间层。
 */
import { app } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, cpSync, rmSync, readdirSync } from 'fs'
import { join, dirname, basename } from 'path'
import { homedir } from 'os'

/** 这些键存全局层（跨空间共享）。其余键一律存当前激活空间的 .mimir/store.json。 */
const GLOBAL_KEYS = new Set(['settings', 'servers:list'])

/** 旧版 store.json 中属于“研究数据”、需要迁移进默认空间的键。 */
const LEGACY_DATA_KEYS = [
  'library:papers',
  'library:projects',
  'library:subscriptions',
  'experiments:list',
  'ledger:entries',
  'figures:list',
  'meetings:index',
  'chat:conversations',
] as const

/** 旧版 userData 下需要迁移到空间根目录的子目录（研究资产）。 */
const LEGACY_ASSET_DIRS = ['papers', 'figures', 'meetings', 'wiki', 'projects'] as const

const WORKSPACES_KEY = 'workspaces:list'
const ACTIVE_KEY = 'activeWorkspaceId'
const DEFAULT_KEY = 'defaultWorkspaceId'

const DEFAULT_WORKSPACE_NAME = '我的科研空间'
/** 默认科研空间根：~/Mimir/<名称>（用户可在创建时自选其它目录）。 */
const SPACES_HOME_DIR = 'Mimir'

export interface WorkspaceRecord {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly createdAt: string
  readonly updatedAt: string
}

let globalStore: Record<string, unknown> = {}
let spaceStore: Record<string, unknown> = {}
let setupDone = false

function globalFilePath(): string {
  return join(homedir(), '.mimir', 'store.json')
}

/** 旧版本全局文件位置（首次升级时一次性迁移到 ~/.mimir/，之后不再读写）。 */
function legacyGlobalFilePath(): string {
  return join(app.getPath('userData'), 'store.json')
}

/**
 * 升级迁移：目标 `~/.mimir/store.json` 尚不存在、但旧全局文件存在时，把旧文件
 * 原样原子写入目标位置。`~/.mimir/store.json` 一旦存在即视为权威源，不再覆盖/合并；
 * 旧文件保留作备份。写入失败仅记录日志（本会话内设置不可见，下次启动可重试）。
 */
function migrateLegacyGlobalFile(): void {
  const target = globalFilePath()
  const legacy = legacyGlobalFilePath()
  if (existsSync(target) || !existsSync(legacy)) return
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeJsonAtomic(target, readJson(legacy))
  } catch (error) {
    console.error('[store] 迁移旧全局文件到 ~/.mimir 失败：', error)
  }
}

function readJson(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {}
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * 原子写 JSON：先写同目录临时文件再 rename 覆盖，避免写一半崩溃损坏 store。
 * 失败会向调用方上抛（不再静默吞错，防止“看似成功实则丢数据”）。
 */
function writeJsonAtomic(path: string, value: Record<string, unknown>): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tempPath = join(dir, `.tmp-${basename(path)}-${process.pid}-${randomUUID()}`)
  try {
    writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf-8')
    renameSync(tempPath, path)
  } catch (error) {
    try {
      unlinkSync(tempPath)
    } catch {
      // 临时文件清理失败可忽略；原始错误继续上抛
    }
    throw error
  }
}

function saveGlobal(): void {
  writeJsonAtomic(globalFilePath(), globalStore)
}

function spaceDataPath(spacePath: string): string {
  return join(spacePath, '.mimir', 'store.json')
}

function readSpaceJson(spacePath: string): Record<string, unknown> {
  return readJson(spaceDataPath(spacePath))
}

function saveSpace(): void {
  const active = getActiveWorkspace()
  // active 为 null 仅出现在「尚无任何空间」的短暂窗口：此时不再静默丢弃，
  // 而是落到 spaceRoot() 兜底目录（createWorkspace/switchWorkspace 生效后会读取真实空间文件）。
  const basePath = active === null ? spaceRoot() : active.path
  writeJsonAtomic(spaceDataPath(basePath), spaceStore)
}

// ─── 空间代际令牌（防跨空间异步回写污染）────────────────────────────────

/** 空间层缓存的代际计数；每次切换/装载空间 +1。 */
let spaceEpoch = 0

/** 装载某空间数据到 spaceStore，并推进代际计数。 */
function loadSpaceCache(spacePath: string): void {
  spaceStore = readSpaceJson(spacePath)
  spaceEpoch += 1
}

/**
 * 当前空间代际令牌 = 激活空间 id + 代际计数。
 * 服务层在「读表 → await 网络/IO → 写回」的跨异步边界应先用它记录，
 * 写回前调用 {@link assertSpaceUnchanged} 防止把旧空间数据写进新空间。
 */
export function currentSpaceEpoch(): string {
  const active = getActiveWorkspace()
  return `${active === null ? '' : active.id}#${spaceEpoch}`
}

/** 断言当前空间与调用开始时一致；不一致抛错中止操作。 */
export function assertSpaceUnchanged(epoch: string): void {
  if (currentSpaceEpoch() !== epoch) {
    throw new Error('科研空间已切换，当前操作已中止，请重试')
  }
}

// ─── 空间注册与指针（全局层）────────────────────────────────────────────

export function listWorkspaces(): WorkspaceRecord[] {
  const raw = globalStore[WORKSPACES_KEY]
  if (!Array.isArray(raw)) return []
  return raw
    .filter((entry): entry is WorkspaceRecord => {
      if (typeof entry !== 'object' || entry === null) return false
      const item = entry as Partial<WorkspaceRecord>
      return typeof item.id === 'string' && typeof item.name === 'string' && typeof item.path === 'string'
    })
    .map((item) => ({ ...item }))
}

function saveWorkspaces(list: WorkspaceRecord[]): void {
  globalStore[WORKSPACES_KEY] = list
  saveGlobal()
}

export function getActiveWorkspace(): WorkspaceRecord | null {
  const id = globalStore[ACTIVE_KEY]
  return typeof id === 'string' ? listWorkspaces().find((w) => w.id === id) ?? null : null
}

function setActiveWorkspaceId(id: string): void {
  globalStore[ACTIVE_KEY] = id
  saveGlobal()
}

/** 当前激活空间的根目录（绝对路径）。 */
export function spaceRoot(): string {
  if (!setupDone) ensureWorkspaceSetup()
  const active = getActiveWorkspace()
  if (active !== null) return active.path
  // 兜底：仅当尚未创建任何空间时可能为 null，此时先指向 userData 下的临时目录
  return join(app.getPath('userData'), 'space')
}

// ─── 公开读写（按 key 路由到全局层 / 空间层）─────────────────────────────

export function loadStore(): void {
  if (setupDone) return
  migrateLegacyGlobalFile()
  globalStore = readJson(globalFilePath())
  ensureWorkspaceSetup()
}

export function getStoreValue<T>(key: string): T | undefined {
  if (GLOBAL_KEYS.has(key)) {
    return globalStore[key] as T | undefined
  }
  return spaceStore[key] as T | undefined
}

export function setStoreValue<T>(key: string, value: T): void {
  if (GLOBAL_KEYS.has(key)) {
    globalStore[key] = value
    saveGlobal()
    return
  }
  spaceStore[key] = value
  saveSpace()
}

export function getStorePath(): string {
  return globalFilePath()
}

// ─── 首次启动 / 迁移 / 切换 ─────────────────────────────────────────────

/** 在父目录下取一个不冲突的目录路径：~/Mimir/<名称>；已存在同名时追加序号。 */
function deriveUniquePath(parentDir: string, baseName: string): string {
  let candidate = join(parentDir, baseName)
  for (let attempt = 2; attempt <= 1000; attempt++) {
    if (!existsSync(candidate)) return candidate
    candidate = join(parentDir, `${baseName} ${String(attempt)}`)
  }
  return candidate
}

function hasLegacyData(): boolean {
  for (const key of LEGACY_DATA_KEYS) {
    if (globalStore[key] !== undefined) return true
  }
  for (const rel of LEGACY_ASSET_DIRS) {
    const dir = join(app.getPath('userData'), rel)
    if (!existsSync(dir)) continue
    try {
      if (readdirSafe(dir).length > 0) return true
    } catch {
      // ignore
    }
  }
  return false
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** 迁移旧版业务键与资产目录到默认空间。 */
function migrateLegacyTo(space: WorkspaceRecord): void {
  const targetSpaceStore = readSpaceJson(space.path)
  let spaceChanged = false
  for (const key of LEGACY_DATA_KEYS) {
    if (globalStore[key] !== undefined) {
      targetSpaceStore[key] = globalStore[key]
      delete globalStore[key]
      spaceChanged = true
    }
  }
  if (spaceChanged) {
    writeJsonAtomic(spaceDataPath(space.path), targetSpaceStore)
    saveGlobal()
  }

  // 资产目录：复制到空间根并删除旧目录（成功一个删一个，避免重复）
  const userData = app.getPath('userData')
  for (const rel of LEGACY_ASSET_DIRS) {
    const src = join(userData, rel)
    if (!existsSync(src)) continue
    const entries = readdirSafe(src)
    if (entries.length === 0) continue
    try {
      cpSync(src, join(space.path, rel), { recursive: true, force: true })
      rmSync(src, { recursive: true, force: true })
    } catch {
      // 复制失败则保留原目录（应用仍可继续用旧位置? —— 不再支持，仅避免误删）
    }
  }
}

/** 激活某空间：切换空间层缓存并持久化激活指针。 */
export function switchWorkspace(id: string): WorkspaceRecord {
  const list = listWorkspaces()
  const target = list.find((w) => w.id === id)
  if (target === undefined) throw new Error(`space-not-found: ${id}`)
  loadSpaceCache(target.path)
  setActiveWorkspaceId(target.id)
  return { ...target }
}

export function setDefaultWorkspace(id: string): void {
  if (!listWorkspaces().some((w) => w.id === id)) throw new Error(`space-not-found: ${id}`)
  globalStore[DEFAULT_KEY] = id
  saveGlobal()
}

/** 默认科研空间（用户标记为 default 的那个）；无标记时取注册表中的第一个。 */
export function getDefaultWorkspace(): WorkspaceRecord | null {
  const list = listWorkspaces()
  if (list.length === 0) return null
  const defaultId = typeof globalStore[DEFAULT_KEY] === 'string' ? (globalStore[DEFAULT_KEY] as string) : undefined
  return list.find((w) => w.id === defaultId) ?? list[0]!
}

export function createWorkspace(name: string, dir?: string): WorkspaceRecord {
  const displayName = name.trim()
  if (displayName === '') throw new Error('空间名称不能为空')
  const now = new Date().toISOString()

  // 解析/选择路径：传入路径，或默认 ~/Mimir/<名称>（自动去重）
  const targetPath =
    dir !== undefined && dir.trim() !== ''
      ? dir.trim()
      : deriveUniquePath(join(homedir(), SPACES_HOME_DIR), displayName)

  const list = listWorkspaces()
  if (list.some((w) => w.path === targetPath)) throw new Error(`已存在位于该目录的科研空间：${targetPath}`)
  mkdirSync(join(targetPath, '.mimir'), { recursive: true })

  const record: WorkspaceRecord = {
    id: randomUUID(),
    name: displayName,
    path: targetPath,
    createdAt: now,
    updatedAt: now,
  }
  saveWorkspaces([...list, record])

  // 若该目录已是某个空间（有 .mimir/store.json），激活后可直接读取其数据
  if (listWorkspaces().length === 1 || getActiveWorkspace() === null) {
    switchWorkspace(record.id)
  }
  return { ...record }
}

export function renameWorkspace(id: string, name: string): WorkspaceRecord {
  const trimmed = name.trim()
  if (trimmed === '') throw new Error('空间名称不能为空')
  const list = listWorkspaces()
  const index = list.findIndex((w) => w.id === id)
  if (index === -1) throw new Error(`space-not-found: ${id}`)
  const next = { ...list[index]!, name: trimmed, updatedAt: new Date().toISOString() }
  list[index] = next
  saveWorkspaces(list)
  return next
}

/** 移除空间注册（磁盘文件保留，供用户手动迁移/备份）。激活中空间不可移除。 */
export function removeWorkspace(id: string): void {
  const active = getActiveWorkspace()
  if (active !== null && active.id === id) throw new Error('不能删除当前正在使用的科研空间，请先切换到其它空间')
  const list = listWorkspaces()
  const next = list.filter((w) => w.id !== id)
  if (next.length === list.length) throw new Error(`space-not-found: ${id}`)
  saveWorkspaces(next)
  if (globalStore[DEFAULT_KEY] === id) {
    if (next.length > 0) {
      const nextDefault = next[0]
      globalStore[DEFAULT_KEY] = nextDefault.id
      if (getActiveWorkspace() === null) setActiveWorkspaceId(nextDefault.id)
    } else {
      delete globalStore[DEFAULT_KEY]
      delete globalStore[ACTIVE_KEY]
    }
    saveGlobal()
  }
}

/**
 * 启动初始化，幂等：
 * - 已注册过科研空间 → 恢复「上次激活」的空间（缺省回退到默认/首个）。
 * - 首次启动且存在旧版单目录数据 → 自动创建默认科研空间（~/Mimir/<名称>）并迁移。
 * - 全新安装（无任何空间也无旧数据）→ 不自动建空间，等渲染进程引导用户创建/选择。
 */
export function ensureWorkspaceSetup(): void {
  if (setupDone) return
  try {
    let list = listWorkspaces()
    if (list.length === 0) {
      if (hasLegacyData()) {
        const now = new Date().toISOString()
        const record = {
          id: randomUUID(),
          name: DEFAULT_WORKSPACE_NAME,
          path: deriveUniquePath(join(homedir(), SPACES_HOME_DIR), DEFAULT_WORKSPACE_NAME),
          createdAt: now,
          updatedAt: now,
        }
        mkdirSync(join(record.path, '.mimir'), { recursive: true })
        migrateLegacyTo(record)
        saveWorkspaces([record])
        list = [record]
        globalStore[DEFAULT_KEY] = record.id
        globalStore[ACTIVE_KEY] = record.id
        saveGlobal()
        loadSpaceCache(record.path)
        setupDone = true
        return
      }
      // 全新安装：交给前端弹窗引导（先创建任意空间后再进入应用）
      delete globalStore[DEFAULT_KEY]
      delete globalStore[ACTIVE_KEY]
      saveGlobal()
      spaceStore = {}
      spaceEpoch += 1
      setupDone = true
      return
    }

    let activeId = typeof globalStore[ACTIVE_KEY] === 'string' ? (globalStore[ACTIVE_KEY] as string) : undefined
    if (activeId === undefined || !list.some((w) => w.id === activeId)) {
      const defaultId = typeof globalStore[DEFAULT_KEY] === 'string' ? (globalStore[DEFAULT_KEY] as string) : undefined
      activeId = list.some((w) => w.id === defaultId)
        ? defaultId
        : list[0]!.id
    }
    const active = list.find((w) => w.id === activeId)!
    if (globalStore[DEFAULT_KEY] === undefined) globalStore[DEFAULT_KEY] = active.id
    globalStore[ACTIVE_KEY] = active.id
    saveGlobal()
    loadSpaceCache(active.path)
    setupDone = true
  } catch (error) {
    // 启动时 userData 不可写等极端情况：不让初始化直接崩溃，但记录错误。
    // 运行时写入失败仍会经 IPC 上抛给渲染进程。
    console.error('[store] ensureWorkspaceSetup 失败：', error)
    setupDone = true
    spaceStore = {}
    spaceEpoch += 1
  }
}
