/**
 * 论文编译快照（移植自 Mimir paper-snapshots 的最小闭环）。
 *
 * - 编译成功后由调用方触发 capture：递归收集 paperDir 下全部 `.tex/.bib`，
 *   原样拷入 `<space>/.mimir/paper-snapshots/<dirHash>/<snapshotId>/` 并写
 *   manifest.json；与最近一份快照逐文件完全相同时跳过（避免无变化堆积）。
 * - 每项目目录保留上限 50 份，超出删除最旧。
 * - revert：按 manifest 的相对路径把文件写回项目（严格限定相对路径不逃逸）。
 */
import { createHash } from 'crypto'
import { mkdir, readdir, stat, readFile, writeFile, copyFile, rm } from 'fs/promises'
import { join, extname, relative, dirname } from 'path'
import { existsSync } from 'fs'
import { spaceRoot } from '../library/store'

const SNAPSHOT_EXTENSIONS = new Set(['.tex', '.bib'])
const SNAPSHOT_LIMIT = 50

export interface SnapshotFileEntry {
  readonly path: string
  readonly sizeBytes: number
}

export interface PaperSnapshotMeta {
  readonly id: string
  readonly createdAt: string
  readonly files: readonly SnapshotFileEntry[]
}

function slugOfProjectDir(projectDir: string): string {
  return createHash('sha1').update(projectDir).digest('hex').slice(0, 16)
}

function snapshotIdNow(now: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  const base =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}${pad(now.getUTCMilliseconds(), 3)}Z`
  return base
}

function rootOf(projectDir: string): string {
  return join(spaceRoot(), '.mimir', 'paper-snapshots', slugOfProjectDir(projectDir))
}

async function collectSnapshotFiles(dir: string, base: string, out: string[]): Promise<void> {
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
      if (['build', 'aux', 'out', 'dist', 'node_modules', '.git', '.vscode', 'template'].includes(entry.name)) continue
      await collectSnapshotFiles(full, base, out)
    } else if (SNAPSHOT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      out.push(full)
    }
  }
}

/** 读取某项目所有快照（最新在前）。 */
export async function listPaperSnapshots(projectDir: string): Promise<PaperSnapshotMeta[]> {
  const root = rootOf(projectDir)
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return []
  }
  const list: PaperSnapshotMeta[] = []
  for (const id of entries) {
    if (id.startsWith('.')) continue
    try {
      const raw = JSON.parse(await readFile(join(root, id, 'manifest.json'), 'utf-8')) as {
        id?: unknown
        createdAt?: unknown
        files?: unknown
      }
      const files = Array.isArray(raw.files)
        ? (raw.files as Array<{ path?: unknown; sizeBytes?: unknown }>)
            .filter((f) => typeof f.path === 'string' && typeof f.sizeBytes === 'number')
            .map((f) => ({ path: f.path as string, sizeBytes: f.sizeBytes as number }))
        : []
      if (typeof raw.createdAt === 'string') {
        list.push({ id: id === raw.id ? id : id, createdAt: raw.createdAt, files })
      }
    } catch {
      // 坏快照忽略
    }
  }
  return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** 与最近一份快照比较是否内容完全相同（逐文件哈希）。 */
async function identicalToLatest(projectDir: string, files: string[]): Promise<boolean> {
  const list = await listPaperSnapshots(projectDir)
  if (list.length === 0) return false
  const latest = list[0]!
  const snapshotDir = join(rootOf(projectDir), latest.id)
  if (latest.files.length !== files.length) return false
  const hashOf = async (file: string): Promise<string> => {
    try {
      const content = await readFile(file)
      return createHash('sha1').update(content).digest('hex')
    } catch {
      return ''
    }
  }
  for (const file of files) {
    const rel = relative(projectDir, file).replace(/\\/g, '/')
    const entry = latest.files.find((f) => f.path === rel)
    if (entry === undefined) return false
    const snapPath = join(snapshotDir, ...rel.split('/'))
    if (!existsSync(snapPath)) return false
    if ((await hashOf(file)) !== (await hashOf(snapPath))) return false
  }
  return true
}

/** 编译成功后拍摄快照；内容无变化时跳过。 */
export async function capturePaperSnapshot(projectDir: string): Promise<{ id: string; skipped: boolean; files: number }> {
  const base = projectDir
  const files: string[] = []
  await collectSnapshotFiles(base, base, files)
  files.sort()
  if (files.length === 0) throw new Error('项目中没有可快照的 .tex/.bib 文件')

  if (await identicalToLatest(base, files)) {
    return { id: '', skipped: true, files: files.length }
  }

  const id = snapshotIdNow(new Date())
  const root = rootOf(base)
  const snapshotDir = join(root, id)
  await mkdir(snapshotDir, { recursive: true })

  const entries: SnapshotFileEntry[] = []
  for (const file of files) {
    const rel = relative(base, file).replace(/\\/g, '/')
    const stats = await stat(file)
    const target = join(snapshotDir, ...rel.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await copyFile(file, target)
    entries.push({ path: rel, sizeBytes: stats.size })
  }
  const meta: PaperSnapshotMeta = {
    id,
    createdAt: new Date().toISOString(),
    files: entries,
  }
  await writeFile(join(snapshotDir, 'manifest.json'), JSON.stringify(meta, null, 2), 'utf-8')

  // 限制数量：删除最旧
  const list = await listPaperSnapshots(base)
  for (const old of list.slice(SNAPSHOT_LIMIT)) {
    await rm(join(root, old.id), { recursive: true, force: true }).catch(() => {})
  }
  return { id, skipped: false, files: files.length }
}

/** 取快照内某一相对路径的文件内容（diff 用），rel 需以 manifest 为准。 */
export async function readSnapshotFile(projectDir: string, id: string, rel: string): Promise<string> {
  const snapshotDir = join(rootOf(projectDir), id)
  const target = join(snapshotDir, ...rel.split('/'))
  if (!target.startsWith(snapshotDir)) throw new Error('非法相对路径')
  return readFile(target, 'utf-8')
}

/** 回退：按 manifest 把快照内容写回项目文件。 */
export async function revertPaperSnapshot(projectDir: string, id: string): Promise<{ restored: number }> {
  const root = rootOf(projectDir)
  const snapshotDir = join(root, id)
  const raw = JSON.parse(await readFile(join(snapshotDir, 'manifest.json'), 'utf-8')) as { files?: unknown }
  const files = Array.isArray(raw.files) ? (raw.files as Array<{ path?: unknown }>) : []
  let restored = 0
  for (const entry of files) {
    if (typeof entry.path !== 'string') continue
    const rel = entry.path
    if (rel.startsWith('/') || rel.includes('..') || rel.includes('\0')) continue
    const target = join(projectDir, ...rel.split('/'))
    if (!target.startsWith(projectDir)) continue
    const source = join(snapshotDir, ...rel.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
    restored += 1
  }
  return { restored }
}

/** 删除一份快照。 */
export async function deletePaperSnapshot(projectDir: string, id: string): Promise<void> {
  const root = rootOf(projectDir)
  await rm(join(root, id), { recursive: true, force: true })
}

/** 项目目录用于展示的短标识（复用 slug）。 */
export function snapshotProjectKey(projectDir: string): string {
  return slugOfProjectDir(projectDir)
}
