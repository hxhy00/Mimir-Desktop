/**
 * 组会 deck 的 LLM 增强器（可选双引擎的内容层）。
 *
 * 在确定性渲染之前，若用户开启了 AI 增强且已配置模型，用一次结构化
 * 请求把「开场导语 / 每篇论文分享要点 / 实验小结」提炼成页级内容；
 * 任何失败（网络、格式、超时）都返回 null，由上层静默降级为确定性。
 * 不经过 DeepAgents（无工具调用），仅单轮 LLM。
 */
import { ChatOpenAI } from '@langchain/openai'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import type { DeckEnhancement, DeckExperimentSource, DeckPaperSource, MeetingModelConfig } from './types'

const ENHANCE_TIMEOUT_MS = 90_000
const ENHANCE_MAX_PAPER_POINTS = 6

interface EnhanceContext {
  readonly title: string
  readonly presenter?: string | undefined
  readonly projectTitle?: string | undefined
  readonly date: string
  readonly papers: readonly DeckPaperSource[]
  readonly experiments: readonly DeckExperimentSource[]
}

/** 从模型输出中剥离可能的 ```json 围栏后解析。 */
function parseJsonObject(raw: string): Record<string, unknown> | null {
  let text = raw.trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/i
  const match = fence.exec(text)
  if (match !== null && match[1] !== undefined) text = match[1].trim()
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

/** 宽松取字符串字段。 */
function stringField(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed
}

/**
 * 尝试对组会素材做一次 LLM 润色。
 * @param model - 已配置的模型连接（必须含 apiKey）。
 * @param context - 素材上下文。
 * @returns 结构化增强产物；无法完成（缺配置/网络/解析失败）返回 null。
 */
export async function enhanceDeck(
  model: MeetingModelConfig,
  context: EnhanceContext,
): Promise<DeckEnhancement | null> {
  const baseUrl = model.baseUrl
  const modelId = model.modelId
  const apiKey = model.apiKey
  if (!baseUrl || !modelId || !apiKey) return null

  const paperLines = context.papers.slice(0, 12).map((paper, index) => {
    const authors = paper.authors.slice(0, 3).join(', ')
    const summary = paper.summary.trim().slice(0, 400)
    const notes = paper.notes.trim().slice(0, 200)
    return (
      `${index + 1}. [id:${paper.arxivId}] ${paper.title}${authors ? ` (作者: ${authors})` : ''}\n` +
      `   摘要: ${summary}\n` +
      (notes !== '' ? `   阅读笔记: ${notes}\n` : '')
    )
  }).join('\n')

  const experimentLines = context.experiments
    .slice(0, 8)
    .map((record) => {
      const entries = Object.entries(record.metrics)
        .slice(0, 4)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join('; ')
      return `- ${record.name} (状态: ${record.status})${entries !== '' ? ` 指标: ${entries}` : ''}`
    })
    .join('\n')

  const system = `你是科研组会 PPT 的内容策划。请根据提供的论文与实验素材，为演示文稿输出精炼的中文内容。要求：
1. 只使用素材中真实存在的信息，不要编造数据或结论。
2. 每条分享要点聚焦方法/贡献/结果/与你所在项目的关联，单条不超过 60 字。
3. 严格只输出一个 JSON 对象，不要输出解释或 Markdown 之外的文字。`

  const user = `汇报主题：${context.title}
${context.presenter ? `汇报人：${context.presenter}\n` : ''}${context.projectTitle ? `关联项目：${context.projectTitle}\n` : ''}
汇报日期：${context.date}

论文素材：
${paperLines === '' ? '（无）' : paperLines}

实验素材：
${experimentLines === '' ? '（无）' : experimentLines}

请输出如下结构的 JSON：
{
  "overview": "80-120 字开场导语，概括本次汇报的推进情况与亮点（若论文与实验都为空，可省略该字段）",
  "paperPoints": {
    "<论文id，必须与上方 [id:xxx] 完全一致>": ["要点1", "要点2", ...]
  },
  "experimentsNote": "一句话实验小结（若实验为空可省略）"
}
其中 paperPoints 为每个 id 至多 4 条要点。若某素材过少而无内容可写，对应字段可省略。`

  try {
    const chat = new ChatOpenAI({
      apiKey,
      model: modelId,
      temperature: 0.4,
      maxRetries: 0,
      ...(baseUrl ? { configuration: { baseURL: baseUrl } } : {}),
    })
    const response = await chat.invoke(
      [new SystemMessage(system), new HumanMessage(user)],
      { signal: AbortSignal.timeout(ENHANCE_TIMEOUT_MS) },
    )
    const content = typeof response.content === 'string' ? response.content : ''
    if (content === '') return null
    const parsed = parseJsonObject(content)
    if (parsed === null) return null

    const paperPoints: Record<string, readonly string[]> = {}
    const rawPoints = parsed['paperPoints']
    if (typeof rawPoints === 'object' && rawPoints !== null && !Array.isArray(rawPoints)) {
      const knownIds = new Set(context.papers.map((paper) => paper.arxivId))
      for (const [arxivId, value] of Object.entries(rawPoints as Record<string, unknown>)) {
        if (!knownIds.has(arxivId)) continue
        if (!Array.isArray(value)) continue
        const points = value
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter((item) => item !== '')
          .slice(0, ENHANCE_MAX_PAPER_POINTS)
        if (points.length > 0) paperPoints[arxivId] = points
      }
    }

    return {
      overview: stringField(parsed['overview'], 400),
      experimentsNote: stringField(parsed['experimentsNote'], 300),
      paperPoints,
    }
  } catch {
    return null
  }
}
