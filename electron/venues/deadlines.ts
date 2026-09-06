/**
 * CCF 会议截稿域纯逻辑（移植自 Mimir 的 `venue-deadlines.ts`）。
 *
 * 负责解析 ccfddl 聚合 YAML、`YYYY-MM-DD HH:mm:ss` + `UTC±H/AoE/PT` 时区换算、
 * 一届会议最近截稿、按名称/等级/领域/时间窗的查询折叠，以及内置的 CCF-A 期刊
 * 静态目录（ccfddl 只追踪会议）。无 DOM、可离线复用；抓取/缓存壳见
 * `./venuesService.ts`。
 */
import { load as parseYaml } from 'js-yaml'

/** CCF 等级字母，`N` = 未上榜。 */
export type CcfRank = 'A' | 'B' | 'C' | 'N'

/** 一届的一轮投稿。 */
export interface VenueTimelineEntry {
  readonly abstractDeadline: string | null
  readonly deadline: string | null
  readonly comment: string | null
}

/** 一届（某年）会议。 */
export interface VenueConf {
  readonly year: number
  /** ccfddl edition id，如 `cvpr26`。 */
  readonly id: string
  readonly link: string
  readonly timeline: readonly VenueTimelineEntry[]
  /** ccfddl 时区串，如 `UTC-12` / `AoE`。 */
  readonly timezone: string
  readonly date: string
  readonly place: string
}

/** 一个会议系列（全部届）。 */
export interface VenueSeries {
  /** 稳定 key：小写标题（`cvpr`）。 */
  readonly key: string
  readonly title: string
  readonly description: string
  readonly sub: string
  readonly ccfRank: CcfRank
  readonly dblp: string | null
  readonly confs: readonly VenueConf[]
}

/** 一届会议的下一个截稿。 */
export interface VenueNextDeadline {
  readonly kind: 'abstract' | 'paper'
  /** 纪元毫秒。 */
  readonly atMs: number
}

/**
 * 解析 ccfddl 时间：墙钟 + 时区。AoE=UTC-12、PT≈UTC-8、UTC±H(:MM) 计算偏移；
 * 先把墙钟当作 UTC 求 `Date.UTC` 再减偏移得到真实 UTC 时刻。解析失败返回 null。
 */
export function parseCcfddlInstant(value: string, timezone: string): number | null {
  const wall = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(value.trim())
  if (wall === null) return null
  const zoneRaw = timezone.trim()
  let offsetMs: number
  if (/^aoe$/i.test(zoneRaw)) offsetMs = -12 * 3_600_000
  else if (/^pt$/i.test(zoneRaw)) offsetMs = -8 * 3_600_000
  else if (/^utc$/i.test(zoneRaw)) offsetMs = 0
  else {
    const zone = /^UTC([+-])(\d{1,2})(?::(\d{2}))?$/i.exec(zoneRaw)
    if (zone === null) return null
    offsetMs = (Number(zone[2]) * 3_600_000 + Number(zone[3] ?? '0') * 60_000) * (zone[1] === '-' ? -1 : 1)
  }
  const utcMs = Date.UTC(
    Number(wall[1]), Number(wall[2]) - 1, Number(wall[3]),
    Number(wall[4]), Number(wall[5]), Number(wall[6] ?? '0'),
  )
  return utcMs - offsetMs
}

/** 从 nowMs 到 atMs 的整天数（向上取整；今天截稿为 0）。 */
export function daysUntil(atMs: number, nowMs: number): number {
  return Math.ceil((atMs - nowMs) / 86_400_000)
}

function timelineEntryOf(raw: unknown): VenueTimelineEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const entry = raw as Record<string, unknown>
  const deadline = typeof entry['deadline'] === 'string' ? entry['deadline'] : null
  const abstract = typeof entry['abstract_deadline'] === 'string' ? entry['abstract_deadline'] : null
  if (deadline === null && abstract === null) return null
  return {
    abstractDeadline: abstract,
    deadline,
    comment: typeof entry['comment'] === 'string' ? entry['comment'] : null,
  }
}

function confOf(raw: unknown): VenueConf | null {
  if (typeof raw !== 'object' || raw === null) return null
  const conf = raw as Record<string, unknown>
  if (typeof conf['id'] !== 'string' || typeof conf['year'] !== 'number') return null
  const timeline = Array.isArray(conf['timeline'])
    ? conf['timeline'].map(timelineEntryOf).filter((entry): entry is VenueTimelineEntry => entry !== null)
    : []
  return {
    year: conf['year'],
    id: conf['id'],
    link: typeof conf['link'] === 'string' ? conf['link'] : '',
    timeline: Object.freeze(timeline),
    timezone: typeof conf['timezone'] === 'string' ? conf['timezone'] : 'UTC-12',
    date: typeof conf['date'] === 'string' ? conf['date'] : '',
    place: typeof conf['place'] === 'string' ? conf['place'] : '',
  }
}

