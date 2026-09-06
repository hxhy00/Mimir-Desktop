/**
 * CCF 会议截稿服务：抓取/缓存/定时刷新 + 空间级 watchlist。
 *
 * 遵循参考实现的关键降级设计：
 * - 读取永不联网：列表/倒计时/搜索一律读本地缓存（缺失/损坏→空态而非报错）；
 * - 抓取失败静默保留旧缓存（透出错误给「手动刷新」入口即可）；
 * - 首次启动延迟 ~2s 自动抓一次，之后每 6 小时刷新；定时器 unref 不阻塞退出；
 * - watchlist 为「当前科研空间」级的 seriesKey 集合，存空间 store。
 */
import { mkdir, readFile, writeFile, rename } from 'fs/promises'
import { join, dirname } from 'path'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { getStoreValue, setStoreValue, spaceRoot } from '../library/store'
import {
  CCF_A_JOURNALS,
  currentConfOf,
  daysUntil,
  parseAllconfYaml,
  queryVenues,
  type CcfRank,
  type VenueQuery,
  type VenueSeries,
  type VenueJournal,
} from './deadlines'

export const CCFDDL_ALLCONF_URL = 'https://ccfddl.github.io/conference/allconf.yml'
export const VENUE_REFRESH_INTERVAL_MS = 6 * 3_600_000
export const VENUE_FETCH_TIMEOUT_MS = 30_000

const WATCH_KEY = 'venues:watch'

interface VenueCacheFile {
  readonly fetchedAt: string
  readonly venues: readonly VenueSeries[]
}

function cacheFilePath(): string {
  return join(spaceRoot(), '.mimir', 'venue-deadlines.cache.json')
}

/** 一张会议的对外视图（ISO 时间）。 */
export interface VenueDeadlineView {
  readonly key: string
  readonly title: string
  readonly description: string
  readonly sub: string
  readonly ccfRank: CcfRank
  readonly dblp: string | null
  readonly conf: {
    readonly year: number
    readonly id: string
    readonly link: string
    readonly date: string
    readonly place: string
  }
  readonly nextDeadlineAt: string | null
  readonly nextDeadlineKind: 'abstract' | 'paper' | null
}

/** 会议/期刊列表的对外负载。 */
export interface VenueListPayload {
  readonly venues: readonly VenueDeadlineView[]
  readonly journals: readonly VenueJournal[]
  readonly watched: readonly string[]
  readonly fetchedAt: string | null
}

function readWatched(): string[] {
  const raw = getStoreValue<string[]>(WATCH_KEY)
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []
}

function writeWatched(list: string[]): void {
  setStoreValue(WATCH_KEY, [...new Set(list)])
}

