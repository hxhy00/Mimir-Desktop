/**
 * 本地桥接服务（Issue 3 Phase 1；安全收口 C4 后为「本机只读协作面」）。
 *
 * 在 Electron 主进程中起一个 HTTP server，只绑定 127.0.0.1，供本机进程间协作
 * 查询 Mimir 的本地科研数据。
 *
 * 设计原则（C4 收口后）：
 * - **只暴露只读查询**：写入/删除路由已全部移除（原 library/import、update、remove、
 *   meetings/generate、venues/watch 的写入口改为「不对外提供」）。理由：确认 token 只能
 *   证明调用方读过 ~/.mimir/bridge.json（同机任意进程都能读），无法构成远程鉴权，
 *   更挡不住「一次授权后调任意写接口」。把危险面整体拿掉，比加固一个挡不住的 token 更可靠。
 * - 只绑定 loopback，不暴露到网络。
 * - 端口通过环境变量 MIMIR_BRIDGE_PORT 或随机端口指定。
 * - 启动时把端口号写入 ~/.mimir/bridge.json，供本机调用方发现。
 *
 * 注：历史上该 bridge 是「为外部 harness 插件提供写能力」的通道；多 harness 集成本身
 * 已在架构 v3 定案中取消，故其写入路由一并下线。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { writeFile, readFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { randomUUID, timingSafeEqual } from 'crypto'

/** 桥接服务状态。 */
interface BridgeState {
  port: number
  server: ReturnType<typeof createServer> | null
  /** 每次启动生成的确认 token：写入操作需要在 X-Mimir-Confirm 头中携带。 */
  confirmToken: string
}

const state: BridgeState = {
  port: 0,
  server: null,
  confirmToken: randomUUID()
}

/** 桥接配置文件路径。 */
function bridgeConfigPath(): string {
  const dir = join(homedir(), '.mimir')
  return join(dir, 'bridge.json')
}

/** 获取当前 confirm token（供 UI 或 approve 卡片使用）。 */
export function getConfirmToken(): string {
  return state.confirmToken
}

/** 获取桥接端口（未启动时返回 0）。 */
export function getBridgePort(): number {
  return state.port
}

/** 获取桥接服务是否已启动。 */
export function isBridgeRunning(): boolean {
  return state.server !== null
}

