/**
 * 开放获取（OA）PDF 位置解析。
 *
 * ── 为什么需要这一层 ───────────────────────────────────────────────────────
 * arXiv 预印本可以用 `/pdf/{id}` 直接下载，但期刊/会议论文（DOI 条目）没有这个
 * 公开端点——旧实现直接拒绝下载（「该论文不是 arXiv 预印本，暂不支持直接下载」）。
 * 这是文献工作流里最常见的断点：搜到了、入库了、却读不了。
 *
 * ── 方案（成熟公开 API，不自研索引）────────────────────────────────────────
 * 按「成本从低到高」的瀑布依次尝试，命中即停：
 * 1. **检索时已带回的 pdfUrl**（OpenAlex `best_oa_location.pdf_url`）——零额外请求；
 * 2. **OpenAlex by-DOI**：同一份数据，但覆盖「先入库、后补链接」的旧条目；
 * 3. **Unpaywall**：OA 状态最权威的数据源（Zotero 官方 PDF 抓取也用它），
 *    免 key，但**必须带真实邮箱**（示例邮箱会被 422 拒绝，官方明确要求）。
 *
 * ⚠️ 实测要点（不是假设，是踩过的坑）：
 * - OpenAlex 常见「有 OA 位置但 `pdf_url` 为 null」——只有 landing_page_url
 *   （机构库/出版商页）。这种**不能当 PDF 直链用**，因此本模块只收 pdf_url，
 *   宁可返回 null 让上层如实报「未找到 OA 版本」，也不给一个必然 404/HTML 的地址。
 * - Unpaywall 的 `best_oa_location.url_for_pdf` 同理可能为 null，需判空。
 */

import { httpFetch } from '../http'

/** Unpaywall 要求的联系邮箱：公开的项目联系地址，非隐私信息。 */
const UNPAYWALL_EMAIL = 'hxhy@users.noreply.github.com'
const REQUEST_TIMEOUT_MS = 15_000

/**
 * OpenAlex API key 接缝：设置页 `settings.openAlexApiKey` 优先，环境变量兜底。
 * 与 paperSearch 同一套理由——不直读 process.env（打包后会被静态替换）。
 * OpenAlex 已转 API Key 预算制，mailto 不再提供配额增益；未配置 key 时回退 mailto 标识。
 */
let openAlexKeyProvider: () => string = () => process.env['MIMIR_OPENALEX_API_KEY'] ?? ''
export function setOpenAlexKeyProvider(provider: () => string): void {
  openAlexKeyProvider = provider
}
/** OpenAlex 鉴权参数：配了 key 走账号配额（额度 ×10），否则回退 mailto 联系标识。 */
function openAlexAuth(): string {
  const key = openAlexKeyProvider().trim()
  return key !== '' ? `api_key=${encodeURIComponent(key)}` : `mailto=${UNPAYWALL_EMAIL}`
}

/** 一个解析到的 OA PDF 位置。 */
export interface OaPdfLocation {
  /** PDF 直链（已校验非空；`contentType` 是否为 PDF 由下载层实际校验） */
  url: string
  /** 来源标识，展示与排障用 */
  source: 'openalex' | 'openalex-oa' | 'unpaywall'
}

/** 归一 DOI：去 URL 前缀与 `doi:` 前缀；不是 DOI 形状时返回 null。 */
export function normalizeDoi(raw: string): string | null {
  const clean = raw.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:/i, '')
  return /^10\.\d{4,9}\/\S+$/.test(clean) ? clean : null
}

/** 判断一个 id 是否 DOI 形状（含 `doi:` 前缀写法）。 */
export function isDoiId(raw: string): boolean {
  return normalizeDoi(raw) !== null
}

async function getJson(url: string): Promise<unknown> {
  const response = await httpFetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Accept: 'application/json' }
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

/** OpenAlex by-DOI：取 `best_oa_location.pdf_url`（常为 null，需判空）。 */
async function viaOpenAlex(doi: string): Promise<OaPdfLocation | null> {
  try {
    const url =
      `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}` +
      `?${openAlexAuth()}&select=id,doi,best_oa_location`
    const data = (await getJson(url)) as {
      best_oa_location?: { pdf_url?: string | null } | null
    }
    const pdf = (data.best_oa_location?.pdf_url ?? '').trim()
    return pdf === '' ? null : { url: pdf, source: 'openalex' }
  } catch {
    return null
  }
}

/** Unpaywall：OA 状态最权威的来源，取 `best_oa_location.url_for_pdf`。 */
async function viaUnpaywall(doi: string): Promise<OaPdfLocation | null> {
  try {
    const url = `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(UNPAYWALL_EMAIL)}`
    const data = (await getJson(url)) as {
      best_oa_location?: { url_for_pdf?: string | null } | null
    }
    const pdf = (data.best_oa_location?.url_for_pdf ?? '').trim()
    return pdf === '' ? null : { url: pdf, source: 'unpaywall' }
  } catch {
    return null
  }
}

/**
 * 为一个 DOI 解析 OA PDF 直链。
 * 瀑布：已带回的 pdfUrl（由调用方传入 hint）→ OpenAlex → Unpaywall。
 * 全部未命中返回 null（上层如实告知「未找到开放获取版本」）。
 */
export async function resolveOaPdfLocation(
  doiOrId: string,
  hint?: { url?: string | undefined; source?: string | undefined }
): Promise<OaPdfLocation | null> {
  const hintUrl = (hint?.url ?? '').trim()
  if (hintUrl !== '') {
    return { url: hintUrl, source: hint?.source === 'unpaywall' ? 'unpaywall' : 'openalex-oa' }
  }
  const doi = normalizeDoi(doiOrId)
  if (doi === null) return null
  return (await viaOpenAlex(doi)) ?? (await viaUnpaywall(doi))
}
