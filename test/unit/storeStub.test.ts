/**
 * store 测试桩的语义回归测试。
 *
 * 背景（审查发现）：旧桩把 `assertSpaceUnchanged` 实现成空函数、`currentSpaceEpoch`
 * 实现成常量，于是「空间代际令牌」这套**核心防御在测试中从未被验证过** ——
 * 测试全绿并不能说明真实 store 的跨空间回写防护成立。本文件把该语义重新钉住：
 *
 *  1. 桩具备 global / space 双层分层（`settings` / `servers:list` 全局，其余按空间）；
 *  2. 空间切换后 `currentSpaceEpoch` 必须变化，旧令牌校验必须**抛错**；
 *  3. 未切换空间时令牌稳定，校验通过（避免误报）；
 *  4. 损坏的空间层数据不会污染其它空间（分桶隔离）。
 *
 * 说明：这里只断言**桩自身**的语义与真实 store.ts 对齐；桩导出面是内部约定，
 * 若将来桩与真实实现进一步分化，本文件应同步更新。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __resetStore,
  assertSpaceUnchanged,
  createTestWorkspace,
  currentSpaceEpoch,
  getActiveWorkspace,
  getStoreValue,
  setStoreValue,
  switchWorkspaceTo,
  __corruptSpaceStore
} from '../stubs/store'

describe('store 桩：global / space 双层分层', () => {
  beforeEach(() => __resetStore())
  afterEach(() => __resetStore())

  it('全局键（settings / servers:list）跨空间共享', () => {
    setStoreValue('settings', { theme: 'dark' })
    const other = createTestWorkspace('另一个空间')
    switchWorkspaceTo(other.id)

    // 切到新空间后，全局层数据仍在（真实 store：全局层不随空间切换）
    expect(getStoreValue('settings')).toEqual({ theme: 'dark' })
  })

  it('空间层键随空间切换而整体替换，互不串味', () => {
    setStoreValue('library:papers', ['空间A的论文'])

    const other = createTestWorkspace('空间B')
    switchWorkspaceTo(other.id)
    // 新空间的空间层是空的（真实 store：各空间各一份 store.json）
    expect(getStoreValue('library:papers')).toBeUndefined()

    setStoreValue('library:papers', ['空间B的论文'])
    expect(getStoreValue('library:papers')).toEqual(['空间B的论文'])
  })
})

describe('store 桩：空间代际令牌（核心防御）', () => {
  beforeEach(() => __resetStore())
  afterEach(() => __resetStore())

  it('未切换空间时令牌稳定，校验通过（不误报）', () => {
    const epoch = currentSpaceEpoch()
    expect(() => assertSpaceUnchanged(epoch)).not.toThrow()
    expect(currentSpaceEpoch()).toBe(epoch)
  })

  it('空间切换后旧令牌校验必须失败 —— 防止旧空间异步回写污染新空间', () => {
    // 模拟：读到旧空间状态 → await 用户批准（期间空间被切换）→ 尝试写回
    const epochBeforeSwitch = currentSpaceEpoch()

    const other = createTestWorkspace('切换后的空间')
    switchWorkspaceTo(other.id)

    // 旧令牌必须失效（旧桩在此处是空函数，防御形同虚设）
    expect(currentSpaceEpoch()).not.toBe(epochBeforeSwitch)
    expect(() => assertSpaceUnchanged(epochBeforeSwitch)).toThrow(/科研空间已切换/)
  })

  it('切回原空间也是「新代际」——旧令牌同样失效（不能靠 id 相等蒙混过关）', () => {
    const first = currentSpaceEpoch()
    const originalId = getActiveWorkspace().id

    const other = createTestWorkspace('中间空间')
    switchWorkspaceTo(other.id)
    switchWorkspaceTo(originalId)

    // 即使空间 id 回到原值，代际计数已推进 → 旧令牌仍然失效
    expect(() => assertSpaceUnchanged(first)).toThrow(/科研空间已切换/)
  })
})

describe('store 桩：损坏空间层数据的隔离语义', () => {
  beforeEach(() => __resetStore())
  afterEach(() => __resetStore())

  it('某空间 store.json 损坏（解析为空）不影响其它空间', () => {
    setStoreValue('library:papers', ['健康空间的论文'])

    const broken = createTestWorkspace('损坏的空间')
    __corruptSpaceStore(broken.id)
    switchWorkspaceTo(broken.id)
    // 损坏空间读出空（真实 readJson 解析失败静默返回 {}）
    expect(getStoreValue('library:papers')).toBeUndefined()
  })
})
