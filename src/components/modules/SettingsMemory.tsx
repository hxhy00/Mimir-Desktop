import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { BrainCircuit, Save, Check } from 'lucide-react'
import { cn } from '@/lib/utils'

/** 长期记忆档案（Mimir Agent 治理 Phase 3）：全局存储于 settings.memoryProfile，
 *  默认不注入每轮 prompt，仅当任务相关时由 Supervisor 通过 load_memory 按需读取。 */
interface MemoryProfile {
  researchFocus: string
  constraints: string
  commonFacts: string
  updatedAt?: string
}

const EMPTY_PROFILE: MemoryProfile = { researchFocus: '', constraints: '', commonFacts: '' }

export function SettingsMemoryCard() {
  const [profile, setProfile] = useState<MemoryProfile>(EMPTY_PROFILE)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => {
    let alive = true
    window.electronAPI
      ?.getSettings?.()
      .then((settings) => {
        if (!alive) return
        const raw = (settings.memoryProfile ?? {}) as Partial<MemoryProfile>
        setProfile({
          researchFocus: typeof raw.researchFocus === 'string' ? raw.researchFocus : '',
          constraints: typeof raw.constraints === 'string' ? raw.constraints : '',
          commonFacts: typeof raw.commonFacts === 'string' ? raw.commonFacts : '',
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
      const next: MemoryProfile = {
        ...profile,
        updatedAt: new Date().toISOString()
      }
      await window.electronAPI?.setSettings?.({ ...settings, memoryProfile: next })
      setMsg({ type: 'ok', text: '记忆档案已保存，Agent 将在相关任务中按需读取。' })
    } catch (error) {
      setMsg({ type: 'error', text: `保存失败：${error instanceof Error ? error.message : '未知错误'}` })
    } finally {
      setSaving(false)
    }
  }

  const set = (key: keyof MemoryProfile) => (value: string) => {
    setProfile((prev) => ({ ...prev, [key]: value }))
    setMsg(null)
  }

  const field = (label: string, key: keyof MemoryProfile, placeholder: string, hint: string) => (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <Label className="text-[11px] text-muted-foreground">{label}</Label>
        <span className="text-[9px] text-muted-foreground/60">{hint}</span>
      </div>
      <Textarea
        rows={3}
        value={profile[key]}
        onChange={(e) => set(key)(e.target.value)}
        placeholder={placeholder}
        className="min-h-[64px] resize-y text-[12px]"
      />
    </div>
  )

  return (
    <section id="settings-memory" className="scroll-mt-10 space-y-3">
      <div className="flex items-center gap-2">
        <BrainCircuit className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold text-foreground">长期记忆</h2>
      </div>
      <p className="text-[11px] text-muted-foreground">
        记录你的长期研究方向与偏好。档案<b className="text-foreground/80">默认不注入每一轮对话</b>；
        仅当任务与这些内容相关时，Supervisor 才会通过 <code className="rounded bg-muted px-1 font-mono text-[10px]">load_memory</code>{' '}
        按需读取。内容仅存本机，不会从对话自动写入。
      </p>

      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
        {field(
          '研究方向 / 关注领域',
          'researchFocus',
          '例：多智能体可靠性；图神经网络的可解释性；扩散模型的采样加速…',
          '用于选题、综述与查新的默认语境'
        )}
        {field(
          '常用约束与偏好',
          'constraints',
          '例：优先 Tectonic 编译；中英混排、公式用 LaTeX；实验不超过 2×A100；习惯先出 plan 再执行…',
          '写作/实验/交付风格约束'
        )}
        {field(
          '常用事实',
          'commonFacts',
          '例：论文项目目录 ~/Mimir/projects/rl-safe；常用服务器 alice@192.168.1.20；组会每周三…',
          '项目路径/服务器/日程等可复用事实'
        )}
        <div className="flex items-center justify-between pt-1">
          <p className="text-[10px] text-muted-foreground/70">
            {profile.updatedAt !== undefined && profile.updatedAt !== ''
              ? `上次更新：${profile.updatedAt.slice(0, 16).replace('T', ' ')}`
              : '尚未保存过'}
          </p>
          <Button size="sm" className="h-7 text-[11px]" onClick={() => void handleSave()} disabled={saving}>
            {saving ? null : msg?.type === 'ok' ? <Check className="h-3.5 w-3.5 mr-1" /> : <Save className="h-3.5 w-3.5 mr-1" />}
            {saving ? '保存中…' : '保存记忆档案'}
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
