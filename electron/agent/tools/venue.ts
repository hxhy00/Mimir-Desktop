import { tool } from 'langchain/tools'
import { z } from 'zod'
import { searchVenueCache } from '../../venues/venuesService'
import type { CcfRank } from '../../venues/deadlines'

/**
 * venue_search：回答「XXX 何时截稿」「近期有哪些 CCF-A/B 会议截稿」。
 * 只查本地缓存，绝不联网（离线可用，靠最后一次自动刷新快照）。
 */
export const venueSearchTool = tool(
  async ({ query, rank, sub, withinDays }) => {
    const result = await searchVenueCache(
      {
        query,
        rank: rank === undefined ? undefined : (rank as CcfRank),
        sub,
        withinDays,
      },
      Date.now(),
    )
    return result
  },
  {
    name: 'venue_search',
    description:
      '查询 CCF 会议/期刊的截稿时间与倒计时（基于本地缓存目录，无需联网）。可回答类似「CVPR 何时截稿」「90 天内截稿的 CCF-A 会议有哪些」。参数可选；sub 领域码可读名对照：AI=人工智能/CV/ML/NLP，DS=体系结构/系统，SE=软件工程/PL，DB=数据库/挖掘，NW=网络，SC=安全，CG=图形/多媒体，HI=人机交互，CT=理论，MX=交叉。',
    schema: z.object({
      query: z.string().optional().describe('名称/描述/DBLP 关键词（大小写不敏感子串）'),
      rank: z.enum(['A', 'B', 'C']).optional().describe('仅看某一 CCF 等级'),
      sub: z.string().optional().describe('仅看某一领域码（如 AI / SE / DB）'),
      withinDays: z.number().int().positive().optional().describe('只看 N 天内截稿的会议'),
    }),
  },
)
