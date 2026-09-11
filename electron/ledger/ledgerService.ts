/**
 * 科研记录（Ledger）服务：手动 + 事件驱动自动沉淀。
 *
 * 存储：当前科研空间的 store key `ledger:entries`（非 GLOBAL_KEYS，天然按空间隔离）。
 *
 * 自动条目通过 {@link appendLedger} 写入，携带 `auto.refKey` 做幂等去重，
 * 避免同一事件（如重复编译）产生多条记录。
 */

import { getStoreValue, setStoreValue } from '../library/store'

export type LedgerEntryType = 'milestone' | 'progress' | 'paper' | 'experiment'

/** 自动生成标记：source 标识事件来源，refKey 用于幂等去重。 */
export interface LedgerAutoMark {
  readonly source: string
  readonly refKey: string
}

export interface LedgerEntry {
  readonly id: string
  readonly title: string
  readonly content: string
  readonly type: LedgerEntryType
  /** YYYY-MM-DD（本地日期）。 */
  readonly date: string
  readonly auto?: LedgerAutoMark
}

const STORAGE_KEY = 'ledger:entries'

function todayYmd(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function readEntries(): LedgerEntry[] {
  const raw = getStoreValue<LedgerEntry[]>(STORAGE_KEY)
  return Array.isArray(raw) ? raw : []
}

/** 全部记录（新的在前），供 Ledger 模块读取。 */
export function listLedgerEntries(): LedgerEntry[] {
  return readEntries()
}

export interface AppendLedgerInput {
  readonly title: string
  readonly content: string
  readonly type: LedgerEntryType
  readonly date?: string
  readonly auto?: LedgerAutoMark
}

/**
 * 追加一条记录。
 * - 携带 `auto.refKey` 时按 (source, refKey) 幂等：已存在则跳过，返回 null。
 * - 返回新写入的条目（被跳过时为 null）。
 */
export function appendLedger(input: AppendLedgerInput): LedgerEntry | null {
  const entries = readEntries()
  if (input.auto !== undefined) {
    const dup = entries.some(
      (e) => e.auto?.source === input.auto!.source && e.auto.refKey === input.auto!.refKey
    )
    if (dup) return null
  }
  const entry: LedgerEntry = {
    id: `ledger-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title: input.title,
    content: input.content,
    type: input.type,
    date: input.date ?? todayYmd(),
    ...(input.auto !== undefined ? { auto: input.auto } : {})
  }
  setStoreValue(STORAGE_KEY, [entry, ...entries])
  return entry
}
