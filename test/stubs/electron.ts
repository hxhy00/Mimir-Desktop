/**
 * electron 模块桩：仅在 vitest（node 环境、无 Electron 运行时）下通过 alias 替换。
 * 只实现被测试模块真正用到的调用面：app.getPath。
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

export default { app }
