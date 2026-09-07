import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Workflow, Save, Check } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Skill 分层路由开关（设置 → 技能路由）。
 * skillRouting：每轮是否自动「召回+精排 → top-K 候选」注入 Supervisor（默认开）。
 * skillRerank：候选超过阈值时是否叠加 LLM 精排（默认开；关闭则用规则排序）。
 */
export function SettingsSkillRoutingCard() {
  const [routing, setRouting] = useState(true)
  const [rerank, setRerank] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => {
    let alive = true
    window.electronAPI
      ?.getSettings?.()
      .then((settings) => {
        if (!alive) return
        setRouting(settings.skillRouting !== false)
        setRerank(settings.skillRerank !== false)
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
      await window.electronAPI?.setSettings?.({ ...settings, skillRouting: routing, skillRerank: rerank })
      setMsg({ type: 'ok', text: '已保存技能路由设置。' })
    } catch (error) {
      setMsg({ type: 'error', text: `保存失败：${error instanceof Error ? error.message : '未知错误'}` })
    } finally {
      setSaving(false)
    }
  }

  const toggleRow = (
    on: boolean,
    onChange: (v: boolean) => void,
    label: string,
    hint: string
  ) => (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[12px] font-medium text-foreground/90">{label}</div>
        <p className="text-[10px] text-muted-foreground">{hint}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => onChange(!on)}
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full transition-colors',
          on ? 'bg-primary' : 'bg-muted'
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all',
            on ? 'left-[18px]' : 'left-0.5'
          )}
        />
      </button>
    </div>
  )

  return (
    <section id="settings-skill-routing" className="scroll-mt-10 space-y-3">
      <div className="flex items-center gap-2">
        <Workflow className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold text-foreground">技能路由</h2>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Mimir 的技能采用「分层路由」：先目录/标签/硬规则粗召回，再精排后只把 top-K 候选注入 Supervisor，
        而不是把全量技能目录塞进每次请求。手动 <code className="rounded bg-muted px-1 font-mono text-[10px]">/技能</code> 直通、不走路由。
      </p>

      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
        {toggleRow(
          routing,
          setRouting,
          '自动技能候选（每轮）',
          '每条消息先做意图判定与召回精排（多一次轻量调用）；关闭后技能目录不注入，需用 / 手动触发。'
        )}
        <div className="border-t border-border/60" />
        {toggleRow(
          rerank,
          setRerank,
          'LLM 精排',
          '候选较多时用 LLM 对候选打分排序（更准，多一次小调用）；关闭则仅按规则排序。'
        )}
        <div className="flex items-center justify-between pt-1">
          <p className="text-[10px] text-muted-foreground/70">
            内置技能以路由元数据注册；自定义技能缺字段会自动推导，关键字段缺失会被拒绝注册。
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