/** 解析 ccfddl 聚合 YAML；坏系列/坏届跳过，绝不因单个坏条目清空整库。 */
export function parseAllconfYaml(text: string): VenueSeries[] {
  let doc: unknown
  try {
    doc = parseYaml(text)
  } catch {
    return []
  }
  if (!Array.isArray(doc)) return []
  const out: VenueSeries[] = []
  for (const raw of doc) {
    if (typeof raw !== 'object' || raw === null) continue
    const series = raw as Record<string, unknown>
    if (typeof series['title'] !== 'string') continue
    const rankRaw = typeof series['rank'] === 'object' && series['rank'] !== null
      ? (series['rank'] as Record<string, unknown>)['ccf']
      : undefined
    const rank = typeof rankRaw === 'string' ? rankRaw.toUpperCase() : 'N'
    const confs = Array.isArray(series['confs'])
      ? series['confs'].map(confOf).filter((conf): conf is VenueConf => conf !== null)
      : []
    if (confs.length === 0) continue
    out.push({
      key: series['title'].toLowerCase(),
      title: series['title'],
      description: typeof series['description'] === 'string' ? series['description'] : '',
      sub: typeof series['sub'] === 'string' ? series['sub'] : '',
      ccfRank: rank === 'A' || rank === 'B' || rank === 'C' ? rank : 'N',
      dblp: typeof series['dblp'] === 'string' ? series['dblp'] : null,
      confs: Object.freeze(confs),
    })
  }
  return out
}

/** 一届会议最近的未来截稿；全过期返回 null。 */
export function nextDeadlineOf(conf: VenueConf, nowMs: number): VenueNextDeadline | null {
  let best: VenueNextDeadline | null = null
  for (const round of conf.timeline) {
    const candidates: VenueNextDeadline[] = []
    if (round.abstractDeadline !== null) {
      const atMs = parseCcfddlInstant(round.abstractDeadline, conf.timezone)
      if (atMs !== null) candidates.push({ kind: 'abstract', atMs })
    }
    if (round.deadline !== null) {
      const atMs = parseCcfddlInstant(round.deadline, conf.timezone)
      if (atMs !== null) candidates.push({ kind: 'paper', atMs })
    }
    for (const candidate of candidates) {
      if (candidate.atMs < nowMs) continue
      if (best === null || candidate.atMs < best.atMs) best = candidate
    }
  }
  return best
}

/** 面板应展示的一届：有待截稿的最近一届，否则最新一届（卡片仍可展示日期/链接）。 */
export function currentConfOf(
  series: VenueSeries,
  nowMs: number,
): { conf: VenueConf; next: VenueNextDeadline | null } | null {
  const ordered = [...series.confs].sort((a, b) => a.year - b.year)
  if (ordered.length === 0) return null
  let upcoming: { conf: VenueConf; next: VenueNextDeadline } | null = null
  for (const conf of ordered) {
    const next = nextDeadlineOf(conf, nowMs)
    if (next === null) continue
    if (upcoming === null || next.atMs < upcoming.next.atMs) upcoming = { conf, next }
  }
  if (upcoming !== null) return upcoming
  const latest = ordered[ordered.length - 1]
  return latest === undefined ? null : { conf: latest, next: null }
}

/** 一次 venue 查询：每个已设字段都会收窄结果。 */
export interface VenueQuery {
  readonly query?: string | undefined
  readonly rank?: CcfRank | undefined
  readonly sub?: string | undefined
  /** 只看未来 N 天内截稿的。 */
  readonly withinDays?: number | undefined
}

/** 一行查询结果。 */
export interface VenueCard {
  readonly series: VenueSeries
  readonly conf: VenueConf
  readonly next: VenueNextDeadline | null
}

/** 折叠目录到一次查询；无当前届的系列不匹配；按最近截稿升序（无截稿最后）。 */
export function queryVenues(catalog: readonly VenueSeries[], query: VenueQuery, nowMs: number): VenueCard[] {
  const needle = query.query?.trim().toLowerCase() ?? ''
  const sub = query.sub?.trim().toLowerCase() ?? ''
  const out: VenueCard[] = []
  for (const series of catalog) {
    if (query.rank !== undefined && series.ccfRank !== query.rank) continue
    if (sub !== '' && series.sub.toLowerCase() !== sub) continue
    if (
      needle !== ''
      && !series.title.toLowerCase().includes(needle)
      && !series.description.toLowerCase().includes(needle)
      && !(series.dblp ?? '').toLowerCase().includes(needle)
    ) continue
    const current = currentConfOf(series, nowMs)
    if (current === null) continue
    if (query.withinDays !== undefined) {
      if (current.next === null) continue
      if (daysUntil(current.next.atMs, nowMs) > query.withinDays) continue
    }
    out.push({ series, conf: current.conf, next: current.next })
  }
  return out.sort((a, b) => {
    if (a.next === null) return b.next === null ? a.series.title.localeCompare(b.series.title) : 1
    if (b.next === null) return -1
    return a.next.atMs - b.next.atMs
  })
}

/** 目录中出现的领域码集合（去重、排序），供筛选下拉。 */
export function venueSubsOf(catalog: readonly VenueSeries[]): readonly string[] {
  return Object.freeze([...new Set(catalog.map((series) => series.sub).filter((sub) => sub !== ''))].sort())
}

