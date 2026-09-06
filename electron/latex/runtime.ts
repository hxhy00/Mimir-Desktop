/**
 * 论文模块的 Tectonic 引擎管理（主进程）。
 *
 * 一个 LaTeX 项目需要可用的编译引擎（latexmk / Tectonic）。系统若已安装
 * TeX 发行版（自带 latexmk）则直接使用；否则用户可在「设置 → 资源下载」
 * 中下载官方 Tectonic 单文件二进制到 userData/tools/tectonic，编译时
 * 自动回退使用该内置引擎，无需手动配置 PATH。
 *
 * 资源下载中心通过 {@link TECTONIC_RESOURCE_ID} 注册这一可下载项。
 */

import { app } from 'electron'
import { join } from 'path'
import {
  chmod,
  mkdir,
  readdir,
  rename,
  rm,
  unlink
} from 'node:fs/promises'
import { createWriteStream, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import type { ExecFileException } from 'node:child_process'

const execFileAsync = promisify(execFile)
const require = createRequire(
  typeof __filename !== 'undefined' ? __filename : import.meta.url
)

/** 设置页「资源下载」中该资源的 id。 */
export const TECTONIC_RESOURCE_ID = 'latex-tectonic'
/** 未联网获取真实大小时 UI 展示的估算体积（实际以 release 资产为准）。 */
export const TECTONIC_APPROX_BYTES = 55 * 1024 * 1024

/** Tectonic 二进制所在目录（userData/tools）。 */
function toolsDir(): string {
  const dir = join(app.getPath('userData'), 'tools')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** 已安装（内置）Tectonic 的可执行文件绝对路径。 */
export function bundledTectonicPath(): string {
  return join(toolsDir(), process.platform === 'win32' ? 'tectonic.exe' : 'tectonic')
}

/** 内置 Tectonic 是否已下载完成。 */
export function hasBundledTectonic(): boolean {
  return existsSync(bundledTectonicPath())
}

// ─── 下载基础（带重定向跟随与进度回调） ─────────────────────────
function downloadFile(
  url: string,
  dest: string,
  onProgress?: (percent: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const https = require('https') as typeof import('https')
    const file = createWriteStream(dest)

    const handleResponse = (response: import('http').IncomingMessage): void => {
      const status = response.statusCode || 0
      // GitHub Releases 等会 302 到实际对象存储
      if (status >= 300 && status < 400 && response.headers.location) {
        file.close()
        const redirectUrl = new URL(response.headers.location, url).toString()
        downloadFile(redirectUrl, dest, onProgress).then(resolve).catch(reject)
        return
      }
      if (status !== 200) {
        file.close()
        reject(new Error(`下载失败: HTTP ${status}`))
        return
      }
      const total = Number.parseInt(response.headers['content-length'] || '0', 10)
      let received = 0
      response.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (total > 0 && onProgress) {
          onProgress(Math.min(99, Math.round((received / total) * 100)))
        }
      })
      response.pipe(file)
    }

    const request = https.get(url, handleResponse)
    request.on('error', (err) => {
      file.close()
      reject(err)
    })
    file.on('finish', () => {
      file.close()
      onProgress?.(100)
      resolve()
    })
    file.on('error', (err) => {
      request.destroy()
      reject(err)
    })
  })
}

// ─── Tectonic 官方 release ──────────────────────────────────────
interface GithubReleaseAsset {
  readonly name: string
  readonly browser_download_url: string
  readonly size: number
}

interface GithubRelease {
  readonly tag_name: string
  readonly assets: GithubReleaseAsset[]
}

/** 依据当前平台/架构挑选官方 release 资产的子串。 */
function assetSubstringsFor(): { mustInclude: string[]; suffixes: string[] } {
  const { platform, arch } = process
  const triples: Record<string, string[]> = {
    darwin: arch === 'arm64' ? ['aarch64-apple-darwin'] : ['x86_64-apple-darwin'],
    linux: arch === 'arm64' ? ['aarch64-unknown-linux-gnu'] : ['x86_64-unknown-linux-gnu'],
    win32: arch === 'arm64' ? ['aarch64-pc-windows-msvc'] : ['x86_64-pc-windows-msvc']
  }
  const candidates = triples[platform] ?? triples.linux
  return {
    mustInclude: candidates,
    suffixes: platform === 'win32' ? ['.zip'] : ['.tar.gz', '.tgz']
  }
}

/** 查询 Tectonic 最新 release 元数据。 */
async function latestTectonicRelease(): Promise<GithubRelease> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetch(
      'https://api.github.com/repos/tectonic-typesetting/tectonic/releases/latest',
      {
        headers: {
          'User-Agent': 'Mimir-Desktop',
          Accept: 'application/vnd.github+json'
        },
        signal: controller.signal
      }
    )
    if (!response.ok) {
      throw new Error(`查询 Tectonic 最新版本失败: HTTP ${response.status}`)
    }
    return (await response.json()) as GithubRelease
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 解压下载的归档。macOS/Linux 优先系统 tar；Windows 的 zip 在 bsdtar
 * 不可用时回退到 PowerShell Expand-Archive。
 */
