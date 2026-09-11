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
