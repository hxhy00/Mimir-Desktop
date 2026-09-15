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
 * - **不改变任何超时/取消语义**：AbortSignal 原样透传。
 */
import { net } from 'electron'

/**
 * 走 Chromium 网络栈的 fetch（自动遵循系统代理）。
 *
 * 选择依据：Electron 文档建议在 `app.ready` 之后再调用 `net.fetch`，
 * 因此本函数在运行时判断而不是在模块加载期缓存。
 */
export function httpFetch(input: string | URL, init?: RequestInit): Promise<Response> {
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