/** CCF-A 期刊静态目录条目（ccfddl 不追踪期刊）。 */
export interface VenueJournal {
  readonly title: string
  readonly fullName: string
  readonly sub: string
  readonly publisher: string
}

/** CCF-A 期刊静态目录（CCF 2022 目录，无截稿，供参考）。 */
export const CCF_A_JOURNALS: readonly VenueJournal[] = Object.freeze([
  { title: 'TOCS', fullName: 'ACM Transactions on Computer Systems', sub: '体系结构/并行与分布计算/存储系统', publisher: 'ACM' },
  { title: 'TOS', fullName: 'ACM Transactions on Storage', sub: '体系结构/并行与分布计算/存储系统', publisher: 'ACM' },
  { title: 'TCAD', fullName: 'IEEE Transactions on Computer-Aided Design of Integrated Circuits and System', sub: '体系结构/并行与分布计算/存储系统', publisher: 'IEEE' },
  { title: 'TC', fullName: 'IEEE Transactions on Computers', sub: '体系结构/并行与分布计算/存储系统', publisher: 'IEEE' },
  { title: 'TPDS', fullName: 'IEEE Transactions on Parallel and Distributed Systems', sub: '体系结构/并行与分布计算/存储系统', publisher: 'IEEE' },
  { title: 'TACO', fullName: 'ACM Transactions on Architecture and Code Optimization', sub: '体系结构/并行与分布计算/存储系统', publisher: 'ACM' },
  { title: 'JSAC', fullName: 'IEEE Journal on Selected Areas in Communications', sub: '计算机网络', publisher: 'IEEE' },
  { title: 'TMC', fullName: 'IEEE Transactions on Mobile Computing', sub: '计算机网络', publisher: 'IEEE' },
  { title: 'TON', fullName: 'IEEE/ACM Transactions on Networking', sub: '计算机网络', publisher: 'IEEE/ACM' },
  { title: 'TDSC', fullName: 'IEEE Transactions on Dependable and Secure Computing', sub: '网络与信息安全', publisher: 'IEEE' },
  { title: 'TIFS', fullName: 'IEEE Transactions on Information Forensics and Security', sub: '网络与信息安全', publisher: 'IEEE' },
  { title: 'JOC', fullName: 'Journal of Cryptology', sub: '网络与信息安全', publisher: 'Springer' },
  { title: 'TOPLAS', fullName: 'ACM Transactions on Programming Languages and Systems', sub: '软件工程/系统软件/程序设计语言', publisher: 'ACM' },
  { title: 'TOSEM', fullName: 'ACM Transactions on Software Engineering and Methodology', sub: '软件工程/系统软件/程序设计语言', publisher: 'ACM' },
  { title: 'TSE', fullName: 'IEEE Transactions on Software Engineering', sub: '软件工程/系统软件/程序设计语言', publisher: 'IEEE' },
  { title: 'TODS', fullName: 'ACM Transactions on Database Systems', sub: '数据库/数据挖掘/内容检索', publisher: 'ACM' },
  { title: 'TOIS', fullName: 'ACM Transactions on Information Systems', sub: '数据库/数据挖掘/内容检索', publisher: 'ACM' },
  { title: 'TKDE', fullName: 'IEEE Transactions on Knowledge and Data Engineering', sub: '数据库/数据挖掘/内容检索', publisher: 'IEEE' },
  { title: 'VLDBJ', fullName: 'The VLDB Journal', sub: '数据库/数据挖掘/内容检索', publisher: 'Springer' },
  { title: 'TOG', fullName: 'ACM Transactions on Graphics', sub: '计算机图形学与多媒体', publisher: 'ACM' },
  { title: 'TIP', fullName: 'IEEE Transactions on Image Processing', sub: '计算机图形学与多媒体', publisher: 'IEEE' },
  { title: 'TVCG', fullName: 'IEEE Transactions on Visualization and Computer Graphics', sub: '计算机图形学与多媒体', publisher: 'IEEE' },
  { title: 'AI', fullName: 'Artificial Intelligence', sub: '人工智能', publisher: 'Elsevier' },
  { title: 'TPAMI', fullName: 'IEEE Transactions on Pattern Analysis and Machine Intelligence', sub: '人工智能', publisher: 'IEEE' },
  { title: 'IJCV', fullName: 'International Journal of Computer Vision', sub: '人工智能', publisher: 'Springer' },
  { title: 'JMLR', fullName: 'Journal of Machine Learning Research', sub: '人工智能', publisher: 'JMLR.org' },
  { title: 'TIT', fullName: 'IEEE Transactions on Information Theory', sub: '计算机科学理论', publisher: 'IEEE' },
  { title: 'TOCHI', fullName: 'ACM Transactions on Computer-Human Interaction', sub: '人机交互与普适计算', publisher: 'ACM' },
  { title: 'IJHCS', fullName: 'International Journal of Human-Computer Studies', sub: '人机交互与普适计算', publisher: 'Elsevier' },
])
