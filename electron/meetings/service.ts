/**
 * 组会演示文稿域服务：从文献库与实验模块收集素材 → buildDeckModel →
 * renderDeck 渲染 .pptx → 落盘空间根 meetings/（文件系统为真相）。
 * 元信息（标题/页数/创建时间）记录在 store key `meetings:index`。
 */
import { mkdir, readdir, stat, unlink } from 'fs/promises'
import { basename, extname, join } from 'path'
import { getStoreValue, setStoreValue, spaceRoot, currentSpaceEpoch, assertSpaceUnchanged } from '../library/store'
import { buildDeckModel, renderDeck } from './deck'
import { enhanceDeck } from './enhance'
import { coverPrompt, figureAbsPath, generateDeckImage, paperArtPrompt, readImageGenConfig } from '../figures/imageGen'
import type {
  DeckPaperSource,
  ExperimentRecord,
  GenerateDeckRequest,
  MeetingDeckView,
  MeetingModelConfig,
  PaperRelevance,
} from './types'

/** store key：论文表 Record<arxivId, PaperRecord>。 */
const PAPERS_KEY = 'library:papers'
/** store key：项目列表 ProjectRecord[]。 */
const PROJECTS_KEY = 'library:projects'
/** store key：实验列表 ExperimentRecord[]。 */
const EXPERIMENTS_KEY = 'experiments:list'
/** store key：deck 元信息 Record<fileName, { title; slides; createdAt }>。 */
const MEETINGS_INDEX_KEY = 'meetings:index'
/** 单份 deck 的页数上限（防御异常内容）。 */
const DECK_SLIDES_CAP = 60

interface PaperRecordLite {
  readonly arxivId: string
  readonly title: string
  readonly authors: readonly string[]
  readonly summary: string
  readonly notes: string
  readonly tags: readonly string[]
  readonly projectIds: readonly string[]
  readonly relevance?: Record<string, PaperRelevance> | undefined
}

