/**
 * electron 模块桩：仅在 vitest（node 环境、无 Electron 运行时）下通过 alias 替换。
 * 只实现被测试模块真正用到的调用面：app.getPath、net.fetch。
 *
 * net.fetch 桩直接转给全局 fetch —— 单测里 fetch 已被 vi.stubGlobal 替换成假实现，
 * 这样测试既能覆盖到走 net 出口的代码路径，又不需要真实 Electron 运行时。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'mimir-test-'))

export const app = {
  getPath: (name: string): string => {
    if (name === 'userData') return join(sandbox, 'userData')
    if (name === 'home') return sandbox
    if (name === 'documents') return join(sandbox, 'Documents')
    if (name === 'desktop') return join(sandbox, 'Desktop')
    return join(sandbox, name)
  },
  getVersion: (): string => '0.0.0-test'
}

export const net = {
  fetch: (input: string | URL, init?: RequestInit): Promise<Response> => fetch(input, init)
}

export default { app, net }
