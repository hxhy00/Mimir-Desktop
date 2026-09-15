/**
 * OA（开放获取）PDF 位置解析单测（全部注入假 fetch，不打真实网络）。
 *
 * 锁定四条口径：
 * 1. DOI 归一与识别（含 URL / `doi:` 前缀写法）；
 * 2. 检索时已带回的 pdfUrl 作 hint 时零额外请求；
 * 3. OpenAlex `pdf_url` 为 null 时回落到 Unpaywall（实测常见：只有 landing_page_url）；
 * 4. 全部未命中返回 null（上层据此如实报「未找到 OA 版本」，而不是给一个必然失败的链接）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isDoiId, normalizeDoi, resolveOaPdfLocation } from '../../electron/library/oaLocation'

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body
  } as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OA 位置解析：DOI 归一', () => {
  it('去掉 URL / doi: 前缀，保留裸 DOI', () => {
    expect(normalizeDoi('https://doi.org/10.1109/cvpr.2016.90')).toBe('10.1109/cvpr.2016.90')
    expect(normalizeDoi('http://dx.doi.org/10.1038/nature12373')).toBe('10.1038/nature12373')
    expect(normalizeDoi('doi:10.1109/cvpr.2016.90')).toBe('10.1109/cvpr.2016.90')
    expect(normalizeDoi('10.1109/cvpr.2016.90')).toBe('10.1109/cvpr.2016.90')
  })

  it('非 DOI 形状（arXiv 裸 id、纯文本）返回 null', () => {
    expect(normalizeDoi('1512.03385')).toBeNull()
    expect(normalizeDoi('Attention Is All You Need')).toBeNull()
    expect(normalizeDoi('')).toBeNull()
  })

  it('isDoiId 与 normalizeDoi 口径一致', () => {
    expect(isDoiId('10.1109/cvpr.2016.90')).toBe(true)
    expect(isDoiId('doi:10.1109/cvpr.2016.90')).toBe(true)
    expect(isDoiId('1512.03385')).toBe(false)
  })
})

describe('OA 位置解析：瀑布链', () => {
  it('已有 hint 直链时不发任何请求', async () => {
    const location = await resolveOaPdfLocation('10.1109/cvpr.2016.90', {
      url: 'https://example.org/paper.pdf',
      source: 'openalex-oa'
    })

    expect(location).toEqual({ url: 'https://example.org/paper.pdf', source: 'openalex-oa' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('OpenAlex 命中 pdf_url 时不再问 Unpaywall', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ best_oa_location: { pdf_url: 'https://repo.example.org/a.pdf' } })
    )

    const location = await resolveOaPdfLocation('10.1234/abc')

    expect(location).toEqual({ url: 'https://repo.example.org/a.pdf', source: 'openalex' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('api.openalex.org')
  })

  it('OpenAlex 只有落地页（pdf_url 为 null）→ 回落 Unpaywall', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ best_oa_location: { pdf_url: null } }))
      .mockResolvedValueOnce(jsonResponse({ best_oa_location: { url_for_pdf: 'https://upw.example.org/b.pdf' } }))

    const location = await resolveOaPdfLocation('10.1234/abc')

    expect(location).toEqual({ url: 'https://upw.example.org/b.pdf', source: 'unpaywall' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('api.unpaywall.org')
    // Unpaywall 官方要求带真实邮箱，否则 422
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('email=')
  })

  it('两源都无 OA 版本 → 返回 null（不给必然失败的链接）', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ best_oa_location: null }))

    const location = await resolveOaPdfLocation('10.1234/abc')

    expect(location).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('上游抛错视作未命中，不向上传播（降级为「未找到」）', async () => {
    fetchMock.mockRejectedValue(new Error('HTTP 500'))

    await expect(resolveOaPdfLocation('10.1234/abc')).resolves.toBeNull()
  })

  it('非 DOI 输入且无 hint → 直接 null，不发请求', async () => {
    await expect(resolveOaPdfLocation('1512.03385')).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
