/**
 * 插件管理（字段名「插件」）：技能的增删改查迁自「设置 → 技能管理」，
 * 并新增 子代理 / 插件 / Hooks 三个可增删改查的配置集合（均本地持久化）。
 *
 * 现状说明：
 * - 技能：内置 research-* 只读；自定义技能经 /trigger 在对话中实时生效（与原先一致）。
 * - 子代理：本页管理 Supervisor 可委派的模块子代理——内置 5 个科研 worker 只读展示（可克隆），
 *   自定义子代理经「重载 Agent」即时生效（主进程 electron/agent/subagentRegistry.ts 消费）。
 * - 插件 / Hooks：本页提供完整的管理（增删改查 + 启用开关）与本地持久化；
 *   作为可管理的配置入口，供后续运行时扩展消费。
 *   TODO: 插件运行时消费尚未接入——配置写入 electron/store 后需在 Agent 调度层读取
 *   hooks.{onBeforeTool|onAfterTool|onContextReady} 并在对应生命周期调用。
 */
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  Command,
  Bot,
  Puzzle,
  Cable,
  Plus,
  Trash2,
  Code2,
  Pencil,
  Check,
  CopyPlus,
  Lock,
  RefreshCw,
  Sparkles,
  ListOrdered
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  COMMAND_ENTRIES,
  SKILL_ENTRIES,
  loadUserSkills,
  saveUserSkills,
  userSkillToEntry,
  parseUserSkillPayload,
  validateUserSkillDraft,
  createUserSkill,
  USER_SKILL_ARGS_PLACEHOLDER,
  USER_SKILL_TRIGGER_RE,
  loadUserCommands,
  saveUserCommands,
  userCommandToEntry,
  parseUserCommandPayload,
  validateUserCommandDraft,
  createUserCommand
} from '@/lib/slash'
import type { SlashEntry, UserSkill, UserSkillDraft, UserCommand, UserCommandDraft } from '@/lib/slash'

// ─── 通用 store（Electron store / localStorage 降级） ─────────────────
async function storeGet<T>(key: string): Promise<T | undefined> {
  if (window.electronAPI?.getStoreValue) {
    try {
      return await window.electronAPI.getStoreValue<T>(key)
    } catch {
      return undefined
    }
  }
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : undefined
  } catch {
    return undefined
  }
}
async function storeSet<T>(key: string, value: T): Promise<void> {
  if (window.electronAPI?.setStoreValue) {
    await window.electronAPI.setStoreValue(key, value)
    return
  }
  localStorage.setItem(key, JSON.stringify(value))
}

// ─── 子代理 / 插件 / Hooks 记录模型 ────────────────────────────────────
export interface SubagentConfig {
  id: string
  name: string
  label: string
  description: string
  systemPrompt: string
  /** 工具白名单勾选（id 见主进程 WORKER_TOOL_CATALOG）；缺省为空数组。 */
  toolIds: string[]
  enabled: boolean
  createdAt: string
}
export interface PluginConfig {
  id: string
  name: string
  description: string
  kind: 'tool' | 'skill' | 'hook'
  config: string
  enabled: boolean
  createdAt: string
}
export interface HookConfig {
  id: string
  name: string
  description: string
  event: string
  actionType: 'script' | 'command' | 'http'
  payload: string
  enabled: boolean
  createdAt: string
}

const STORE_SUBAGENTS = 'plugins:subagents'
const STORE_PLUGINS = 'plugins:plugins'
const STORE_HOOKS = 'plugins:hooks'

const uid = (prefix: string): string => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
const nowIso = (): string => new Date().toISOString()

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={cn('relative h-5 w-9 shrink-0 rounded-full transition-colors', on ? 'bg-primary' : 'bg-muted')}
    >
      <span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all', on ? 'left-[18px]' : 'left-0.5')} />
    </button>
  )
}

// ─── 技能 tab（迁自 设置 → 技能管理） ────────────────────────────────────
const EMPTY_SKILL_DRAFT: UserSkillDraft = {
  trigger: '',
  title: '',
  description: '',
  whenToUse: '',
  argsHint: '',
  usage: '',
  body: ''
}

