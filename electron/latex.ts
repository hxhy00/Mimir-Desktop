/**
 * LaTeX 编译引擎：探测 latexmk/tectonic，编译 main.tex 并解析诊断信息。
 * 从 Mimir monorepo 的 dsh-mimir/src/tools/latex.ts 移植，去掉 dsh-tools
 * 依赖，改为纯函数供 IPC 处理器调用。
 */

import { execFile } from 'node:child_process'
import type { ExecFileException } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'

// ─── mimir-tex 预览白名单 ────────────────────────────────────────────────
// mimir-tex://pdf/?p=<绝对路径> 用于 iframe 预览 LaTeX 编译产物 main.pdf。
// 为避免渲染进程被注入后可越权读取任意本地 PDF，仅放行两类路径：
// 1) 本会话内经 latex:compile 登记过的「论文项目目录」；
// 2) 位于当前激活科研空间根目录内的文件。
/** 本会话内成功产生过编译产物（main.pdf）的论文项目目录。 */
const allowedLatexPdfDirs = new Set<string>()

/** latex:compile 返回非空 pdfPath 时由 IPC 层登记项目目录。 */
export function registerLatexPdfDir(dir: string): void {
  if (typeof dir === 'string' && dir !== '') allowedLatexPdfDirs.add(dir)
}

/** 判断某个绝对 PDF 路径是否允许经 mimir-tex 协议读取。 */
export function isLatexPdfAllowed(filePath: string, spaceRootDir: string): boolean {
  if (allowedLatexPdfDirs.has(dirname(filePath))) return true
  const rel = relative(spaceRootDir, filePath)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** 一条从编译日志中恢复的诊断信息。 */
export interface LatexIssue {
  readonly severity: 'error' | 'warning'
  /** 诊断发出时最内层打开的文件，已知时提供。 */
  readonly file?: string
  /** 1-based 输入行号，日志声明时提供。 */
  readonly line?: number
  readonly message: string
}

/** 支持的 TeX 引擎种类。 */
export type LatexEngineKind = 'latexmk' | 'tectonic'

/** 已解析的具体可执行文件与命令行方言。 */
export interface ResolvedLatexEngine {
  readonly kind: LatexEngineKind
  readonly executable: string
}

/** 一次编译的可见结果。 */
export interface LatexCompileResult {
  readonly success: boolean
  /** 产生该结果的引擎。 */
  readonly engine: LatexEngineKind
  readonly errors: LatexIssue[]
  readonly warnings: LatexIssue[]
  readonly logExcerpt: string
  /** 生成的 PDF 绝对路径；成功时提供。 */
  readonly pdfPath: string | null
}

/** 引擎可执行文件本身未找到。 */
function isMissingEngine(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === 'ENOENT'
}

/** 各引擎的命令行；都在项目目录内运行。 */
const ENGINE_ARGS: Record<LatexEngineKind, readonly string[]> = {
  latexmk: ['-pdf', '-interaction=nonstopmode', '-halt-on-error', 'main.tex'],
  tectonic: ['--keep-logs', '--synctex', 'main.tex'],
}

/** 真实 PATH 探测：`<command> --version` 运行完成，或 ENOENT 表示不存在。 */
async function probeOnPath(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(command, ['--version'], { timeout: 10_000 }, (error: ExecFileException | null) => {
      resolve(error === null || !isMissingEngine(error))
    })
  })
}

/** 找不到可用引擎时给出的安装指引。 */
const INSTALL_GUIDANCE =
  '请安装 TeX 发行版（TeX Live / MacTeX 自带 latexmk）或 Tectonic（https://tectonic-typesetting.github.io）。'

/** 从绝对路径的 basename 判断引擎种类；未知名称直接报错。 */
function kindFromBasename(path: string): LatexEngineKind {
  const name = basename(path).toLowerCase()
  if (name.includes('tectonic')) return 'tectonic'
  if (name.includes('latexmk')) return 'latexmk'
  throw new Error(`latex.engine '${path}' 必须指向 tectonic 或 latexmk 可执行文件（按 basename 判断）。`)
}

/** 进程生命周期内自动探测引擎的缓存。 */
let autoEngineCache: Promise<ResolvedLatexEngine> | undefined

/** 依次探测 PATH 上的 latexmk 与 tectonic；先命中者胜出。 */
async function detectEngine(probe: (command: string) => Promise<boolean>): Promise<ResolvedLatexEngine> {
  if (await probe('latexmk')) return { kind: 'latexmk', executable: 'latexmk' }
  if (await probe('tectonic')) return { kind: 'tectonic', executable: 'tectonic' }
  throw new Error(`PATH 上未找到 LaTeX 引擎（已查找 latexmk 和 tectonic）。${INSTALL_GUIDANCE}`)
}

/**
 * 将引擎选择解析为具体可执行文件。
 * @param engine - `auto`（默认；依次探测 latexmk、tectonic）、引擎名或绝对路径。
 * @param probe - PATH 探测覆盖；提供时绕过 auto 缓存。
 */
