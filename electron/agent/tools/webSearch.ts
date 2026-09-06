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
    description: '搜索网页获取最新信息。输入关键词，返回相关网页的标题、链接和摘要。',
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
