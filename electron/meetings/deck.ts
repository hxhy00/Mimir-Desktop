/**
 * 组会演示文稿的纯模型（buildDeckModel）与 pptxgenjs 渲染壳（renderDeck）。
 *
 * 移植自 Mimir 参考实现 `packages/mimir/src/services/meeting.ts`：幻灯计划为
 * 可测试的纯数据模型，渲染层是它的薄壳。本桌面版去掉图片/逐图维度，保留
 * title / agenda / bullets / closing 四类页与统一的学术房型版式（浅底、
 * accent 分隔线、页脚 deck 标题 + 页码）。
 */
import type { DeckExperimentSource, DeckPaperSource, ExperimentStatus } from './types'

/** 组会房型的正文字体（参考实现同款）。 */
export const DECK_FONT = 'Microsoft YaHei'

/** 一页上一条要点。 */
export interface DeckBullet {
  readonly text: string
  /** 强调行以 accent 色加粗渲染。 */
  readonly emph?: boolean | undefined
}

/** 纯幻灯计划：每页画什么（在调用 pptxgenjs 前定稿）。 */
export type DeckSlide =
  | { readonly kind: 'title'; readonly title: string; readonly subtitle: string; readonly imagePath?: string | undefined }
  | { readonly kind: 'agenda'; readonly sections: readonly string[] }
  | {
      readonly kind: 'bullets'
      readonly heading: string
      readonly kicker?: string | undefined
      readonly bullets: readonly DeckBullet[]
      readonly imagePath?: string | undefined
    }
  | { readonly kind: 'closing' }

/** buildDeckModel 的全部入参（已收集、已排序）。 */
export interface DeckModelInput {
  readonly title: string
  readonly date: string
  readonly presenter?: string | undefined
  readonly projectTitle?: string | undefined
  readonly papers: readonly DeckPaperSource[]
  readonly experiments: readonly DeckExperimentSource[]
  /** LLM 开场导语（可选）。 */
  readonly overview?: string | undefined
  /** LLM 实验小结（可选）。 */
  readonly experimentsNote?: string | undefined
  /** LLM 分享要点（keyed by arxivId，可选）。 */
  readonly paperPoints?: Readonly<Record<string, readonly string[]>> | undefined
  /** AI 封面图（绝对路径，可选）。 */
  readonly coverImage?: string | undefined
  /** 每篇论文的概念插图（绝对路径，keyed by arxivId，可选）。 */
  readonly paperImages?: Readonly<Record<string, string>> | undefined
}

/** 一页幻灯一次展示的论文上限（参考实现同款，避免篇幅失控）。 */
export const DECK_MAX_PAPERS = 12

/** 单页实验条数上限。 */
export const DECK_MAX_EXPERIMENTS_PER_SLIDE = 8

function dateOnly(iso: string): string {
  return iso.slice(0, 10)
}

/** 实验状态 → 中文。 */
function statusLabel(status: ExperimentStatus): string {
  if (status === 'success') return '成功'
  if (status === 'running') return '运行中'
  return '失败'
}

