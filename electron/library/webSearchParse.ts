/**
 * DuckDuckGo HTML 版搜索结果解析（**全项目唯一一份实现**）。
 *
 * ── 为什么要有这个文件 ──────────────────────────────────────────────────
 * 原先 `libraryService.searchWeb` 和 `agent/tools/webSearch.ts` **各写了一份**
 * 完全相同的正则解析（连 bug 都逐字一致）。两份并行实现意味着改一处必须记得改另一处，
 * 口径必然漂移。此处合并为唯一实现，两处调用方都引用它。
 *
 * ── 为什么用 cheerio 而不是正则（旧实现的三个真实缺陷）────────────────
 * 旧正则为 `<div class="result[^"]*">([\s\S]*?)</div>\s*</div>\s*</div>`，
 * 在结构真实的页面（`test/fixtures/ddg-results.html`）上实测出三个问题：
 *
 * 1. **数量截断**：它把 `</div></div></div>` 这种"连续三个闭合标签"当作条目分隔符。
 *    真实的 DDG 结果块里 `result__extras` 内层也是 div，导致**嵌套层级不等长时提前截断**，
 *    实测只解析出 2 条（页面有 3 条）。
 * 2. **只取第一个 href**：`block.match(/href="([^"]*)"/)` 取的是块内**任意**第一个链接，
 *    而不是标题链接本身。一旦 DDG 在标题前插入其他 `<a>`（如站点图标），URL 就取错。
 * 3. **实体不解码**：`&amp;` 原样留下（实测 URL 里出现 `&amp;rut=`）。
 *
 * cheerio 按 DOM 结构选择器取值，三个问题一并消除，且页面结构变化时能明确失败。
 *
 * ── 未联网验证的说明（重要）─────────────────────────────────────────────
 * 开发时**当前网络环境无法直连 duckduckgo.com**（已实测：`html.duckduckgo.com`
 * 连接超时，同环境 `arxiv.org` 正常）。因此：
 * - 选择器基于 DDG HTML 版长期稳定的类名（`result` / `result__a` / `result__snippet`）；
 * - 测试 fixture 为**按真实结构手工构造**的 HTML，非线上抓取；
 * - **待联网环境验证**：建议用真实返回页替换 `test/fixtures/ddg-results.html` 并跑测试，
 *   确认选择器仍然命中（这是本模块唯一的遗留风险）。
 */
import { load } from 'cheerio'

/** 一条网页搜索结果（与 `library/types.ts` 的 `WebSearchEntry` 字段对齐） */
export interface WebSearchResult {
  title: string
  url: string
  content: string
  engine: string
  category: string
  publishedDate: string
}

/**
 * 解析 DuckDuckGo HTML 版结果页。
 *
 * @param html 页面 HTML
 * @param maxResults 最多返回条数
 * @returns 结构化结果；**未识别到任何结果时返回空数组**（调用方据此判失败，见下）
 *
 * 注意：本函数不抛异常。**返回空数组的含义是"页面结构可能已变或真的无结果"**，
 * 调用方必须把它当**可疑信号**处理（提示用户），而不是当作"搜索成功但没找到"静默返回 ——
 * 这是旧实现最危险的失败模式（页面改版后永远返回空，看起来像"没有结果"）。
 */
export function parseDuckDuckGoResults(html: string, maxResults: number): WebSearchResult[] {
  const $ = load(html)
  const results: WebSearchResult[] = []

  // `.result` 同时命中广告位（`result--ad`），需排除，否则广告会混进结果
  $('.result').each((_index, element) => {
    if (results.length >= maxResults) return false
    const $result = $(element)
    if ($result.hasClass('result--ad') || $result.hasClass('result--ad--small')) return

    const $link = $result.find('a.result__a').first()
    if ($link.length === 0) return

    const title = $link.text().trim()
    const url = resolveDuckDuckGoUrl($link.attr('href') ?? '')
    if (title === '' || url === '') return

    const content = $result.find('.result__snippet').first().text().trim()
    results.push({
      title,
      url,
      content,
      engine: 'duckduckgo',
      category: 'general',
      publishedDate: '',
    })
  })

  return results
}

/**
 * 还原 DDG 的跳转链接为真实 URL。
 *
 * DDG HTML 版把结果链接包成 `//duckduckgo.com/l/?uddg=<encodeURIComponent(真实URL)>&rut=...`，
 * 必须解出 `uddg` 才是用户要的地址。直链（无 uddg）原样返回。
 *
 * 返回空字符串表示"这是个跳转链接但没有 uddg 参数"——**宁可丢弃也不要暴露
 * `duckduckgo.com/l/?...` 这种中间跳转地址**（旧实现就是这么漏出去的）。
 */
export function resolveDuckDuckGoUrl(href: string): string {
  if (href === '') return ''
  try {
    const parsed = new URL(href, 'https://duckduckgo.com')
    const target = parsed.searchParams.get('uddg')
    if (target !== null && target !== '') return target
    // 是 DDG 自身的跳转端点但拿不到目标 → 丢弃
    if (parsed.hostname.endsWith('duckduckgo.com') && parsed.pathname.startsWith('/l/')) return ''
    return parsed.toString()
  } catch {
    return ''
  }
}
