/**
 * 编译报错的一键 AI 修复：把错误行 ±3 行上下文发给已配置对话模型，
 * 要求返回 `{ fileName, from, to }` 最小补丁；主进程校验 `from` 唯一后落盘。
 * 解析/校验失败时返回原始建议文本（渲染进程可展示给用户手动处理）。
 */
import { readFile, writeFile } from 'fs/promises'
import { join, extname } from 'path'
import { ChatOpenAI } from '@langchain/openai'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { getStoreValue } from '../library/store'

const AI_FIX_TIMEOUT_MS = 90_000
const FIX_CONTEXT_RADIUS = 3

export interface AiFixRequest {
  readonly projectDir: string
  /** 相对项目目录的 .tex 路径（正斜杠）。 */
  readonly fileName: string
  readonly line: number
  readonly message: string
}

export interface AiFixResult {
  readonly applied: boolean
  /** 应用后写的行数（仅统计变动个数，简化置为替换次数）。 */
  readonly replaced?: number
  /** 未自动应用时模型的原始建议文本（供人工参考）。 */
  readonly suggestion?: string
}

interface ModelConnection {
  apiKey: string
  modelId: string
  baseUrl?: string | undefined
}

function activeModel(): ModelConnection | null {
  const settings = getStoreValue<Record<string, unknown>>('settings') ?? {}
  const models = (settings.models as Array<Record<string, unknown>> | undefined) ?? []
  const selectedModelId = settings.selectedModelId as string | undefined
  const selected = models.find((m) => m.id === selectedModelId) ?? models[0]
  if (selected === undefined || typeof selected.apiKey !== 'string' || selected.apiKey === '') return null
  return {
    apiKey: selected.apiKey,
    modelId: typeof selected.modelId === 'string' ? selected.modelId : 'deepseek-chat',
    baseUrl: typeof selected.baseUrl === 'string' ? selected.baseUrl : undefined,
  }
}

function parsePatch(raw: string): { fileName?: string; from?: string; to?: string } | null {
  let text = raw.trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/i
  const match = fence.exec(text)
  if (match !== null && match[1] !== undefined) text = match[1].trim()
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    return {
      fileName: typeof record.fileName === 'string' ? record.fileName : undefined,
      from: typeof record.from === 'string' ? record.from : undefined,
      to: typeof record.to === 'string' ? record.to : undefined,
    }
  } catch {
    return null
  }
}

/** 修复编译报错：优先自动应用最小补丁，失败回退为建议文本。 */
export async function aiFixIssue(request: AiFixRequest): Promise<AiFixResult> {
  const model = activeModel()
  if (model === null) return { applied: false, suggestion: '未配置可用模型：请先在「设置」中添加模型。' }

  const rel = request.fileName
  if (rel === '' || rel.startsWith('/') || rel.split('/').some((p) => p === '..')) {
    return { applied: false, suggestion: '非法文件路径' }
  }
  const filePath = join(request.projectDir, ...rel.split('/'))
  if (!filePath.startsWith(request.projectDir) || extname(filePath).toLowerCase() !== '.tex') {
    return { applied: false, suggestion: '非法文件路径' }
  }

  let source: string
  try {
    source = await readFile(filePath, 'utf-8')
  } catch {
    return { applied: false, suggestion: '无法读取源码文件，可能已被移动或删除。' }
  }

  const sourceLines = source.split('\n')
  const lineIndex = Number.isFinite(request.line) ? request.line - 1 : 0
  const start = Math.max(0, lineIndex - FIX_CONTEXT_RADIUS)
  const end = Math.min(sourceLines.length, lineIndex + FIX_CONTEXT_RADIUS + 1)
  const contextBlock = sourceLines
    .slice(start, end)
    .map((text, index) => `${String(start + index + 1)} | ${text}`)
    .join('\n')

  const system = '你是严谨的 LaTeX 修复助手。只输出一个 JSON 对象，不要任何解释。'
  const user = `The paper's LaTeX compile reported the issue below. Please produce a minimal patch.

Issue: ${request.message}
File (relative): ${rel}${Number.isFinite(request.line) ? ` (line ${String(request.line)})` : ''}

Source context (lines ${String(start + 1)}-${String(end)}):
\`\`\`latex
${contextBlock}
\`\`\`

Respond with exactly:
{
  "fileName": "${rel}",
  "from": "the exact unique existing text that should be replaced",
  "to": "the replacement text"
}
Rules:
- "from" must match exactly and only once in the whole file;
- do not change unrelated content;
- use escaped newlines (\\n) inside "from"/"to" when multi-line.`

  try {
    const chat = new ChatOpenAI({
      apiKey: model.apiKey,
      model: model.modelId,
      temperature: 0.1,
      maxRetries: 0,
      ...(model.baseUrl ? { configuration: { baseURL: model.baseUrl } } : {}),
    })
    const response = await chat.invoke(
      [new SystemMessage(system), new HumanMessage(user)],
      { signal: AbortSignal.timeout(AI_FIX_TIMEOUT_MS) },
    )
    const content = typeof response.content === 'string' ? response.content : ''
    if (content === '') return { applied: false, suggestion: '模型未返回内容' }
    const patch = parsePatch(content)
    if (patch === null) {
      return { applied: false, suggestion: content.slice(0, 2000) }
    }
    const from = patch.from ?? ''
    const to = patch.to ?? ''
    if (from === '') return { applied: false, suggestion: content.slice(0, 2000) }
    const occurrences = source.split(from).length - 1
    if (occurrences !== 1) {
      return {
        applied: false,
        suggestion: `模型建议的待替换文本在文件中出现 ${String(occurrences)} 次（应恰为 1 次），未自动应用。\n\n模型回复：\n${content.slice(0, 2000)}`,
      }
    }
    const next = source.replace(from, to)
    await writeFile(filePath, next, 'utf-8')
    return { applied: true, replaced: 1 }
  } catch (error) {
    return { applied: false, suggestion: `调用模型失败：${error instanceof Error ? error.message : '未知错误'}` }
  }
}
