import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { BookOpen, Save, Check } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * 文献检索源设置（设置 → Agent）。
 * - openAlexApiKey：OpenAlex 免费账号的 API key。OpenAlex 已从「mailto 礼貌池」
 *   转为 API Key + 每日预算制（key 额度 ×10，无需绑卡）；未配置时仍可用（mailto 标识）。
 * - s2ApiKey：Semantic Scholar Graph API 的免费 key。
 *   不配也能用（共享 IP 配额）：search/vector 等端点常 429，节流保守、命中限流即冷却；
 *   配了走账号配额（1 req/s 起）：节流放宽到 200ms、429 冷却从 30s 缩到 5s，
 *   语义检索兜底基本不再缺席。
 */
export function SettingsResearchSourcesCard() {
  const [s2ApiKey, setS2ApiKey] = useState('')
  const [openAlexApiKey, setOpenAlexApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => {
    let alive = true
    window.electronAPI
      ?.getSettings?.()
      .then((settings) => {
        if (!alive) return
        setS2ApiKey(typeof settings.s2ApiKey === 'string' ? settings.s2ApiKey : '')
        setOpenAlexApiKey(typeof settings.openAlexApiKey === 'string' ? settings.openAlexApiKey : '')
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const handleSave = async () => {
    setSaving(true)
    setMsg(null)
    try {
      const settings = ((await window.electronAPI?.getSettings?.()) ?? {}) as Record<string, unknown>
      await window.electronAPI?.setSettings?.({ ...settings, s2ApiKey: s2ApiKey.trim(), openAlexApiKey: openAlexApiKey.trim() })
      setMsg({ type: 'ok', text: '已保存。检索源立即使用新配置，无需重启。' })
    } catch (error) {
      setMsg({ type: 'error', text: `保存失败：${error instanceof Error ? error.message : '未知错误'}` })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section id="settings-research-sources" className="scroll-mt-10 space-y-3">
      <div className="flex items-center gap-2">
        <BookOpen className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold text-foreground">文献检索源</h2>
      </div>
      <p className="text-[11px] text-muted-foreground">
        <code className="rounded bg-muted px-1 font-mono text-[10px]">paper_search</code> 默认走 OpenAlex（免配置），
        Semantic Scholar 作语义检索兜底与标题匹配。两者都不需要 key，但 Semantic Scholar 的匿名配额按共享 IP 计——
        容易撞上限流而静默缺席。
      </p>

      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div className="space-y-1.5 border-b border-border pb-3">
          <div className="text-[12px] font-medium text-foreground/90">OpenAlex API Key（可选）</div>
          <div className="relative">
            <Input
              type={showKey ? 'text' : 'password'}
              placeholder="留空则使用 mailto 联系标识（仍可用，额度较低）"
              value={openAlexApiKey}
              onChange={(e) => setOpenAlexApiKey(e.target.value)}
              className="h-8 text-[11px] font-mono pr-7"
            />
            <button
              type="button"
              onClick={() => setShowKey(!showKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            >
              {showKey ? '隐藏' : '显示'}
            </button>
          </div>
          <p className="text-[10px] text-muted-foreground">
            OpenAlex 已从 mailto 礼貌池改为 <strong>API Key + 每日预算制</strong>：免费账号
            （约 30 秒注册，无需绑卡）在{' '}
            <a
              href="https://openalex.org/settings/api"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              openalex.org 设置页
            </a>{' '}
            复制 key，额度为未配置时的 10 倍。只保存在本机 store.json，不外发。
          </p>
        </div>
        <div className="space-y-1.5">
          <div className="text-[12px] font-medium text-foreground/90">Semantic Scholar API Key（可选）</div>
          <div className="relative">
            <Input
              type={showKey ? 'text' : 'password'}
              placeholder="留空则使用匿名共享配额"
              value={s2ApiKey}
              onChange={(e) => setS2ApiKey(e.target.value)}
              className="h-8 text-[11px] font-mono pr-7"
            />
            <button
              type="button"
              onClick={() => setShowKey(!showKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            >
              {showKey ? '隐藏' : '显示'}
            </button>
          </div>
          <p className="text-[10px] text-muted-foreground">
            官方免费申请：发邮件至{' '}
            <a
              href="https://www.semanticscholar.org/product/api#api-key-form"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Semantic Scholar API 申请表
            </a>
            （附用途说明与联系邮箱，通常几分钟批复）。配置后请求走你的账号配额：节流自动放宽、
            限流冷却大幅缩短，语义检索兜底基本不再缺席。只保存在本机 store.json，不外发。
          </p>
        </div>
        <div className="flex items-center justify-between pt-1">
          <p className="text-[10px] text-muted-foreground/70">
            arXiv 官方接口限速 3 秒/次，仅作「最新预印本」补充源，主题近期活跃时才会被调用。
          </p>
          <Button size="sm" className="h-7 text-[11px]" onClick={() => void handleSave()} disabled={saving}>
            {saving ? null : msg?.type === 'ok' ? <Check className="h-3.5 w-3.5 mr-1" /> : <Save className="h-3.5 w-3.5 mr-1" />}
            {saving ? '保存中…' : '保存设置'}
          </Button>
        </div>
        {msg !== null && (
          <p
            className={cn(
              'rounded-md border px-2.5 py-1.5 text-[10px]',
              msg.type === 'error'
                ? 'border-destructive/30 bg-destructive/5 text-destructive'
                : 'border-green-500/30 bg-green-500/5 text-green-600'
            )}
          >
            {msg.text}
          </p>
        )}
      </div>
    </section>
  )
}
