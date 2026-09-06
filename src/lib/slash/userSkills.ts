/**
 * 自定义技能（由「设置 → 技能管理 → 导入技能」创建）。
 *
 * 与 registry 中的内置 research-* 技能并列，均以 L0 形态落地：输入
 * `/trigger 参数` 时把「任务正文」展开为一段结构化提示发给 Agent。
 *
 * 存储：独立 store key `mimir:user-skills`（Electron store；浏览器降级
 * localStorage），增删即时生效，与 settings 的「保存设置」流程解耦。
 */

import type { SlashEntry } from './types'

/** 触发词合法形态：小写字母开头，仅含 [a-z0-9-]（与 registry 的 /trigger 解析一致）。 */
export const USER_SKILL_TRIGGER_RE = /^[a-z][a-z0-9-]*$/

/** 自定义技能在 store 中的键名（同时用作浏览器 localStorage 键）。 */
export const USER_SKILL_STORAGE_KEY = 'mimir:user-skills'

/** 正文中代表「本次参数」的占位符。 */
export const USER_SKILL_ARGS_PLACEHOLDER = '{{args}}'

const NO_ARGS_HINT = '（本次未提供参数；若正文需要具体对象，先向用户澄清再开始。）'

/** 一条自定义技能（已持久化的记录）。 */
export interface UserSkill {
  readonly id: string
  readonly trigger: string
  readonly title: string
  readonly description: string
  readonly whenToUse: string
  readonly argsHint: string
  readonly usage: string
  /** 任务正文模板，可含 {{args}} 占位符。 */
  readonly body: string
  readonly createdAt: string
}

/** 用户填写的自定义技能草稿（尚未生成 id / createdAt）。 */
export type UserSkillDraft = Omit<UserSkill, 'id' | 'createdAt'>

/** 校验一条草稿；takenTriggers 为已占用的触发词（内置 + 已导入）。返回错误列表（空 = 通过）。 */
export function validateUserSkillDraft(draft: UserSkillDraft, takenTriggers: ReadonlySet<string>): string[] {
  const errors: string[] = []
  const trigger = draft.trigger.trim()
  if (trigger === '') {
    errors.push('触发词不能为空')
  } else if (!USER_SKILL_TRIGGER_RE.test(trigger)) {
    errors.push('触发词需为小写字母开头，且仅含小写字母/数字/中划线')
  } else if (takenTriggers.has(trigger)) {
    errors.push(`触发词 /${trigger} 已存在`)
  }
  if (draft.title.trim() === '') errors.push('标题不能为空')
  if (draft.body.trim() === '') errors.push('任务正文不能为空')
  return errors
}

