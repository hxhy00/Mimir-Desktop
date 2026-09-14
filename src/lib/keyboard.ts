/**
 * 键盘事件的小工具（跨组件的统一口径）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * 「回车提交」的写法（`e.key === 'Enter' && submit()`）在纯英文输入下没问题，
 * 但对中文/日文/韩文用户是**真实故障**：输入法组合期间按回车是「确认候选词」，
 * 而该键盘事件同样会冒泡到 onKeyDown —— 于是「打了一半拼音按回车选字」被当成提交，
 * 半截文本直接发出去（聊天输入框最严重：消息已发出，无法挽回）。
 *
 * 判据用 `nativeEvent.isComposing`（浏览器直接给出），不自己维护
 * compositionstart/end 状态：部分输入法的 compositionend 晚于该次 keydown，
 * 自建状态会在这一帧判断失误；Safari 上 `keyCode === 229` 的旧判据也不可靠。
 */

/** 该回车是否为输入法「确认候选词」而非用户想提交。 */
export function isImeComposing(e: {
  nativeEvent: { isComposing: boolean }
}): boolean {
  return e.nativeEvent.isComposing
}

/**
 * 「提交型回车」统一判据：非输入法组合中、且未按 Shift。
 *
 * Shift+Enter 留给换行（文本域场景），调用方不需要再重复判断。
 */
export function isSubmitEnter(e: {
  key: string
  shiftKey: boolean
  nativeEvent: { isComposing: boolean }
}): boolean {
  return e.key === 'Enter' && !e.shiftKey && !isImeComposing(e)
}
