/**
 * 桥接服务 HTTP 客户端（Issue 3 Phase 1）。
 *
 * 所有 harness 插件共用的 HTTP 客户端，通过 ~/.mimir/bridge.json 发现端口，
 * 然后向 127.0.0.1:PORT 发请求。
 *
 * ponytail: 只暴露一个 callMimirBridge 函数，够用即可。
 */

import { request as httpRequest } from 'http'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

/** 桥接配置缓存（进程级）。 */
let cachedPort = 0
let cachedToken = ''

/** 读取 ~/.mimir/bridge.json 获取端口和 token。 */
async function loadBridgeConfig(): Promise<{ port: number; confirmToken: string }> {
  if (cachedPort > 0) return { port: cachedPort, confirmToken: cachedToken }
  try {
    const raw = await readFile(join(homedir(), '.mimir', 'bridge.json'), 'utf-8')
    const config = JSON.parse(raw)
    cachedPort = typeof config.port === 'number' ? config.port : 0
    cachedToken = typeof config.confirmToken === 'string' ? config.confirmToken : ''
    return { port: cachedPort, confirmToken: cachedToken }
  } catch {
    return { port: 0, confirmToken: '' }
  }
}

/** 调用 Mimir 桥接服务。 */
export async function callMimirBridge(
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const { port, confirmToken } = await loadBridgeConfig()
  if (port === 0) throw new Error('Mimir 桥接服务未运行，请先启动 Mimir Desktop')

  return new Promise((resolve, reject) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (method === 'POST' && confirmToken) headers['X-Mimir-Confirm'] = confirmToken

    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
        } catch {
          reject(new Error('桥接服务返回了非 JSON 响应'))
        }
      })
    })
    req.on('error', reject)
    if (bodyStr) req.write(bodyStr)
    req.end()
  })
}

/** 重置缓存（用于测试或桥接端口变化后）。 */
export function resetBridgeCache(): void {
  cachedPort = 0
  cachedToken = ''
}
