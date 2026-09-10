/**
 * 模型发现：从 OpenAI 兼容端点拉取 `/v1/models`。
 *
 * 关键设计：
 * 1. URL 归一化：用户输入可能是服务根（https://example.com）或已含 `/v1`
 *    （https://example.com/v1），甚至直接传完整 model list URL。需要在不破坏
 *    用户已拼路径的情况下，落到一个可用的 models 端点。
 * 2. 响应兼容：标准 OpenAI 兼容端点返回 `{ data: [{ id, ... }] }`；部分网关
 *    直接返回数组或带其它字段。需要宽松解析、归一化、去重、排序。
 * 3. 凭据安全：API Key 只走 Authorization 头，不出现在错误信息或日志中。
 * 4. 行为对标 `model:test`：复用同样的 15s 超时与错误返回结构（只多一个
 *    `models` 字段），让上层调用方式一致。
 */

/** 规范化后返回的单个模型条目。 */
export interface DiscoveredModel {
  readonly id: string
  readonly ownedBy?: string
  readonly raw?: Record<string, unknown>
}

/** `model:list` IPC 返回结构（与 `model:test` 风格对齐）。 */
export interface ListModelsResult {
  readonly ok: boolean
  readonly message?: string
  readonly models?: readonly DiscoveredModel[]
  readonly endpoint?: string
}

/** 归一化用户输入的 baseUrl，得到 `${baseUrl}/models` 或原样的 URL。 */
export function buildModelsEndpoint(input: string): { url: string; alreadyHasModelsPath: boolean } {
  const trimmed = input.trim()
  if (trimmed === '') {
    throw new Error('请先填写请求地址')
  }
  // 去掉末尾 /
  let stripped = trimmed.replace(/\/+$/, '')
  // 若已经是 /models（可能带查询参数），原样返回
  if (/\/models(\?|$)/.test(stripped)) {
    return { url: stripped, alreadyHasModelsPath: true }
  }
  // 若路径已经包含 /v1 等明确版本前缀，不再追加 /v1
  if (/\/v\d+(?:\/|$)/.test(stripped)) {
    return { url: `${stripped}/models`, alreadyHasModelsPath: false }
  }
  // 默认追加 /v1/models（OpenAI 兼容约定）
  return { url: `${stripped}/v1/models`, alreadyHasModelsPath: false }
}

/** 从宽松响应中提取模型 id 列表。 */
export function parseModelsResponse(json: unknown): DiscoveredModel[] {
  const collected: DiscoveredModel[] = []

  const pushEntry = (entry: unknown): void => {
    if (typeof entry !== 'object' || entry === null) return
    const obj = entry as Record<string, unknown>
    // 标准 OpenAI 格式：{ id, object, owned_by, ... }
    // 部分厂商格式：{ name, model, ... }，优先取 id，没有就退化到 name/model
    const idRaw = obj['id']
    const id = typeof idRaw === 'string' && idRaw.trim() !== ''
      ? idRaw.trim()
      : typeof obj['name'] === 'string' && (obj['name'] as string).trim() !== ''
        ? (obj['name'] as string).trim()
        : typeof obj['model'] === 'string' && (obj['model'] as string).trim() !== ''
          ? (obj['model'] as string).trim()
          : null
    if (id === null) return
    const ownedBy = typeof obj['owned_by'] === 'string' ? (obj['owned_by'] as string) : undefined
    collected.push({ id, ownedBy, raw: obj })
  }

  if (Array.isArray(json)) {
    for (const entry of json) pushEntry(entry)
  } else if (typeof json === 'object' && json !== null) {
    const obj = json as Record<string, unknown>
    if (Array.isArray(obj['data'])) {
      for (const entry of obj['data'] as unknown[]) pushEntry(entry)
    } else if (Array.isArray(obj['models'])) {
      // 部分网关（如 OpenRouter / 自建）的变体
      for (const entry of obj['models'] as unknown[]) pushEntry(entry)
    } else {
      // 完全未知结构：尝试把对象本身作为单条记录
      pushEntry(obj)
    }
  }

  // 去重 + 排序：稳定顺序方便用户在前端快速找到模型
  const dedup = new Map<string, DiscoveredModel>()
  for (const m of collected) {
    if (!dedup.has(m.id)) dedup.set(m.id, m)
  }
  return Array.from(dedup.values()).sort((a, b) => a.id.localeCompare(b.id))
}

/** 主进程实际调用的实现：组装请求、解析响应、归一化错误。 */
export async function listModels(args: { baseUrl: string; apiKey: string; timeoutMs?: number }): Promise<ListModelsResult> {
  const { baseUrl, apiKey } = args
  if (!baseUrl || !apiKey) {
    return { ok: false, message: '请填写请求地址和 API Key' }
  }

  let endpoint: string
  try {
    endpoint = buildModelsEndpoint(baseUrl).url
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '请求地址无效' }
  }

  const controller = new AbortController()
  const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 15_000
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json'
      },
      signal: controller.signal
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      if (response.status === 401 || response.status === 403) {
        return { ok: false, message: `认证失败 (HTTP ${response.status})`, endpoint }
      }
      return { ok: false, message: `HTTP ${response.status}: ${text.slice(0, 200)}`, endpoint }
    }
    let json: unknown
    try {
      json = await response.json()
    } catch {
      return { ok: false, message: '响应不是合法 JSON，服务可能不支持 /v1/models', endpoint }
    }
    const models = parseModelsResponse(json)
    if (models.length === 0) {
      return { ok: false, message: '服务返回了空模型列表', endpoint }
    }
    return { ok: true, models, endpoint }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, message: `请求超时（${Math.round(timeoutMs / 1000)}s）`, endpoint }
    }
    return {
      ok: false,
      message: error instanceof Error ? error.message : '请求失败',
      endpoint
    }
  } finally {
    clearTimeout(timer)
  }
}
