/**
 * arXiv API 工具：搜索、单篇获取、PDF 下载（从 Mimir 移植，增强现有实现）。
 */
import type { ArxivEntry } from './types'
import { httpFetch } from '../http'

/** 撤销 arXiv Atom feed 使用的小型 XML 实体词汇 */
function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 折叠 feed 中一个字段内的空白 */
function normalizeField(text: string): string {
  return unescapeXml(text).trim().replace(/\s+/g, ' ')
}

/** 提取一个 entry 块内第一个 <name>...</name> 的内容 */
function firstTag(block: string, name: string): string {
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(block)
  return match?.[1] === undefined ? '' : normalizeField(match[1])
}

/** 解析 Atom feed 为条目列表 */
export function parseArxivFeed(xml: string): ArxivEntry[] {
  const entries: ArxivEntry[] = []
  const entryBlocks = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? []
  for (const block of entryBlocks) {
    const rawId = firstTag(block, 'id')
    const id = rawId.replace(/^https?:\/\/arxiv\.org\/abs\//, '')
    if (id.length === 0) continue
    const authors = [...block.matchAll(/<name>([\s\S]*?)<\/name>/g)]
      .map((match) => normalizeField(match[1] ?? ''))
      .filter((name) => name.length > 0)
    entries.push({
      id,
      title: firstTag(block, 'title'),
      authors,
      summary: firstTag(block, 'summary'),
      published: firstTag(block, 'published'),
      url: `https://arxiv.org/abs/${id}`,
    })
  }
  return entries
}

/** 请求一个 arXiv API URL，传输/HTTP 失败直接 reject */
async function fetchArxiv(url: string, signal: AbortSignal): Promise<string> {
  const response = await httpFetch(url, {
    signal,
    headers: { 'User-Agent': ARXIV_PDF_USER_AGENT }
  })
  if (!response.ok) {
    throw new Error(`arXiv API request failed: HTTP ${response.status} for ${url}`)
  }
  return response.text()
}

/** 一次 arXiv 全文搜索并解析 feed */
export async function fetchArxivSearch(
  query: string,
  maxResults: number,
  signal: AbortSignal,
  options: { sortBySubmittedDate?: boolean } = {},
): Promise<ArxivEntry[]> {
  const sort = options.sortBySubmittedDate === true ? '&sortBy=submittedDate&sortOrder=descending' : ''
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${maxResults}${sort}`
  return parseArxivFeed(await fetchArxiv(url, signal))
}

/** 单篇 PDF 下载的硬上限（安全不变量） */
export const ARXIV_PDF_MAX_BYTES = 64 * 1024 * 1024

/**
 * arXiv 官方 ToS 要求程序化访问带可识别的 User-Agent（匿名无标识流量会被
 * 刻意慢速响应/限速）。mailto 指向项目公开联系邮箱，非隐私信息。
 */
export const ARXIV_PDF_USER_AGENT = 'Mimir-Desktop (https://github.com/hxhy/Mimir-Desktop; mailto:hxhy@users.noreply.github.com)'

/**
 * PDF 下载域名顺序：`export.arxiv.org` 是 arXiv 给自动化访问的官方通道
 * （配额独立于主站，主站会对程序流量故意降速）；主站作为回退。
 */
const ARXIV_PDF_HOSTS = ['https://export.arxiv.org', 'https://arxiv.org'] as const

/** 从单个域名下载一篇 arXiv 论文的 PDF 字节（失败直接 reject，由调用方决定回退）。 */
async function fetchArxivPdfFromHost(host: string, arxivId: string, signal: AbortSignal): Promise<Uint8Array> {
  const url = `${host}/pdf/${arxivId}`
  const response = await httpFetch(url, {
    signal,
    headers: { 'User-Agent': ARXIV_PDF_USER_AGENT }
  })
  if (!response.ok) {
    throw new Error(`arXiv PDF request failed: HTTP ${response.status} for ${url}`)
  }
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > ARXIV_PDF_MAX_BYTES) {
    throw new Error(`arXiv PDF exceeds the ${String(ARXIV_PDF_MAX_BYTES)}-byte cap for ${url}`)
  }
  if (response.body === null) throw new Error(`arXiv returned an empty PDF body for ${url}`)
  const chunks: Uint8Array[] = []
  let length = 0
  const reader = response.body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.length
    if (length > ARXIV_PDF_MAX_BYTES) {
      await reader.cancel()
      throw new Error(`arXiv PDF exceeds the ${String(ARXIV_PDF_MAX_BYTES)}-byte cap for ${url}`)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  if (bytes.length === 0) throw new Error(`arXiv returned an empty PDF body for ${url}`)
  if (bytes.length < 5 || String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') {
    throw new Error(`arXiv returned a non-PDF body for ${url}`)
  }
  return bytes
}

/** 下载一篇 arXiv 论文的 PDF 字节：按域名顺序尝试（export 主通道 → 主站回退）。 */
export async function fetchArxivPdf(arxivId: string, signal: AbortSignal): Promise<Uint8Array> {
  const id = arxivId.trim()
  if (!/^[a-zA-Z0-9._/-]+$/.test(id)) throw new Error(`invalid arXiv id: ${arxivId}`)
  const errors: string[] = []
  for (const host of ARXIV_PDF_HOSTS) {
    try {
      return await fetchArxivPdfFromHost(host, id, signal)
    } catch (error) {
      // abort 是调用方主动取消，不做域名回退直接抛
      if (signal.aborted) throw error
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  throw new Error(`arXiv PDF 下载失败（已尝试 ${ARXIV_PDF_HOSTS.join(' / ')}）：${errors.join('；')}`)
}

/**
 * 从任意 URL 下载 PDF 字节（OA 直链用）。
 *
 * 与 arXiv 通道共享同一组安全不变量：体积上限、`%PDF-` 魔数校验、可取消。
 * 仅允许 https —— OA 直链来自第三方（机构库/出版商），明文 http 一律拒绝。
 */
export async function fetchPdfBytes(url: string, signal: AbortSignal): Promise<Uint8Array> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:') {
    throw new Error(`拒绝非 https 的 PDF 直链：${url}`)
  }
  const response = await httpFetch(url, {
    signal,
    redirect: 'follow',
    headers: { 'User-Agent': ARXIV_PDF_USER_AGENT, Accept: 'application/pdf,*/*' }
  })
  if (!response.ok) {
    throw new Error(`PDF 下载失败: HTTP ${response.status}（${url}）`)
  }
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > ARXIV_PDF_MAX_BYTES) {
    throw new Error(`PDF 超过 ${String(ARXIV_PDF_MAX_BYTES)} 字节上限（${url}）`)
  }
  if (response.body === null) throw new Error(`服务器返回了空的 PDF 内容（${url}）`)
  const chunks: Uint8Array[] = []
  let length = 0
  const reader = response.body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.length
    if (length > ARXIV_PDF_MAX_BYTES) {
      await reader.cancel()
      throw new Error(`PDF 超过 ${String(ARXIV_PDF_MAX_BYTES)} 字节上限（${url}）`)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  if (bytes.length === 0) throw new Error(`服务器返回了空的 PDF 内容（${url}）`)
  // 魔数校验是最终判据：不少出版商对「无权限」返回 200 + HTML 登录页
  if (bytes.length < 5 || String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') {
    const kind = contentType === '' ? '未知类型' : contentType
    throw new Error(`该地址返回的不是 PDF（Content-Type: ${kind}），可能需要登录或为落地页：${url}`)
  }
  return bytes
}

/** 一个 arXiv id 的存储 PDF 文件名（百分号编码避免旧式斜杠冲突） */
export function paperPdfFileName(arxivId: string): string {
  return `${encodeURIComponent(arxivId)}.pdf`
}