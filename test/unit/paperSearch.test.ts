/**
 * 文献检索统一访问层单测（全部注入假 fetch，不打真实网络）。
 *
 * 锁定口径：
 * 1. OpenAlex 为默认主源，查询用官方推荐的 title_and_abstract.search 过滤；
 * 2. arXiv 补充是**条件触发**：结果近期活跃才补，陈旧主题一发都不发（省 3s 排队与 429 暴露面）；
 * 3. OpenAlex 空结果时用 S2 search/vector 语义检索兜底；
 * 4. 缓存生效：同一查询第二次不再发 HTTP；
 * 5. 按 id 解析的失败信息**如实列出数据源**，不再谎称"限流相关"（历史误导）；
 * 6. arXiv id 解析以 **arXiv 官方 API 为主源**（OpenAlex 无 arxiv 过滤器，DOI 映射
 *    覆盖不完整），单测注入 fake fetcher 不打真实网络。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resolvePaperById,
  searchPapers,
  shouldSupplementArxiv,
  setS2KeyProvider,
  __resetS2KeyProvider,
  setArxivOfficialFetcher,
  __resetCacheForTest,
  FRESHNESS_WINDOW_DAYS
} from '../../electron/agent/paperSearch'

/** 构造一个返回 JSON 的假 Response。 */
function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body
  } as unknown as Response
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
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

/** 近期发表的 OpenAlex work（新鲜度门槛命中用）。 */
const freshOpenAlexWork = { ...openAlexWork, publication_date: daysAgoIso(2), publication_year: new Date().getFullYear() }

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  // 默认无 key：走匿名保守节流路径（provider 不触网，仅影响间隔与冷却时长）
  setS2KeyProvider(() => '')
  // 默认注入「arXiv 官方 API 未命中」的 fake：单测聚焦 OpenAlex/S2 路径；
  // arXiv 主源行为在专门用例里单独注入。
  setArxivOfficialFetcher(async () => null)
  // 模块级缓存跨用例清空（cache 是模块单例，不清会串扰）
  __resetCacheForTest()
})

afterEach(() => {
  vi.unstubAllGlobals()
  __resetS2KeyProvider()
})

