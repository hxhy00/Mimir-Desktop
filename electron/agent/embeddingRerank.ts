/**
 * Skill 精排的向量化实现（阶段2.5）。
 *
 * 用 {@link OpenAIEmbeddings}（@langchain/openai 内置，非自研）把「用户请求」与
 * 「候选技能文本」编码成向量，按余弦相似度排序，替代原来的 LLM 精排调用——
 * 把每条消息的 2 次 LLM 调用降到 1 次（仅保留 Meta-Cognition）。
 *
 * 端点复用当前 chat 模型的 baseUrl / apiKey（多数网关同一 Key 同时提供
 * chat 与 embeddings）；embedding 模型名由 settings.embeddingModel 指定，
 * 缺省取常见默认值。网关不支持 embedding 接口时，本模块会抛错，
 * 调用方应捕获并回退规则排序（routeSkills 的 llmRerank 契约即返回 null）。
 */
import { OpenAIEmbeddings } from '@langchain/openai'
import type { RouterCandidate } from './skillRouter'

/** 缺省 embedding 模型名（多数 OpenAI 兼容网关可识别）。 */
export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small'

export interface EmbeddingConfig {
  apiKey: string
  baseUrl?: string
  /** embedding 模型名；缺省 {@link DEFAULT_EMBEDDING_MODEL}。 */
  model?: string
}

/** 判断是否为「嵌入接口不可用」类错误（用于给出可读回退原因）。 */
export function isEmbeddingUnavailable(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return /embedding|not found|404|does not exist|unsupported|invalid.*model/i.test(msg)
}

/** 余弦相似度（向量已归一化时退化为点积）。 */
function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** 把候选技能压成一段用于向量化的文本（标题 + 说明 + 适用边界 + 正例）。 */
function candidateText(c: RouterCandidate): string {
  return [c.title, c.description, c.applicableBoundary, ...(c.positiveExamples ?? [])]
    .filter((s) => typeof s === 'string' && s.trim() !== '')
    .join('；')
}

/**
 * 用 embedding 相似度对候选做精排。
 *
 * @returns 排序后的候选（与原候选同一批，仅顺序不同）；抛出异常表示不可用。
 */
export async function rerankByEmbedding(
  cands: RouterCandidate[],
  query: string,
  config: EmbeddingConfig
): Promise<RouterCandidate[]> {
  if (cands.length === 0) return cands
  const embedder = new OpenAIEmbeddings({
    apiKey: config.apiKey,
    model: config.model !== undefined && config.model.trim() !== '' ? config.model.trim() : DEFAULT_EMBEDDING_MODEL,
    ...(config.baseUrl !== undefined && config.baseUrl !== ''
      ? { configuration: { baseURL: config.baseUrl } }
      : {})
  })

  const texts = [query, ...cands.map(candidateText)]
  const vectors = await embedder.embedDocuments(texts)
  const queryVec = vectors[0]
  const scored = cands.map((c, i) => ({ cand: c, score: cosine(queryVec, vectors[i + 1]) }))
  scored.sort((a, b) => b.score - a.score)
  return scored.map((s) => s.cand)
}
