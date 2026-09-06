/**
 * 图表管理域服务：把上传的图片以原始二进制落到 userData/figures/，
 * 元信息记录在 store key `figures:list`。渲染进程通过自定义协议
 * `mimir-img://figures/<fileName>` 按需读取图片内容（避免 base64 落 store）。
 */
import { randomUUID } from 'crypto'
import { mkdir, writeFile, readdir, stat, unlink, rename, readFile } from 'fs/promises'
import { join, extname, basename, relative } from 'path'
import { getStoreValue, setStoreValue, spaceRoot } from '../library/store'

const FIGURES_KEY = 'figures:list'

/** 允许保存的图片扩展名（与协议 serve 的白名单一致）。 */
const FIGURE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

export interface FigureRecord {
  readonly id: string
  /** 显示名（原始文件名）。 */
  readonly name: string
  /** 磁盘上的文件名（basename，含扩展名）。 */
  readonly fileName: string
  readonly sizeBytes: number
  readonly createdAt: string
}

export function figuresDir(): string {
  return join(spaceRoot(), 'figures')
}

/** 校验图片 dataUrl，返回二进制 Buffer 与扩展名。非法输入返回 null。 */
function decodeImageDataUrl(dataUrl: string): { buffer: Buffer; ext: string } | null {
  const match = /^data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim())
  if (match === null) return null
  const mime = match[1] === 'jpg' ? 'jpeg' : match[1]
  const ext = `.${mime === 'jpeg' ? 'jpg' : mime}`
  try {
    return { buffer: Buffer.from(match[2] ?? '', 'base64'), ext }
  } catch {
    return null
  }
}

function readIndex(): FigureRecord[] {
  return getStoreValue<FigureRecord[]>(FIGURES_KEY) ?? []
}

function writeIndex(list: FigureRecord[]): void {
  setStoreValue(FIGURES_KEY, list)
}

/** 从原始文件名派生一个安全的基础名（无扩展名，保留中文）。 */
function cleanStem(name: string): string {
  const stem = basename(name).replace(/\.[^.]+$/, '')
  const cleaned = stem
    .replace(/[\\/:*?"<>|\n\r\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  return cleaned === '' ? 'image' : cleaned
}

/** 保存一张上传图片（dataUrl → 文件），返回其记录。 */
export async function importFigure(name: string, dataUrl: string): Promise<FigureRecord> {
  const decoded = decodeImageDataUrl(dataUrl)
  if (decoded === null) throw new Error('不支持的图片格式（支持 png / jpg / gif / webp）')

  const dir = figuresDir()
  await mkdir(dir, { recursive: true })

  const stem = cleanStem(name)
  const index = readIndex()
  const taken = new Set(index.map((record) => record.fileName))
  // 找到磁盘上不冲突的文件名（如 plot.png / plot-2.png）
  let fileName = `${stem}${decoded.ext}`
  for (let attempt = 2; attempt <= 1000; attempt++) {
    if (!taken.has(fileName)) break
    fileName = `${stem}-${String(attempt)}${decoded.ext}`
  }
  // 原子写：先写临时文件再改名，避免进程中断留下半截图片
  const tempPath = join(dir, `${fileName}.tmp`)
  await writeFile(tempPath, decoded.buffer)
  await rename(tempPath, join(dir, fileName))
  const displayName = basename(String(name).trim() || fileName)
  const record: FigureRecord = {
    id: randomUUID(),
    name: displayName,
    fileName,
    sizeBytes: decoded.buffer.length,
    createdAt: new Date().toISOString(),
  }
  writeIndex([record, ...index])
  return record
}

/** 列出全部图片（最新在前）。 */
export async function listFigures(): Promise<FigureRecord[]> {
  const dir = figuresDir()
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }
  const index = readIndex()
  const present = new Map(index.map((record) => [record.fileName, record]))
  const list: FigureRecord[] = []
  for (const file of files) {
    const meta = present.get(file)
    const stats = await stat(join(dir, file)).catch(() => undefined)
    if (stats === undefined || !stats.isFile()) continue
    list.push({
      id: meta?.id ?? file,
      name: meta?.name ?? file,
      fileName: file,
      sizeBytes: stats.size,
      createdAt: meta?.createdAt ?? stats.birthtime.toISOString(),
    })
  }
  // 磁盘上已被外部删除的记录无需保留
  const stale = index.filter((record) => !files.includes(record.fileName))
  if (stale.length > 0) writeIndex(index.filter((record) => files.includes(record.fileName)))
  return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** 删除一张图片；fileName 须为 basename 且在允许扩展名内。 */
export async function removeFigure(fileName: string): Promise<void> {
  if (basename(fileName) !== fileName) throw new Error('非法文件名')
  if (!FIGURE_EXTENSIONS.has(extname(fileName).toLowerCase())) throw new Error('非法文件名')
  const dir = figuresDir()
  await unlink(join(dir, fileName))
  writeIndex(readIndex().filter((record) => record.fileName !== fileName))
}

/** 将 fileName 解析为图片绝对路径（协议 serve 与安全检查复用）；非法返回 null。 */
export function figureFilePath(fileName: string): string | null {
  if (fileName === '' || fileName.includes('\0')) return null
  if (basename(fileName) !== fileName) return null
  if (!FIGURE_EXTENSIONS.has(extname(fileName).toLowerCase())) return null
  return join(figuresDir(), fileName)
}

// ─── 重命名 + 同步 LaTeX 引用 ──────────────────────────────────────────

const TEX_SKIP_DIRS = new Set(['build', 'aux', 'out', 'dist', 'node_modules', '.git', '.vscode', '.mimir'])

/** 递归收集目录下 .tex 文件的绝对路径。 */
async function collectTexFiles(dir: string, base: string, out: string[]): Promise<void> {
  let entries: Array<{ name: string; isDirectory: () => boolean }>
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (TEX_SKIP_DIRS.has(entry.name)) continue
      await collectTexFiles(full, base, out)
    } else if (extname(entry.name).toLowerCase() === '.tex') {
      out.push(full)
    }
  }
}