async function extractArchive(archive: string, destDir: string): Promise<void> {
  const isZip = archive.endsWith('.zip')
  try {
    await execFileAsync('tar', ['-xf', archive, '-C', destDir])
    return
  } catch (error) {
    if (!isZip || process.platform !== 'win32') throw error
  }
  await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destDir}' -Force`
  ])
}

/** 在解压目录里找名为 tectonic 的可执行文件（避免依赖固定目录层级）。 */
async function locateTectonicBinary(root: string, depth = 3): Promise<string | null> {
  const exeName = process.platform === 'win32' ? 'tectonic.exe' : 'tectonic'
  if (depth < 0) return null
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isFile() && (entry.name === exeName || entry.name === 'tectonic')) {
      return full
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = await locateTectonicBinary(join(root, entry.name), depth - 1)
      if (found !== null) return found
    }
  }
  return null
}

/**
 * 下载并安装内置 Tectonic 引擎到 userData/tools。
 * 以「下载到临时归档 → 解压到临时目录 → 找到二进制 → 原子改名」完成，
 * 任一步失败都会清理残留，不会留下半安装状态。
 */
export async function downloadTectonicEngine(onProgress?: (percent: number) => void): Promise<void> {
  const release = await latestTectonicRelease()
  const { mustInclude, suffixes } = assetSubstringsFor()
  const asset = release.assets.find((a) =>
    mustInclude.every((part) => a.name.includes(part)) &&
    suffixes.some((s) => a.name.endsWith(s)) &&
    !a.name.toLowerCase().includes('checksum')
  )
  if (asset === undefined) {
    const hint = process.platform === 'win32' ? '（Windows zip）' : '（.tar.gz）'
    throw new Error(
      `在 Tectonic ${release.tag_name} 中找不到当前平台资产：${mustInclude.join('/')}${hint}`
    )
  }

  const dest = bundledTectonicPath()
  if (existsSync(dest)) unlinkSync(dest)
  const stamp = Date.now().toString(36)
  const archivePath = join(tmpdir(), `tectonic-${stamp}${asset.name.slice(asset.name.lastIndexOf('.'))}`)
  const stageDir = join(toolsDir(), `.tectonic-stage-${stamp}`)

  try {
    await mkdir(stageDir, { recursive: true })
    await downloadFile(asset.browser_download_url, archivePath, onProgress)
    await extractArchive(archivePath, stageDir)
    const binary = await locateTectonicBinary(stageDir)
    if (binary === null) throw new Error('下载的归档中未找到 tectonic 可执行文件')
    if (process.platform !== 'win32') await chmod(binary, 0o755)
    await rename(binary, dest)
  } finally {
    await rm(stageDir, { recursive: true, force: true })
    await unlink(archivePath).catch(() => undefined)
  }
  if (!hasBundledTectonic()) throw new Error('引擎安装校验失败，请重试')
}

// ─── 引擎探测与编译选择 ──────────────────────────────────────────

/** 探测系统 PATH 上的 latexmk / tectonic（绕过 auto 的失败缓存）。 */
async function detectSystemEngine(): Promise<{ kind: string; executable: string } | null> {
  const probe = async (command: string): Promise<boolean> =>
    new Promise((resolve) => {
      execFile(
        command,
        ['--version'],
        { timeout: 10_000 },
        (error: ExecFileException | null) => {
          resolve(error === null || (error as { code?: unknown }).code !== 'ENOENT')
        }
      )
    })
  if (await probe('latexmk')) return { kind: 'latexmk', executable: 'latexmk' }
  if (await probe('tectonic')) return { kind: 'tectonic', executable: 'tectonic' }
  return null
}

/** 顶栏/探测接口用：返回当前可用的引擎（系统优先，其次内置 Tectonic）。 */
export async function availableEngine(): Promise<{ kind: string; executable: string } | null> {
  const system = await detectSystemEngine()
  if (system !== null) return system
  if (hasBundledTectonic()) return { kind: 'tectonic', executable: bundledTectonicPath() }
  return null
}

/**
 * 编译入口使用的引擎选择：系统引擎 > 内置 Tectonic > 明确报错并引导去
 * 「设置 → 资源下载」下载。
 */
export async function pickEngineExecutable(): Promise<string> {
  const engine = await availableEngine()
  if (engine !== null) return engine.executable
  throw new Error(
    '未找到 LaTeX 引擎。请安装 TeX 发行版（MacTeX / TeX Live，自带 latexmk），或在应用「设置 → 资源下载」中下载内置 Tectonic 引擎。'
  )
}

/** 资源下载中心的展示元数据。 */
export function tectonicResourceInfo(): {
  id: string
  name: string
  description: string
  sizeBytes: number
  installed: boolean
} {
  return {
    id: TECTONIC_RESOURCE_ID,
    name: 'Tectonic 单文件 LaTeX 引擎',
    description: hasBundledTectonic()
      ? '已下载到应用目录，论文模块编译时会自动使用（无需安装 TeX 发行版）。'
      : '官方单文件编译引擎，无外部依赖。系统没有 TeX 时下载它即可编译论文；已安装 TeX 也可下载备用。',
    sizeBytes: TECTONIC_APPROX_BYTES,
    installed: hasBundledTectonic()
  }
}