/** JSON 响应辅助。 */
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** 解析请求体为 JSON。 */
function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
      } catch (error) {
        reject(error instanceof Error ? error : new Error('Invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** 解析 URL 查询参数。 */
function parseQuery(url: string): URLSearchParams {
  const idx = url.indexOf('?')
  return new URLSearchParams(idx >= 0 ? url.slice(idx + 1) : '')
}

/** 去掉查询参数的路径。 */
function pathOf(url: string): string {
  const idx = url.indexOf('?')
  return idx >= 0 ? url.slice(0, idx) : url
}

/**
 * 桥接路由表。
 *
 * 每个 handler 的签名：(req, params, body?) => Promise<unknown>
 * 成功返回值会被 JSON 序列化；失败抛出 Error。
 *
 * 路由约定：
 *   GET  /api/:domain/:action  — 只读查询
 *   POST /api/:domain/:action  — 写入操作（需 X-Mimir-Confirm 头）
 */
type RouteHandler = (
  req: IncomingMessage,
  params: Record<string, string>,
  body?: unknown
) => Promise<unknown>

/** 注册路由。 */
const routes: Array<{ method: string; pattern: RegExp; paramNames: string[]; handler: RouteHandler }> = []

function route(method: string, pathPattern: string, handler: RouteHandler): void {
  const paramNames: string[] = []
  const regexStr = pathPattern.replace(/:(\w+)/g, (_match, name: string) => {
    paramNames.push(name)
    return '([^/]+)'
  })
  routes.push({ method, pattern: new RegExp(`^${regexStr}$`), paramNames, handler })
}

/** 从 URL path 中提取路由参数。 */
function matchRoute(
  method: string,
  pathname: string
): { handler: RouteHandler; params: Record<string, string> } | null {
  for (const r of routes) {
    if (r.method !== method) continue
    const m = pathname.match(r.pattern)
    if (m === null) continue
    const params: Record<string, string> = {}
    r.paramNames.forEach((name, i) => { params[name] = m[i + 1] ?? '' })
    return { handler: r.handler, params }
  }
  return null
}

/**
 * 恒定时间字符串比较（C4，长度不等直接返回 false，不泄漏前缀信息）。
 * 保留：供未来若重新开放需鉴权的接口使用；当前只读路由无需 token。
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf-8')
  const bb = Buffer.from(b, 'utf-8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

// ═══════════════════════════════════════════════════════════════
//  路由实现（只读查询面）
// ═══════════════════════════════════════════════════════════════

import * as library from '../library/libraryService'
import { listFigures } from '../figures/figuresService'
import { listMeetingDecks } from '../meetings/service'
import { listVenueDeadlines } from '../venues/venuesService'

// ── 服务器状态（占位：返回空列表，Issue 3 Phase 2 补充）───────
route('GET', '/api/servers/list', async () => {
  return { servers: [] }
})

// ── 文献库 ───────────────────────────────────────────────────
route('GET', '/api/library/papers', async () => {
  return { papers: library.listPapers() }
})

route('GET', '/api/library/projects', async () => {
  return { projects: library.listProjects() }
})

// ── 写路由（C4 已移除）─────────────────────────────────────────
// 原 POST /api/library/import、/api/library/update、/api/library/remove、
// /api/meetings/generate、/api/venues/watch 均已下线：确认 token 只证明调用方读过
// 本机 bridge.json，无法作为写操作授权（同机任意进程可读，且一次授权即可调任意写接口）。
// 写入能力保留在应用内的 UI 与 Agent 工具路径（后者经 approval.ts 逐次人工确认）。

// ── 图表 ─────────────────────────────────────────────────────
route('GET', '/api/figures/list', async () => {
  return { figures: await listFigures() }
})

// ── 组会 ─────────────────────────────────────────────────────
route('GET', '/api/meetings/list', async () => {
  return { decks: await listMeetingDecks() }
})

// ── 会议截稿 ─────────────────────────────────────────────────
route('GET', '/api/venues/list', async () => {
  return listVenueDeadlines()
})

// ═══════════════════════════════════════════════════════════════
//  HTTP 请求分发
// ═══════════════════════════════════════════════════════════════

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET'
  const pathname = pathOf(req.url ?? '/')

  // 健康检查
  if (pathname === '/health') {
    json(res, 200, { ok: true, port: state.port, confirmToken: state.confirmToken.slice(0, 8) + '…' })
    return
  }

  // API 路由
  if (pathname.startsWith('/api/')) {
    const matched = matchRoute(method, pathname)
    if (matched === null) {
      json(res, 404, { error: `未知路由: ${method} ${pathname}` })
      return
    }
    try {
      let body: unknown = undefined
      if (method === 'POST') {
        body = await parseBody(req)
      }
      const result = await matched.handler(req, matched.params, body)
      json(res, 200, result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      json(res, 400, { error: message })
    }
    return
  }

  json(res, 404, { error: 'Not found' })
}

/**
 * 启动桥接服务。
 * @param preferredPort 首选端口；0 或省略表示随机端口。
 */
export async function startBridge(preferredPort = 0): Promise<{ port: number }> {
  if (state.server !== null) {
    return { port: state.port }
  }

  // 每次启动刷新确认 token
  state.confirmToken = randomUUID()

  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res)
    } catch (error) {
      console.error('[bridge] unhandled error:', error)
      json(res, 500, { error: 'Internal server error' })
    }
  })

  return new Promise((resolve, reject) => {
    server.listen(preferredPort, '127.0.0.1', async () => {
      const addr = server.address()
      if (addr === null || typeof addr === 'string') {
        reject(new Error('Failed to get server address'))
        return
      }
      state.port = addr.port
      state.server = server

      // 写入 bridge.json 供插件发现
      const configDir = join(homedir(), '.mimir')
      if (!existsSync(configDir)) await mkdir(configDir, { recursive: true })
      await writeFile(bridgeConfigPath(), JSON.stringify({
        port: state.port,
        confirmToken: state.confirmToken,
        pid: process.pid,
        startedAt: new Date().toISOString()
      }, null, 2), 'utf-8')

      console.log(`[bridge] listening on 127.0.0.1:${state.port}`)
      resolve({ port: state.port })
    })
    server.on('error', reject)
  })
}

/**
 * 停止桥接服务。
 */
export async function stopBridge(): Promise<void> {
  if (state.server === null) return
  return new Promise((resolve) => {
    state.server!.close(() => {
      state.server = null
      state.port = 0
      console.log('[bridge] stopped')
      resolve()
    })
  })
}

/**
 * 读取桥接配置（供外部插件发现端口）。
 */
export async function readBridgeConfig(): Promise<{ port: number; confirmToken: string; pid: number } | null> {
  try {
    const raw = await readFile(bridgeConfigPath(), 'utf-8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}
