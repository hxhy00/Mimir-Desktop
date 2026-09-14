/**
 * 会话上下文治理（electron/agent/contextManager.ts）单元测试。
 *
 * 约定：
 * - store 是同步 API，这里用 `vi.mock` 换成内存实现，绝不接触真实文件系统；
 * - 用 `setTokenCounter` 注入确定性计数器（1 字符 = 1 token），让阈值判定可预测；
 * - 每个用例用独立 conversationId，避免用例之间相互污染。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** 内存 store + 可控抛错开关（vi.mock 工厂与用例共享同一引用）。 */
const fakeStore = vi.hoisted(() => ({
  memory: new Map<string, unknown>(),
  state: { throwOnGet: false }
}))

vi.mock('../stubs/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stubs/store')>()
  return {
    ...actual,
    getStoreValue: (key: string): unknown => {
      if (fakeStore.state.throwOnGet) throw new Error('store unavailable')
      return fakeStore.memory.get(key)
    },
    setStoreValue: (key: string, value: unknown): void => {
      fakeStore.memory.set(key, value)
    },
    currentSpaceEpoch: (): string => 'test-space#0',
    assertSpaceUnchanged: (): void => {}
  }
})

import {
  COMPRESS_FAIL_PREFIX,
  HISTORY_ARCHIVE_PREFIX,
  REMINDER_STORE_PREFIX,
  buildCapabilityDeclarationText,
  buildGovernedHistory,
  contextLimits,
  countContextTokens,
  findChunkStart,
  observeToolEvent,
  purgeConversation,
  reminderTextFromEvent,
  resetConversation,
  setTokenCounter,
  sumTokens,
  truncateToTail,
  type HistoryMsg,
  type ToolEventLike
} from '../../electron/agent/contextManager'

/**
 * 构造一条「工具已完成并返回文本」的事件。
 *
 * 注意：这里构造的是**结构化**事件（`step.resultSummary`），不是文案事件。
 * 失效提醒已改为只认结构化字段 —— 靠解析 `text` 里 `' 返回：'` 的做法已删除
 * （那种写法只要有人改一句文案就会静默失效，见 `reminderTextFromEvent` 的说明）。
 */
function toolDone(name: string, returned: string): ToolEventLike {
  return {
    taskId: 't',
    title: name,
    status: 'done',
    kind: 'tool',
    step: { name, stage: 'result', resultSummary: returned }
  }
}

/** 交替 user/assistant、每条 perMsg 字符的历史（注入 length 计数器时即 perMsg token）。 */
function makeHistory(count: number, perMsg: number): HistoryMsg[] {
  const out: HistoryMsg[] = []
  for (let i = 0; i < count; i += 1) {
    out.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'x'.repeat(perMsg) })
  }
  return out
}

const sizesOf = (msgs: readonly HistoryMsg[]): number[] => msgs.map((m) => countContextTokens(m.content))

beforeEach(() => {
  fakeStore.memory.clear()
  fakeStore.state.throwOnGet = false
  setTokenCounter((t) => t.length)
})

afterEach(() => {
  setTokenCounter(null)
})

describe('countContextTokens / sumTokens：token 计数接缝', () => {
  it('注入计数器后按注入实现走', () => {
    setTokenCounter((t) => t.length)
    expect(countContextTokens('hello')).toBe(5)
    expect(
      sumTokens([
        { role: 'user', content: 'abcd' },
        { role: 'assistant', content: 'xy' }
      ])
    ).toBe(6)
  })

  it('注入任意计数器都生效（非字符实现）', () => {
    setTokenCounter(() => 42)
    expect(countContextTokens('任意文本')).toBe(42)
  })

  it('setTokenCounter(null) 后走字符估算兜底：中文 1/字、英文 1/4', () => {
    setTokenCounter(null)
    expect(countContextTokens('')).toBe(0)
    expect(countContextTokens('中文')).toBe(2)
    expect(countContextTokens('abcd')).toBe(1)
    expect(countContextTokens('中ab')).toBe(2) // 1 个 CJK + ceil(2/4)
  })
})

