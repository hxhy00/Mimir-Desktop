/**
 * MCP Server（Issue 3 Phase 1）—— 基于 stdio 的 MCP 协议服务。
 *
 * 让 Pi / 支持 MCP 的 Agent 通过 stdin/stdout 与 Mimir 的本地科研能力交互。
 * 内部通过 HTTP 桥接（127.0.0.1:BRIDGE_PORT）调用 Mimir 主进程。
 *
 * 协议：JSON-RPC 2.0 over stdio（每行一个 JSON 对象）。
 * 只实现 MCP 的 tools/list 和 tools/call，不实现 resources/。
 *
 * 用法：在 Pi 的 MCP 配置中添加：
 *   { "command": "electron", "args": ["--mcp-server"] }
 * 或
 *   { "command": "node", "args": ["electron/plugins/mcpServer.js"] }
 *
 * ponytail: Phase 1 只暴露 5 个核心工具，足够验证端到端。完整能力集在 Phase 2 补充。
 */

import { createInterface, type Interface } from 'readline'
import { request as httpRequest } from 'http'

/** 读取桥接配置获取端口。 */
async function readBridgePort(): Promise<number> {
  try {
    const { readFile } = await import('fs/promises')
    const { join } = await import('path')
    const { homedir } = await import('os')
    const raw = await readFile(join(homedir(), '.mimir', 'bridge.json'), 'utf-8')
    const config = JSON.parse(raw)
    return typeof config.port === 'number' ? config.port : 0
  } catch {
    return 0
  }
}

/** 读取桥接确认 token。 */
async function readBridgeConfirmToken(): Promise<string> {
  try {
    const { readFile } = await import('fs/promises')
    const { join } = await import('path')
    const { homedir } = await import('os')
    const raw = await readFile(join(homedir(), '.mimir', 'bridge.json'), 'utf-8')
    const config = JSON.parse(raw)
    return typeof config.confirmToken === 'string' ? config.confirmToken : ''
  } catch {
    return ''
  }
}

/** 调用桥接服务。 */
async function callBridge(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  confirmToken?: string
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (confirmToken) headers['X-Mimir-Confirm'] = confirmToken
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
        } catch (error) {
          reject(error)
        }
      })
    })
    req.on('error', reject)
    if (bodyStr) req.write(bodyStr)
    req.end()
  })
}

// ═══════════════════════════════════════════════════════════════
//  MCP 工具定义
// ═══════════════════════════════════════════════════════════════

interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'mimir_library_list',
    description: '列出文献库中的所有论文',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'mimir_library_projects',
    description: '列出文献库中的所有项目',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'mimir_figures_list',
    description: '列出图表库中的所有图片',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'mimir_meetings_list',
    description: '列出所有已生成的组会 PPT',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'mimir_venues_list',
    description: '查询 CCF 会议截稿列表',
    inputSchema: { type: 'object', properties: {} }
  }
]

/** 根据 MCP 工具名路由到桥接 API。 */
async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  bridgePort: number,
  confirmToken: string
): Promise<unknown> {
  switch (name) {
    case 'mimir_library_list':
      return callBridge(bridgePort, 'GET', '/api/library/papers')
    case 'mimir_library_projects':
      return callBridge(bridgePort, 'GET', '/api/library/projects')
    case 'mimir_figures_list':
      return callBridge(bridgePort, 'GET', '/api/figures/list')
    case 'mimir_meetings_list':
      return callBridge(bridgePort, 'GET', '/api/meetings/list')
    case 'mimir_venues_list':
      return callBridge(bridgePort, 'GET', '/api/venues/list')
    default:
      throw new Error(`未知工具: ${name}`)
  }
}

// ═══════════════════════════════════════════════════════════════
//  JSON-RPC 2.0 over stdio
// ═══════════════════════════════════════════════════════════════

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

function sendResponse(res: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(res) + '\n')
}

function sendError(id: string | number | null, code: number, message: string, data?: unknown): void {
  sendResponse({ jsonrpc: '2.0', id, error: { code, message, data } })
}

async function handleRequest(
  req: JsonRpcRequest,
  bridgePort: number,
  confirmToken: string
): Promise<void> {
  const { id, method, params } = req

  if (method === 'initialize') {
    sendResponse({
      jsonrpc: '2.0',
      id: id ?? null,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mimir-mcp', version: '0.1.0' }
      }
    })
    return
  }

  if (method === 'notifications/initialized') {
    // 客户端通知，不需要响应
    return
  }

  if (method === 'tools/list') {
    sendResponse({
      jsonrpc: '2.0',
      id: id ?? null,
      result: { tools: MCP_TOOLS }
    })
    return
  }

  if (method === 'tools/call') {
    const toolName = (params?.name as string) ?? ''
    const toolArgs = ((params?.arguments as Record<string, unknown>) ?? {}) as Record<string, unknown>
    try {
      const result = await handleToolCall(toolName, toolArgs, bridgePort, confirmToken)
      sendResponse({
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        }
      })
    } catch (error) {
      sendResponse({
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          content: [{ type: 'text', text: `错误: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true
        }
      })
    }
    return
  }

  sendError(id ?? null, -32601, `Method not found: ${method}`)
}

// ═══════════════════════════════════════════════════════════════
//  入口
// ═══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const bridgePort = await readBridgePort()
  const confirmToken = await readBridgeConfirmToken()

  if (bridgePort === 0) {
    process.stderr.write('[mcp] 错误：无法读取桥接服务端口。请先启动 Mimir Desktop。\n')
    process.exit(1)
  }

  process.stderr.write(`[mcp] 连接桥接服务 127.0.0.1:${bridgePort}\n`)

  const rl: Interface = createInterface({ input: process.stdin })
  rl.on('line', async (line) => {
    if (line.trim() === '') return
    let req: JsonRpcRequest
    try {
      req = JSON.parse(line)
    } catch {
      sendError(null, -32700, 'Parse error')
      return
    }
    await handleRequest(req, bridgePort, confirmToken)
  })

  rl.on('close', () => {
    process.exit(0)
  })
}

// 仅在直接执行时启动（非 import）
if (process.argv[1]?.includes('mcpServer')) {
  main().catch((error) => {
    process.stderr.write(`[mcp] 致命错误: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
