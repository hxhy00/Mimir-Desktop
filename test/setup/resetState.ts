/**
 * 全局测试隔离：在每个用例后把「跨用例会泄漏的进程级单例」还原到干净状态。
 *
 * 为什么需要它（真实事故）：本仓出现过「单文件跑绿、全量跑红」——`singleThread` /
 * 慢速调度下多个测试文件共享同一进程，`test/stubs/store.ts` 的内存 store 是**模块级
 * 单例**，`electron/agent/approval.ts` 的 sender/negotiated 同样是模块级状态。
 * 于是：
 *   ① approvalFlow 把策略设成全权档 `danger-full-access` 后若未复原；
 *   ② 后续文件（如 liveAgent）读到残留策略 → 空间外读取被判定为「全权档放行」，
 *      既不弹卡也不落审计，断言随之失败。
 *
 * 这里统一在 `afterEach` 收口，而不是让每个测试文件各自 `beforeEach` 重置——
 * 后者依赖「下一条用例会替上一条善后」的隐式约定，新增文件一漏就复发。
 */
import { afterEach } from 'vitest'
// 必须**经 vitest alias 相同的路径**导入 stub，否则会拿到另一个模块实例，
// 清空的是「空壳」而真正的 store 仍留有上个用例的数据（跨用例污染）。
import { __resetStore } from '../../electron/library/store'
import { resetApprovalSender } from '../../electron/agent/approval'

afterEach(() => {
  // 清空策略 / 审计等持久化状态：这是「全权档泄漏」的直接污染源。
  __resetStore()
  // 解绑假渲染层并把在途请求按拒绝结掉（Fail-Closed），避免批准通道残留到下一个用例。
  resetApprovalSender()
})
