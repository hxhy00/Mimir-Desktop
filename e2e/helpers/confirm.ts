/**
 * 处理渲染进程的 `window.confirm` / `alert`。
 *
 * 为什么必须它：应用有 14 处原生 `window.confirm`（删记录、删论文、切空间脏检查等）。
 * Playwright 默认**不自动应答** JS dialog，若不注册 handler，触发 confirm 的操作会一直挂起直到超时。
 *
 * ⚠️ 关键约束：handler **只能注册一次**。本项目的 page 是 worker 级共享的，若每个 test
 * 都 `page.on('dialog', ...)`，同一次 confirm 会被多个 handler 抢答，第二个就抛
 * 「No dialog is showing」。因此注册放在 launchApp 内（每实例一次），
 * recorder 通过 reset() 在用例间清空调用记录。
 */
import type { Page } from '@playwright/test'

export interface DialogRecorder {
  /** 被 accept 的 dialog 文案 */
  accepted: string[]
  /** 被 dismiss（取消）的 dialog 文案 */
  dismissed: string[]
  /** 切换下一次 dialog 的应答方式（默认 accept），用于验证取消路径 */
  setNextAction: (action: 'accept' | 'dismiss') => void
  /** 清空记录并复位为 accept —— 每个 test 开始时调用 */
  reset: () => void
}

/**
 * 在 page 上注册**唯一**的 dialog 自动应答器。返回可复用的 recorder。
 * 只应在 launchApp 里调用一次。
 */
export function installDialogHandler(page: Page): DialogRecorder {
  let nextAction: 'accept' | 'dismiss' = 'accept'

  const recorder: DialogRecorder = {
    accepted: [],
    dismissed: [],
    setNextAction: (action) => {
      nextAction = action
    },
    reset: () => {
      recorder.accepted.length = 0
      recorder.dismissed.length = 0
      nextAction = 'accept'
    }
  }

  page.on('dialog', async (dialog) => {
    const message = dialog.message()
    try {
      if (nextAction === 'accept') {
        recorder.accepted.push(message)
        await dialog.accept()
      } else {
        recorder.dismissed.push(message)
        await dialog.dismiss()
      }
    } catch {
      // dialog 可能已被其它路径关闭；忽略即可，不影响用例断言。
    }
    nextAction = 'accept'
  })

  return recorder
}