async function readCache(): Promise<VenueCacheFile | null> {
  try {
    const path = cacheFilePath()
    if (!existsSync(path)) return null
    const parsed: unknown = JSON.parse(await readFile(path, 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as { fetchedAt?: unknown; venues?: unknown }
    if (typeof record.fetchedAt !== 'string' || !Array.isArray(record.venues)) return null
    return { fetchedAt: record.fetchedAt, venues: record.venues as readonly VenueSeries[] }
  } catch {
    return null
  }
}

async function writeCacheAtomic(venues: readonly VenueSeries[], fetchedAt: string): Promise<void> {
  const path = cacheFilePath()
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  const tempPath = join(dir, `${randomUUID()}.tmp`)
  await writeFile(tempPath, JSON.stringify({ fetchedAt, venues }), 'utf-8')
  await rename(tempPath, path)
}

/** 立即抓取 ccfddl 聚合数据并写缓存。失败抛错（旧缓存保留）。 */
export async function refreshVenueDeadlines(): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), VENUE_FETCH_TIMEOUT_MS)
  let text: string
  try {
    const response = await fetch(CCFDDL_ALLCONF_URL, { signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    text = await response.text()
  } finally {
    clearTimeout(timer)
  }
  const parsed = parseAllconfYaml(text)
  if (parsed.length === 0) throw new Error('解析 ccfddl 目录为空，可能是数据源变更')
  const fetchedAt = new Date().toISOString()
  await writeCacheAtomic(parsed, fetchedAt)
  return fetchedAt
}

/** 列表：读本地缓存（离线可用）+ 空间 watchlist。永不联网。 */
export async function listVenueDeadlines(): Promise<VenueListPayload> {
  const cache = await readCache()
  const nowMs = Date.now()
  const watched = readWatched()
  const watchedSet = new Set(watched)

  const rows: VenueDeadlineView[] = []
  if (cache !== null) {
    for (const series of cache.venues) {
      const current = currentConfOf(series, nowMs)
      if (current === null) continue
      const { conf, next } = current
      rows.push({
        key: series.key,
        title: series.title,
        description: series.description,
        sub: series.sub,
        ccfRank: series.ccfRank,
        dblp: series.dblp,
        conf: { year: conf.year, id: conf.id, link: conf.link, date: conf.date, place: conf.place },
        nextDeadlineAt: next === null ? null : new Date(next.atMs).toISOString(),
        nextDeadlineKind: next === null ? null : next.kind,
      })
    }
    rows.sort((a, b) => {
      const aWatched = watchedSet.has(a.key)
      const bWatched = watchedSet.has(b.key)
      if (aWatched !== bWatched) return aWatched ? -1 : 1
      const aAt = a.nextDeadlineAt === null ? Number.POSITIVE_INFINITY : new Date(a.nextDeadlineAt).getTime()
      const bAt = b.nextDeadlineAt === null ? Number.POSITIVE_INFINITY : new Date(b.nextDeadlineAt).getTime()
      if (aAt !== bAt) return aAt - bAt
      return a.title.localeCompare(b.title)
    })
  }

  return {
    venues: rows,
    journals: CCF_A_JOURNALS,
    watched,
    fetchedAt: cache?.fetchedAt ?? null,
  }
}

/** 设置/取消关注某个会议系列（当前科研空间级）。 */
export function setVenueWatch(seriesKey: string, watched: boolean): void {
  if (seriesKey === '') throw new Error('series key 不能为空')
  const list = readWatched()
  if (watched) {
    if (!list.includes(seriesKey)) writeWatched([...list, seriesKey])
  } else {
    writeWatched(list.filter((key) => key !== seriesKey))
  }
}

/** venue_search 工具用：只查本地缓存并返回文本摘要。 */
export async function searchVenueCache(query: VenueQuery, nowMs: number): Promise<string> {
  const cache = await readCache()
  if (cache === null) {
    return '会议截稿目录尚未就绪：首次启动后约 2 秒会自动抓取；离线环境保留最近一次缓存。请稍后再试。'
  }
  const matches = queryVenues(cache.venues, query, nowMs)
  const limited = matches.slice(0, 30)
  if (limited.length === 0) {
    return `没有匹配的会议截稿（缓存更新于 ${cache.fetchedAt.slice(0, 16).replace('T', ' ')}）。`
  }
  const lines = limited.map(({ series, conf, next }) => {
    const countdown = next === null ? '无近期截稿'
      : `还剩 ${String(daysUntil(next.atMs, nowMs))} 天（${next.kind === 'paper' ? '全文' : '摘要'}截稿 ${new Date(next.atMs).toLocaleString('zh-CN')}）`
    return `- ${series.title} (${series.ccfRank === 'N' ? '未上榜' : `CCF-${series.ccfRank}`}) ${conf.year}: ${countdown}. 时间 ${conf.date} @ ${conf.place}. ${conf.link}`
  })
  return [
    `共 ${String(matches.length)} 个匹配（展示前 ${String(limited.length)}，目录更新于 ${cache.fetchedAt.slice(0, 16).replace('T', ' ')}）：`,
    '',
    lines.join('\n'),
  ].join('\n')
}

/** 每天首屏后台刷新与 6h 周期刷新（只执行一次）。 */
let loopStarted = false
export function startVenueDeadlineLoop(): void {
  if (loopStarted) return
  loopStarted = true
  // 首刷延迟 2s
  const first = setTimeout(() => {
    refreshVenueDeadlines().catch(() => {})
  }, 2_000)
  first.unref?.()
  // 之后每 6h
  const timer = setInterval(() => {
    refreshVenueDeadlines().catch(() => {})
  }, VENUE_REFRESH_INTERVAL_MS)
  timer.unref?.()
}
