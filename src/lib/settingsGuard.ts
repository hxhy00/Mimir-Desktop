/**
 * 设置模块的「离开守卫」协议。
 *
 * 设置页有大量独立状态（模型列表、主题、语音引擎等），只有它自己知道
 * 是否存在未保存更改、以及如何保存。App 层负责拦截「切换模块」动作，
 * 因此在两者之间通过本模块建立单例会话：
 *
 * - 设置页挂载时 {@link registerSettingsSession} 注册会话；
 * - App 在离开设置前询问 {@link getSettingsSession}，脏则弹确认框，
 *   用户选择「保存并离开」时调用会话的 save()。
 *
 * 同一时刻只有一个 Settings 实例，模块卸载即注销，无需多实例管理。
 */

export interface SettingsSession {
  /** 是否存在未保存的更改。 */
  isDirty(): boolean
  /** 保存当前编辑内容到持久化存储。 */
  save(): Promise<void>
}

let session: SettingsSession | null = null

export function registerSettingsSession(next: SettingsSession | null): void {
  session = next
}

export function getSettingsSession(): SettingsSession | null {
  return session
}