describe('findChunkStart：窗口断点只落在 user 边界', () => {
  it('边界只落在 role === "user" 上', () => {
    const msgs = makeHistory(4, 10)
    const start = findChunkStart(msgs, sizesOf(msgs), 4, 25)
    expect(start).toBe(2)
    expect(msgs[start].role).toBe('user')
  })

  it('超预算即停止：单条候选已超预算时返回原 end', () => {
    const msgs: HistoryMsg[] = [{ role: 'user', content: 'x'.repeat(100) }]
    expect(findChunkStart(msgs, sizesOf(msgs), 1, 50)).toBe(1)
  })

  it('没有任何 user 边界且预算充足时收束到段首 0（整段返回，不硬切）', () => {
    const msgs: HistoryMsg[] = [
      { role: 'assistant', content: 'x'.repeat(10) },
      { role: 'assistant', content: 'y'.repeat(10) }
    ]
    expect(findChunkStart(msgs, sizesOf(msgs), 2, 1000)).toBe(0)
  })
})

describe('truncateToTail：只保留最近窗口', () => {
  const msgs: HistoryMsg[] = [
    { role: 'user', content: 'a'.repeat(10) },
    { role: 'assistant', content: 'b'.repeat(10) },
    { role: 'assistant', content: 'c'.repeat(10) }
  ]

  it('按预算从尾部保留，丢弃更早的消息', () => {
    const cut = truncateToTail(msgs, sizesOf(msgs), 20, false)
    expect(cut).toHaveLength(2)
    expect(cut).toEqual([msgs[1], msgs[2]])
  })

  it('noticeTruncated = true 时在队首插入截断提示', () => {
    const cut = truncateToTail(msgs, sizesOf(msgs), 20, true)
    expect(cut).toHaveLength(3)
    expect(cut[0].role).toBe('assistant')
    expect(cut[0].content).toContain('【注意】')
    expect(cut[0].content).toContain('被截断')
  })

  it('单条超预算时按尾部裁剪（保留最近的正文）', () => {
    const single: HistoryMsg[] = [{ role: 'user', content: 'abcdefghij' }]
    const cut = truncateToTail(single, sizesOf(single), 4, false)
    expect(cut).toHaveLength(1)
    expect(cut[0].content).toBe('ghij')
  })
})

describe('reminderTextFromEvent：从工具事件识别失效对象', () => {
  it('非 tool 事件返回 null', () => {
    expect(reminderTextFromEvent({ taskId: 't', title: 'x', status: 'done' })).toBeNull()
    expect(
      reminderTextFromEvent({
        taskId: 't',
        title: 'x',
        status: 'done',
        kind: 'think',
        step: { name: 'x', stage: 'result', resultSummary: '删除' }
      })
    ).toBeNull()
  })

  it('status 非 done 返回 null', () => {
    expect(
      reminderTextFromEvent({
        taskId: 't',
        title: 'x',
        status: 'running',
        kind: 'tool',
        step: { name: 'x', stage: 'result', resultSummary: '删除' }
      })
    ).toBeNull()
  })

  it('缺少结构化结果（无 step / stage 非 result / 空 resultSummary）返回 null', () => {
    // 无 step：即便 text 里写着「删除」也不认 —— 语义只从结构化字段读
    expect(
      reminderTextFromEvent({ taskId: 't', title: 'x', status: 'done', kind: 'tool', text: 'x 返回：删除' })
    ).toBeNull()
    // stage 是 call（调用行，不是返回行）
    expect(
      reminderTextFromEvent({
        taskId: 't',
        title: 'x',
        status: 'done',
        kind: 'tool',
        step: { name: 'x', stage: 'call', argsSummary: '删除' }
      } as ToolEventLike)
    ).toBeNull()
    // resultSummary 缺失
    expect(
      reminderTextFromEvent({
        taskId: 't',
        title: 'x',
        status: 'done',
        kind: 'tool',
        step: { name: 'x', stage: 'result' }
      })
    ).toBeNull()
  })

  it('非破坏性返回文本返回 null', () => {
    expect(reminderTextFromEvent(toolDone('read_file', '读取成功，共 10 行'))).toBeNull()
  })

  it('命中「删除/改名/覆盖/清空/回退」返回提醒文本', () => {
    const text = reminderTextFromEvent(toolDone('set_paper', '已覆盖旧标签'))
    expect(text).not.toBeNull()
    expect(text).toContain('set_paper')
    expect(text).toContain('执行后：')
    expect(text).toContain('已覆盖旧标签')
    expect(text).toContain('（若相关对象已被删除/改名/覆盖')
    expect(text).not.toContain('…')
  })

  it('长文本截断到 60 字 + 省略号', () => {
    const returned = `删除${'a'.repeat(80)}`
    const text = reminderTextFromEvent(toolDone('write_file', returned))!
    expect(text).toContain(`${returned.slice(0, 60)}…`)
    expect(text).not.toContain(returned) // 完整长文本不应出现
  })
})

