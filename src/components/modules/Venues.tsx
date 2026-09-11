import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { CalendarClock, RefreshCw, Loader2, Star, BookOpen, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { handoffToAgent } from '@/lib/agentContext'

type RankFilter = 'ALL' | 'A' | 'B' | 'C'
type Mode = 'conferences' | 'journals'

function daysUntilIso(iso: string | null, nowMs: number): number | null {
  if (iso === null) return null
  const at = new Date(iso).getTime()
  if (!Number.isFinite(at)) return null
  return Math.ceil((at - nowMs) / 86_400_000)
}

function deadlineText(iso: string | null, kind: 'abstract' | 'paper' | null, nowMs: number): string {
  const days = daysUntilIso(iso, nowMs)
  if (days === null) return '暂无近期截稿'
  const label = kind === 'paper' ? '全文截稿' : kind === 'abstract' ? '摘要截稿' : '截稿'
  if (days <= 0) return `${label} · 今天`
  return `${label} · 剩 ${String(days)} 天`
}

export function Venues() {
  const api = window.electronAPI
  const [mode, setMode] = useState<Mode>('conferences')
  const [venues, setVenues] = useState<VenueDeadlineView[]>([])
  const [journals, setJournals] = useState<VenueJournalView[]>([])
  const [watched, setWatched] = useState<Set<string>>(new Set())
  const [fetchedAt, setFetchedAt] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [rank, setRank] = useState<RankFilter>('ALL')
  const [sub, setSub] = useState('')
  const [withinDays, setWithinDays] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!api?.venues) return
    setLoading(true)
    try {
      const res = await api.venues.list()
      if (res.ok) {
        setVenues(res.venues ?? [])
        setJournals(res.journals ?? [])
        setWatched(new Set(res.watched ?? []))
        setFetchedAt(res.fetchedAt ?? null)
        setErrorMsg(null)
      } else {
        setErrorMsg(res.message ?? '读取目录失败')
      }
    } catch {
      setErrorMsg('读取目录失败')
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  const refresh = useCallback(async () => {
    if (!api?.venues) return
    setRefreshing(true)
    setErrorMsg(null)
    try {
      const res = await api.venues.refresh()
      if (res.ok) await load()
      else setErrorMsg(res.message ?? '刷新失败（已保留旧缓存）')
    } catch {
      setErrorMsg('刷新失败')
    } finally {
      setRefreshing(false)
    }
  }, [api, load])

  const toggleWatch = useCallback(
    async (key: string) => {
      const nowWatched = watched.has(key)
      const next = new Set(watched)
      if (nowWatched) next.delete(key)
      else next.add(key)
      setWatched(next)
      if (!api?.venues) return
      const res = await api.venues.setWatch(key, !nowWatched)
      if (!res.ok) {
        // 失败回滚
        setWatched(new Set(watched))
      }
    },
    [api, watched]
  )

  /** 把会议截稿信息交给 Agent：用于规划投稿时间线 / 拆解里程碑。 */
  const handleHandoffToAgent = useCallback((venue: VenueDeadlineView) => {
    const days = daysUntilIso(venue.nextDeadlineAt, Date.now())
    const excerpt = [
      `会议：${venue.title}`,
      venue.description !== '' ? `简介：${venue.description}` : '',
      `CCF 等级：${venue.ccfRank}`,
      days !== null
        ? `距最近截稿：${String(days)} 天（${venue.nextDeadlineKind === 'abstract' ? '摘要' : '全文'}）`
        : '近期无截稿',
      venue.conf.date !== '' ? `会议时间：${venue.conf.date}` : '',
      venue.conf.place !== '' ? `地点：${venue.conf.place}` : '',
      venue.conf.link !== '' ? `官网：${venue.conf.link}` : ''
    ]
      .filter((line) => line !== '')
      .join('\n')
    handoffToAgent({
      kind: 'venue',
      refId: venue.key,
      title: venue.title,
      excerpt,
      meta: { ccfRank: venue.ccfRank, nextDeadlineAt: venue.nextDeadlineAt }
    })
  }, [])

  const subOptions = useMemo(() => {
    if (mode === 'conferences') {
      return [...new Set(venues.map((v) => v.sub).filter((s) => s !== ''))].sort()
    }
    return [...new Set(journals.map((j) => j.sub).filter((s) => s !== ''))].sort()
  }, [mode, venues, journals])

  const visibleVenues = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const nowMs = Date.now()
    const list = venues.filter((v) => {
      if (needle !== ''
        && !v.title.toLowerCase().includes(needle)
        && !v.description.toLowerCase().includes(needle)
        && !(v.dblp ?? '').toLowerCase().includes(needle)) return false
      if (rank !== 'ALL' && v.ccfRank !== rank) return false
      if (sub !== '' && v.sub !== sub) return false
      if (withinDays !== null) {
        const days = daysUntilIso(v.nextDeadlineAt, nowMs)
        if (days === null || days > withinDays) return false
      }
      return true
    })
    return list.sort((a, b) => {
      const aw = watched.has(a.key)
      const bw = watched.has(b.key)
      if (aw !== bw) return aw ? -1 : 1
      const da = daysUntilIso(a.nextDeadlineAt, nowMs)
      const db = daysUntilIso(b.nextDeadlineAt, nowMs)
      if (da !== null && db !== null) return da - db
      if (da !== null) return -1
      if (db !== null) return 1
      return a.title.localeCompare(b.title)
    })
  }, [venues, query, rank, sub, withinDays, watched])

  const visibleJournals = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return journals
      .filter((j) => {
        if (needle !== ''
          && !j.title.toLowerCase().includes(needle)
          && !j.fullName.toLowerCase().includes(needle)) return false
        if (sub !== '' && j.sub !== sub) return false
        return true
      })
      .sort((a, b) => a.sub.localeCompare(b.sub) || a.title.localeCompare(b.title))
  }, [journals, query, sub])

  const fetchedLabel = fetchedAt === null
    ? '尚未抓取'
    : `更新于 ${fetchedAt.slice(0, 16).replace('T', ' ')}`

  return (
    <div className="flex h-full flex-col">
      <div className="module-header">
        <div className="flex items-center gap-3">
          <span className="module-title">会议截稿</span>
          <span className="text-[11px] text-muted-foreground">
            {mode === 'conferences' ? `${venues.length} 个系列 · ${fetchedLabel}` : `${journals.length} 本 CCF-A 期刊`}
          </span>
        </div>
        <div className="flex items-center gap-1.5 no-drag">
          <Button size="sm" variant="outline" className="h-7" onClick={refresh} disabled={refreshing}>
            {refreshing ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />}
            刷新
          </Button>
        </div>
      </div>

      <div className="px-5 py-3 space-y-2.5 flex flex-col min-h-0 flex-1 overflow-y-auto">
        {fetchedAt === null && (
          <div className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-[11px] text-primary">
            <CalendarClock className="h-3.5 w-3.5 shrink-0" />
            本地目录尚未抓取：启动后约 2 秒会自动从 ccfddl 拉取，也可点右上角「刷新」立即获取（离线环境展示最近一次快照）。
          </div>
        )}

        {errorMsg !== null && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
            {errorMsg}
          </div>
        )}

        {/* 模式切换 */}
        <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-0.5 w-fit">
          <button
            onClick={() => setMode('conferences')}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1 text-[11px] transition-colors',
              mode === 'conferences' ? 'bg-background text-foreground shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <CalendarClock className="h-3 w-3" />
            会议截稿
          </button>
          <button
            onClick={() => setMode('journals')}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1 text-[11px] transition-colors',
              mode === 'journals' ? 'bg-background text-foreground shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <BookOpen className="h-3 w-3" />
            CCF-A 期刊
          </button>
        </div>

        {/* 过滤条 */}
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={mode === 'conferences' ? '搜索会议名称 / DBLP…' : '搜索期刊…'}
            className="h-7 w-56 text-[11px]"
          />
          {subOptions.length > 0 && (
            <Select value={sub} onValueChange={setSub}>
              <SelectTrigger className="h-7 w-52 text-[11px]">
                <SelectValue placeholder="全部领域" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="" className="text-[11px]">全部领域</SelectItem>
                {subOptions.map((item) => (
                  <SelectItem key={item} value={item} className="text-[11px]">{item}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {mode === 'conferences' && (
            <>
              <div className="flex items-center gap-1">
                {(['ALL', 'A', 'B', 'C'] as const).map((value) => (
                  <button
                    key={value}
                    onClick={() => setRank(value)}
                    className={cn(
                      'rounded-md px-2 py-1 text-[10px] font-medium transition-colors',
                      rank === value ? 'bg-primary/10 text-primary' : 'bg-muted/60 text-muted-foreground hover:bg-accent'
                    )}
                  >
                    {value === 'ALL' ? '全部' : `CCF-${value}`}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1 ml-auto">
                {([null, 30, 90] as const).map((days) => (
                  <button
                    key={String(days)}
                    onClick={() => setWithinDays(days)}
                    className={cn(
                      'rounded-md px-2 py-1 text-[10px] font-medium transition-colors',
                      withinDays === days ? 'bg-primary/10 text-primary' : 'bg-muted/60 text-muted-foreground hover:bg-accent'
                    )}
                  >
                    {days === null ? '全部时间' : `${String(days)} 天内`}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            加载中…
          </div>
        ) : mode === 'conferences' ? (
          visibleVenues.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
              <CalendarClock className="h-8 w-8 opacity-30 mb-2" />
              <p className="text-[12px] font-medium">没有匹配的会议</p>
              <p className="text-[11px] mt-0.5 opacity-70">调整搜索或过滤条件重试</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
              {visibleVenues.map((venue) => {
                const days = daysUntilIso(venue.nextDeadlineAt, Date.now())
                const soon = days !== null && days < 30
                const isWatched = watched.has(venue.key)
                return (
                  <div
                    key={venue.key}
                    className={cn(
                      'rounded-lg border bg-card p-3 hover:shadow-sm transition-all',
                      soon ? 'border-primary/40' : 'border-border'
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-medium text-[13px]">{venue.title}</span>
                          <span className="text-[10px] text-muted-foreground">{venue.conf.year}</span>
                          {venue.ccfRank !== 'N' && (
                            <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[9px] font-bold text-blue-500">
                              CCF-{venue.ccfRank}
                            </span>
                          )}
                          {venue.sub !== '' && (
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">{venue.sub}</span>
                          )}
                        </div>
                        {venue.description !== '' && (
                          <p className="mt-1 text-[10px] text-muted-foreground line-clamp-2">{venue.description}</p>
                        )}
                      </div>
                      <button
                        onClick={() => toggleWatch(venue.key)}
                        className={cn(
                          'flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors',
                          isWatched ? 'text-amber-500 hover:bg-amber-500/10' : 'text-muted-foreground hover:bg-muted'
                        )}
                        title={isWatched ? '取消关注' : '关注'}
                      >
                        <Star className={cn('h-3.5 w-3.5', isWatched && 'fill-amber-500')} />
                      </button>
                      <button
                        onClick={() => handleHandoffToAgent(venue)}
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-primary hover:bg-primary/10"
                        title="交给 Agent（规划该会议的投稿时间线）"
                      >
                        <Sparkles className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    <div className="mt-2">
                      <p
                        className={cn(
                          'text-[12px] font-semibold tabular-nums',
                          soon ? 'text-primary' : 'text-foreground'
                        )}
                      >
                        {deadlineText(venue.nextDeadlineAt, venue.nextDeadlineKind, Date.now())}
                      </p>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        {venue.conf.date !== '' && <span>{venue.conf.date}</span>}
                        {venue.conf.place !== '' && <span>{venue.conf.date !== '' ? ' · ' : ''}{venue.conf.place}</span>}
                      </p>
                      {venue.conf.link !== '' && (
                        <a
                          href={venue.conf.link}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 inline-block text-[10px] text-primary hover:underline"
                        >
                          {venue.conf.link.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                        </a>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )
        ) : visibleJournals.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <BookOpen className="h-8 w-8 opacity-30 mb-2" />
            <p className="text-[12px] font-medium">没有匹配的期刊</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
            {visibleJournals.map((journal) => (
              <div key={journal.title} className="rounded-lg border border-border bg-card p-3 hover:shadow-sm transition-shadow">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="font-semibold text-[13px]">{journal.title}</span>
                  <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[9px] font-bold text-blue-500">CCF-A</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">{journal.publisher}</span>
                </div>
                <p className="mt-1 text-[10px] text-muted-foreground">{journal.fullName}</p>
                {journal.sub !== '' && <p className="mt-1 text-[9px] text-muted-foreground/70">{journal.sub}</p>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