/** 由草稿生成一条可持久化的技能记录。 */
export function createUserSkill(draft: UserSkillDraft): UserSkill {
  return {
    id: `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    trigger: draft.trigger.trim(),
    title: draft.title.trim(),
    description: draft.description.trim(),
    whenToUse: draft.whenToUse.trim(),
    argsHint: draft.argsHint.trim(),
    usage: draft.usage.trim(),
    body: draft.body,
    createdAt: new Date().toISOString()
  }
}

/** 自定义技能的任务正文展开：{{args}} 替换为参数；无参数给提示语；无占位符则前置参数行。 */
export function userSkillCompose(body: string): (args: string) => string {
  return (args: string): string => {
    const trimmed = args.trim()
    if (trimmed === '') {
      return body.includes(USER_SKILL_ARGS_PLACEHOLDER)
        ? body.replaceAll(USER_SKILL_ARGS_PLACEHOLDER, NO_ARGS_HINT)
        : body
    }
    if (body.includes(USER_SKILL_ARGS_PLACEHOLDER)) {
      return body.replaceAll(USER_SKILL_ARGS_PLACEHOLDER, trimmed)
    }
    // 正文没有占位符时，把参数作为「本次任务对象」行前置，避免用户输入被吞掉。
    return `本次任务对象：${trimmed}\n\n${body}`
  }
}

/** 把一条自定义技能转换为注册表条目（kind = 'skill'），供菜单与 /xxx 解析使用。 */
export function userSkillToEntry(skill: UserSkill): SlashEntry {
  return {
    trigger: skill.trigger,
    kind: 'skill',
    title: skill.title,
    description: skill.description,
    whenToUse: skill.whenToUse,
    argsHint: skill.argsHint,
    usage: skill.usage,
    requiresArg: false,
    compose: userSkillCompose(skill.body)
  }
}

/** 解析「导入技能」粘贴的 JSON：接受单个对象或对象数组。返回草稿列表与错误信息。 */
export function parseUserSkillPayload(raw: unknown): { drafts: UserSkillDraft[]; errors: string[] } {
  const drafts: UserSkillDraft[] = []
  const errors: string[] = []
  const records = Array.isArray(raw) ? raw : [raw]
  records.forEach((item, index) => {
    const label = Array.isArray(raw) ? `第 ${index + 1} 条` : '该条'
    if (typeof item !== 'object' || item === null) {
      errors.push(`${label}不是对象`)
      return
    }
    const rec = item as Record<string, unknown>
    const trigger = typeof rec.trigger === 'string' ? rec.trigger.trim() : ''
    if (trigger === '') {
      errors.push(`${label}缺少 trigger`)
      return
    }
    drafts.push({
      trigger,
      title: typeof rec.title === 'string' ? rec.title.trim() : '',
      description: typeof rec.description === 'string' ? rec.description.trim() : '',
      whenToUse: typeof rec.whenToUse === 'string' ? rec.whenToUse.trim() : '',
      argsHint: typeof rec.argsHint === 'string' ? rec.argsHint.trim() : '',
      usage: typeof rec.usage === 'string' ? rec.usage.trim() : '',
      body: typeof rec.body === 'string' ? rec.body : ''
    })
  })
  return { drafts, errors }
}

async function storeRead<T>(key: string): Promise<T | undefined> {
  if (window.electronAPI?.getStoreValue) {
    try {
      return await window.electronAPI.getStoreValue<T>(key)
    } catch {
      return undefined
    }
  }
  try {
    const cached = localStorage.getItem(key)
    return cached ? (JSON.parse(cached) as T) : undefined
  } catch {
    return undefined
  }
}

async function storeWrite<T>(key: string, value: T): Promise<void> {
  if (window.electronAPI?.setStoreValue) {
    await window.electronAPI.setStoreValue(key, value)
    return
  }
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // ignore
  }
}

/** 加载全部自定义技能（脏数据自动过滤）。 */
export async function loadUserSkills(): Promise<UserSkill[]> {
  const raw = await storeRead<unknown>(USER_SKILL_STORAGE_KEY)
  if (!Array.isArray(raw)) return []
  const list: UserSkill[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    if (typeof rec.trigger !== 'string' || typeof rec.title !== 'string' || typeof rec.body !== 'string') continue
    if (!USER_SKILL_TRIGGER_RE.test(rec.trigger.trim())) continue
    list.push({
      id: typeof rec.id === 'string' && rec.id !== '' ? rec.id : `skill-${Math.random().toString(36).slice(2, 10)}`,
      trigger: rec.trigger.trim(),
      title: rec.title.trim(),
      description: typeof rec.description === 'string' ? rec.description.trim() : '',
      whenToUse: typeof rec.whenToUse === 'string' ? rec.whenToUse.trim() : '',
      argsHint: typeof rec.argsHint === 'string' ? rec.argsHint.trim() : '',
      usage: typeof rec.usage === 'string' ? rec.usage.trim() : '',
      body: rec.body,
      createdAt: typeof rec.createdAt === 'string' ? rec.createdAt : ''
    })
  }
  return list
}

/** 保存自定义技能列表（覆盖式）。 */
export async function saveUserSkills(skills: readonly UserSkill[]): Promise<void> {
  await storeWrite(
    USER_SKILL_STORAGE_KEY,
    skills.map((skill) => ({ ...skill }))
  )
}
