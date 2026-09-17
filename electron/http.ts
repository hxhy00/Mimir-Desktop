/**
 * 主进程 HTTP 出口（统一接缝）。
 *
 * ── 为什么需要这一层 ───────────────────────────────────────────────────────
 * Node 自带的全局 `fetch`（undici）**不读取系统代理设置**：用户在系统/浏览器里配好
 * 代理后，渲染层的网页请求走代理，主进程的接口请求却仍然直连——在国内访问
 * OpenAlex / arXiv / Semantic Scholar 时，表现就是「网页能开、检索和下载一直转圈」。
 *
 * Electron 的 `net.fetch` 走 Chromium 网络栈，**自动遵循系统代理与 hosts 配置**，
 * 这是 Electron 官方推荐的主进程网络出口。
 *
 * ── 设计约定 ───────────────────────────────────────────────────────────────
 * - 保留 undici 作为**降级路径**：极少数环境下 `net` 尚未 ready（或非 Electron 上下文，
 *   如单测/vitest 的 node 环境）时回退到全局 fetch，保证功能不因接缝而中断；
 * - 仅暴露 `httpFetch` 一个函数，调用方签名与全局 fetch 完全一致，替换是机械的；
 * - **重试语义（对齐 OpenAlex 官方错误处理文档）**：仅对 429（限流）与 5xx（服务端
 *   临时故障）做指数退避重试；其余 4xx 是客户端错误（如 404 未收录、422 参数非法），
 *   重试无意义，原样返回让调用方按状态码自行处置；AbortError / TypeError（网络层
 *   取消或断连）不重试——取消是调用方的明确意图，网络断连交给上层降级逻辑。
 * - **不改变任何超时/取消语义**：AbortSignal 原样透传；调用方传了自己的 signal 时，
 *   退避等待会被该 signal 打断并立即抛出（不打断不了了之）。
 */
import { net } from 'electron'

/** 重试参数：指数退避（1s、2s、4s），共 3 次尝试。学术 API 的限流窗口都在秒级。 */
const RETRY_ATTEMPTS = 3
const RETRY_BASE_DELAY_MS = 1_000

/** 判断一个状态码是否值得重试：仅 429 与 5xx（对齐 OpenAlex 官方 errors 文档）。 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599)
}

/**
 * 走 Chromium 网络栈的 fetch（自动遵循系统代理），带 429/5xx 指数退避重试。
 *
 * 选择依据：Electron 文档建议在 `app.ready` 之后再调用 `net.fetch`，
 * 因此本函数在运行时判断而不是在模块加载期缓存。
 */
export async function httpFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const doFetch = (): Promise<Response> => {
    if (typeof net?.fetch === 'function') {
      try {
        return net.fetch(typeof input === 'string' ? input : input.toString(), init)
      } catch (error) {
        // net 未 ready（极少见）：降级直连，不把网络出口问题放大成功能不可用
        console.warn('[http] net.fetch 不可用，降级到全局 fetch：', error)
      }
    }
    return fetch(input, init)
  }

  let response = await doFetch()
  for (let attempt = 0; attempt + 1 < RETRY_ATTEMPTS && isRetryableStatus(response.status); attempt++) {
    // 尊重服务端 Retry-After（秒数格式）；无头时用指数退避
    const retryAfter = Number(response.headers.get('retry-after'))
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : RETRY_BASE_DELAY_MS * 2 ** attempt
    console.warn(`[http] HTTP ${String(response.status)}，${String(Math.round(waitMs / 1000))}s 后重试（第 ${String(attempt + 2)}/${String(RETRY_ATTEMPTS)} 次）`)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, waitMs)
      init?.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          reject(init.signal?.reason ?? new Error('Aborted'))
        },
        { once: true }
      )
    })
    response = await doFetch()
  }
  return response
}