describe('observeToolEvent：失效提醒登记', () => {
  it('命中时写入 store', () => {
    const conv = 'obs-hit'
    const ev = toolDone('write_file', '删除 old.txt')
    observeToolEvent(conv, ev)
    const list = fakeStore.memory.get(REMINDER_STORE_PREFIX + conv) as string[]
    expect(list).toHaveLength(1)
    expect(list[0]).toBe(reminderTextFromEvent(ev))
  })

  it('连续同款去重（不重复写入）', () => {
    const conv = 'obs-dedupe'
    const ev = toolDone('write_file', '删除 old.txt')
    observeToolEvent(conv, ev)
    observeToolEvent(conv, ev)
    expect(fakeStore.memory.get(REMINDER_STORE_PREFIX + conv) as string[]).toHaveLength(1)
  })

  it('超过 20 条时只保留最近 20 条', () => {
    const conv = 'obs-limit'
    for (let i = 0; i < 25; i += 1) {
      observeToolEvent(conv, toolDone(`t${i}`, `删除记录 ${i}`))
    }
    const list = fakeStore.memory.get(REMINDER_STORE_PREFIX + conv) as string[]
    expect(list).toHaveLength(20)
    expect(list[0]).toBe(reminderTextFromEvent(toolDone('t5', '删除记录 5')))
    expect(list[19]).toBe(reminderTextFromEvent(toolDone('t24', '删除记录 24')))
  })

  it('store 抛错时不向外抛（尽力而为）', () => {
    fakeStore.state.throwOnGet = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(() => observeToolEvent('obs-throw', toolDone('write_file', '删除'))).not.toThrow()
    warn.mockRestore()
  })

  it('非破坏性事件不写入 store', () => {
    const conv = 'obs-noop'
    observeToolEvent(conv, toolDone('read_file', '读取成功'))
    expect(fakeStore.memory.get(REMINDER_STORE_PREFIX + conv)).toBeUndefined()
  })
})