describe('paperSearch：统一文献检索访问层', () => {
  it('关键词检索走 OpenAlex（title_and_abstract.search 过滤），并归一成库形状', async () => {
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
    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url).toContain('api.openalex.org')
    // 官方推荐用法：filter=title_and_abstract.search:"..."（而非裸 search= 全文模式）
    expect(decodeURIComponent(url)).toContain('title_and_abstract.search:"residual learning"')
    expect(url).not.toContain('&search=')
  })

  it('无法解析 arxiv id 时（纯期刊论文）用 doi 作 id，URL 指向 DOI', async () => {
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

  it('arXiv 补充只在结果近期活跃时触发，并按 id 去重合并', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [freshOpenAlexWork] }))
    const supplement = vi.fn().mockResolvedValue([
      // 与 OpenAlex 同 id（版本号已归一）→ 应被去重
      { id: '1512.03385', title: 'Deep Residual Learning', authors: ['Kaiming He'], summary: 'dup', published: '2015-12-10', url: 'https://arxiv.org/abs/1512.03385' },
      // 新条目 → 应补进来
      { id: '1706.03762', title: 'Attention Is All You Need', authors: ['Ashish Vaswani'], summary: 'new', published: daysAgoIso(1), url: 'https://arxiv.org/abs/1706.03762' }
    ])

    const entries = await searchPapers('transformer fresh', 10, supplement)

    expect(entries.map((e) => e.id)).toEqual(['1512.03385', '1706.03762'])
    expect(supplement).toHaveBeenCalledTimes(1)
  })

  it('结果全是陈旧论文时**跳过** arXiv 补充（不发请求、不调用补充源）', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [openAlexWork] }))
    const supplement = vi.fn().mockResolvedValue([])

    const entries = await searchPapers('old topic query', 5, supplement)

    expect(entries).toHaveLength(1)
    expect(supplement).not.toHaveBeenCalled()
  })

  it('arXiv 补充源抛错（限流）不影响整体：主源结果照常返回', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [freshOpenAlexWork] }))
    const supplement = vi.fn().mockRejectedValue(new Error('429 Too Many Requests'))

    const entries = await searchPapers('residual fresh', 5, supplement)

    expect(entries).toHaveLength(1)
  })

  it('OpenAlex 空结果时用 S2 向量语义检索兜底', async () => {
    fetchMock.mockImplementation(async (url: unknown) => {
      if (String(url).includes('api.openalex.org')) return jsonResponse({ results: [] })
      if (String(url).includes('search/vector')) {
        return jsonResponse({
          data: [
            {
              title: 'Hydrography extraction from LiDAR DEM',
              abstract: 'We extract river networks.',
              year: 2024,
              externalIds: { ArXiv: '2401.00001', DOI: null },
              authors: [{ name: 'A. Author' }]
            }
          ]
        })
      }
      return jsonResponse({})
    })

    const entries = await searchPapers('hydrography extraction LiDAR vector fallback', 5)

    expect(entries).toHaveLength(1)
    expect(entries[0]?.id).toBe('2401.00001')
    expect(entries[0]?.source).toBe('semantic-scholar')
    const s2Call = fetchMock.mock.calls.find((c) => String(c[0]).includes('search/vector'))
    expect(s2Call).toBeDefined()
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

  it('按 id 解析（arXiv id）：arXiv 官方主源命中即返回，不再请求 OpenAlex/S2', async () => {
    const official = vi.fn().mockResolvedValue({
      id: '1512.03385',
      title: 'Deep Residual Learning for Image Recognition',
      authors: ['Kaiming He'],
      summary: 'residual',
      published: '2015-12-10',
      link: 'https://arxiv.org/abs/1512.03385',
      url: 'https://arxiv.org/abs/1512.03385',
      source: 'arxiv'
    })
    setArxivOfficialFetcher(official)

    const entry = await resolvePaperById('1512.03385v2')

    expect(entry.id).toBe('1512.03385')
    expect(entry.source).toBe('arxiv')
    expect(official).toHaveBeenCalledWith('1512.03385')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('按 id 解析（arXiv id）：arXiv 未收录时走 OpenAlex DOI 通道（10.48550/arxiv.{id}）', async () => {
    fetchMock.mockResolvedValue(jsonResponse(openAlexWork))

    const entry = await resolvePaperById('1512.03385v2')

    expect(entry.id).toBe('1512.03385')
    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url).toContain('api.openalex.org/works/doi:')
    expect(decodeURIComponent(url)).toContain('10.48550/arxiv.1512.03385')
  })

  it('按 id 解析（DOI）：走 OpenAlex singleton 端点', async () => {
    // 纯期刊论文：无 arXiv 落地页/DOI 前缀，id 落到 DOI 本身
    fetchMock.mockResolvedValue(
      jsonResponse({
        ...openAlexWork,
        doi: 'https://doi.org/10.1109/cvpr.2016.90',
        best_oa_location: null,
        primary_location: { source: { display_name: 'CVPR' } }
      })
    )

    const entry = await resolvePaperById('10.1109/cvpr.2016.90')

    expect(entry.id).toBe('10.1109/cvpr.2016.90')
    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url).toContain('api.openalex.org/works/doi:')
  })

  it('按 id 解析失败时报错如实列出数据源，不再谎称"限流相关"', async () => {
    // 404（未收录）：getJson 对 !ok 抛错
    fetchMock.mockResolvedValue({ ok: false, status: 404 } as unknown as Response)

    // 用 DOI 形式（不以 arxiv 裸 id 走 S2 by-id 分支）避免触发 S2 串行节流等待
    const failing = resolvePaperById('10.9999/not-exist')
    await expect(failing).rejects.toThrow(/arXiv \/ OpenAlex \/ Semantic Scholar/)
    await expect(resolvePaperById('10.9999/not-exist')).rejects.not.toThrow(/限流/)
  })
})

describe('shouldSupplementArxiv：新鲜度门槛', () => {
  it('最新发表日期在窗口内 → 需要补充', () => {
    expect(
      shouldSupplementArxiv([
        { id: 'a', title: 't', authors: [], summary: '', published: daysAgoIso(FRESHNESS_WINDOW_DAYS - 1), url: '' }
      ])
    ).toBe(true)
  })

  it('全部结果超出窗口 → 跳过补充', () => {
    expect(
      shouldSupplementArxiv([
        { id: 'a', title: 't', authors: [], summary: '', published: daysAgoIso(FRESHNESS_WINDOW_DAYS + 30), url: '' }
      ])
    ).toBe(false)
  })

  it('空结果或日期缺失/非法 → 跳过补充（不发无谓的 arXiv 请求）', () => {
    expect(shouldSupplementArxiv([])).toBe(false)
    expect(
      shouldSupplementArxiv([{ id: 'a', title: 't', authors: [], summary: '', published: '', url: '' }])
    ).toBe(false)
  })
})
