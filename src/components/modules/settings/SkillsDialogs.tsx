/**
 * 设置页的「技能管理」三件套弹窗：
 * 1. 技能管理（列表：内置只读 + 自定义可删）
 * 2. 技能详情（标题 / 触发词 / 说明 / 正文）
 * 3. 导入技能（手动填写 / 粘贴 JSON）
 *
 * 这三个弹窗共享同一组状态（列表、详情、导入草稿），原先内联在 `Settings.tsx`
 * 中，使该文件超过 2500 行。整体抽为本组件后，`Settings.tsx` 只需控制「是否打开」。
 */
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Code2, Eye, Loader2, Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  COMMAND_ENTRIES,
  SKILL_ENTRIES,
  loadUserSkills,
  saveUserSkills,
  createUserSkill,
  validateUserSkillDraft,
  parseUserSkillPayload,
  userSkillToEntry,
  USER_SKILL_ARGS_PLACEHOLDER
} from '@/lib/slash'
import type { SlashEntry, UserSkill, UserSkillDraft } from '@/lib/slash'

/** 「导入技能」手动表单的空白草稿。 */
const EMPTY_SKILL_DRAFT: UserSkillDraft = {
  trigger: '',
  title: '',
  description: '',
  whenToUse: '',
  argsHint: '',
  usage: '',
  body: ''
}

