/**
 * 主进程统一日志设施（基于 electron-log）。
 *
 * ── 为什么引入它 ──────────────────────────────────────────────────────────
 * 本项目历史上主进程 / 渲染进程各自 `console.log`，Electron 打包后**渲染进程日志不可见**，
 * 且两个进程的日志没有统一时间轴。跨进程问题（如「流式回复内容显示不全」）只能靠读代码
 * 逐段猜，无法判断丢在「LLM 输出 → 主进程转发 → IPC → 渲染层拼接」的哪一环。
 *
 * electron-log 是 Electron 社区事实标准（零依赖、三入口统一、内置文件落盘与作用域），
 * 官方推荐「渲染进程日志经 IPC 汇总到主进程统一写文件」，避免多进程争抢同一日志文件。
 *
 * ── 落盘位置 ─────────────────────────────────────────────────────────────
 * macOS:   ~/Library/Logs/{appName}/main.log
 * Windows: %USERPROFILE%\AppData\Roaming\{appName}\logs\main.log
 * Linux:   ~/.config/{appName}/logs/main.log
 * 用户反馈问题时，直接把这个文件给出来即可。
 *
 * ── 作用域（scope）───────────────────────────────────────────────────────
 * 用 `log.scope('stream')` 给同一条链路上的日志打统一标签，便于按 `(stream)` 过滤。
 * 流式链路的埋点约定（协议见 `agent/streamProtocol.ts` 与 `src/lib/logger.ts`）：
 * - 主进程 `stream.end.out`     正文流结束（带事件数、转发字符数、最终长度）
 * - preload  `stream.seq.gap`   **seq 跳号 = 确定性丢包**（带缺失量与事件类型）
 * - preload  `stream.evt.stale` 陈旧流的迟到事件（按 streamId 丢弃）
 * - 渲染层 `stream.end.in`      渲染层收到结束事件（带实际收到字符数）
 * - 渲染层 `stream.end.mismatch` 收到字符数与主进程声明长度不一致（对账失败）
 *
 * 排查顺序：**先看有没有 `stream.seq.gap`**（有 = 传输丢包，直接定位）；
 * 无跳号但长度不符 → 看 `stream.end.out` 是否为模型侧就少。
 */
import log from 'electron-log/main'
import { app } from 'electron'

/**
 * 日志级别。
 *
 * 开发期默认 `debug`（能看到逐 chunk 埋点），生产默认 `info`（避免日志文件膨胀）。
 * 需要现场排查线上问题时可临时改成 `debug`，或设环境变量 `MIMIR_LOG_LEVEL=debug`。
 */
const LEVEL = (process.env.MIMIR_LOG_LEVEL ?? (app.isPackaged ? 'info' : 'debug')) as
  | 'error'
  | 'warn'
  | 'info'
  | 'verbose'
  | 'debug'
  | 'silly'

/** 单文件大小上限（字节）：超过后 electron-log 自动轮转到 `main.old.log`。 */
const MAX_FILE_SIZE = 5 * 1024 * 1024

let initialized = false

/**
 * 初始化日志设施（幂等，可重复调用）。
 *
 * 必须在 `app.whenReady()` 之后调用：`app.getPath('logs')` / `app.getName()` 依赖 app ready。
 */
export function initLogger(): void {
  if (initialized) return
  initialized = true

  // 所有级别的消息统一落文件（默认 file transport 会过滤掉 debug 以下，这里放开）
  log.transports.file.level = LEVEL
  log.transports.console.level = LEVEL
  log.transports.file.maxSize = MAX_FILE_SIZE
  // 文件里保留毫秒时间戳与作用域标签，便于对齐跨进程时序
  log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {scope} {text}'
  log.transports.console.format = '[{h}:{i}:{s}.{ms}] [{level}] {scope} {text}'

  // 兜底：捕获主进程未处理异常与 Promise 拒绝，避免崩溃现场无日志
  log.errorHandler.startCatching({ showDialog: false })
}

export default log

/** 流式链路专用作用域：`(stream)` 标签，便于过滤。 */
export const streamLog = log.scope('stream')

/** Agent 执行链路作用域。 */
export const agentLog = log.scope('agent')

/** IPC / 进程通信作用域。 */
export const ipcLog = log.scope('ipc')