describe('buildGovernedHistory：治理总入口', () => {
  it('历史为空 → 返回空数组、compressed=false', async () => {
    const outcome = await buildGovernedHistory({
      conversationId: 'gov-empty',
      messages: [],
      compress: vi.fn(async () => ({ ok: true, summary: 'S' }))
    })
    expect(outcome).toEqual({ history: [], compressed: false, tokens: 0, truncated: false })
  })

  it('已累积的失效提醒被前置到历史（最新在前）', async () => {
    const conv = 'gov-reminder'
    fakeStore.memory.set(REMINDER_STORE_PREFIX + conv, ['r1', 'r2'])
    const messages: HistoryMsg[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' }
    ]
    const outcome = await buildGovernedHistory({
      conversationId: conv,
      messages,
      compress: vi.fn(async () => ({ ok: true, summary: 'S' }))
    })
    expect(outcome.history[0]).toEqual({ role: 'assistant', content: 'r2' })
    expect(outcome.history[1]).toEqual({ role: 'assistant', content: 'r1' })
    expect(outcome.history.slice(2)).toEqual(messages)
    expect(outcome.compressed).toBe(false)
  })

  it('未超阈值 → 原样返回，且余量充足时把熔断计数重置为 0', async () => {
    const conv = 'gov-under'
    fakeStore.memory.set(COMPRESS_FAIL_PREFIX + conv, 2)
    const messages: HistoryMsg[] = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好，我是 Mimir' }
    ]
    const compress = vi.fn(async () => ({ ok: true, summary: 'S' }))
    const outcome = await buildGovernedHistory({ conversationId: conv, messages, compress })

    expect(compress).not.toHaveBeenCalled()
    expect(outcome.compressed).toBe(false)
    expect(outcome.truncated).toBe(false)
    expect(outcome.history).toEqual(messages)
    expect(outcome.tokens).toBe(sumTokens(messages))
    expect(fakeStore.memory.get(COMPRESS_FAIL_PREFIX + conv)).toBe(0)
  })

  it('超阈值 + 压缩成功 → 摘要 + 能力提醒 + 最近窗口原文，且归档原文', async () => {
    const conv = 'gov-ok'
    const L = contextLimits()
    const perMsg = Math.floor(L.compressChunkTokens / 2)
    const count = Math.ceil(L.maxTokens / perMsg) + 4
    const messages = makeHistory(count, perMsg)
    expect(sumTokens(messages)).toBeGreaterThan(L.maxTokens)

    const chunks: HistoryMsg[][] = []
    const compress = vi.fn(async (chunk: HistoryMsg[]) => {
      chunks.push(chunk)
      return { ok: true, summary: `摘要${chunks.length}` }
    })
    const outcome = await buildGovernedHistory({ conversationId: conv, messages, compress })

    expect(compress).toHaveBeenCalled()
    for (const chunk of chunks) expect(sumTokens(chunk)).toBeLessThanOrEqual(L.compressChunkTokens)

    const start = findChunkStart(messages, sizesOf(messages), messages.length, L.keepTailTokens)
    expect(start).toBeGreaterThan(0)
    const tail = messages.slice(start)

    expect(outcome.compressed).toBe(true)
    expect(outcome.truncated).toBe(false)
    expect(outcome.history[0].content.startsWith('【更早对话摘要（已压缩）】')).toBe(true)
    expect(outcome.history[1].content).toContain('【能力提醒')
    expect(outcome.history[1].content).toContain('read_file/write_file/edit_file/glob/grep/ls/execute')
    expect(outcome.history.slice(2)).toEqual(tail)
    expect(outcome.tokens).toBe(sumTokens(outcome.history))

    const archive = fakeStore.memory.get(HISTORY_ARCHIVE_PREFIX + conv) as unknown[]
    expect(Array.isArray(archive)).toBe(true)
    expect(archive).toHaveLength(chunks.length)
  })

  it('压缩全部失败 → 降级为截断、truncated=true，且熔断计数 +1', async () => {
    const conv = 'gov-fail'
    const L = contextLimits()
    const perMsg = Math.floor(L.compressChunkTokens / 2)
    const count = Math.ceil(L.maxTokens / perMsg) + 4
    const messages = makeHistory(count, perMsg)

    const compress = vi.fn(async () => ({ ok: false, message: 'boom' }))
    const outcome = await buildGovernedHistory({ conversationId: conv, messages, compress })

    expect(compress).toHaveBeenCalledTimes(L.failLimit) // 段级熔断：连续失败即停
    expect(outcome.compressed).toBe(false)
    expect(outcome.truncated).toBe(true)
    expect(fakeStore.memory.get(COMPRESS_FAIL_PREFIX + conv)).toBe(1)

    const expected = truncateToTail(messages, sizesOf(messages), L.keepTailTokens, false)
    expect(outcome.history).toEqual(expected)
  })

  it('熔断计数已达上限 → 不再调用 compress，直接截断并在队首提示', async () => {
    const conv = 'gov-breaker'
    const L = contextLimits()
    const perMsg = Math.floor(L.compressChunkTokens / 2)
    const count = Math.ceil(L.maxTokens / perMsg) + 4
    const messages = makeHistory(count, perMsg)
    fakeStore.memory.set(COMPRESS_FAIL_PREFIX + conv, L.failLimit)

    const compress = vi.fn(async () => ({ ok: true, summary: '不应被调用' }))
    const outcome = await buildGovernedHistory({ conversationId: conv, messages, compress })

    expect(compress).not.toHaveBeenCalled()
    expect(outcome.compressed).toBe(false)
    expect(outcome.truncated).toBe(true)
    expect(outcome.history[0].content).toContain('【注意】')
    expect(outcome.history[0].content).toContain('被截断')
    expect(fakeStore.memory.get(COMPRESS_FAIL_PREFIX + conv)).toBe(L.failLimit)
  })

  it('无更早内容可压（整段仅一条且自身超阈值）→ 原样返回，不静默截断用户刚粘贴的长文', async () => {
    const conv = 'gov-single'
    const L = contextLimits()
    const content = 'x'.repeat(L.maxTokens + 1000)
    const messages: HistoryMsg[] = [{ role: 'user', content }]
    const compress = vi.fn(async () => ({ ok: true, summary: 'S' }))
    const outcome = await buildGovernedHistory({ conversationId: conv, messages, compress })

    // findChunkStart 返回 end（此处 1），start 归一化后归 0 → 走「原样返回」分支：
    // 不压缩、不截断（静默截断用户刚粘贴的长文比超预算更糟）。
    expect(findChunkStart(messages, sizesOf(messages), messages.length, L.keepTailTokens)).toBe(1)
    expect(compress).not.toHaveBeenCalled()
    expect(outcome.compressed).toBe(false)
    expect(outcome.truncated).toBe(false)
    expect(outcome.history).toEqual(messages)
    expect(fakeStore.memory.get(COMPRESS_FAIL_PREFIX + conv) ?? 0).toBe(0)
  })

  it('边界消息自身超分段预算（[大,大,小]）→ 强制前进，旧历史仍被分段压缩', async () => {
    const conv = 'gov-forced-advance'
    const L = contextLimits()
    // [大, 大, 小]：total > MAX，且 head 边界那条（B）自身就 > COMPRESS_CHUNK_TOKENS。
    const messages: HistoryMsg[] = [
      { role: 'user', content: 'a'.repeat(20000) },
      { role: 'user', content: 'b'.repeat(15000) },
      { role: 'user', content: 'c'.repeat(5000) }
    ]
    expect(sumTokens(messages)).toBeGreaterThan(L.maxTokens)
    expect(messages[1].content.length).toBeGreaterThan(L.compressChunkTokens)

    const chunks: HistoryMsg[][] = []
    const compress = vi.fn(async (chunk: HistoryMsg[]) => {
      chunks.push(chunk)
      return { ok: true, summary: 'S' }
    })
    const outcome = await buildGovernedHistory({ conversationId: conv, messages, compress })

    // 修复前：边界消息 B 自身超预算 → findChunkStart 切出空段 → 一段都不压、静默截断
    //（明明 A、B 都可压）。修复后：强制前进，B、A 各独占一段被压缩（从新到旧）。
    expect(compress).toHaveBeenCalledTimes(2)
    expect(chunks.map((c) => c.map((m) => m.content.length))).toEqual([[15000], [20000]])
    expect(outcome.compressed).toBe(true)
    expect(outcome.truncated).toBe(false)
    expect(outcome.history[0].content.startsWith('【更早对话摘要（已压缩）】')).toBe(true)
    expect(outcome.history.slice(2)).toEqual([messages[2]]) // tail 只保留最新一条 C
    expect(fakeStore.memory.get(COMPRESS_FAIL_PREFIX + conv) ?? 0).toBe(0)
  })

  it('尾窗口保最新一条：最新一条自身超 keepTailTokens 时仍原样保留在末尾', async () => {
    const conv = 'gov-keep-latest'
    const L = contextLimits()
    // B（最新）自身 > keepTailTokens：按「≤ keepTail 的后缀」只有空集。
    // 旧实现会让 start = all.length → 尾窗口为空、连最新一轮也进摘要，B 被裁到 keepTail；
    // 新实现 start 退化为 all.length - 1：B 原文保留在末尾，由更早的 A 承担压缩。
    const messages: HistoryMsg[] = [
      { role: 'user', content: 'a'.repeat(L.keepTailTokens + 4000) },
      { role: 'user', content: 'b'.repeat(L.keepTailTokens + 4000) }
    ]
    expect(sumTokens(messages)).toBeGreaterThan(L.maxTokens)
    expect(messages[1].content.length).toBeGreaterThan(L.keepTailTokens)

    const compress = vi.fn(async () => ({ ok: true, summary: 'S' }))
    const outcome = await buildGovernedHistory({ conversationId: conv, messages, compress })

    expect(compress).toHaveBeenCalled() // 更早的 A 被压缩
    const last = outcome.history[outcome.history.length - 1]
    expect(last).toBe(messages[1]) // 最新一条仍在 history 末尾
    expect(last.role).toBe('user')
    expect(last.content).toBe(messages[1].content) // 内容未被裁剪
    expect(last.content.length).toBeGreaterThan(L.keepTailTokens)
    expect(fakeStore.memory.get(COMPRESS_FAIL_PREFIX + conv) ?? 0).toBe(0)
  })

  it('病态超长段（单条 > 2×阈值）不可强制压缩 → 截断且不污染熔断计数', async () => {
    const conv = 'gov-pathological'
    const L = contextLimits()
    // A 自身 > MAX*2：强制前进被上界保护拦下 → 一段都没提交给摘要器（attempted === 0）。
    const messages: HistoryMsg[] = [
      { role: 'user', content: 'a'.repeat(L.maxTokens * 2 + 1000) },
      { role: 'user', content: 'b'.repeat(L.maxTokens) }
    ]
    expect(sumTokens(messages)).toBeGreaterThan(L.maxTokens)

    const compress = vi.fn(async () => ({ ok: true, summary: 'S' }))
    const outcome = await buildGovernedHistory({ conversationId: conv, messages, compress })

    expect(compress).not.toHaveBeenCalled()
    expect(outcome.compressed).toBe(false)
    expect(outcome.truncated).toBe(true)
    // 关键回归：切不出可压段落不得被误记为「摘要器失败」（修复前会写成 1）。
    expect(fakeStore.memory.get(COMPRESS_FAIL_PREFIX + conv) ?? 0).toBe(0)
  })

  it('反向守卫：真·压缩失败（ok:false）按轮累加熔断计数，不得被弱化为 0', async () => {
    const conv = 'gov-attempted-guard'
    const L = contextLimits()
    const perMsg = Math.floor(L.compressChunkTokens / 2)
    const count = Math.ceil(L.maxTokens / perMsg) + 4
    const messages = makeHistory(count, perMsg)

    const compress = vi.fn(async () => ({ ok: false, message: 'boom' }))
    await buildGovernedHistory({ conversationId: conv, messages, compress })
    expect(compress).toHaveBeenCalled() // attempted > 0
    expect(fakeStore.memory.get(COMPRESS_FAIL_PREFIX + conv)).toBe(1)

    await buildGovernedHistory({ conversationId: conv, messages, compress })
    expect(fakeStore.memory.get(COMPRESS_FAIL_PREFIX + conv)).toBe(2)

    await buildGovernedHistory({ conversationId: conv, messages, compress })
    expect(fakeStore.memory.get(COMPRESS_FAIL_PREFIX + conv)).toBe(3)
  })
})