/** 技能管理弹窗中的一行（左：标题/触发词/说明；右：详情 + 可选删除）。 */
function SkillRow({
  title,
  trigger,
  description,
  onOpen,
  onDelete
}: {
  title: string
  trigger: string
  description: string
  onOpen: () => void
  onDelete?: () => void
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2.5">
      <button type="button" className="min-w-0 flex-1 cursor-pointer text-left" onClick={onOpen} title="查看详情">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-[12px] font-semibold text-foreground">{title}</span>
          <span className="shrink-0 rounded-full bg-emerald-500/10 px-1.5 py-px text-[9px] font-medium text-emerald-600">
            技能
          </span>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">/{trigger}</span>
        </div>
        {description !== '' && (
          <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{description}</p>
        )}
      </button>
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={onOpen}
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="查看详情"
        >
          <Eye className="h-3.5 w-3.5" />
        </button>
        {onDelete !== undefined && (
          <button
            type="button"
            onClick={onDelete}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            title="删除技能"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

export interface SkillsDialogsProps {
  /** 技能管理弹窗是否打开（由设置页控制，便于页内「技能」入口联动）。 */
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * 技能管理三件套弹窗。
 *
 * 自定义技能列表状态内聚在本组件；挂载即从磁盘读取一次。
 * 内置技能来自 `SKILL_ENTRIES`（只读）。
 */
export function SkillsDialogs({ open, onOpenChange }: SkillsDialogsProps) {
  const [userSkills, setUserSkills] = useState<UserSkill[]>([])
  const [skillDetail, setSkillDetail] = useState<
    { source: 'builtin'; entry: SlashEntry } | { source: 'custom'; skill: UserSkill } | null
  >(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importTab, setImportTab] = useState<'form' | 'json'>('form')
  const [importForm, setImportForm] = useState<UserSkillDraft>(EMPTY_SKILL_DRAFT)
  const [importJson, setImportJson] = useState('')
  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  /** 详情弹窗所需：统一为 SlashEntry + 正文（仅自定义技能有可编辑正文）。 */
  const skillDetailEntry = skillDetail !== null
    ? skillDetail.source === 'builtin'
      ? skillDetail.entry
      : userSkillToEntry(skillDetail.skill)
    : null
  const skillDetailBody = skillDetail?.source === 'custom' ? skillDetail.skill.body : null

  const refreshUserSkills = useCallback(async () => {
    try {
      setUserSkills(await loadUserSkills())
    } catch {
      setUserSkills([])
    }
  }, [])

  const openSkillImport = useCallback(() => {
    setImportForm(EMPTY_SKILL_DRAFT)
    setImportJson('')
    setImportTab('form')
    setImportMsg(null)
    setImportOpen(true)
  }, [])

  /** 提交一批草稿：逐条校验（语法 + 与内置/已导入的触发词查重），通过则创建并落盘。 */
  const confirmImportSkills = useCallback(async () => {
    setImporting(true)
    setImportMsg(null)
    try {
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
          setImportMsg({
            type: 'error',
            text: structuralErrors.length > 0 ? structuralErrors.join('\n') : '没有可导入的技能（请提供含 trigger/title/body 的对象）。'
          })
          return
        }
      } else {
        drafts.push(importForm)
      }

      const taken = new Set<string>([
        ...COMMAND_ENTRIES.map((e) => e.trigger),
        ...SKILL_ENTRIES.map((e) => e.trigger),
        ...userSkills.map((s) => s.trigger)
      ])
      const added: UserSkill[] = []
      const errors: string[] = [...structuralErrors]
      for (const draft of drafts) {
        const triggerLabel = draft.trigger.trim() === '' ? '（触发词为空）' : `/${draft.trigger.trim()}`
        const issues = validateUserSkillDraft(draft, taken)
        if (issues.length > 0) {
          errors.push(`${triggerLabel}：${issues.join('；')}`)
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
    } finally {
      setImporting(false)
    }
  }, [importTab, importJson, importForm, userSkills])

  /** 删除自定义技能（内置技能不可删）。 */
  const handleDeleteUserSkill = useCallback(
    async (skill: UserSkill) => {
      if (!window.confirm(`删除自定义技能「${skill.title}」？\n触发词 /${skill.trigger} 将从斜杠菜单移除。`)) return
      const next = userSkills.filter((s) => s.id !== skill.id)
      setUserSkills(next)
      if (skillDetail !== null && skillDetail.source === 'custom' && skillDetail.skill.id === skill.id) {
        setSkillDetail(null)
      }
      await saveUserSkills(next).catch(() => {})
    },
    [userSkills, skillDetail]
  )

  // 挂载时刷新一次自定义技能（供列表展示）。
  useEffect(() => {
    void refreshUserSkills()
  }, [refreshUserSkills])

  return (
    <>
      {/* 技能管理（列表 + 导入 / 查看详情 / 删除） */}
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-2xl">
          <div className="flex items-start justify-between gap-3 pr-6">
            <DialogHeader className="p-0">
              <DialogTitle>技能管理</DialogTitle>
              <DialogDescription>
                聊天输入框输入 <span className="font-mono text-primary">/</span> 会呼出「技能与指令」菜单。内置技能只读；自定义技能可导入与删除。
              </DialogDescription>
            </DialogHeader>
            <Button size="sm" className="mt-0.5 h-7 shrink-0" onClick={openSkillImport}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              导入技能
            </Button>
          </div>

          <div className="max-h-[58vh] space-y-4 overflow-y-auto pr-1">
            {/* 内置技能 */}
            <div className="space-y-1.5">
              <p className="text-[10px] font-medium text-muted-foreground">内置技能 · {SKILL_ENTRIES.length}</p>
              {SKILL_ENTRIES.map((entry) => (
                <SkillRow
                  key={`builtin-${entry.trigger}`}
                  title={entry.title.replace(/（.*）/, '')}
                  trigger={entry.trigger}
                  description={entry.description}
                  onOpen={() => setSkillDetail({ source: 'builtin', entry })}
                />
              ))}
            </div>

            {/* 自定义技能 */}
            <div className="space-y-1.5">
              <p className="text-[10px] font-medium text-muted-foreground">我的技能 · {userSkills.length}</p>
              {userSkills.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-6 text-muted-foreground">
                  <p className="text-[11px]">还没有自定义技能</p>
                  <Button variant="ghost" size="sm" className="mt-1 h-6 text-[10px]" onClick={openSkillImport}>
                    <Plus className="h-3 w-3 mr-1" />
                    导入第一个技能
                  </Button>
                </div>
              ) : (
                userSkills.map((skill) => (
                  <SkillRow
                    key={`custom-${skill.id}`}
                    title={skill.title}
                    trigger={skill.trigger}
                    description={skill.description}
                    onOpen={() => setSkillDetail({ source: 'custom', skill })}
                    onDelete={() => handleDeleteUserSkill(skill)}
                  />
                ))
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" className="h-7" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 技能详情 */}
      <Dialog open={skillDetail !== null} onOpenChange={(o) => { if (!o) setSkillDetail(null) }}>
        <DialogContent className="max-h-[85vh] sm:max-w-lg">
          {skillDetail !== null && skillDetailEntry !== null && (
            <>
              <DialogHeader className="pr-6">
                <DialogTitle className="flex items-center gap-2">
                  <span className="truncate">{skillDetailEntry.title}</span>
                  <span
                    className={cn(
                      'shrink-0 rounded-full px-1.5 py-px text-[9px] font-medium',
                      skillDetail.source === 'builtin' ? 'bg-primary/10 text-primary' : 'bg-emerald-500/10 text-emerald-600'
                    )}
                  >
                    {skillDetail.source === 'builtin' ? '内置' : '自定义'}
                  </span>
                </DialogTitle>
                <DialogDescription>斜杠技能详情与使用说明。</DialogDescription>
              </DialogHeader>

              <div className="space-y-3 overflow-y-auto text-[11px]">
                <div>
                  <p className="text-[10px] text-muted-foreground">触发方式</p>
                  <p className="mt-0.5 font-mono text-primary">/{skillDetailEntry.trigger}</p>
                </div>
                {skillDetailEntry.description !== '' && (
                  <div>
                    <p className="text-[10px] text-muted-foreground">说明</p>
                    <p className="mt-0.5 leading-relaxed text-foreground/90">{skillDetailEntry.description}</p>
                  </div>
                )}
                {skillDetailEntry.whenToUse !== '' && (
                  <div>
                    <p className="text-[10px] text-muted-foreground">适用场景</p>
                    <p className="mt-0.5 leading-relaxed text-foreground/90">{skillDetailEntry.whenToUse}</p>
                  </div>
                )}
                {skillDetailEntry.argsHint !== '' && (
                  <div>
                    <p className="text-[10px] text-muted-foreground">参数提示</p>
                    <p className="mt-0.5 font-mono text-foreground/90">{skillDetailEntry.argsHint}</p>
                  </div>
                )}
                {skillDetailEntry.usage !== '' && (
                  <div>
                    <p className="text-[10px] text-muted-foreground">用法示例</p>
                    <p className="mt-0.5 whitespace-pre-wrap rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-[10px] leading-relaxed text-foreground/90">
                      {skillDetailEntry.usage}
                    </p>
                  </div>
                )}
                {skillDetailBody !== null && (
                  <div>
                    <p className="text-[10px] text-muted-foreground">
                      任务正文{skillDetailBody.includes(USER_SKILL_ARGS_PLACEHOLDER) ? '（支持参数占位符）' : ''}
                    </p>
                    <pre className="mt-0.5 max-h-[36vh] overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-[10px] leading-relaxed text-foreground/90">
                      {skillDetailBody}
                    </pre>
                  </div>
                )}
                {skillDetailBody === null && (
                  <p className="rounded-md bg-muted/50 px-3 py-2 text-[10px] text-muted-foreground">
                    内置技能正文随版本提供，管理页不展示；在聊天输入框输入 /{skillDetailEntry.trigger} 后按回车即可调用。
                  </p>
                )}
              </div>

              <DialogFooter>
                <Button variant="outline" size="sm" className="h-7" onClick={() => setSkillDetail(null)}>
                  关闭
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* 导入技能 */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>导入技能</DialogTitle>
            <DialogDescription>
              新增一条自定义技能；导入后即可在聊天输入框用 <span className="font-mono text-primary">/触发词</span> 调用。
            </DialogDescription>
          </DialogHeader>

          {/* 导入方式切换 */}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => { setImportTab('form'); setImportMsg(null) }}
              className={cn(
                'flex items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-[12px] font-medium transition-colors',
                importTab === 'form' ? 'border-primary bg-primary/5 text-primary' : 'border-border text-muted-foreground hover:bg-accent'
              )}
            >
              <Plus className="h-3.5 w-3.5" />
              手动填写
            </button>
            <button
              type="button"
              onClick={() => { setImportTab('json'); setImportMsg(null) }}
              className={cn(
                'flex items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-[12px] font-medium transition-colors',
                importTab === 'json' ? 'border-primary bg-primary/5 text-primary' : 'border-border text-muted-foreground hover:bg-accent'
              )}
            >
              <Code2 className="h-3.5 w-3.5" />
              粘贴 JSON
            </button>
          </div>

          {importTab === 'form' ? (
            <div className="space-y-2.5">
              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1">
                  <Label className="text-[11px]">触发词 *</Label>
                  <Input
                    placeholder="my-skill"
                    value={importForm.trigger}
                    onChange={(e) => setImportForm({ ...importForm, trigger: e.target.value })}
                    className="h-7 text-[12px] font-mono"
                    autoFocus
                  />
                  <p className="text-[9px] text-muted-foreground">小写字母开头，可用 -</p>
                </div>
                <div className="col-span-2 space-y-1">
                  <Label className="text-[11px]">标题 *</Label>
                  <Input
                    placeholder="如：文献速读（my-skill）"
                    value={importForm.title}
                    onChange={(e) => setImportForm({ ...importForm, title: e.target.value })}
                    className="h-7 text-[12px]"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">一句话说明</Label>
                <Input
                  placeholder="在斜杠菜单里展示的一句话"
                  value={importForm.description}
                  onChange={(e) => setImportForm({ ...importForm, description: e.target.value })}
                  className="h-7 text-[12px]"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">适用场景</Label>
                <Input
                  placeholder="什么时候适合用这个技能？"
                  value={importForm.whenToUse}
                  onChange={(e) => setImportForm({ ...importForm, whenToUse: e.target.value })}
                  className="h-7 text-[12px]"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-[11px]">参数提示</Label>
                  <Input
                    placeholder="如 <研究方向>（可空）"
                    value={importForm.argsHint}
                    onChange={(e) => setImportForm({ ...importForm, argsHint: e.target.value })}
                    className="h-7 text-[12px] font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">用法示例</Label>
                  <Input
                    placeholder="如 /my-skill 多模态综述"
                    value={importForm.usage}
                    onChange={(e) => setImportForm({ ...importForm, usage: e.target.value })}
                    className="h-7 text-[12px] font-mono"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">任务正文（发给 Agent 的提示词）*</Label>
                <Textarea
                  rows={8}
                  placeholder="把你希望 Agent 执行的任务写清楚……正文里可用 {{args}} 占位本次调用参数。"
                  value={importForm.body}
                  onChange={(e) => setImportForm({ ...importForm, body: e.target.value })}
                  className="text-[11px] leading-relaxed"
                />
                <p className="text-[9px] text-muted-foreground">
                  调用时「/触发词 参数」中的参数会替换正文里的 {USER_SKILL_ARGS_PLACEHOLDER}；未提供参数时会给出提示语。
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label className="text-[11px]">技能 JSON（支持单个对象或数组）</Label>
              <Textarea
                rows={10}
                placeholder={JSON.stringify(
                  {
                    trigger: 'my-skill',
                    title: '我的技能（my-skill）',
                    description: '一句话说明',
                    whenToUse: '适用场景',
                    argsHint: '<方向>',
                    usage: '/my-skill 参数',
                    body: '请帮我…{{args}}…'
                  },
                  null,
                  2
                )}
                value={importJson}
                onChange={(e) => setImportJson(e.target.value)}
                className="font-mono text-[11px] leading-relaxed"
              />
              <p className="text-[9px] text-muted-foreground">
                字段：trigger（必填）、title（必填）、body（必填）、description / whenToUse / argsHint / usage（可选）。
              </p>
            </div>
          )}

          {importMsg !== null && (
            <div
              className={cn(
                'whitespace-pre-wrap rounded-md border px-3 py-2 text-[11px]',
                importMsg.type === 'ok'
                  ? 'border-green-500/30 bg-green-500/5 text-green-600'
                  : 'border-destructive/30 bg-destructive/5 text-destructive'
              )}
            >
              {importMsg.text}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" size="sm" className="h-7" onClick={() => setImportOpen(false)}>
              取消
            </Button>
            <Button size="sm" className="h-7" onClick={() => void confirmImportSkills()} disabled={importing}>
              {importing ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Plus className="h-3.5 w-3.5 mr-1" />}
              {importing ? '导入中...' : '导入'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
