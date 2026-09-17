/**
 * 本地桩网关（OpenAI 兼容），让对话链路在**完全离线**下可测。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * 对话是产品最核心的功能，却长期零覆盖：真实链路要打外部模型（花 token、不稳定、
 * 受网络影响），违背本仓库 E2E「不触网络」的纪律。于是只能测外围（输入框、批准卡），
 * 真正的「发消息 → 流式回复 → 多轮上下文 → 停止 → 持久化」一条都测不了。
 *
 * 关键事实（已核对实现，非猜测）：
 * - `agentService.initialize()` 把配置里的 `baseUrl` 原样传给 LangChain `ChatOpenAI`
 *   的 `configuration.baseURL`（electron/agent/agentService.ts L592–600），
 *   因此请求会打到 `POST {baseUrl}/chat/completions`，是**标准 OpenAI 兼容协议**。
 * - `initAgentFromSettings()` 在应用启动时读 store 的 `settings.models` 自动初始化
 *   （electron/main.ts L50–72），而 E2E 的 seed 能预置 `settings`（e2e/fixtures/seed.ts）。
 *
 * 于是：**只要 seed 一条指向本桩的模型配置，产品代码零改动即可连上它**。
 *
 * ── 提供什么 ────────────────────────────────────────────────────────────────
 * - `GET  /v1/models`            模型发现（设置页「获取模型列表」用）
 * - `POST /v1/chat/completions`  核心。`stream:true` 返 SSE，`stream:false` 返一次性 JSON
 *
 * 用 Node 原生 `http` 实现：零新依赖，与现有 fixture 体系一致（见 app.ts 的说明）。
 *
 * ── 设计取舍：请求记录 ──────────────────────────────────────────────────────
 * `requests` 保存每次 `chat/completions` 的**解析后请求体**。这是断言「多轮上下文确实
 * 带上了历史」的唯一可靠手段——UI 上看到两轮对话不能证明历史被送进了模型，只有请求体
 * 能证明。用例通过 `gateway.requests[1].messages` 直接断言。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'

/** 桩的应答策略：按调用次数依次生效，用尽后重复最后一条。 */
export type GatewayReply =
  /** 纯文本回复，逐块流式产出（模拟逐字）。 */
  | {
      kind: 'text'
      text: string
      chunkSize?: number
      /**
       * 每块之间的间隔（毫秒）。供「停止生成」这类用例制造可观察的流式窗口：
       * 默认 0 时整段回复在毫秒内发完，UI 的流式态（停止按钮）来不及被人/测试观察到，
       * 用例就只能在「已结束」的界面上找按钮而必然超时。
       * 这不是为了「让测试变慢」，而是为了让被观测的状态真实存在足够久。
       */
      chunkDelayMs?: number
    }
  /** 报错（模拟上游故障），用于验证错误提示与运行态释放。 */
  | { kind: 'error'; status: number; message: string }

/** 一次 `chat/completions` 请求的记录（供用例断言）。 */
export interface RecordedRequest {
  /** 请求体原文，便于排查协议不符。 */
  raw: string
  model: string
  stream: boolean
  messages: Array<{ role: string; content: unknown }>
  /** 请求是否带工具定义（LangChain 一定会带；用于确认协议形态）。 */
  toolCount: number
}

export interface FakeGateway {
  /** 形如 `http://127.0.0.1:PORT/v1`，直接写进 seed 的 baseUrl。 */
  baseUrl: string
  /** 收到的请求记录，按时间顺序。 */
  requests: RecordedRequest[]
  /** 设定应答队列（按调用次序消耗）。 */
  setReplies(replies: GatewayReply[]): void
  /** 清空请求记录（用例之间隔离）。 */
  resetRequests(): void
  /** 关闭服务并等待端口释放。 */
  close(): Promise<void>
}