function SkillsPanel() {
  const [userSkills, setUserSkills] = useState<UserSkill[]>([])
  const [detail, setDetail] = useState<{ source: 'builtin'; entry: SlashEntry } | { source: 'custom'; skill: UserSkill } | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importTab, setImportTab] = useState<'form' | 'json'>('form')
  const [importForm, setImportForm] = useState<UserSkillDraft>(EMPTY_SKILL_DRAFT)
  const [importJson, setImportJson] = useState('')
  const [importMsg, setImportMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  const refresh = useCallback(async () => {
    try {
      setUserSkills(await loadUserSkills())
    } catch {
      setUserSkills([])
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const openImport = () => {
    setImportForm(EMPTY_SKILL_DRAFT)
    setImportJson('')
    setImportTab('form')
    setImportMsg(null)
    setImportOpen(true)
  }

  const confirmImport = async () => {
    setImportMsg(null)
    const drafts: UserSkillDraft[] = []
    let structuralErrors: string[] = []
    if (importTab === 'json') {
      let parsed: unknown
      try {
        parsed = JSON.parse(importJson.trim())
      } catch {
        setImportMsg({ type: 'error', text: 'JSON 格式不正确，请检查后重试。' })
        return
      }
      const result = parseUserSkillPayload(parsed)
      structuralErrors = result.errors
      drafts.push(...result.drafts)
      if (drafts.length === 0) {
        setImportMsg({ type: 'error', text: structuralErrors.length > 0 ? structuralErrors.join('\n') : '没有可导入的技能（请提供含 trigger/title/body 的对象）。' })
        return
      }
    } else {
      drafts.push(importForm)
    }
    const taken = new Set<string>([
      ...COMMAND_ENTRIES.map((e) => e.trigger),
      ...SKILL_ENTRIES.map((e) => e.trigger),
      ...userSkills.map((s) => s.trigger),
      'clear'
    ])
    const added: UserSkill[] = []
    const errors: string[] = [...structuralErrors]
    for (const draft of drafts) {
      const label = draft.trigger.trim() === '' ? '（触发词为空）' : `/${draft.trigger.trim()}`
      const issues = validateUserSkillDraft(draft, taken)
      if (issues.length > 0) {
        errors.push(`${label}：${issues.join('；')}`)
        continue
      }
      const skill = createUserSkill(draft)
      added.push(skill)
      taken.add(skill.trigger)
    }
    if (added.length > 0) {
      const next = [...userSkills, ...added]
      setUserSkills(next)
      await saveUserSkills(next)
    }
    if (importTab === 'form') setImportForm(EMPTY_SKILL_DRAFT)
    else setImportJson('')
    const lines: string[] = []
    if (added.length > 0) lines.push(`已导入 ${added.length} 个技能，可在聊天输入框直接使用。`)
    if (errors.length > 0) lines.push(errors.join('\n'))
    if (lines.length === 0) lines.push('没有新增技能。')
    setImportMsg({ type: added.length > 0 && errors.length === 0 ? 'ok' : 'error', text: lines.join('\n') })
  }

  const removeSkill = async (skill: UserSkill) => {
    if (!window.confirm(`删除自定义技能「${skill.title}」？\n触发词 /${skill.trigger} 将从斜杠菜单移除。`)) return
    const next = userSkills.filter((s) => s.id !== skill.id)
    setUserSkills(next)
    if (detail !== null && detail.source === 'custom' && detail.skill.id === skill.id) setDetail(null)
    await saveUserSkills(next).catch(() => {})
  }

  const detailEntry = detail !== null ? (detail.source === 'builtin' ? detail.entry : userSkillToEntry(detail.skill)) : null
  const detailBody = detail?.source === 'custom' ? detail.skill.body : null

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[12px] font-medium text-foreground">当前可用技能</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              内置 {SKILL_ENTRIES.length} 个（只读） · 我的 {userSkills.length} 个
            </p>
          </div>
          <Button size="sm" className="h-7" onClick={openImport}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            导入技能
          </Button>
        </div>
      </div>

      <div className="space-y-1.5">
        <p className="text-[10px] font-medium text-muted-foreground">我的自定义技能</p>
        {userSkills.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-6 text-muted-foreground">
            <p className="text-[11px]">还没有自定义技能</p>
            <Button variant="ghost" size="sm" className="mt-1 h-6 text-[10px]" onClick={openImport}>
              <Plus className="h-3 w-3 mr-1" />
              导入第一个技能
            </Button>
          </div>
        ) : (
          userSkills.map((skill) => (
            <div key={skill.id} className="flex items-center gap-2 rounded-lg border border-border/70 bg-card px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-medium text-foreground">
                  <span className="text-muted-foreground">/</span>
                  {skill.trigger}
                  <span className="ml-1.5 font-normal text-muted-foreground/80">{skill.title}</span>
                </p>
                {skill.description !== '' && <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{skill.description}</p>}
              </div>
              <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[10px]" onClick={() => setDetail({ source: 'custom', skill })}>
                <Pencil className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[10px] text-destructive hover:text-destructive"
                onClick={() => void removeSkill(skill)}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))
        )}
      </div>

      <div className="space-y-1.5">
        <p className="text-[10px] font-medium text-muted-foreground">内置技能（只读）· {SKILL_ENTRIES.length}</p>
        {SKILL_ENTRIES.map((entry) => (
          <div key={`builtin-${entry.trigger}`} className="flex items-center gap-2 rounded-lg border border-border/70 bg-card px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] font-medium text-foreground">
                <span className="text-muted-foreground">/</span>
                {entry.trigger}
                <span className="ml-1.5 font-normal text-muted-foreground/80">{entry.title.replace(/（.*）/, '')}</span>
              </p>
              <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{entry.description}</p>
            </div>
            <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[10px]" onClick={() => setDetail({ source: 'builtin', entry })}>
              详情
            </Button>
          </div>
        ))}
      </div>

      {/* 导入技能 */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>导入技能</DialogTitle>
            <DialogDescription>新增一条自定义技能；导入后即可在聊天输入框用 /触发词 调用。</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => { setImportTab('form'); setImportMsg(null) }} className={cn('rounded-md border px-3 py-2 text-[12px]', importTab === 'form' ? 'border-primary bg-primary/5 text-primary' : 'border-border text-muted-foreground')}>
              <Plus className="h-3.5 w-3.5 mr-1 inline" />手动填写
            </button>
            <button type="button" onClick={() => { setImportTab('json'); setImportMsg(null) }} className={cn('rounded-md border px-3 py-2 text-[12px]', importTab === 'json' ? 'border-primary bg-primary/5 text-primary' : 'border-border text-muted-foreground')}>
              <Code2 className="h-3.5 w-3.5 mr-1 inline" />粘贴 JSON
            </button>
          </div>
          {importTab === 'form' ? (
            <div className="space-y-2.5">
              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1">
                  <Label className="text-[11px]">触发词 *</Label>
                  <Input className="h-7 text-[12px] font-mono" value={importForm.trigger} onChange={(e) => setImportForm({ ...importForm, trigger: e.target.value })} placeholder="my-skill" autoFocus />
                </div>
                <div className="col-span-2 space-y-1">
                  <Label className="text-[11px]">标题 *</Label>
                  <Input className="h-7 text-[12px]" value={importForm.title} onChange={(e) => setImportForm({ ...importForm, title: e.target.value })} placeholder="如：文献速读（my-skill）" />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">一句话说明</Label>
                <Input className="h-7 text-[12px]" value={importForm.description} onChange={(e) => setImportForm({ ...importForm, description: e.target.value })} placeholder="在斜杠菜单里展示的一句话" />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">适合何时使用</Label>
                <Input className="h-7 text-[12px]" value={importForm.whenToUse} onChange={(e) => setImportForm({ ...importForm, whenToUse: e.target.value })} placeholder="什么时候该用这条技能" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-[11px]">参数提示</Label>
                  <Input className="h-7 text-[12px]" value={importForm.argsHint} onChange={(e) => setImportForm({ ...importForm, argsHint: e.target.value })} placeholder="如 <研究方向>" />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">用法示例</Label>
                  <Input className="h-7 text-[12px]" value={importForm.usage} onChange={(e) => setImportForm({ ...importForm, usage: e.target.value })} placeholder="如 /my-skill 我的参数" />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">任务正文 *（支持 {USER_SKILL_ARGS_PLACEHOLDER}）</Label>
                <Textarea rows={7} className="text-[12px]" value={importForm.body} onChange={(e) => setImportForm({ ...importForm, body: e.target.value })} placeholder={`一段结构化指令；需要注入用户参数时写 ${USER_SKILL_ARGS_PLACEHOLDER} 占位符`} />
              </div>
            </div>
          ) : (
            <div className="space-y-1">
              <Label className="text-[11px]">JSON（单个对象或数组）</Label>
              <Textarea rows={10} className="font-mono text-[11px]" value={importJson} onChange={(e) => setImportJson(e.target.value)} placeholder={'[{"trigger":"my-skill","title":"…","description":"…","body":"…"}]'} />
            </div>
          )}
          {importMsg !== null && (
            <p className={cn('whitespace-pre-wrap rounded-md border px-2.5 py-1.5 text-[10px]', importMsg.type === 'error' ? 'border-destructive/30 bg-destructive/5 text-destructive' : 'border-green-500/30 bg-green-500/5 text-green-600')}>{importMsg.text}</p>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" className="h-7" onClick={() => setImportOpen(false)}>关闭</Button>
            <Button size="sm" className="h-7" onClick={() => void confirmImport()}>导入</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 技能详情 */}
      <Dialog open={detail !== null} onOpenChange={(open) => { if (!open) setDetail(null) }}>
        <DialogContent className="max-h-[85vh] sm:max-w-lg">
          {detailEntry !== null && (
            <>
              <DialogHeader className="pr-6">
                <DialogTitle className="flex items-center gap-2">
                  <span className="truncate">{detailEntry.title}</span>
                  <span className={cn('shrink-0 rounded-full px-1.5 py-px text-[9px] font-medium', detail?.source === 'builtin' ? 'bg-primary/10 text-primary' : 'bg-emerald-500/10 text-emerald-600')}>
                    {detail?.source === 'builtin' ? '内置' : '自定义'}
                  </span>
                </DialogTitle>
                <DialogDescription>斜杠技能详情与使用说明。</DialogDescription>
              </DialogHeader>
              <div className="space-y-3 overflow-y-auto text-[11px]">
                <div>
                  <p className="text-[10px] text-muted-foreground">触发方式</p>
                  <p className="mt-0.5 font-mono text-primary">/{detailEntry.trigger}</p>
                </div>
                {detailEntry.description !== '' && (
                  <div>
                    <p className="text-[10px] text-muted-foreground">说明</p>
                    <p className="mt-0.5 leading-relaxed text-foreground/90">{detailEntry.description}</p>
                  </div>
                )}
                {detailEntry.whenToUse !== '' && (
                  <div>
                    <p className="text-[10px] text-muted-foreground">适用场景</p>
                    <p className="mt-0.5 leading-relaxed text-foreground/90">{detailEntry.whenToUse}</p>
                  </div>
                )}
                {detailEntry.argsHint !== '' && (
                  <div>
                    <p className="text-[10px] text-muted-foreground">参数提示</p>
                    <p className="mt-0.5 font-mono text-foreground/90">{detailEntry.argsHint}</p>
                  </div>
                )}
                {detailEntry.usage !== '' && (
                  <div>
                    <p className="text-[10px] text-muted-foreground">用法示例</p>
                    <p className="mt-0.5 whitespace-pre-wrap rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-[10px]">{detailEntry.usage}</p>
                  </div>
                )}
                {detailBody !== null ? (
                  <div>
                    <p className="text-[10px] text-muted-foreground">任务正文{detailBody.includes(USER_SKILL_ARGS_PLACEHOLDER) ? '（支持参数占位符）' : ''}</p>
                    <pre className="mt-0.5 max-h-[36vh] overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-[10px]">{detailBody}</pre>
                  </div>
                ) : (
                  <p className="rounded-md bg-muted/50 px-3 py-2 text-[10px] text-muted-foreground">
                    内置技能正文随版本提供，管理页不展示；在聊天输入框输入 /{detailEntry.trigger} 后按回车即可调用。
                  </p>
                )}
              </div>
              <DialogFooter>
                <Button variant="outline" size="sm" className="h-7" onClick={() => setDetail(null)}>关闭</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─── 指令 tab（与技能同级：内置只读 + 自定义指令增删改查） ──────────────
const EMPTY_COMMAND_DRAFT: UserCommandDraft = {
  trigger: '',
  title: '',
  description: '',
  whenToUse: '',
  argsHint: '',
  usage: '',
  requiresArg: false,
  body: ''
}

function CommandsPanel() {
  const [userCommands, setUserCommands] = useState<UserCommand[]>([])
  const [detail, setDetail] = useState<{ source: 'builtin'; entry: SlashEntry } | { source: 'custom'; cmd: UserCommand } | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importTab, setImportTab] = useState<'form' | 'json'>('form')
  const [importForm, setImportForm] = useState<UserCommandDraft>(EMPTY_COMMAND_DRAFT)
  const [importJson, setImportJson] = useState('')
  const [importMsg, setImportMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  const refresh = useCallback(async () => {
    try {
      setUserCommands(await loadUserCommands())
    } catch {
      setUserCommands([])
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const openImport = () => {
    setImportForm(EMPTY_COMMAND_DRAFT)
    setImportJson('')
    setImportTab('form')
    setImportMsg(null)
    setImportOpen(true)
  }

  const confirmImport = async () => {
    setImportMsg(null)
    const drafts: UserCommandDraft[] = []
    let structuralErrors: string[] = []
    if (importTab === 'json') {
      let parsed: unknown
      try {
        parsed = JSON.parse(importJson.trim())
      } catch {
        setImportMsg({ type: 'error', text: 'JSON 格式不正确，请检查后重试。' })
        return
      }
      const result = parseUserCommandPayload(parsed)
      structuralErrors = result.errors
      drafts.push(...result.drafts)
      if (drafts.length === 0) {
        setImportMsg({ type: 'error', text: structuralErrors.length > 0 ? structuralErrors.join('\n') : '没有可导入的指令（请提供含 trigger/title/body 的对象）。' })
        return
      }
    } else {
      drafts.push(importForm)
    }
    const taken = new Set<string>([
      ...COMMAND_ENTRIES.map((e) => e.trigger),
      ...SKILL_ENTRIES.map((e) => e.trigger),
      ...userCommands.map((c) => c.trigger),
      'clear'
    ])
    const added: UserCommand[] = []
    const errors: string[] = [...structuralErrors]
    for (const draft of drafts) {
      const label = draft.trigger.trim() === '' ? '（触发词为空）' : `/${draft.trigger.trim()}`
      const issues = validateUserCommandDraft(draft, taken)
      if (issues.length > 0) {
        errors.push(`${label}：${issues.join('；')}`)
        continue
      }
      const cmd = createUserCommand(draft)
      added.push(cmd)
      taken.add(cmd.trigger)
    }
    if (added.length > 0) {
      const next = [...userCommands, ...added]
      setUserCommands(next)
      await saveUserCommands(next)
    }
    if (importTab === 'form') setImportForm(EMPTY_COMMAND_DRAFT)
    else setImportJson('')
    const lines: string[] = []
    if (added.length > 0) lines.push(`已导入 ${added.length} 个指令，可在聊天输入框直接使用。`)
    if (errors.length > 0) lines.push(errors.join('\n'))
    if (lines.length === 0) lines.push('没有新增指令。')
    setImportMsg({ type: added.length > 0 && errors.length === 0 ? 'ok' : 'error', text: lines.join('\n') })
  }

  const removeCommand = async (cmd: UserCommand) => {
    if (!window.confirm(`删除自定义指令「${cmd.title}」？\n触发词 /${cmd.trigger} 将从斜杠菜单移除。`)) return
    const next = userCommands.filter((c) => c.id !== cmd.id)
    setUserCommands(next)
    if (detail !== null && detail.source === 'custom' && detail.cmd.id === cmd.id) setDetail(null)
    await saveUserCommands(next).catch(() => {})
  }

  const detailEntry = detail !== null ? (detail.source === 'builtin' ? detail.entry : userCommandToEntry(detail.cmd)) : null
  const detailBody = detail?.source === 'custom' ? detail.cmd.body : null

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[12px] font-medium text-foreground">当前可用指令</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              内置 {COMMAND_ENTRIES.length} 个（只读） · 我的 {userCommands.length} 个 · 技能 {SKILL_ENTRIES.length} 个
            </p>
          </div>
          <Button size="sm" className="h-7" onClick={openImport}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            导入指令
          </Button>
        </div>
      </div>

      <div className="space-y-1.5">
        <p className="text-[10px] font-medium text-muted-foreground">我的自定义指令</p>
        {userCommands.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-6 text-muted-foreground">
            <p className="text-[11px]">还没有自定义指令</p>
            <Button variant="ghost" size="sm" className="mt-1 h-6 text-[10px]" onClick={openImport}>
              <Plus className="h-3 w-3 mr-1" />
              导入第一个指令
            </Button>
          </div>
        ) : (
          userCommands.map((cmd) => (
            <div key={cmd.id} className="flex items-center gap-2 rounded-lg border border-border/70 bg-card px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-medium text-foreground">
                  <span className="text-muted-foreground">/</span>
                  {cmd.trigger}
                  {cmd.requiresArg && <span className="ml-1 text-[9px] text-amber-600">（需参数）</span>}
                  <span className="ml-1.5 font-normal text-muted-foreground/80">{cmd.title}</span>
                </p>
                {cmd.description !== '' && <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{cmd.description}</p>}
              </div>
              <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[10px]" onClick={() => setDetail({ source: 'custom', cmd })}>
                <Pencil className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[10px] text-destructive hover:text-destructive"
                onClick={() => void removeCommand(cmd)}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))
        )}
      </div>

      <div className="space-y-1.5">
        <p className="text-[10px] font-medium text-muted-foreground">内置指令（只读）· {COMMAND_ENTRIES.length}</p>
        {COMMAND_ENTRIES.map((entry) => (
          <div key={`builtin-cmd-${entry.trigger}`} className="flex items-center gap-2 rounded-lg border border-border/70 bg-card px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] font-medium text-foreground">
                <span className="text-muted-foreground">/</span>
                {entry.trigger}
                {entry.requiresArg && <span className="ml-1 text-[9px] text-amber-600">（需参数）</span>}
                <span className="ml-1.5 font-normal text-muted-foreground/80">{entry.title.replace(/（.*）/, '')}</span>
              </p>
              <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{entry.description}</p>
            </div>
            <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[10px]" onClick={() => setDetail({ source: 'builtin', entry })}>
              详情
            </Button>
          </div>
        ))}
      </div>

      {/* 导入指令 */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>导入指令</DialogTitle>
            <DialogDescription>新增一条自定义指令；导入后即可在聊天输入框用 /触发词 调用。</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => { setImportTab('form'); setImportMsg(null) }} className={cn('rounded-md border px-3 py-2 text-[12px]', importTab === 'form' ? 'border-primary bg-primary/5 text-primary' : 'border-border text-muted-foreground')}>
              <Plus className="h-3.5 w-3.5 mr-1 inline" />手动填写
            </button>
            <button type="button" onClick={() => { setImportTab('json'); setImportMsg(null) }} className={cn('rounded-md border px-3 py-2 text-[12px]', importTab === 'json' ? 'border-primary bg-primary/5 text-primary' : 'border-border text-muted-foreground')}>
              <Code2 className="h-3.5 w-3.5 mr-1 inline" />粘贴 JSON
            </button>
          </div>
          {importTab === 'form' ? (
            <div className="space-y-2.5">
              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1">
                  <Label className="text-[11px]">触发词 *</Label>
                  <Input className="h-7 text-[12px] font-mono" value={importForm.trigger} onChange={(e) => setImportForm({ ...importForm, trigger: e.target.value })} placeholder="my-command" autoFocus />
                </div>
                <div className="col-span-2 space-y-1">
                  <Label className="text-[11px]">标题 *</Label>
                  <Input className="h-7 text-[12px]" value={importForm.title} onChange={(e) => setImportForm({ ...importForm, title: e.target.value })} placeholder="如：批量整理（my-command）" />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">一句话说明</Label>
                <Input className="h-7 text-[12px]" value={importForm.description} onChange={(e) => setImportForm({ ...importForm, description: e.target.value })} placeholder="在斜杠菜单里展示的一句话" />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">适合何时使用</Label>
                <Input className="h-7 text-[12px]" value={importForm.whenToUse} onChange={(e) => setImportForm({ ...importForm, whenToUse: e.target.value })} placeholder="什么时候该用这条指令" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-[11px]">参数提示</Label>
                  <Input className="h-7 text-[12px]" value={importForm.argsHint} onChange={(e) => setImportForm({ ...importForm, argsHint: e.target.value })} placeholder="如 <研究方向>" />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">用法示例</Label>
                  <Input className="h-7 text-[12px]" value={importForm.usage} onChange={(e) => setImportForm({ ...importForm, usage: e.target.value })} placeholder="如 /my-command 我的参数" />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={importForm.requiresArg}
                    onChange={(e) => setImportForm({ ...importForm, requiresArg: e.target.checked })}
                    className="h-3.5 w-3.5 rounded border-muted-foreground/50 accent-primary"
                  />
                  <span className="text-[11px] text-foreground">必须提供参数</span>
                </label>
                <span className="text-[10px] text-muted-foreground">开启后，未带参数调用会提醒补充参数。</span>
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">任务正文 *（支持 {USER_SKILL_ARGS_PLACEHOLDER}）</Label>
                <Textarea rows={7} className="text-[12px]" value={importForm.body} onChange={(e) => setImportForm({ ...importForm, body: e.target.value })} placeholder={`一段结构化指令；需要注入用户参数时写 ${USER_SKILL_ARGS_PLACEHOLDER} 占位符`} />
              </div>
            </div>
          ) : (
            <div className="space-y-1">
              <Label className="text-[11px]">JSON（单个对象或数组）</Label>
              <Textarea rows={10} className="font-mono text-[11px]" value={importJson} onChange={(e) => setImportJson(e.target.value)} placeholder={'[{"trigger":"my-command","title":"…","description":"…","body":"…"}]'} />
            </div>
          )}
          {importMsg !== null && (
            <p className={cn('whitespace-pre-wrap rounded-md border px-2.5 py-1.5 text-[10px]', importMsg.type === 'error' ? 'border-destructive/30 bg-destructive/5 text-destructive' : 'border-green-500/30 bg-green-500/5 text-green-600')}>{importMsg.text}</p>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" className="h-7" onClick={() => setImportOpen(false)}>关闭</Button>
            <Button size="sm" className="h-7" onClick={() => void confirmImport()}>导入</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 指令详情 */}
      <Dialog open={detail !== null} onOpenChange={(open) => { if (!open) setDetail(null) }}>
        <DialogContent className="max-h-[85vh] sm:max-w-lg">
          {detailEntry !== null && (
            <>
              <DialogHeader className="pr-6">
                <DialogTitle className="flex items-center gap-2">
                  <span className="truncate">{detailEntry.title}</span>
                  <span className={cn('shrink-0 rounded-full px-1.5 py-px text-[9px] font-medium', detail?.source === 'builtin' ? 'bg-primary/10 text-primary' : 'bg-emerald-500/10 text-emerald-600')}>
                    {detail?.source === 'builtin' ? '内置' : '自定义'}
                  </span>
                </DialogTitle>
                <DialogDescription>斜杠指令详情与使用说明。</DialogDescription>
              </DialogHeader>
              <div className="space-y-3 overflow-y-auto text-[11px]">
                <div>
                  <p className="text-[10px] text-muted-foreground">触发方式</p>
                  <p className="mt-0.5 font-mono text-primary">/{detailEntry.trigger}</p>
                </div>
                {detailEntry.requiresArg && (
                  <div>
                    <p className="text-[10px] text-muted-foreground">参数</p>
                    <p className="mt-0.5 text-amber-600">必须提供参数，否则会提醒补充。</p>
                  </div>
                )}
                {detailEntry.description !== '' && (
                  <div>
                    <p className="text-[10px] text-muted-foreground">说明</p>
                    <p className="mt-0.5 leading-relaxed text-foreground/90">{detailEntry.description}</p>
                  </div>
                )}
                {detailEntry.whenToUse !== '' && (
                  <div>
                    <p className="text-[10px] text-muted-foreground">适用场景</p>
                    <p className="mt-0.5 leading-relaxed text-foreground/90">{detailEntry.whenToUse}</p>
                  </div>
                )}
                {detailEntry.argsHint !== '' && (
                  <div>
                    <p className="text-[10px] text-muted-foreground">参数提示</p>
                    <p className="mt-0.5 font-mono text-foreground/90">{detailEntry.argsHint}</p>
                  </div>
                )}
                {detailEntry.usage !== '' && (
                  <div>
                    <p className="text-[10px] text-muted-foreground">用法示例</p>
                    <p className="mt-0.5 whitespace-pre-wrap rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-[10px]">{detailEntry.usage}</p>
                  </div>
                )}
                {detailBody !== null ? (
                  <div>
                    <p className="text-[10px] text-muted-foreground">任务正文{detailBody.includes(USER_SKILL_ARGS_PLACEHOLDER) ? '（支持参数占位符）' : ''}</p>
                    <pre className="mt-0.5 max-h-[36vh] overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-[10px]">{detailBody}</pre>
                  </div>
                ) : (
                  <p className="rounded-md bg-muted/50 px-3 py-2 text-[10px] text-muted-foreground">
                    内置指令正文随版本提供，管理页不展示；在聊天输入框输入 /{detailEntry.trigger} 后按回车即可调用。
                  </p>
                )}
              </div>
              <DialogFooter>
                <Button variant="outline" size="sm" className="h-7" onClick={() => setDetail(null)}>关闭</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─── 通用集合 CRUD（子代理 / 插件 / Hooks） ─────────────────────────────
type RecordKind = 'subagent' | 'plugin' | 'hook'
type AnyRecord = Record<string, unknown>

interface FieldDef {
  key: string
  label: string
  placeholder?: string
  textarea?: boolean
  full?: boolean
  options?: { value: string; label: string }[]
}

function CollectionPanel({
  kind,
  storeKey,
  title,
  description,
  fields,
  makeEmpty,
  labelOf
}: {
  kind: RecordKind
  storeKey: string
  title: string
  description: string
  fields: FieldDef[]
  makeEmpty: () => AnyRecord
  labelOf: (r: AnyRecord) => string
}) {
  const [items, setItems] = useState<AnyRecord[]>([])
  const [editing, setEditing] = useState<AnyRecord | null>(null)
  const [saving, setSaving] = useState(false)

  const refresh = useCallback(async () => {
    const raw = await storeGet<AnyRecord[]>(storeKey)
    setItems(Array.isArray(raw) ? raw : [])
  }, [storeKey])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const persist = async (next: AnyRecord[]) => {
    setItems(next)
    await storeSet(storeKey, next)
  }

  const remove = async (rec: AnyRecord) => {
    if (!window.confirm(`删除「${labelOf(rec)}」？`)) return
    await persist(items.filter((r) => (r.id as string) !== (rec.id as string)))
    if (editing !== null && (editing.id as string) === (rec.id as string)) setEditing(null)
  }

  const saveEditing = async () => {
    if (editing === null) return
    setSaving(true)
    try {
      const isNew = items.every((r) => (r.id as string) !== (editing.id as string))
      const next = isNew ? [...items, editing] : items.map((r) => ((r.id as string) === (editing.id as string) ? editing : r))
      await persist(next)
      setEditing(null)
    } finally {
      setSaving(false)
    }
  }

  const toggleEnabled = async (rec: AnyRecord, v: boolean) => {
    await persist(items.map((r) => ((r.id as string) === (rec.id as string) ? { ...r, enabled: v } : r)))
  }

  const renderField = (f: FieldDef) => {
    const value = editing?.[f.key] ?? ''
    const setValue = (v: string) => setEditing((prev) => (prev === null ? prev : { ...prev, [f.key]: v }))
    return (
      <div key={f.key} className={cn('space-y-1', f.full ? 'col-span-2' : '')}>
        <Label className="text-[11px]">{f.label}</Label>
        {f.options !== undefined ? (
          <select
            className="h-7 w-full rounded-md border border-border bg-background px-2 text-[12px]"
            value={String(value)}
            onChange={(e) => setValue(e.target.value)}
          >
            {f.options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        ) : f.textarea === true ? (
          <Textarea rows={f.key === 'systemPrompt' || f.key === 'config' || f.key === 'payload' ? 5 : 3} className="text-[12px]" value={String(value)} onChange={(e) => setValue(e.target.value)} placeholder={f.placeholder} />
        ) : (
          <Input className="h-7 text-[12px]" value={String(value)} onChange={(e) => setValue(e.target.value)} placeholder={f.placeholder} />
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[12px] font-medium text-foreground">{title}</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">{description}</p>
          </div>
          <Button size="sm" className="h-7" onClick={() => setEditing({ ...makeEmpty(), id: uid(kind), enabled: true, createdAt: nowIso() })}>
            <Plus className="h-3.5 w-3.5 mr-1" />新增
          </Button>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-8 text-muted-foreground">
          <p className="text-[11px]">还没有{title}，点右上角「新增」创建一条。</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {items.map((rec) => (
            <div key={rec.id as string} className="flex items-center gap-2 rounded-lg border border-border/70 bg-card px-3 py-2">
              <Toggle on={rec.enabled === true} onChange={(v) => void toggleEnabled(rec, v)} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-medium text-foreground">{labelOf(rec)}</p>
                {typeof rec.description === 'string' && rec.description !== '' && (
                  <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{rec.description}</p>
                )}
              </div>
              <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[10px]" onClick={() => setEditing({ ...rec })}>
                <Pencil className="h-3 w-3" />
              </Button>
              <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[10px] text-destructive hover:text-destructive" onClick={() => void remove(rec)}>
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null) }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{items.some((r) => (r.id as string) === (editing?.id as string)) ? `编辑${title}` : `新增${title}`}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {editing !== null && (
            <div className="grid grid-cols-2 gap-2.5">
              {fields.map(renderField)}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" className="h-7" onClick={() => setEditing(null)}>取消</Button>
            <Button size="sm" className="h-7" onClick={() => void saveEditing()} disabled={saving}>
              {saving ? null : <Check className="h-3.5 w-3.5 mr-1" />}
              {saving ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─── 子代理管理（内置只读 + 自定义增删改查；变更后重载 Agent 即时生效） ─────
interface BuiltinSubagentMeta {
  id: string
  label: string
  description: string
  systemPrompt: string
  toolIds: string[]
}

const SUBAGENT_NAME_RE = /^[a-z][a-z0-9-]*$/

/** 归一化一条 store 里的自定义子代理（兼容旧记录缺 toolIds）。 */
function normalizeSubagent(rec: AnyRecord): SubagentConfig {
  return {
    id: String(rec.id ?? uid('agent')),
    name: typeof rec.name === 'string' ? rec.name.trim() : '',
    label: typeof rec.label === 'string' ? rec.label.trim() : '',
    description: typeof rec.description === 'string' ? rec.description.trim() : '',
    systemPrompt: typeof rec.systemPrompt === 'string' ? rec.systemPrompt : '',
    toolIds: Array.isArray(rec.toolIds) ? rec.toolIds.map((t) => String(t)) : [],
    enabled: rec.enabled !== false,
    createdAt: typeof rec.createdAt === 'string' ? rec.createdAt : nowIso()
  }
}

function SubagentsPanel() {
  const [tools, setTools] = useState<{ id: string; label: string; description: string }[]>([])
  const [builtins, setBuiltins] = useState<BuiltinSubagentMeta[]>([])
  const [items, setItems] = useState<SubagentConfig[]>([])
  const [editing, setEditing] = useState<SubagentConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [genOpen, setGenOpen] = useState(false)
  const [genText, setGenText] = useState('')
  const [genBusy, setGenBusy] = useState(false)
  const [genErr, setGenErr] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (window.electronAPI?.getSubagentCatalog) {
      try {
        const cat = await window.electronAPI.getSubagentCatalog()
        setTools(Array.isArray(cat.tools) ? cat.tools : [])
        setBuiltins(Array.isArray(cat.builtin) ? cat.builtin : [])
      } catch {
        setTools([])
        setBuiltins([])
      }
    }
    const raw = await storeGet<AnyRecord[]>(STORE_SUBAGENTS)
    setItems(Array.isArray(raw) ? raw.map(normalizeSubagent) : [])
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const persist = async (next: SubagentConfig[]): Promise<void> => {
    setItems(next)
    await storeSet(STORE_SUBAGENTS, next)
  }

  /** 变更后重载 Agent，使子代理注册即时生效。 */
  const reloadAfterChange = useCallback(async (): Promise<void> => {
    if (window.electronAPI?.reloadAgent) {
      try {
        const res = await window.electronAPI.reloadAgent()
        setNotice({ kind: res.ok ? 'ok' : 'err', text: res.message })
        return
      } catch (error) {
        setNotice({ kind: 'err', text: `重载 Agent 失败：${error instanceof Error ? error.message : '未知错误'}` })
        return
      }
    }
    setNotice({ kind: 'err', text: '浏览器模式无法重载 Agent：请在 Electron 中重新初始化后生效。' })
  }, [])

  const validate = (draft: SubagentConfig): string | null => {
    const name = draft.name.trim()
    if (name === '') return '标识 name 不能为空'
    if (!SUBAGENT_NAME_RE.test(name)) return 'name 需为小写字母开头，且仅含小写字母/数字/中划线'
    const clashBuiltin = builtins.some((b) => b.id === name)
    const clashCustom = items.some((i) => i.id !== draft.id && i.name === name)
    if (clashBuiltin || clashCustom) return `name「${name}」已被占用（内置或其它自定义子代理）`
    if (draft.description.trim() === '') return '一句话说明不能为空'
    if (draft.systemPrompt.trim() === '') return '系统提示词不能为空'
    return null
  }

  const saveEditing = async (): Promise<void> => {
    if (editing === null) return
    const err = validate(editing)
    if (err !== null) {
      setNotice({ kind: 'err', text: err })
      return
    }
    setSaving(true)
    try {
      const clean: SubagentConfig = {
        ...editing,
        name: editing.name.trim(),
        label: editing.label.trim() !== '' ? editing.label.trim() : editing.name.trim(),
        description: editing.description.trim(),
        toolIds: [...new Set(editing.toolIds)]
      }
      const isNew = items.every((r) => r.id !== clean.id)
      await persist(isNew ? [...items, clean] : items.map((r) => (r.id === clean.id ? clean : r)))
      setEditing(null)
      await reloadAfterChange()
    } finally {
      setSaving(false)
    }
  }

  const toggleCustom = async (rec: SubagentConfig, v: boolean): Promise<void> => {
    await persist(items.map((r) => (r.id === rec.id ? { ...r, enabled: v } : r)))
    await reloadAfterChange()
  }

  const removeCustom = async (rec: SubagentConfig): Promise<void> => {
    if (!window.confirm(`删除自定义子代理「${rec.name}」？`)) return
    await persist(items.filter((r) => r.id !== rec.id))
    if (editing !== null && editing.id === rec.id) setEditing(null)
    await reloadAfterChange()
  }

  const toggleTool = (toolId: string): void => {
    setEditing((prev) => {
      if (prev === null) return prev
      const has = prev.toolIds.includes(toolId)
      return { ...prev, toolIds: has ? prev.toolIds.filter((t) => t !== toolId) : [...prev.toolIds, toolId] }
    })
  }

  const startNew = (): void => {
    setNotice(null)
    setEditing({
      id: uid('agent'),
      name: '',
      label: '',
      description: '',
      systemPrompt: '',
      toolIds: [],
      enabled: true,
      createdAt: nowIso()
    })
  }

  const startClone = (b: BuiltinSubagentMeta): void => {
    setNotice(null)
    setEditing({
      id: uid('agent'),
      name: '',
      label: `${b.label} · 克隆`,
      description: b.description,
      systemPrompt: b.systemPrompt,
      toolIds: [...b.toolIds],
      enabled: true,
      createdAt: nowIso()
    })
  }

  /** 一句话职责描述 → AI 生成子代理草稿并打开编辑框。 */
  const generate = async (): Promise<void> => {
    const p = genText.trim()
    if (p === '') {
      setGenErr('请先描述子代理职责（一句话即可）。')
      return
    }
    if (window.electronAPI?.generateSubagent === undefined) {
      setGenErr('AI 生成仅在 Electron 运行环境中可用。')
      return
    }
    setGenBusy(true)
    setGenErr(null)
    try {
      const taken = [...builtins.map((b) => b.id), ...items.map((i) => i.name)]
      const res = await window.electronAPI.generateSubagent(p, taken)
      if (!res.ok || res.draft === undefined) {
        setGenErr(res.message ?? '生成失败，请重试。')
        return
      }
      setEditing({ id: uid('agent'), ...res.draft, enabled: true, createdAt: nowIso() })
      setGenOpen(false)
      setGenText('')
      setNotice({ kind: 'ok', text: 'AI 已生成子代理草稿（name/说明/提示词/工具已填），检查无误后点「保存并重载」生效。' })
    } catch (error) {
      setGenErr(`生成失败：${error instanceof Error ? error.message : '未知错误'}`)
    } finally {
      setGenBusy(false)
    }
  }

  const isEditingNew = editing !== null && items.every((r) => r.id !== editing.id)

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-[12px] font-medium text-foreground">子代理</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              内置 {builtins.length} 个（只读种子）· 我的 {items.length} 个 · 变更保存后自动重载 Agent 即时生效
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" className="h-7" onClick={() => void reloadAfterChange()} title="重新初始化 Supervisor（按最新子代理注册）">
              <RefreshCw className="h-3.5 w-3.5 mr-1" />重载 Agent
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 border-violet-500/30 text-violet-600 hover:bg-violet-500/10 dark:text-violet-300"
              onClick={() => { setGenErr(null); setGenText(''); setGenOpen(true) }}
              title="用一句话职责描述让 AI 生成子代理草稿"
            >
              <Sparkles className="h-3.5 w-3.5 mr-1" />AI 生成
            </Button>
            <Button size="sm" className="h-7" onClick={startNew}>
              <Plus className="h-3.5 w-3.5 mr-1" />新增
            </Button>
          </div>
        </div>
        {notice !== null && (
          <p className={cn('mt-2 rounded-md px-2.5 py-1.5 text-[10px]', notice.kind === 'ok' ? 'bg-emerald-500/10 text-emerald-600' : 'bg-amber-500/10 text-amber-600')}>
            {notice.text}
          </p>
        )}
      </div>

      {/* 内置子代理（只读种子 + 克隆） */}
      {builtins.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] font-medium text-muted-foreground">内置（只读）· {builtins.length}</p>
          <div className="space-y-1.5">
            {builtins.map((b) => (
              <div key={b.id} className="flex items-center gap-2 rounded-lg border border-border/70 bg-card px-3 py-2">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <Lock className="h-3 w-3" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-medium text-foreground">{b.label} <span className="ml-1 font-mono text-[10px] text-muted-foreground">{b.id}</span></p>
                  <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{b.description} · {b.toolIds.length} 个工具</p>
                </div>
                <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[10px]" onClick={() => startClone(b)} title="克隆为自定义子代理（改 name / 提示词 / 工具后另存）">
                  <CopyPlus className="h-3 w-3 mr-1" />克隆
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 自定义子代理（增删改查 + 启停） */}
      <div>
        <p className="mb-1 text-[10px] font-medium text-muted-foreground">我的自定义子代理 · {items.length}</p>
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-7 text-center text-muted-foreground">
            <Bot className="mb-1.5 h-5 w-5 opacity-50" />
            <p className="text-[11px]">还没有自定义子代理。「克隆」内置子代理或点右上角「新增」创建，即可成为 Supervisor 可委派的模块。</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {items.map((rec) => (
              <div key={rec.id} className="flex items-center gap-2 rounded-lg border border-border/70 bg-card px-3 py-2">
                <Toggle on={rec.enabled === true} onChange={(v) => void toggleCustom(rec, v)} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-medium text-foreground">
                    {rec.label !== '' ? rec.label : rec.name}
                    <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">/agent:{rec.name}</span>
                    {rec.enabled === false && <span className="ml-1.5 rounded bg-muted px-1 py-px text-[9px] text-muted-foreground">已停用</span>}
                  </p>
                  {rec.description !== '' && (
                    <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{rec.description} · {rec.toolIds.length} 个工具</p>
                  )}
                </div>
                <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[10px]" onClick={() => { setNotice(null); setEditing({ ...rec, toolIds: [...rec.toolIds] }) }}>
                  <Pencil className="h-3 w-3" />
                </Button>
                <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[10px] text-destructive hover:text-destructive" onClick={() => void removeCustom(rec)}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* AI 一句话生成子代理草稿 */}
      <Dialog open={genOpen} onOpenChange={(open) => { if (!genBusy) { setGenOpen(open); setGenErr(null) } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>AI 生成子代理</DialogTitle>
            <DialogDescription>
              用一句话描述职责，AI 会生成 name / 一句话说明 / 系统提示词 / 工具白名单草稿；你可在编辑框检查后保存。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Textarea
              rows={3}
              className="text-[12px]"
              value={genText}
              onChange={(e) => setGenText(e.target.value)}
              placeholder={'如：把实验结果自动整理成周报并写入成长记录；或 从文献库挑选相关工作做方法对比综述'}
              autoFocus
            />
            {genErr !== null && <p className="text-[10px] text-amber-600">{genErr}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" className="h-7" disabled={genBusy} onClick={() => setGenOpen(false)}>取消</Button>
            <Button size="sm" className="h-7" disabled={genBusy || genText.trim() === ''} onClick={() => void generate()}>
              <Sparkles className={cn('h-3.5 w-3.5 mr-1', genBusy && 'animate-pulse')} />
              {genBusy ? '生成中…' : '生成草稿'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 编辑 / 新增对话框 */}
      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null) }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{isEditingNew ? '新增自定义子代理' : '编辑子代理'}</DialogTitle>
            <DialogDescription>
              name 是 Supervisor 委派标识（小写字母数字-，全局唯一）；label/说明/提示词决定何时委派与如何执行；工具只能从内置白名单勾选。
            </DialogDescription>
          </DialogHeader>
          {editing !== null && (
            <div className="grid grid-cols-2 gap-2.5">
              <div className="space-y-1">
                <Label className="text-[11px]">标识 name *</Label>
                <Input className="h-7 font-mono text-[12px]" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="my-researcher（小写字母数字-）" />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">展示名</Label>
                <Input className="h-7 text-[12px]" value={editing.label} onChange={(e) => setEditing({ ...editing, label: e.target.value })} placeholder="如：我的文献助手" />
              </div>
              <div className="col-span-2 space-y-1">
                <Label className="text-[11px]">一句话说明 *</Label>
                <Input className="h-7 text-[12px]" value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} placeholder="给 Supervisor 判断何时委派：负责什么、能力边界…" />
              </div>
              <div className="col-span-2 space-y-1">
                <Label className="text-[11px]">系统提示词 *</Label>
                <Textarea rows={6} className="text-[12px]" value={editing.systemPrompt} onChange={(e) => setEditing({ ...editing, systemPrompt: e.target.value })} placeholder="该子代理的角色、职责、纪律、输出格式…" />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label className="text-[11px]">工具集（内置白名单勾选 · {editing.toolIds.length} 个）</Label>
                <div className="flex flex-wrap gap-1">
                  {tools.length === 0 && <p className="text-[10px] text-muted-foreground">目录暂不可用（非 Electron 运行时不展示工具勾选）。</p>}
                  {tools.map((t) => {
                    const on = editing.toolIds.includes(t.id)
                    return (
                      <button
                        key={t.id}
                        type="button"
                        title={t.description}
                        onClick={() => toggleTool(t.id)}
                        className={cn(
                          'flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] transition-colors',
                          on ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border bg-background text-muted-foreground hover:bg-accent'
                        )}
                      >
                        {on && <Check className="h-2.5 w-2.5" />}
                        <span className="font-mono">{t.id}</span>
                        <span className="max-w-[140px] truncate">{t.label}</span>
                      </button>
                    )
                  })}
                </div>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px]" onClick={() => setEditing((p) => (p === null ? p : { ...p, toolIds: tools.map((t) => t.id) }))}>全选</Button>
                  <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px]" onClick={() => setEditing((p) => (p === null ? p : { ...p, toolIds: [] }))}>清空</Button>
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" className="h-7" onClick={() => setEditing(null)}>取消</Button>
            <Button size="sm" className="h-7" onClick={() => void saveEditing()} disabled={saving}>
              {saving ? '保存中…' : (<><Check className="h-3.5 w-3.5 mr-1" />保存并重载</>)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─── 插件管理（五个 tab） ──────────────────────────────────────────────
type PluginsTab = 'skills' | 'commands' | 'subagents' | 'plugins' | 'hooks'
const TABS: { id: PluginsTab; label: string; icon: React.ElementType; desc: string }[] = [
  { id: 'commands', label: '指令', icon: ListOrdered, desc: '内置只读 + 自定义指令增删改查（指令在对话时展开为任务提示）' },
  { id: 'skills', label: '技能', icon: Command, desc: '内置只读 + 自定义技能增删改查' },
  { id: 'subagents', label: '子代理', icon: Bot, desc: 'Supervisor 可委派的模块子代理注册（增删改查 + 启停）' },
  { id: 'plugins', label: '插件', icon: Puzzle, desc: '插件注册（增删改查 + 启停；配置留待运行时扩展消费）' },
  { id: 'hooks', label: 'Hooks', icon: Cable, desc: '事件钩子注册（增删改查 + 启停；留待运行时扩展消费）' }
]

export function Plugins() {
  const [tab, setTab] = useState<PluginsTab>('skills')

  return (
    <div className="flex h-full flex-col">
      <div className="drag-region flex h-12 shrink-0 items-center justify-between px-5">
        <span className="module-title">插件</span>
        <span className="text-[11px] text-muted-foreground">技能 · 子代理 · 插件 · Hooks 统一管理</span>
      </div>
      <div className="no-drag flex flex-wrap items-center gap-1.5 border-b border-border px-5 py-2">
        {TABS.map((t) => {
          const Icon = t.icon
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                'flex h-7 items-center gap-1.5 rounded-full px-3 text-[11px] font-medium transition-colors',
                tab === t.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          )
        })}
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="mx-auto max-w-3xl space-y-3">
          <p className="text-[10px] text-muted-foreground">{TABS.find((t) => t.id === tab)?.desc}</p>
          {tab === 'skills' && <SkillsPanel />}
          {tab === 'commands' && <CommandsPanel />}
          {tab === 'subagents' && <SubagentsPanel />}
          {tab === 'plugins' && (
            <CollectionPanel
              kind="plugin"
              storeKey={STORE_PLUGINS}
              title="插件"
              description="注册可插拔能力；运行时扩展消费这些配置前，可先作为能力清单管理。"
              labelOf={(r) => String(r.name ?? '')}
              makeEmpty={() => ({ name: '', description: '', kind: 'tool', config: '{}' })}
              fields={[
                { key: 'name', label: '名称 *', placeholder: '插件名' },
                { key: 'description', label: '说明', full: true },
                { key: 'kind', label: '类型', options: [{ value: 'tool', label: 'tool' }, { value: 'skill', label: 'skill' }, { value: 'hook', label: 'hook' }] },
                { key: 'config', label: '配置（JSON）', full: true, textarea: true, placeholder: '{"endpoint":"…","settings":{…}}' }
              ]}
            />
          )}
          {tab === 'hooks' && (
            <CollectionPanel
              kind="hook"
              storeKey={STORE_HOOKS}
              title="Hooks"
              description="注册事件钩子；运行时扩展消费这些配置前，可先作为钩子清单管理。"
              labelOf={(r) => `${String(r.event ?? '')} · ${String(r.name ?? '')}`}
              makeEmpty={() => ({ name: '', description: '', event: 'message:beforeSend', actionType: 'script', payload: '' })}
              fields={[
                { key: 'name', label: '名称 *', placeholder: '钩子名' },
                { key: 'event', label: '事件', options: [
                  { value: 'message:beforeSend', label: 'message:beforeSend' },
                  { value: 'message:afterComplete', label: 'message:afterComplete' },
                  { value: 'agent:beforeTool', label: 'agent:beforeTool' },
                  { value: 'agent:afterTool', label: 'agent:afterTool' }
                ] },
                { key: 'actionType', label: '执行方式', options: [
                  { value: 'script', label: 'script' },
                  { value: 'command', label: 'command' },
                  { value: 'http', label: 'http' }
                ] },
                { key: 'description', label: '说明', full: true },
                { key: 'payload', label: '脚本 / 命令 / URL', full: true, textarea: true }
              ]}
            />
          )}
        </div>
      </div>
    </div>
  )
}
