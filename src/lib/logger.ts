/**
 * 渲染进程日志门面。
 *
 * ── 为什么不直接用 electron-log/renderer ──────────────────────────────────
 * `electron-log/renderer` 需要 preload 侧桥接才能把日志送到主进程写文件（见 electron/preload.ts
 * 的 `bridgeLogger`）。这里不直接依赖它的 renderer 入口，而是把日志经**已有的一条 IPC 通道**
 * 送给主进程，保证：
 * 1. 打包后日志也落同一份文件（与主进程日志同一时间轴，便于对齐跨进程时序）；
 * 2. 渲染层代码不依赖 electron-log 的入口解析差异（vite 打包下 renderer/preload 入口易踩坑）；
 * 3. 浏览器降级模式（非 Electron）下自动退回 console，不报错。
 *
 * ── 与主进程的作用域约定 ─────────────────────────────────────────────────
 * 渲染层只发 `scope` 字符串，主进程按同名 scope 重建 logger（见 electron/preload.ts）。
 * 流式链路固定用 `stream` 作用域，便于在 main.log 里用 `(stream)` 过滤整条链路。
 */

/** 渲染层可用的日志级别（与主进程 electron-log 对齐）。 */
export type LogLevel = 'error' | 'warn' | 'info' | 'verbose' | 'debug' | 'silly'

interface LogBridge {
  log: (level: LogLevel, scope: string, message: string) => void
}

/** preload 注入的日志桥（非 Electron 环境下为 undefined）。 */
function bridge(): LogBridge | undefined {
  return (window as unknown as { mimirLog?: LogBridge }).mimirLog
}

/** 输出一条日志：优先经 IPC 送主进程，降级到 console。 */
function emit(level: LogLevel, scope: string, message: string): void {
  const b = bridge()
  if (b !== undefined) {
    try {
      b.log(level, scope, message)
      return
    } catch {
      // 桥接异常（如窗口已销毁）→ 退回 console，不因日志失败影响业务
    }
  }
  const line = `[${scope}] ${message}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

/** 创建一个带作用域标签的 logger（与主进程 `log.scope(name)` 语义一致）。 */
export function createLogger(scope: string): {
  error: (message: string) => void
  warn: (message: string) => void
  info: (message: string) => void
  debug: (message: string) => void
} {
  return {
    error: (message) => emit('error', scope, message),
    warn: (message) => emit('warn', scope, message),
    info: (message) => emit('info', scope, message),
    debug: (message) => emit('debug', scope, message)
  }
}

/** 流式链路专用 logger：与主进程 `streamLog` 同名作用域，便于对照两端日志。 */
export const streamLog = createLogger('stream')