describe('buildCapabilityDeclarationText：压缩后能力声明重建', () => {
  it('包含内置文件工具行与当前能力域（files 不重复声明）', () => {
    const text = buildCapabilityDeclarationText()
    expect(text).toContain('read_file/write_file/edit_file/glob/grep/ls/execute')
    expect(text).toContain('文献调研(literature)')
    expect(text).toContain('服务器(server)')
    expect(text).not.toContain('文件整理(files)')
  })

  it('传入 skills 时包含 /trigger', () => {
    const text = buildCapabilityDeclarationText([
      { trigger: 'paper', title: '论文' },
      { trigger: 'review', title: '审稿' }
    ])
    expect(text).toContain('/paper')
    expect(text).toContain('/review')
  })

  it('未传 skills 时给出通用调用说明', () => {
    expect(buildCapabilityDeclarationText()).toContain('用户可随时以「/触发词 参数」形式调用')
  })
})

describe('resetConversation / purgeConversation：治理状态重置', () => {
  it('resetConversation 后提醒为空、熔断计数为 0，归档保留', async () => {
    const conv = 'reset-1'
    fakeStore.memory.set(REMINDER_STORE_PREFIX + conv, ['a', 'b'])
    fakeStore.memory.set(COMPRESS_FAIL_PREFIX + conv, 2)
    fakeStore.memory.set(HISTORY_ARCHIVE_PREFIX + conv, [{ at: 't', head: [] }])

    resetConversation(conv)

    expect(fakeStore.memory.get(REMINDER_STORE_PREFIX + conv)).toEqual([])
    expect(fakeStore.memory.get(COMPRESS_FAIL_PREFIX + conv)).toBe(0)
    expect(fakeStore.memory.get(HISTORY_ARCHIVE_PREFIX + conv)).toEqual([{ at: 't', head: [] }])

    const messages: HistoryMsg[] = [{ role: 'user', content: 'hi' }]
    const outcome = await buildGovernedHistory({
      conversationId: conv,
      messages,
      compress: vi.fn(async () => ({ ok: true, summary: 'S' }))
    })
    expect(outcome.history).toEqual(messages) // 提醒已清空，不再前置
  })

  it('purgeConversation 额外清空归档键', () => {
    const conv = 'purge-1'
    fakeStore.memory.set(REMINDER_STORE_PREFIX + conv, ['a'])
    fakeStore.memory.set(COMPRESS_FAIL_PREFIX + conv, 3)
    fakeStore.memory.set(HISTORY_ARCHIVE_PREFIX + conv, [{ at: 't', head: [] }])

    purgeConversation(conv)

    expect(fakeStore.memory.get(REMINDER_STORE_PREFIX + conv)).toEqual([])
    expect(fakeStore.memory.get(COMPRESS_FAIL_PREFIX + conv)).toBe(0)
    expect(fakeStore.memory.get(HISTORY_ARCHIVE_PREFIX + conv)).toEqual([])
  })
})

describe('contextLimits：阈值快照', () => {
  it('与文档一致，且满足 max > keepTail > chunk', () => {
    const L = contextLimits()
    expect(L.maxTokens).toBe(32000)
    expect(L.keepTailTokens).toBe(16000)
    expect(L.compressChunkTokens).toBe(4000)
    expect(L.failLimit).toBe(3)
    expect(L.maxTokens).toBeGreaterThan(L.keepTailTokens)
    expect(L.keepTailTokens).toBeGreaterThan(L.compressChunkTokens)
  })
})