/** 一行的指标摘要（截前 4 个）。 */
function metricsLineOf(record: DeckExperimentSource): string {
  const entries = Object.entries(record.metrics)
  if (entries.length === 0) return ''
  return entries
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${typeof value === 'number' && !Number.isInteger(value) ? Number(value.toPrecision(4)) : String(value)}`)
    .join(' · ')
}

/** 裁剪作者列表：前 3 位 + et al. */
function authorsLine(authors: readonly string[]): string {
  if (authors.length === 0) return ''
  return authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' et al.' : '')
}

/** 把一篇论文的确定性素材折成要点（不含 LLM 产出）。 */
function paperBulletsOf(
  paper: DeckPaperSource,
): DeckBullet[] {
  const bullets: DeckBullet[] = []
  const authors = authorsLine(paper.authors)
  if (authors !== '') bullets.push({ text: authors })
  if (paper.relevanceScore !== undefined) {
    const reason = paper.relevanceReason !== undefined && paper.relevanceReason !== ''
      ? ` — ${paper.relevanceReason}`
      : ''
    bullets.push({ text: `相关度 ${String(paper.relevanceScore)}/10${reason}`, emph: true })
  }
  const notes = paper.notes.trim()
  if (notes !== '') {
    bullets.push({ text: `笔记：${notes.slice(0, 200)}` })
  } else {
    bullets.push({ text: paper.summary.trim().slice(0, 240) })
  }
  if (paper.tags.length > 0) {
    bullets.push({ text: `标签：${paper.tags.slice(0, 6).join(' / ')}` })
  }
  return bullets
}

/**
 * 生成纯幻灯计划。页序：title → agenda → overview（可选）→ papers →
 * experiments → closing。论文/实验已在外层预选预排序。
 */
export function buildDeckModel(input: DeckModelInput): readonly DeckSlide[] {
  const slides: DeckSlide[] = []

  const subtitleParts = [input.date]
  if (input.presenter !== undefined && input.presenter !== '') subtitleParts.push(`汇报人：${input.presenter}`)
  if (input.projectTitle !== undefined && input.projectTitle !== '') subtitleParts.push(input.projectTitle)
  slides.push({
    kind: 'title',
    title: input.title,
    subtitle: subtitleParts.join('  ·  '),
    ...(input.coverImage !== undefined ? { imagePath: input.coverImage } : {}),
  })

  const sections: string[] = []
  if (input.overview !== undefined && input.overview.trim() !== '') sections.push('开场导语')
  if (input.papers.length > 0) sections.push(`文献分享（${String(input.papers.length)} 篇）`)
  if (input.experiments.length > 0) sections.push('实验结果')
  sections.push('下一步计划')
  slides.push({ kind: 'agenda', sections })

  if (input.overview !== undefined && input.overview.trim() !== '') {
    slides.push({
      kind: 'bullets',
      heading: '开场导语',
      bullets: [{ text: input.overview.trim() }],
    })
  }

  if (input.papers.length > 0) {
    for (const paper of input.papers.slice(0, DECK_MAX_PAPERS)) {
      const enhanced = input.paperPoints?.[paper.arxivId] ?? []
      let bullets: DeckBullet[]
      if (enhanced.length > 0) {
        bullets = enhanced.slice(0, 6).map((text) => ({ text }))
      } else {
        bullets = paperBulletsOf(paper)
      }
      if (bullets.length === 0) bullets = [{ text: paper.summary.trim().slice(0, 200) }]
      slides.push({
        kind: 'bullets',
        kicker: '文献分享',
        heading: paper.title,
        bullets,
        ...(input.paperImages?.[paper.arxivId] !== undefined
          ? { imagePath: input.paperImages[paper.arxivId] }
          : {}),
      })
    }
  }

  if (input.experiments.length > 0) {
    const bullets: DeckBullet[] = []
    if (input.experimentsNote !== undefined && input.experimentsNote.trim() !== '') {
      bullets.push({ text: input.experimentsNote.trim(), emph: true })
    }
    for (const record of input.experiments.slice(0, DECK_MAX_EXPERIMENTS_PER_SLIDE)) {
      const metrics = metricsLineOf(record)
      bullets.push({
        text: `${record.name}（${statusLabel(record.status)}）${metrics === '' ? '' : ` — ${metrics}`}`,
      })
    }
    if (input.experiments.length > DECK_MAX_EXPERIMENTS_PER_SLIDE) {
      bullets.push({ text: `…以及另外 ${String(input.experiments.length - DECK_MAX_EXPERIMENTS_PER_SLIDE)} 次实验` })
    }
    slides.push({ kind: 'bullets', heading: '实验结果', bullets })
  }

  slides.push({ kind: 'closing' })
  return slides
}

/* ── pptxgenjs 渲染壳 ─────────────────────────────────────────────────── */

/*
 * pptxgenjs 4 的 d.ts 在 nodenext 下不可构造，此处把动态 import 的默认导出
 * cast 到自定义窄接口（参考实现同款做法），只暴露渲染壳用到的成员。
 */

/** 宽松选项包——pptxgenjs 实际接受的键远超这里声明的。 */
type PptxOptions = Record<string, unknown>

/** 富文本段落里的一个 run。 */
interface PptxTextRun {
  readonly text: string
  readonly options?: PptxOptions | undefined
}

/** 渲染壳要绘制的页表面。 */
interface PptxSlideSurface {
  addText(text: string | readonly PptxTextRun[], options: PptxOptions): void
  addShape(name: 'rect' | 'line', options: PptxOptions): void
  addImage(options: PptxOptions): void
}

/** 渲染壳驱动的 deck 表面。 */
interface PptxDeck {
  layout: string
  defineLayout(layout: { readonly name: string; readonly width: number; readonly height: number }): void
  addSlide(): PptxSlideSurface
  writeFile(options: { readonly fileName: string }): Promise<void>
}

type PptxDeckCtor = new () => PptxDeck

/** 16:9 画布（英寸）。 */
const PAGE = { width: 10, height: 5.625 } as const
const ACCENT = '4F7CFF'
const INK = '17233D'
const MUTED = '64748B'
const BG = 'F7F9FC'
const CARD = 'FFFFFF'
const CARD_LINE = 'E2E8F0'

/** 日志辅助：渲染失败时保留现场信息。 */
const PAGE_TOTAL_CAP = 60

/**
 * 渲染幻灯计划到 .pptx（parent 目录须已存在）。房型版式与参考实现一致：
 * 浅底、title 页左侧 accent 竖条、内容页 kicker + 大标题 + accent 分隔线，
 * 页脚含 deck 标题与页码。
 */
export async function renderDeck(
  slides: readonly DeckSlide[],
  outPath: string,
  meta: { readonly title?: string | undefined } = {},
): Promise<void> {
  if (slides.length === 0) throw new Error('幻灯计划为空')
  const { default: PptxGenJS } = (await import('pptxgenjs')) as unknown as { default: PptxDeckCtor }
  const pptx = new PptxGenJS()
  pptx.defineLayout({ name: 'W16x9', width: PAGE.width, height: PAGE.height })
  pptx.layout = 'W16x9'

  const pageCount = slides.length
  if (pageCount > PAGE_TOTAL_CAP) {
    throw new Error(`幻灯数量 ${pageCount} 超过 ${PAGE_TOTAL_CAP} 页上限`)
  }

  const footer = (page: PptxSlideSurface, index: number): void => {
    if (meta.title !== undefined && meta.title !== '') {
      page.addText(meta.title, {
        x: 0.6,
        y: PAGE.height - 0.32,
        w: 6,
        h: 0.25,
        fontFace: DECK_FONT,
        fontSize: 8,
        color: MUTED,
      })
    }
    page.addText(`${String(index + 1)} / ${String(pageCount)}`, {
      x: PAGE.width - 1.4,
      y: PAGE.height - 0.32,
      w: 0.8,
      h: 0.25,
      fontFace: DECK_FONT,
      fontSize: 8,
      color: MUTED,
      align: 'right',
    })
  }

  const header = (page: PptxSlideSurface, kicker: string | undefined, heading: string): void => {
    if (kicker !== undefined && kicker !== '') {
      page.addText(kicker, {
        x: 0.6,
        y: 0.24,
        w: PAGE.width - 1.2,
        h: 0.28,
        fontFace: DECK_FONT,
        fontSize: 10,
        bold: true,
        color: ACCENT,
        charSpacing: 2,
      })
    }
    page.addText(heading, {
      x: 0.6,
      y: 0.52,
      w: PAGE.width - 1.2,
      h: 0.6,
      fontFace: DECK_FONT,
      fontSize: 21,
      bold: true,
      color: INK,
      fit: 'shrink',
    })
    page.addShape('line', { x: 0.6, y: 1.14, w: PAGE.width - 1.2, h: 0, line: { color: ACCENT, width: 1.5 } })
  }

  for (const [index, slide] of slides.entries()) {
    const page = pptx.addSlide()
    page.addShape('rect', { x: 0, y: 0, w: PAGE.width, h: PAGE.height, fill: { color: BG } })

    if (slide.kind === 'title') {
      page.addShape('rect', { x: 0, y: 0, w: 0.22, h: PAGE.height, fill: { color: ACCENT } })
      const hasArt = slide.imagePath !== undefined
      page.addText(slide.title, {
        x: 0.9,
        y: 1.5,
        w: hasArt ? 4.9 : PAGE.width - 1.8,
        h: 1.6,
        fontFace: DECK_FONT,
        fontSize: 30,
        bold: true,
        color: INK,
        align: hasArt ? 'left' : 'center',
        valign: 'middle',
        fit: 'shrink',
      })
      page.addText(slide.subtitle, {
        x: 0.9,
        y: 3.25,
        w: hasArt ? 4.9 : PAGE.width - 1.8,
        h: 0.5,
        fontFace: DECK_FONT,
        fontSize: 13,
        color: MUTED,
        align: hasArt ? 'left' : 'center',
      })
      if (hasArt && slide.imagePath !== undefined) {
        page.addShape('rect', { x: 6.0, y: 0.6, w: 3.6, h: 4.4, fill: { color: CARD }, line: { color: CARD_LINE, width: 1 } })
        page.addImage({
          path: slide.imagePath,
          x: 6.15,
          y: 0.75,
          w: 3.3,
          h: 4.1,
          sizing: { type: 'contain', w: 3.3, h: 4.1 },
        })
      }
      continue
    }

    if (slide.kind === 'agenda') {
      header(page, 'AGENDA', '目录')
      page.addText(
        slide.sections.flatMap((section, row) => [
          { text: `${String(row + 1).padStart(2, '0')}  `, options: { bold: true, color: ACCENT } },
          { text: section, options: { color: INK, breakLine: true } },
        ]),
        { x: 1.0, y: 1.5, w: 8, h: 3.5, fontFace: DECK_FONT, fontSize: 19, lineSpacing: 40, valign: 'top' },
      )
      footer(page, index)
      continue
    }

    if (slide.kind === 'bullets') {
      header(page, slide.kicker, slide.heading)
      const hasArt = slide.imagePath !== undefined
      page.addText(
        slide.bullets.map((bullet) => ({
          text: bullet.text,
          options: {
            bullet: { code: '2022' },
            bold: bullet.emph === true,
            color: bullet.emph === true ? ACCENT : INK,
            breakLine: true,
          },
        })),
        {
          x: 0.8,
          y: 1.4,
          w: hasArt ? 5.3 : PAGE.width - 1.6,
          h: 3.75,
          fontFace: DECK_FONT,
          fontSize: 14,
          lineSpacing: 26,
          valign: 'top',
          fit: 'shrink',
        },
      )
      if (hasArt && slide.imagePath !== undefined) {
        page.addShape('rect', { x: 6.3, y: 1.4, w: 3.3, h: 3.7, fill: { color: CARD }, line: { color: CARD_LINE, width: 1 } })
        page.addImage({
          path: slide.imagePath,
          x: 6.45,
          y: 1.55,
          w: 3.0,
          h: 3.4,
          sizing: { type: 'contain', w: 3.0, h: 3.4 },
        })
      }
      footer(page, index)
      continue
    }

    // closing
    page.addShape('rect', { x: 0, y: 0, w: 0.22, h: PAGE.height, fill: { color: ACCENT } })
    page.addText('下一步计划', {
      x: 0.9,
      y: 1.8,
      w: PAGE.width - 1.8,
      h: 0.8,
      fontFace: DECK_FONT,
      fontSize: 26,
      bold: true,
      color: INK,
      align: 'center',
    })
    page.addText('（现场讨论填充）', {
      x: 0.9,
      y: 2.8,
      w: PAGE.width - 1.8,
      h: 0.5,
      fontFace: DECK_FONT,
      fontSize: 14,
      color: MUTED,
      align: 'center',
    })
  }

  await pptx.writeFile({ fileName: outPath })
}
