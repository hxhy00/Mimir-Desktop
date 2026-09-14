/**
 * 文献检索统一访问层单测（全部注入假 fetch，不打真实网络）。
 *
 * 锁定四条口径：
 * 1. OpenAlex 为默认主源，结果归一成库条目形状（arxivId / url 指向 arXiv）；
 * 2. arXiv 补充源的结果与主源按 id 去重合并，不出现重复条目；
 * 3. 缓存生效：同一查询第二次不再发 HTTP；
 * 4. 按 id 解析的失败信息**如实列出数据源**，不再谎称"限流相关"（历史误导）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolvePaperById, searchPapers } from '../../electron/agent/paperSearch'

/** 构造一个返回 JSON 的假 Response。 */
function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body
  } as unknown as Response
}

const openAlexWork = {
  id: 'https://openalex.org/W1',
  doi: 'https://doi.org/10.48550/arxiv.1512.03385',
  title: 'Deep Residual Learning for Image Recognition',
  publication_year: 2016,
  publication_date: '2016-06-27',
  authorships: [{ authors: [{ display_name: 'Kaiming He' }, { display_name: 'Xiangyu Zhang' }] }],
  primary_location: { source: { display_name: 'arXiv (Cornell University)' } },
  best_oa_location: { landing_page_url: 'https://arxiv.org/abs/1512.03385v1', pdf_url: null },
  abstract_inverted_index: { Deep: [0], residual: [1], learning: [2] }
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('paperSearch：统一文献检索访问层', () => {
  it('关键词检索走 OpenAlex，并把条目归一成库形状（arxivId 从 best_oa_location 提取）', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [openAlexWork] }))

    const entries = await searchPapers('residual learning', 5)

    expect(entries).toHaveLength(1)
    expect(entries[0]?.id).toBe('1512.03385')
    expect(entries[0]?.title).toBe('Deep Residual Learning for Image Recognition')
    expect(entries[0]?.authors).toEqual(['Kaiming He', 'Xiangyu Zhang'])
    expect(entries[0]?.url).toBe('https://arxiv.org/abs/1512.03385')
    expect(entries[0]?.source).toBe('openalex')
    // 倒排索引重建出的摘要
    expect(entries[0]?.summary).toBe('Deep residual learning')
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('api.openalex.org')
  })

  it('关键词检索无法解析 arxiv id 时（纯期刊论文）用 doi 作 id，URL 指向 DOI', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        results: [
          {
            ...openAlexWork,
            // 期刊正式版：DOI 不是 arXiv 注册前缀（10.48550/arXiv.xxx），且无 arXiv 落地页
            doi: 'https://doi.org/10.1109/cvpr.2016.90',
            best_oa_location: null,
            primary_location: { source: { display_name: 'CVPR' } }
          }
        ]
      })
    )

    const entries = await searchPapers('some journal paper', 5)

    expect(entries[0]?.id).toBe('10.1109/cvpr.2016.90')
    expect(entries[0]?.url).toContain('doi.org')
  })

  it('arXiv 补充源的结果按 id 与主源去重合并（重复条目不出现两次）', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [openAlexWork] }))
    const supplement = vi.fn().mockResolvedValue([
      // 与 OpenAlex 同 id（版本号已归一）→ 应被去重
      { id: '1512.03385', title: 'Deep Residual Learning', authors: ['Kaiming He'], summary: 'dup', published: '2015-12-10', url: 'https://arxiv.org/abs/1512.03385' },
      // 新条目 → 应补进来
      { id: '1706.03762', title: 'Attention Is All You Need', authors: ['Ashish Vaswani'], summary: 'new', published: '2017-06-12', url: 'https://arxiv.org/abs/1706.03762' }
    ])

    const entries = await searchPapers('transformer', 10, supplement)

    expect(entries.map((e) => e.id)).toEqual(['1512.03385', '1706.03762'])
    expect(supplement).toHaveBeenCalledTimes(1)
  })

  it('arXiv 补充源抛错（限流）不影响整体：主源结果照常返回', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [openAlexWork] }))
    const supplement = vi.fn().mockRejectedValue(new Error('429 Too Many Requests'))

    const entries = await searchPapers('residual', 5, supplement)

    expect(entries).toHaveLength(1)
  })

  it('缓存生效：同一查询第二次不再发 HTTP', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [openAlexWork] }))

    await searchPapers('cached query', 5)
    await searchPapers('cached query', 5)

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('空查询直接返回空数组，不发请求', async () => {
    const entries = await searchPapers('   ', 5)
    expect(entries).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('按 id 解析：OpenAlex filter 直取，命中后不再问 Semantic Scholar', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [openAlexWork] }))

    const entry = await resolvePaperById('1512.03385v2')

    expect(entry.id).toBe('1512.03385')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('filter=arxiv%3A1512.03385')
  })

  it('按 id 解析失败时报错如实列出数据源，不再谎称"限流相关"', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [] }))

    // 用 DOI 形式（不以 arxiv 裸 id 走 S2 by-id 分支）避免触发 S2 串行节流等待
    const failing = resolvePaperById('10.9999/not-exist')
    await expect(failing).rejects.toThrow(/OpenAlex \/ Semantic Scholar/)
    await expect(resolvePaperById('10.9999/not-exist')).rejects.not.toThrow(/限流/)
  })
})