/** 把一段文本切成小块，模拟模型逐 token 产出。 */
function chunk(text: string, size: number): string[] {
  if (size <= 0) return [text]
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

/** 构造一个 OpenAI 兼容的流式分片（SSE data 行）。 */
function sseChunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  const payload = {
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  }
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** 构造非流式应答体。 */
function completionBody(text: string): string {
  return JSON.stringify({
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-model',
    choices: [
      { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }
    ],
    usage: { prompt_tokens: 1, completion_tokens: text.length, total_tokens: text.length + 1 }
  })
}

/** 非阻塞等待。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 读取请求体全文。 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    req.on('data', (c: Buffer) => parts.push(c))
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * 启动桩网关，监听 127.0.0.1 的**随机空闲端口**。
 *
 * 为什么随机端口：并行 worker 会各起一个桩，固定端口必然冲突。
 * 传 0 让系统分配，再从 `address()` 读回真实端口。
 */
export async function startFakeGateway(
  replies: GatewayReply[] = [{ kind: 'text', text: '这是桩网关的回复。' }]
): Promise<FakeGateway> {
  let queue: GatewayReply[] = replies.length > 0 ? replies : [{ kind: 'text', text: '' }]
  const requests: RecordedRequest[] = []

  const server = createServer((req, res) => {
    void handle(req, res)
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? ''

    // 模型发现：返回一个固定模型，满足设置页的下拉候选。
    if (url.startsWith('/v1/models') || url.startsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'fake-model', object: 'model', owned_by: 'e2e' }]
        })
      )
      return
    }

    if (!url.includes('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `桩网关未实现该路径: ${url}` } }))
      return
    }

    const raw = await readBody(req)
    // 解析失败不静默：把原文回给用例，便于定位协议不符。
    let parsed: Record<string, unknown> = {}
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `请求体非合法 JSON: ${raw.slice(0, 200)}` } }))
      return
    }

    const messages = Array.isArray(parsed.messages)
      ? (parsed.messages as Array<{ role: string; content: unknown }>)
      : []
    const tools = Array.isArray(parsed.tools) ? parsed.tools : []
    requests.push({
      raw,
      model: typeof parsed.model === 'string' ? parsed.model : '',
      stream: parsed.stream === true,
      messages,
      toolCount: tools.length
    })

    // 按调用次序取应答：队列用尽后重复最后一条，避免用例要精确预算调用次数。
    const reply = queue.length > 1 ? (queue.shift() as GatewayReply) : queue[0]

    if (reply.kind === 'error') {
      res.writeHead(reply.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: reply.message, type: 'fake_error' } }))
      return
    }

    if (parsed.stream !== true) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(completionBody(reply.text))
      return
    }

    // ── 流式分支 ──────────────────────────────────────────────────────────
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
    // 首个分片带 role，与真实上游一致（LangChain 据此建立消息）。
    res.write(sseChunk({ role: 'assistant', content: '' }))
    const delay = reply.chunkDelayMs ?? 0
    for (const piece of chunk(reply.text, reply.chunkSize ?? 4)) {
      if (delay > 0) await sleep(delay)
      // 客户端可能在流中被 abort（用户点停止）：此时写入会失败，属预期，直接收手。
      if (res.writableEnded || res.destroyed) return
      res.write(sseChunk({ content: piece }))
    }
    res.write(sseChunk({}, 'stop'))
    res.write('data: [DONE]\n\n')
    res.end()
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    setReplies(next: GatewayReply[]): void {
      queue = next.length > 0 ? [...next] : [{ kind: 'text', text: '' }]
    },
    resetRequests(): void {
      requests.length = 0
    },
    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        server.close(() => resolve())
        // 关闭时若有 keep-alive 连接挂着，close 回调不触发；主动断开兜底。
        server.closeAllConnections?.()
      })
    }
  }
}

/** 断言辅助：从请求记录里取出全部 user 消息文本。 */
export function userTexts(record: RecordedRequest): string[] {
  return record.messages
    .filter((m) => m.role === 'user')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
}
