/**
 * 外链协议白名单（主进程唯一的「能否交给操作系统打开」判定）。
 *
 * 为什么需要独立模块：这条判定的调用方有两个 —— 窗口层的 `setWindowOpenHandler`
 * （用户点击渲染层里的链接）与 IPC 层的 `shell:openExternal`（执行过程里的来源链接）。
 * 两处都在主进程，但 `ipc/index.ts` 与 `main.ts` 互相引用会形成循环依赖，因此把判定
 * 单独抽出，让两边引用同一份实现，杜绝「一处修了、另一处还是旧口径」的漂移。
 *
 * 安全动机：`shell.openExternal` 会把 URL 原样交给操作系统，`file:` / `javascript:` /
 * 自定义 scheme 都可能产生系统侧副作用。链接内容可能来自模型返回的 Markdown，属于
 * **不可信输入**，因此必须在交给系统之前校验，而不是只在渲染层判。
 */

/** 允许交给系统打开的外链协议（仅这两个）。 */
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:'])

/** URL 是否为可安全外开的 http(s) 链接。 */
export function isSafeExternalUrl(url: unknown): boolean {
  if (typeof url !== 'string' || url === '') return false
  try {
    return ALLOWED_EXTERNAL_PROTOCOLS.has(new URL(url).protocol)
  } catch {
    return false
  }
}
