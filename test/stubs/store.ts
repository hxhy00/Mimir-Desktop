/**
 * library/store 的测试桩：绕过 electron / 文件系统，提供内存版 store。
 * 通过 vitest.config.ts 的 alias 注入（仅测试环境生效）。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const testRoot = mkdtempSync(join(tmpdir(), 'mimir-space-'))
const memory = new Map<string, unknown>()

export function spaceRoot(): string {
  return testRoot
}

export function getStoreValue<T>(key: string): T | undefined {
  return memory.get(key) as T | undefined
}

export function setStoreValue<T>(key: string, value: T): void {
  memory.set(key, value)
}

export function getActiveWorkspace(): { id: string; name: string; path: string } {
  return { id: 'test', name: 'test', path: testRoot }
}

export function testRootPath(): string {
  return testRoot
}

/**
 * 测试隔离专用：清空内存 store。
 *
 * 为什么必须有：`memory` 是**模块级单例**，而 vitest 在 `singleThread` / 慢速调度下会
 * 让多个测试文件共享同一进程与同一模块实例——某条用例写进 store 的策略（如全权档
 * `danger-full-access`）会**泄漏到后续文件**，表现为「单文件跑绿、全量跑红」。
 * 由 test/setup/resetState.ts 在每个用例后调用，从根上切断跨用例/跨文件污染。
 */
export function __resetStore(): void {
  memory.clear()
}