interface ProjectRecordLite {
  readonly id: string
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** 当前空间要使用的组会目录（<space>/meetings）。 */
export function meetingsDir(): string {
  return join(spaceRoot(), 'meetings')
}

/** 从 settings 中取当前选中的可用模型（无配置返回 null）。 */
export function activeMeetingModel(): { model: MeetingModelConfig; name: string } | null {
  const settings = getStoreValue<Record<string, unknown>>('settings') ?? {}
  const models = (settings.models as Array<Record<string, unknown>> | undefined) ?? []
  const selectedModelId = settings.selectedModelId as string | undefined
  const selected = models.find((m) => m.id === selectedModelId) ?? models[0]
  if (selected === undefined || typeof selected.apiKey !== 'string' || selected.apiKey === '') return null
  return {
    model: {
      baseUrl: typeof selected.baseUrl === 'string' ? selected.baseUrl : undefined,
      modelId: typeof selected.modelId === 'string' ? selected.modelId : undefined,
      apiKey: selected.apiKey,
    },
    name: (typeof selected.modelId === 'string' ? selected.modelId : '') || '已配置模型',
  }
}

/** 把非法字符从展示标题中剔除，得到可安全入文件名的片段。 */
function fileStem(title: string, fallback: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\n\r\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
  return cleaned === '' ? fallback : cleaned
}

/** 生成唯一的文件路径（同名时追加 -2/-3…）。 */
async function uniquePptxPath(title: string, stamp: string): Promise<string> {
  const dir = meetingsDir()
  const stem = fileStem(title, '组会汇报')
  let candidate = join(dir, `${stem}-${stamp}.pptx`)
  for (let attempt = 2; ; attempt++) {
    try {
      await stat(candidate)
    } catch {
      return candidate
    }
    candidate = join(dir, `${stem}-${stamp}-${String(attempt)}.pptx`)
  }
}

/** 校验 deck 文件名并返回绝对路径；非法输入返回 null。 */
export function meetingDeckPath(file: string): string | null {
  if (file === '' || file.includes('\0')) return null
  if (basename(file) !== file) return null
  if (extname(file).toLowerCase() !== '.pptx') return null
  return join(meetingsDir(), file)
}

function readIndex(): Record<string, { title: string; slides: number; createdAt: string }> {
  return getStoreValue<Record<string, { title: string; slides: number; createdAt: string }>>(MEETINGS_INDEX_KEY) ?? {}
}

function writeIndex(index: Record<string, { title: string; slides: number; createdAt: string }>): void {
  setStoreValue(MEETINGS_INDEX_KEY, index)
}

/** 从 store 读论文表。 */
function loadPapers(): PaperRecordLite[] {
  const table = getStoreValue<Record<string, PaperRecordLite>>(PAPERS_KEY) ?? {}
  return Object.values(table)
}

/** 从 store 读项目列表。 */
function loadProjects(): ProjectRecordLite[] {
  return getStoreValue<ProjectRecordLite[]>(PROJECTS_KEY) ?? []
}

/** 从 store 读实验列表（与 Experiments 模块同一份数据）。 */
function loadExperiments(): ExperimentRecord[] {
  return getStoreValue<ExperimentRecord[]>(EXPERIMENTS_KEY) ?? []
}

/** 生成一份组会演示文稿并返回其视图。 */
export async function generateMeetingDeck(request: GenerateDeckRequest): Promise<MeetingDeckView> {
  const epoch = currentSpaceEpoch()
  const title = request.title.trim()
  if (title === '') throw new Error('汇报主题不能为空')

  const papersById = new Map(loadPapers().map((paper) => [paper.arxivId, paper]))
  const projects = loadProjects()
  const project = request.projectId === undefined
    ? undefined
    : projects.find((p) => p.id === request.projectId)

  // 论文：保持调用方给的顺序；只保留确实在库中的记录。
  const papers: DeckPaperSource[] = []
  for (const arxivId of request.paperIds) {
    const paper = papersById.get(arxivId)
    if (paper === undefined) continue
    const verdict = project !== undefined ? paper.relevance?.[project.id] : undefined
    papers.push({
      arxivId: paper.arxivId,
      title: paper.title,
      authors: paper.authors,
      summary: paper.summary,
      notes: paper.notes,
      tags: paper.tags,
      relevanceScore: verdict?.score,
      relevanceReason: verdict?.reason,
    })
    if (papers.length >= 12) break
  }

  // 实验：保持给定顺序。
  const experimentsById = new Map(loadExperiments().map((record) => [record.id, record]))
  const experiments = request.experimentIds
    .map((id) => experimentsById.get(id))
    .filter((record): record is ExperimentRecord => record !== undefined)

  const date = request.date !== undefined && request.date.trim() !== ''
    ? request.date.trim().slice(0, 10)
    : new Date().toISOString().slice(0, 10)

  // LLM 增强（best-effort）
  let overview: string | undefined
  let experimentsNote: string | undefined
  let paperPoints: Readonly<Record<string, readonly string[]>> | undefined
  if (request.enhance) {
    const active = activeMeetingModel()
    if (active !== null) {
      const enhancement = await enhanceDeck(active.model, {
        title,
        presenter: request.presenter,
        projectTitle: project?.title,
        date,
        papers,
        experiments,
      })
      if (enhancement !== null) {
        overview = enhancement.overview
        experimentsNote = enhancement.experimentsNote
        if (Object.keys(enhancement.paperPoints).length > 0) paperPoints = enhancement.paperPoints
      }
      assertSpaceUnchanged(epoch)
    }
  }

  // AI 配图（best-effort：任一失败跳过，绝不拖垮 deck 生成）
  let coverImage: string | undefined
  let paperImages: Readonly<Record<string, string>> | undefined
  if (request.aiImages === true) {
    const imageConfig = readImageGenConfig()
    if (imageConfig !== null) {
      try {
        const cover = await generateDeckImage(imageConfig, `AI 封面 - ${title.slice(0, 40)}`, coverPrompt(title))
        coverImage = figureAbsPath(cover)
      } catch {
        // 封面失败可忽略
      }
      const artMap: Record<string, string> = {}
      for (const paper of papers.slice(0, 4)) {
        try {
          const figure = await generateDeckImage(
            imageConfig,
            `AI 配图 - ${paper.title.slice(0, 40)}`,
            paperArtPrompt(paper.title, paper.summary),
          )
          artMap[paper.arxivId] = figureAbsPath(figure)
        } catch {
          // 单篇失败继续
        }
      }
      if (Object.keys(artMap).length > 0) paperImages = artMap
      assertSpaceUnchanged(epoch)
    }
  }

  const slides = buildDeckModel({
    title,
    date,
    presenter: request.presenter,
    projectTitle: project?.title,
    papers,
    experiments,
    overview,
    experimentsNote,
    paperPoints,
    coverImage,
    paperImages,
  })
  if (slides.length === 0) throw new Error('没有可展示的内容，请至少选择一篇论文或一项实验')
  if (slides.length > DECK_SLIDES_CAP) throw new Error(`内容过多（${String(slides.length)} 页）`)

  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const dir = meetingsDir()
  await mkdir(dir, { recursive: true })
  const outPath = await uniquePptxPath(title, stamp)
  await renderDeck(slides, outPath, { title })
  assertSpaceUnchanged(epoch)

  const file = basename(outPath)
  const meta = { title, slides: slides.length, createdAt: new Date().toISOString() }
  writeIndex({ ...readIndex(), [file]: meta })
  const stats = await stat(outPath)

  return {
    file,
    path: outPath,
    title,
    slides: slides.length,
    sizeBytes: stats.size,
    updatedAt: stats.mtime.toISOString(),
    createdAt: meta.createdAt,
  }
}

/** 列出 meetings 目录中的全部 deck（最新在前）。 */
export async function listMeetingDecks(): Promise<MeetingDeckView[]> {
  const dir = meetingsDir()
  let files: string[]
  try {
    files = (await readdir(dir)).filter((name) => extname(name).toLowerCase() === '.pptx')
  } catch {
    return []
  }
  const index = readIndex()
  const views: MeetingDeckView[] = []
  for (const file of files) {
    const path = join(dir, file)
    const stats = await stat(path).catch(() => undefined)
    if (stats === undefined || !stats.isFile()) continue
    const meta = index[file]
    views.push({
      file,
      path,
      title: meta?.title ?? file.replace(/\.pptx$/i, ''),
      slides: meta?.slides ?? 0,
      sizeBytes: stats.size,
      updatedAt: stats.mtime.toISOString(),
      createdAt: meta?.createdAt ?? stats.birthtime.toISOString(),
    })
  }
  views.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return views
}

/** 删除一份 deck（文件名需为 basename 且 .pptx）。 */
export async function deleteMeetingDeck(file: string): Promise<void> {
  const epoch = currentSpaceEpoch()
  const path = meetingDeckPath(file)
  if (path === null) throw new Error('非法文件名')
  await unlink(path)
  assertSpaceUnchanged(epoch)
  const index = readIndex()
  if (file in index) {
    const next = { ...index }
    delete next[file]
    writeIndex(next)
  }
}
