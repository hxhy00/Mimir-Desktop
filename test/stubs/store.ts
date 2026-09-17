/**
 * library/store 的测试桩：绕过 Electron / 真实文件系统，提供内存版 store。
 * 通过 vitest.config.ts 的 alias 注入（仅测试环境生效）。
 *
 * 桩必须**忠实模拟真实 store.ts 的语义**（见 electron/library/store.ts），
 * 否则「测试通过」只是桩和测试互相配合演出来的假象：
 *
 * 1. 双层分层：`settings` / `servers:list` 存全局层（跨空间共享），
 *    其余键一律存**当前激活空间**的空间层。空间切换后，空间层整体替换为新空间的数据。
 * 2. 空间代际令牌（spaceEpoch）：每次切换/装载空间都推进计数；
 *    `assertSpaceUnchanged` 在「空间已切换」时必须抛错 —— 这是防止旧空间异步回写
 *    污染新空间的核心防御。旧桩把这两个实现成常量/空函数，该防御在测试里从未生效。
 * 3. 真实 store 的 readJson 对损坏 JSON 会静默返回 {}（吞掉 ParseError），
 *    属于已知审查项（见 test/unit/storeStub.test.ts 中的文档化说明）；桩同步保留
 *    「损坏 → 空对象」语义，由专门用例锁住该行为，防止有人无意识地改掉它。
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 与真实 store 的 GLOBAL_KEYS 对齐（见 electron/library/store.ts）。 */
const GLOBAL_KEYS = new Set(['settings', 'servers:list'])

export interface StubWorkspaceRecord {
  readonly id: string
  readonly name: string
  readonly path: string
}

let spaceSeq = 0
/** 模块启动即创建一个激活空间，等价于真实 store 启动后必有激活空间的常见状态。 */
const initialWorkspace: StubWorkspaceRecord = {
  id: `space-${++spaceSeq}`,
  name: 'test',
  path: mkInitialRoot()
}

const globalStore = new Map<string, unknown>()
/** 空间层数据按「空间 id」分桶保存，切换空间即整体换桶（真实语义：各空间各一份 store.json）。 */
const spaceBuckets = new Map<string, Map<string, unknown>>()

let activeWorkspace: StubWorkspaceRecord = initialWorkspace
spaceBuckets.set(initialWorkspace.id, new Map())

/** 空间代际计数：每次切换/装载空间 +1，与真实 store 的 spaceEpoch 对齐。 */
let spaceEpoch = 0

function mkInitialRoot(): string {
  return mkdtempSync(join(tmpdir(), 'mimir-space-'))
}

export function spaceRoot(): string {
  return activeWorkspace.path
}

export function testRootPath(): string {
  return activeWorkspace.path
}

export function getActiveWorkspace(): StubWorkspaceRecord {
  return activeWorkspace
}

// ─── 空间代际令牌（与真实 store.ts 的防御语义一致）─────────────────────────

/**
 * 当前空间代际令牌 = 激活空间 id + 代际计数。
 * 与真实实现唯一的差别是「id 生成」：测试里用 `space-N`，真实用 UUID。
 */
export function currentSpaceEpoch(): string {
  return `${activeWorkspace.id}#${spaceEpoch}`
}

/**
 * 断言当前空间与调用开始时一致；不一致抛错中止操作。
 * 语义与真实实现逐字对齐（错误文案也保持一致，服务层测试可依赖该信息）。
 */
export function assertSpaceUnchanged(epoch: string): void {
  if (currentSpaceEpoch() !== epoch) {
    throw new Error('科研空间已切换，当前操作已中止，请重试')
  }
}

// ─── 空间注册与切换（供测试编排使用，不进业务 IPC 面）─────────────────────

export function listWorkspaces(): StubWorkspaceRecord[] {
  return [{ ...initialWorkspace }, ...registered.slice(1).map((w) => ({ ...w }))]
}

const registered: StubWorkspaceRecord[] = [initialWorkspace]

/**
 * 创建（注册）一个新的测试空间，并把它登记为可切换对象。
 * 不自动切换激活空间 —— 调用方按需 {@link switchWorkspaceTo}。
 */
export function createTestWorkspace(name: string, path?: string): StubWorkspaceRecord {
  const record: StubWorkspaceRecord = {
    id: `space-${++spaceSeq}`,
    name,
    path: path ?? `${initialWorkspace.path}/../mimir-space-${spaceSeq}`
  }
  registered.push(record)
  spaceBuckets.set(record.id, new Map())
  return record
}

/**
 * 切换激活空间：推进代际计数 + 整体替换空间层数据桶 —— 与真实 switchWorkspace
 * 的 loadSpaceCache（spaceStore 替换 + spaceEpoch += 1）语义一致。
 */
export function switchWorkspaceTo(id: string): StubWorkspaceRecord {
  const target = registered.find((w) => w.id === id)
  if (target === undefined) throw new Error(`space-not-found: ${id}`)
  activeWorkspace = target
  spaceEpoch += 1
  return { ...target }
}

// ─── 双层读写（按 key 路由到全局层 / 当前空间层，与真实实现一致）─────────

export function getStoreValue<T>(key: string): T | undefined {
  if (GLOBAL_KEYS.has(key)) {
    return globalStore.get(key) as T | undefined
  }
  return spaceBuckets.get(activeWorkspace.id)!.get(key) as T | undefined
}

export function setStoreValue<T>(key: string, value: T): void {
  if (GLOBAL_KEYS.has(key)) {
    globalStore.set(key, value)
    return
  }
  spaceBuckets.get(activeWorkspace.id)!.set(key, value)
}

/**
 * 损坏空间层 JSON 的语义锁：真实 readJson 解析失败会静默返回 {}（数据丢失不报错）。
 * 测试编排通过此入口模拟「某空间 store.json 损坏」，随后切换到该空间时应看到
 * 空间层数据为空 —— 用例见 test/unit/storeStub.test.ts。
 */
export function __corruptSpaceStore(id: string): void {
  spaceBuckets.set(id, new Map())
}

/**
 * 测试隔离专用：清空内存 store 并回到初始空间。
 *
 * 为什么必须有：`memory` 是**模块级单例**，而 vitest 在 `singleThread` / 慢速调度下会
 * 让多个测试文件共享同一进程与同一模块实例——某条用例写进 store 的策略（如全权档
 * `danger-full-access`）会**泄漏到后续文件**，表现为「单文件跑绿、全量跑红」。
 * 由 test/setup/resetState.ts 在每个用例后调用，从根上切断跨用例/跨文件污染。
 */
export function __resetStore(): void {
  globalStore.clear()
  for (const bucket of spaceBuckets.values()) bucket.clear()
  // 回到初始空间：跨用例残留的「切换状态」同样属于污染源（否则下个文件的
  // currentSpaceEpoch 会带着上个文件切换出的空间 id 与更高的 epoch）。
  activeWorkspace = initialWorkspace
  spaceEpoch = 0
}