export async function resolveLatexEngine(
  engine: string,
  probe?: (command: string) => Promise<boolean>,
): Promise<ResolvedLatexEngine> {
  if (engine === 'latexmk' || engine === 'tectonic') {
    return { kind: engine, executable: engine }
  }
  if (isAbsolute(engine)) {
    return { kind: kindFromBasename(engine), executable: engine }
  }
  if (engine !== 'auto') {
    // 裸自定义名称按 PATH 上的 latexmk 方言可执行文件处理。
    return { kind: 'latexmk', executable: engine }
  }
  if (probe !== undefined) return detectEngine(probe)
  autoEngineCache ??= detectEngine(probeOnPath)
  return autoEngineCache
}

/** 一条 tectonic 诊断行：`error: [file.tex:NN: ]message`。 */
const TECTONIC_DIAGNOSTIC_RE = /^(error|warning):\s+(.*)$/
/** tectonic 消息中可选的 `<file>:<line>: ` 位置前缀。 */
const TECTONIC_LOCATION_RE = /^(\S+\.tex):(\d+):\s+(.*)$/

/**
 * 解析无 main.log 时的 tectonic stdout/stderr。只有 `error:` / `warning:`
 * 行携带诊断，其余是进度噪音。
 */
export function parseTectonicErrors(log: string): LatexIssue[] {
  const issues: LatexIssue[] = []
  for (const line of log.split('\n')) {
    const match = TECTONIC_DIAGNOSTIC_RE.exec(line)
    if (match === null) continue
    const severity = match[1] === 'error' ? 'error' as const : 'warning' as const
    const message = (match[2] ?? '').trim()
    const location = TECTONIC_LOCATION_RE.exec(message)
    if (location === null || location[1] === undefined) {
      issues.push({ severity, message })
    } else {
      issues.push({
        severity,
        file: location[1],
        line: Number.parseInt(location[2] ?? '0', 10),
        message: (location[3] ?? '').trim(),
      })
    }
  }
  return issues
}

/** 运行引擎一次，以合并输出与退出状态 resolve。 */
function runEngine(
  engine: ResolvedLatexEngine,
  projectDir: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ ok: boolean; log: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      engine.executable,
      [...ENGINE_ARGS[engine.kind]],
      { cwd: projectDir, timeout: timeoutMs, signal, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        if (error !== null && signal.aborted) {
          reject(new Error('latex_compile 已取消', { cause: error }))
          return
        }
        if (error !== null && isMissingEngine(error)) {
          const reason = isAbsolute(engine.executable)
            ? `LaTeX 引擎 '${engine.executable}' 未找到：配置的绝对路径不存在或不可执行。`
            : `LaTeX 引擎 '${engine.executable}' 未在 PATH 上找到。`
          reject(new Error(`${reason} ${INSTALL_GUIDANCE}`, { cause: error }))
          return
        }
        // 超时终止或非零退出仍产生可解析的日志。
        resolve({ ok: error === null, log: `${stdout}\n${stderr}` })
      },
    )
  })
}

/** 日志尾部返回的字符数；其余是不可恢复的噪音。 */
const LOG_EXCERPT_CHARS = 4096

/**
 * 编译一个项目目录中的 main.tex 并解析日志。
 * tectonic 的 `--keep-logs` 会留下标准 TeX main.log；存在时用 latexmk
 * 日志解析器解析，否则解析运行时的 `error:` / `warning:` 行。
 * @param projectDir - 包含 main.tex 的目录；必须存在。
 * @param engine - 引擎选择（auto / 名称 / 绝对路径）。
 * @param timeoutMs - 编译超时（毫秒）。
 * @returns 解析后的诊断、所用引擎、成功标志、日志尾部与 PDF 路径。
 */
export async function compileLatex(
  projectDir: string,
  engine: string,
  timeoutMs: number,
): Promise<LatexCompileResult> {
  const stats = await stat(projectDir).catch(() => undefined)
  if (stats === undefined || !stats.isDirectory()) {
    throw new Error(`latex_compile: '${projectDir}' 不是包含 main.tex 的现有目录`)
  }
  const resolved = await resolveLatexEngine(engine)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let run: { ok: boolean; log: string }
  try {
    run = await runEngine(resolved, projectDir, timeoutMs, controller.signal)
  } finally {
    clearTimeout(timer)
  }
  // 优先使用 tectonic 留下的磁盘 TeX 日志（--keep-logs）：远比其简洁的控制台行丰富。
  const diskLog = resolved.kind === 'tectonic'
    ? await readFile(join(projectDir, 'main.log'), 'utf8').catch(() => undefined)
    : undefined
  const source = diskLog ?? run.log
  const issues = diskLog !== undefined
    ? parseLatexErrors(diskLog)
    : resolved.kind === 'tectonic'
      ? parseTectonicErrors(run.log)
      : parseLatexErrors(run.log)
  const pdfPath = join(projectDir, 'main.pdf')
  const pdfExists = await stat(pdfPath).then((s) => s.isFile()).catch(() => false)
  return {
    success: run.ok && !issues.some(issue => issue.severity === 'error'),
    engine: resolved.kind,
    errors: issues.filter(issue => issue.severity === 'error'),
    warnings: issues.filter(issue => issue.severity === 'warning'),
    logExcerpt: source.slice(-LOG_EXCERPT_CHARS),
    pdfPath: pdfExists ? pdfPath : null,
  }
}

