/**
 * 自定义指令（由「插件 → 指令 → 导入指令」创建）。
 *
 * 与 registry 中的内置指令并列，以 L0 形态落地：输入 `/trigger 参数`
 * 时把「任务正文」展开为一段结构化提示发给 Agent。
 *
 * 存储：独立 store key `mimir:user-commands`（Electron store；浏览器降级
 * localStorage），增删即时生效，与 settings 的「保存设置」流程解耦。
 */
import type { SlashEntry } from './types'
import { USER_SKILL_TRIGGER_RE, USER_SKILL_ARGS_PLACEHOLDER } from './userSkills'

/** 自定义指令在 store 中的键名（同时用作浏览器 localStorage 键）。 */
export const USER_COMMAND_STORAGE_KEY = 'mimir:user-commands'

const NO_ARGS_HINT = '（本次未提供参数；若正文需要具体对象，先向用户澄清再开始。）'

/** 一条自定义指令（已持久化的记录）。 */
export interface UserCommand {
  readonly id: string
  readonly trigger: string
  readonly title: string
  readonly description: string
  readonly whenToUse: string
  readonly argsHint: string
  readonly usage: string
  readonly requiresArg: boolean
  /** 任务正文模板，可含 {{args}} 占位符。 */
  readonly body: string
  readonly createdAt: string
}

/** 用户填写的自定义指令草稿（尚未生成 id / createdAt）。 */
export type UserCommandDraft = Omit<UserCommand, 'id' | 'createdAt'>

/** 校验一条草稿；takenTriggers 为已占用的触发词（内置 + 已导入）。返回错误列表（空 = 通过）。 */
export function validateUserCommandDraft(draft: UserCommandDraft, takenTriggers: ReadonlySet<string>): string[] {
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

/** 由草稿生成一条可持久化的指令记录。 */
export function createUserCommand(draft: UserCommandDraft): UserCommand {
  return {
    id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    trigger: draft.trigger.trim(),
    title: draft.title.trim(),
    description: draft.description.trim(),
    whenToUse: draft.whenToUse.trim(),
    argsHint: draft.argsHint.trim(),
    usage: draft.usage.trim(),
    requiresArg: draft.requiresArg,
    body: draft.body,
    createdAt: new Date().toISOString()
  }
}

/** 自定义指令的任务正文展开：{{args}} 替换为参数；无参数给提示语；无占位符则前置参数行。 */
export function userCommandCompose(body: string, requiresArg: boolean): (args: string) => string {
  return (args: string): string => {
    const trimmed = args.trim()
    if (trimmed === '') {
      if (requiresArg) return body.includes(USER_SKILL_ARGS_PLACEHOLDER)
        ? body.replaceAll(USER_SKILL_ARGS_PLACEHOLDER, '（本次未附带参数。如需要，先向用户索要参数后再开始。）')
        : body
      return body.includes(USER_SKILL_ARGS_PLACEHOLDER)
        ? body.replaceAll(USER_SKILL_ARGS_PLACEHOLDER, NO_ARGS_HINT)
        : body
    }
    if (body.includes(USER_SKILL_ARGS_PLACEHOLDER)) {
      return body.replaceAll(USER_SKILL_ARGS_PLACEHOLDER, trimmed)
    }
    return `本次参数/说明：${trimmed}\n\n${body}`
  }
}

/** 把一条自定义指令转换为注册表条目（kind = 'command'），供菜单与 /xxx 解析使用。 */
export function userCommandToEntry(cmd: UserCommand): SlashEntry {
  return {
    trigger: cmd.trigger,
    kind: 'command',
    title: cmd.title,
    description: cmd.description,
    whenToUse: cmd.whenToUse,
    argsHint: cmd.argsHint,
    usage: cmd.usage,
    requiresArg: cmd.requiresArg,
    compose: userCommandCompose(cmd.body, cmd.requiresArg)
  }
}

/** 解析「导入指令」粘贴的 JSON：接受单个对象或对象数组。返回草稿列表与错误信息。 */
export function parseUserCommandPayload(raw: unknown): { drafts: UserCommandDraft[]; errors: string[] } {
  const drafts: UserCommandDraft[] = []
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
      requiresArg: typeof rec.requiresArg === 'boolean' ? rec.requiresArg : false,
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

/** 加载全部自定义指令（脏数据自动过滤）。 */
export async function loadUserCommands(): Promise<UserCommand[]> {
  const raw = await storeRead<unknown>(USER_COMMAND_STORAGE_KEY)
  if (!Array.isArray(raw)) return []
  const list: UserCommand[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    if (typeof rec.trigger !== 'string' || typeof rec.title !== 'string' || typeof rec.body !== 'string') continue
    if (!USER_SKILL_TRIGGER_RE.test(rec.trigger.trim())) continue
    list.push({
      id: typeof rec.id === 'string' && rec.id !== '' ? rec.id : `cmd-${Math.random().toString(36).slice(2, 10)}`,
      trigger: rec.trigger.trim(),
      title: rec.title.trim(),
      description: typeof rec.description === 'string' ? rec.description.trim() : '',
      whenToUse: typeof rec.whenToUse === 'string' ? rec.whenToUse.trim() : '',
      argsHint: typeof rec.argsHint === 'string' ? rec.argsHint.trim() : '',
      usage: typeof rec.usage === 'string' ? rec.usage.trim() : '',
      requiresArg: typeof rec.requiresArg === 'boolean' ? rec.requiresArg : false,
      body: rec.body,
      createdAt: typeof rec.createdAt === 'string' ? rec.createdAt : ''
    })
  }
  return list
}

/** 保存自定义指令列表（覆盖式）。 */
export async function saveUserCommands(cmds: readonly UserCommand[]): Promise<void> {
  await storeWrite(
    USER_COMMAND_STORAGE_KEY,
    cmds.map((cmd) => ({ ...cmd }))
  )
}
