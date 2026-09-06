/**
 * AI 配图（image-gen）：调用 OpenAI 兼容 `/images/generations` 生成组会封面与
 * 论文概念插图，并以 PNG 落盘进图表目录（figures:list 一并管理、可复用）。
 * 任何失败都应被上层 best-effort 吞掉，绝不拖垮组会生成。
 */
import { join } from 'path'
import { getStoreValue } from '../library/store'
import { figuresDir, importFigure, type FigureRecord } from './figuresService'

export interface ImageGenConfig {
  readonly baseUrl: string
  readonly modelId: string
  readonly apiKey: string
}

const IMAGE_GEN_TIMEOUT_MS = 60_000

/** 读取设置中的图像生成配置（settings.imageGen）。 */
export function readImageGenConfig(): ImageGenConfig | null {
  const settings = getStoreValue<Record<string, unknown>>('settings') ?? {}
  const raw = settings['imageGen']
  if (typeof raw !== 'object' || raw === null) return null
  const config = raw as Record<string, unknown>
  if (
    typeof config['baseUrl'] !== 'string' || config['baseUrl'] === ''
    || typeof config['modelId'] !== 'string' || config['modelId'] === ''
    || typeof config['apiKey'] !== 'string' || config['apiKey'] === ''
  ) return null
  return {
    baseUrl: config['baseUrl'],
    modelId: config['modelId'],
    apiKey: config['apiKey'],
  }
}

/** 封面提示词：极简学术封面，纯图无字。 */
export function coverPrompt(title: string): string {
  return `Minimalist scientific presentation cover illustration about ${title}. Clean flat vector style, abstract geometric shapes and gradient accents, no text or letters.`
}

/** 论文概念图提示词：依据标题+摘要画概念插图。 */
export function paperArtPrompt(title: string, summary: string): string {
  const excerpt = summary.trim().slice(0, 220)
  return `Concept illustration for a research paper titled "${title}". ${excerpt ? `Related idea: ${excerpt}. ` : ''}Clean flat vector academic style, no text or letters.`
}

/** 生成一张图并返回落盘记录；失败抛错（由上层 best-effort 处理）。 */
export async function generateDeckImage(
  config: ImageGenConfig,
  name: string,
  prompt: string,
): Promise<FigureRecord> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), IMAGE_GEN_TIMEOUT_MS)
  let buffer: Buffer
  try {
    const base = config.baseUrl.replace(/\/+$/, '')
    const response = await fetch(`${base}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.modelId,
        prompt,
        n: 1,
        size: '1536x1024',
        response_format: 'b64_json',
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`图像服务 HTTP ${response.status}: ${text.slice(0, 200)}`)
    }
    const data = (await response.json()) as { data?: Array<{ b64_json?: string }> }
    const b64 = data.data?.[0]?.b64_json
    if (typeof b64 !== 'string' || b64 === '') throw new Error('图像服务未返回数据')
    buffer = Buffer.from(b64, 'base64')
  } finally {
    clearTimeout(timer)
  }
  // 落盘到图表目录（含 index 登记，可在图表模块中看到/复用）
  return importFigure(name, `data:image/png;base64,${buffer.toString('base64')}`)
}

/** 由 figure 记录得到可嵌入 pptx 的绝对路径。 */
export function figureAbsPath(figure: FigureRecord): string {
  return join(figuresDir(), figure.fileName)
}
