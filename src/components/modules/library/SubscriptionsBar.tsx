import { useState } from 'react'
import { Bell, BellPlus, BellRing, Loader2, Trash2, Check, X, RefreshCw, ExternalLink } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ArxivSubscriptionView, SubscriptionCheckOutcome } from './types'
import { formatDate } from './types'

interface SubscriptionsBarProps {
  subscriptions: ArxivSubscriptionView[]
  onSave: (query: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onCheck: (id?: string) => Promise<SubscriptionCheckOutcome[]>
  onOpenExternal: (url: string) => void
}

export function SubscriptionsBar({
  subscriptions,
  onSave,
  onDelete,
  onCheck,
  onOpenExternal
}: SubscriptionsBarProps) {
  const [expanded, setExpanded] = useState(false)
  const [adding, setAdding] = useState(false)
  const [newQuery, setNewQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [checkingId, setCheckingId] = useState<string | null>(null)
  const [outcomes, setOutcomes] = useState<SubscriptionCheckOutcome[]>([])

  const totalNew = subscriptions.reduce((sum, s) => sum + s.newEntries.length, 0)

  const submitAdd = async () => {
    if (!newQuery.trim() || busy) return
    setBusy(true)
    try {
      await onSave(newQuery.trim())
      setNewQuery('')
      setAdding(false)
    } finally {
      setBusy(false)
    }
  }

  const runCheck = async (id?: string) => {
    setCheckingId(id ?? 'all')
    try {
      const result = await onCheck(id)
      setOutcomes(result)
    } finally {
      setCheckingId(null)
    }
  }

  return (
    <div className="shrink-0 px-5 py-2 border-b border-border">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          {totalNew > 0 ? <BellRing className="h-3.5 w-3.5 text-primary" /> : <Bell className="h-3.5 w-3.5" />}
          arXiv 订阅
          {totalNew > 0 && (
            <span className="px-1.5 py-0.5 rounded-full bg-primary/10 text-primary text-[9px] font-semibold">
              {totalNew} 新
            </span>
          )}
          <span className="text-[10px] opacity-60">{expanded ? '收起' : '展开'}</span>
        </button>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => runCheck()}
          disabled={checkingId !== null || subscriptions.length === 0}
        >
          {checkingId === 'all' ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
          检查新论文
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => setAdding(true)}
        >
          <BellPlus className="h-3 w-3 mr-1" />
          添加订阅
        </Button>
      </div>

      {expanded && (
        <div className="mt-2 space-y-1.5">
          {adding && (
            <div className="flex items-center gap-1.5">
              <Input
                value={newQuery}
                onChange={(e) => setNewQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitAdd()
                  if (e.key === 'Escape') setAdding(false)
                }}
                placeholder="订阅关键词，如 large language models"
                className="h-7 text-[12px] flex-1 max-w-sm"
                autoFocus
              />
              <Button size="sm" className="h-7 text-[11px]" onClick={submitAdd} disabled={busy || !newQuery.trim()}>
                <Check className="h-3 w-3 mr-1" />保存
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={() => setAdding(false)}>
                <X className="h-3 w-3" />
              </Button>
            </div>
          )}

          {subscriptions.length === 0 && !adding && (
            <p className="text-[11px] text-muted-foreground/60">暂无订阅。添加关键词后，可定期检查 arXiv 新论文。</p>
          )}

          {subscriptions.map((sub) => (
            <div key={sub.id} className="rounded-md border border-border bg-card p-2">
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-medium flex-1 truncate">{sub.query}</span>
                <span className="text-[10px] text-muted-foreground">
                  {sub.lastCheckedAt ? `上次检查 ${formatDate(sub.lastCheckedAt)}` : '未检查'}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                  onClick={() => runCheck(sub.id)}
                  disabled={checkingId !== null}
                >
                  {checkingId === sub.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                </Button>
                <button
                  onClick={() => onDelete(sub.id)}
                  className="text-muted-foreground/50 hover:text-destructive transition-colors"
                  title="删除订阅"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
              {sub.newEntries.length > 0 && (
                <div className="mt-1.5 space-y-1">
                  {sub.newEntries.map((entry) => (
                    <div key={entry.id} className="flex items-start gap-1.5 text-[11px]">
                      <span className="mt-0.5 h-1 w-1 rounded-full bg-primary shrink-0" />
                      <button
                        onClick={() => onOpenExternal(entry.url)}
                        className="flex-1 min-w-0 text-left hover:text-primary transition-colors line-clamp-1"
                        title={entry.title}
                      >
                        {entry.title}
                      </button>
                      <button
                        onClick={() => onOpenExternal(entry.url)}
                        className="text-muted-foreground/50 hover:text-muted-foreground shrink-0"
                        title="打开"
                      >
                        <ExternalLink className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          {outcomes.length > 0 && (
            <div className="space-y-1">
              {outcomes.map((outcome, index) => (
                <p key={index} className={cn('text-[10px]', outcome.error ? 'text-destructive' : 'text-muted-foreground')}>
                  「{outcome.subscription.query}」：{outcome.error ?? `发现 ${outcome.added.length} 篇新论文`}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}