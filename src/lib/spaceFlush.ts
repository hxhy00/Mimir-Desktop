/**
 * 跨空间切换时的「数据落盘收尾」注册表。
 *
 * 背景：会话（`chat:conversations`）等数据按空间隔离，且渲染层用防抖写入 store。
 * 切空间时挂载的组件会随 key 变化被卸载，若不在卸载前 flush，最新一轮改动会
 * 连同旧空间的 store 缓存一起丢失（下一次 flush 只会写进新空间）。
 *
 * 因此各模块在挂载时注册一个同步 flush 函数，App 在推进 UI 空间纪元前统一调用。
 * 这里的 flush 必须只做「写当前空间数据」，不得产生新的跨空间读。
 */

type SpaceFlush = () => void

const flushes = new Set<SpaceFlush>()

/** 注册一个空间切换前的落盘函数，返回取消函数。 */
export function registerSpaceFlush(fn: SpaceFlush): () => void {
  flushes.add(fn)
  return () => {
    flushes.delete(fn)
  }
}

/** 依次执行所有已注册的落盘函数；单个失败不影响其余，也不阻断空间切换。 */
export function flushSessionOnSpaceChange(): void {
  for (const fn of [...flushes]) {
    try {
      fn()
    } catch {
      // 落盘尽力而为：失败不应阻断空间切换
    }
  }
}