// ─── latexmk 日志解析（从 dsh-mimir/src/latex-log.ts 移植） ───────────────

/** 可变累加器，用于一条错误的 `l.<n>` 尾部尚未到达时。 */
interface PendingError {
  file?: string
  message: string
  line?: number
}

/** `(` 后的路径状 token：以 `.`/`/`/盘符开头，或带 TeX 家族扩展名。 */
const FILE_TOKEN_RE = /^[a-zA-Z0-9_./:\\-]+$/
const FILE_TOKEN_EXT_RE = /\.(tex|sty|cls|clo|def|cfg|bib|aux|bbl|bst|out|toc|fd)$/
const ERROR_LINE_RE = /^!\s+(.*)$/
const ERROR_LINE_NO_RE = /^l\.(\d+)(?:\s|$)/
const WARNING_RE = /^(?:LaTeX|Package\s+\S+|Class\s+\S+)\s+Warning:\s+(.*)$/
const WARNING_LINE_NO_RE = /on input line (\d+)\.?\s*$/

/** 一个 `(` 分隔的 token 是否值得在栈上跟踪的文件名。 */
function isFileToken(token: string): boolean {
  if (token.length === 0 || !FILE_TOKEN_RE.test(token)) return false
  return token.startsWith('./') || token.startsWith('../') || token.startsWith('/') || FILE_TOKEN_EXT_RE.test(token)
}

/** 当前最内层打开的文件；非文件 `(` 层级占据 null 槽位。 */
function currentOpenFile(stack: readonly (string | null)[]): string | undefined {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const entry = stack[index]
    if (entry !== null && entry !== undefined) return entry
  }
  return undefined
}

/** 扫描一行，维护打开文件栈；每个 `(` 与一个 `)` 配对。 */
function trackFiles(line: string, stack: (string | null)[]): void {
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '(') {
      const rest = line.slice(index + 1)
      const end = rest.search(/[\s()]/)
      const token = end === -1 ? rest : rest.slice(0, end)
      stack.push(isFileToken(token) ? token : null)
    } else if (char === ')') {
      if (stack.length > 0) stack.pop()
    }
  }
}

/** 从警告消息中剥离尾部的行号短语。 */
function warningMessage(raw: string): string {
  return raw.replace(/\s+on input line \d+\.?\s*$/, '').trim()
}

/**
 * 解析一份编译日志为有序诊断。
 * @param log - TeX 运行的原始 stdout/stderr 文本。
 * @returns 按日志顺序的错误与警告；空数组表示干净日志。
 */
export function parseLatexErrors(log: string): LatexIssue[] {
  const issues: LatexIssue[] = []
  const fileStack: (string | null)[] = []
  let pending: PendingError | undefined

  const flushPending = (): void => {
    if (pending === undefined) return
    const error: LatexIssue = {
      severity: 'error',
      message: pending.message,
      ...(pending.file === undefined ? {} : { file: pending.file }),
      ...(pending.line === undefined ? {} : { line: pending.line }),
    }
    issues.push(error)
    pending = undefined
  }

  for (const line of log.split('\n')) {
    const currentFile = currentOpenFile(fileStack)

    const errorMatch = ERROR_LINE_RE.exec(line)
    if (errorMatch !== null) {
      flushPending()
      pending = {
        message: (errorMatch[1] ?? '').trim(),
        ...(currentFile === undefined ? {} : { file: currentFile }),
      }
      trackFiles(line, fileStack)
      continue
    }

    const lineNoMatch = ERROR_LINE_NO_RE.exec(line)
    if (lineNoMatch !== null && pending !== undefined) {
      pending.line = Number.parseInt(lineNoMatch[1] ?? '0', 10)
      flushPending()
      trackFiles(line, fileStack)
      continue
    }

    // 只有新错误、警告、`l.<n>` 尾部或 EOF 会关闭错误的尾部窗口：
    // 中间的辅助行（`<inserted text>`、换行上下文）不能夺走错误的行号。
    const warningMatch = WARNING_RE.exec(line)
    if (warningMatch !== null) {
      flushPending()
      const raw = warningMatch[1] ?? ''
      const warningLineNo = WARNING_LINE_NO_RE.exec(raw)
      const warning: LatexIssue = {
        severity: 'warning',
        message: warningMessage(raw),
        ...(currentFile === undefined ? {} : { file: currentFile }),
        ...(warningLineNo === null ? {} : { line: Number.parseInt(warningLineNo[1] ?? '0', 10) }),
      }
      issues.push(warning)
    }

    trackFiles(line, fileStack)
  }

  flushPending()
  return issues
}