/** 一次 LaTeX 引用命中（用于预览）。 */
export interface FigureRenameUsage {
  /** 项目目录绝对路径。 */
  readonly dir: string
  /** 相对项目目录的 .tex 路径。 */
  readonly file: string
  readonly count: number
}

/** 从 newName 派生安全的文件名（沿用原名扩展名）。 */
function sanitizeRenameTarget(oldFile: string, newName: string): { newFile: string; displayName: string } {
  if (basename(oldFile) !== oldFile) throw new Error('非法文件名')
  if (!FIGURE_EXTENSIONS.has(extname(oldFile).toLowerCase())) throw new Error('非法文件名')
  const ext = extname(oldFile).toLowerCase()
  const clean = cleanStem(newName)
  return { newFile: `${clean}${ext}`, displayName: newName.trim() }
}

/** 预览：确认新文件名合法性 + 统计各项目目录内引用旧文件名的 .tex 命中。 */
export async function previewFigureRename(
  oldFile: string,
  newName: string,
  projectDirs: readonly string[],
): Promise<{ newFile: string; usages: FigureRenameUsage[] }> {
  const { newFile } = sanitizeRenameTarget(oldFile, newName)
  const dir = figuresDir()
  const targetPath = join(dir, newFile)
  try {
    await stat(targetPath)
    throw new Error(`已存在同名文件：${newFile}`)
  } catch (error) {
    if (error instanceof Error && !error.message.startsWith('ENOENT')) throw error
  }

  const usages: FigureRenameUsage[] = []
  for (const projectDir of projectDirs) {
    const files: string[] = []
    await collectTexFiles(projectDir, projectDir, files)
    for (const file of files) {
      let content: string
      try {
        content = await readFile(file, 'utf-8')
      } catch {
        continue
      }
      // 统计精确文件名出现次数（includegraphics 内通常就是完整文件名）
      const count = content.split(oldFile).length - 1
      if (count > 0) {
        usages.push({ dir: projectDir, file: relative(projectDir, file).replace(/\\/g, '/'), count })
      }
    }
  }
  return { newFile, usages }
}

/** 应用改名：重命名文件 + 更新索引 + 替换各项目目录内引用并重写 .tex。 */
export async function applyFigureRename(
  oldFile: string,
  newName: string,
  projectDirs: readonly string[],
): Promise<{ newFile: string; replaced: number }> {
  const { newFile, displayName } = sanitizeRenameTarget(oldFile, newName)
  const dir = figuresDir()
  const oldPath = join(dir, oldFile)
  const newPath = join(dir, newFile)
  if (oldPath === newPath) throw new Error('新文件名与原文件名相同')
  try {
    await stat(newPath)
    throw new Error(`已存在同名文件：${newFile}`)
  } catch (error) {
    if (error instanceof Error && !error.message.startsWith('ENOENT')) throw error
  }

  await rename(oldPath, newPath)

  // 更新索引：仅当该文件在索引中
  const index = readIndex()
  const nextIndex = index.map((record) =>
    record.fileName === oldFile
      ? { ...record, fileName: newFile, name: displayName === '' ? newFile : displayName }
      : record,
  )
  writeIndex(nextIndex)

  // 替换项目 .tex 引用
  let replaced = 0
  for (const projectDir of projectDirs) {
    const files: string[] = []
    await collectTexFiles(projectDir, projectDir, files)
    for (const file of files) {
      let content: string
      try {
        content = await readFile(file, 'utf-8')
      } catch {
        continue
      }
      if (!content.includes(oldFile)) continue
      const next = content.split(oldFile).join(newFile)
      replaced += content.split(oldFile).length - 1
      await writeFile(file, next, 'utf-8')
    }
  }
  return { newFile, replaced }
}
