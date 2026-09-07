import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { UserRound, Save, Check } from 'lucide-react'
import { cn } from '@/lib/utils'

/** 永久层「身份与默认值」（Mimir Agent 治理 Phase 4）：存于全局设置 settings.identity。
 *  一旦填写，主进程会在每一轮对话将其作为极小 system 段恒定注入 Supervisor；
 *  默认（未填写身份/写作语言）不注入任何内容。自动学习从不写入永久层。
 *  分界：会随课题/进展变化的内容（研究方向、常用约束）请维护到「长期记忆」档案。 */
interface IdentityProfile {
  role: string
  /** 与 Agent 交流语言：zh=中文（系统默认，无需注入）；en=English（显式覆盖）。 */
  interactLanguage: 'zh' | 'en'
  /** 论文/正式写作语言：''=未指定；'zh'=中文；'en'=English。 */
  writingLanguage: '' | 'zh' | 'en'
  updatedAt?: string
}

const EMPTY_PROFILE: IdentityProfile = { role: '', interactLanguage: 'zh', writingLanguage: '' }

const INTERACT_OPTIONS: { value: IdentityProfile['interactLanguage']; label: string }[] = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' }
]
const WRITING_OPTIONS: { value: IdentityProfile['writingLanguage']; label: string }[] = [
  { value: '', label: '未指定' },
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' }
]

export function SettingsIdentityCard() {
  const [profile, setProfile] = useState<IdentityProfile>(EMPTY_PROFILE)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => {
    let alive = true
    window.electronAPI
      ?.getSettings?.()
      .then((settings) => {
        if (!alive) return
        const raw = (settings.identity ?? {}) as Partial<IdentityProfile>
        setProfile({
          role: typeof raw.role === 'string' ? raw.role : '',
          interactLanguage: raw.interactLanguage === 'en' ? 'en' : 'zh',
          writingLanguage:
            raw.writingLanguage === 'en' || raw.writingLanguage === 'zh' ? raw.writingLanguage : '',
          updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined
        })
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
      const next: IdentityProfile = {
        role: profile.role.trim(),
        interactLanguage: profile.interactLanguage,
        writingLanguage: profile.writingLanguage,
        updatedAt: new Date().toISOString()
      }
      await window.electronAPI?.setSettings?.({ ...settings, identity: next })
      setMsg({ type: 'ok', text: '已保存，下一轮对话起生效（默认不注入任何内容，仅显式填写的身份/语言会被恒定携带）。' })
    } catch (error) {
      setMsg({ type: 'error', text: `保存失败：${error instanceof Error ? error.message : '未知错误'}` })
    } finally {
      setSaving(false)
    }
  }

  const seg = <T extends string>(
    options: { value: T; label: string }[],
    current: T,
    onPick: (v: T) => void
  ) => (
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onPick(o.value)}
          className={cn(
            'rounded-md border px-2 py-1.5 text-[12px] transition-all duration-150',
            current === o.value
              ? 'border-primary bg-primary/5 text-primary font-medium shadow-sm'
              : 'border-border hover:bg-accent hover:border-border/80'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )

  return (
    <section id="settings-identity" className="scroll-mt-10 space-y-3">
      <div className="flex items-center gap-2">
        <UserRound className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold text-foreground">身份与默认值</h2>
      </div>
      <p className="text-[11px] text-muted-foreground">
        永久层设定：只放<b className="text-foreground/80">几乎不变的身份事实</b>（科研身份、交互/写作语言）。
        已填写内容会在每一轮对话作为极小片段<b className="text-foreground/80">恒定注入</b> Agent，即时生效、无需重载；
        自动学习<b>永远不会</b>写入这一层。默认不注入任何内容，只有显式填写的字段才会被携带。
        会随课题/进展变化的内容请放到下面的「长期记忆」。
      </p>

      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between">
            <Label className="text-[11px] text-muted-foreground">科研身份</Label>
            <span className="text-[9px] text-muted-foreground/60">影响建议的深度与术语粒度</span>
          </div>
          <Input
            value={profile.role}
            onChange={(e) => {
              setProfile((prev) => ({ ...prev, role: e.target.value }))
              setMsg(null)
            }}
            placeholder="例：机器学习方向博士研究生；独立研究者…（留空则不注入）"
            className="h-8 text-[12px]"
          />
        </div>

        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between">
            <Label className="text-[11px] text-muted-foreground">与 Agent 交流语言</Label>
            <span className="text-[9px] text-muted-foreground/60">中文为默认；选 English 时覆盖系统默认</span>
          </div>
          {seg<IdentityProfile['interactLanguage']>(INTERACT_OPTIONS, profile.interactLanguage, (v) => {
            setProfile((prev) => ({ ...prev, interactLanguage: v }))
            setMsg(null)
          })}
        </div>

        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between">
            <Label className="text-[11px] text-muted-foreground">论文 / 正式写作语言</Label>
            <span className="text-[9px] text-muted-foreground/60">用于 LaTeX / 组会 / rebuttal 等产物的默认语言</span>
          </div>
          {seg<IdentityProfile['writingLanguage']>(WRITING_OPTIONS, profile.writingLanguage, (v) => {
            setProfile((prev) => ({ ...prev, writingLanguage: v }))
            setMsg(null)
          })}
        </div>

        <div className="flex items-center justify-between pt-1">
          <p className="text-[10px] text-muted-foreground/70">
            {profile.updatedAt !== undefined && profile.updatedAt !== ''
              ? `上次更新：${profile.updatedAt.slice(0, 16).replace('T', ' ')}`
              : '尚未保存过（保持默认：不注入）'}
          </p>
          <Button size="sm" className="h-7 text-[11px]" onClick={() => void handleSave()} disabled={saving}>
            {saving ? null : msg?.type === 'ok' ? <Check className="h-3.5 w-3.5 mr-1" /> : <Save className="h-3.5 w-3.5 mr-1" />}
            {saving ? '保存中…' : '保存身份设定'}
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
