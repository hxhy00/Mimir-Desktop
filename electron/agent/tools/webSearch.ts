import { tool } from 'langchain/tools'
import { z } from 'zod'

/**
 * Web search tool using DuckDuckGo (no API key required)
 */
export const webSearchTool = tool(
  async ({ query, maxResults = 5 }) => {
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        }
      })
      const html = await response.text()

      // Parse search results
      const results = parseDuckDuckGoResults(html, maxResults)

      if (results.length === 0) {
        return '未找到相关搜索结果。'
      }

      return results
        .map((result, i) => {
          return `### ${i + 1}. ${result.title}\n` +
            `- 链接: ${result.url}\n` +
            `- 摘要: ${result.snippet}`
        })
        .join('\n\n')
    } catch (error) {
      return `搜索失败: ${error instanceof Error ? error.message : '未知错误'}`
    }
  },
  {
    name: 'web_search',
    // 描述必须承载「什么时候该用它」——模型选工具时读的是这里，而不是 systemPrompt 里的规则条文。
    // 实测教训：只在 systemPrompt 里写「禁止用网页检索替代结构化工具」，模型会概括成「一律别用
    // web_search」，把「在网上找 2025 年 VLA 综述」这种明确要网页链接的请求也一并回避（见
    // test/eval/README.md 配对分析②的 lit-05）。因此这里把正向触发条件写在工具自己的描述上。
    description:
      '搜索网页获取最新信息（只读，不入库）。返回相关网页的标题、链接和摘要。' +
      '当用户说「在网上找 / 帮我搜一下 / 要链接 / 网页资料」时用它——**即便话题是学术主题**' +
      '（例：「在网上找 2025 年 VLA 综述文章，只要链接和摘要」→ 用本工具，用户要的是网页链接）。' +
      '查产品动态、博客、新闻、官方公告等非学术来源同样用它。',
    schema: z.object({
      query: z.string().describe('搜索关键词'),
      maxResults: z.number().optional().default(5).describe('返回结果数量，默认 5')
    })
  }
)

interface SearchResult {
  title: string
  url: string
  snippet: string
}

function parseDuckDuckGoResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = []
  const resultRegex = /<div class="result[^"]*">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g
  let match: RegExpExecArray | null

  while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
    const block = match[1]

    const titleMatch = block.match(/<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/)
    const urlMatch = block.match(/href="([^"]*)"/)
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/)

    if (titleMatch && urlMatch) {
      const title = titleMatch[1].replace(/<[^>]+>/g, '').trim()
      const url = urlMatch[1]
      const snippet = snippetMatch
        ? snippetMatch[1].replace(/<[^>]+>/g, '').trim()
        : ''

      results.push({ title, url, snippet })
    }
  }

  return results
}
