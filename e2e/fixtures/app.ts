/**
 * 共享 fixture：整个 spec 文件只启动一次 Electron。
 *
 * 为什么需要它：主进程装载 LangChain 全家桶，冷启动约十几秒。若每条用例都重启，
 * P1–P3 几十个用例会慢到不可接受。这里用 Playwright 的 **worker 级 fixture**
 * （test.extend + 非 auto 的 `{ scope: 'worker' }`），让同一 worker 内的所有用例共享一个实例。
 *
 * 代价与约束：worker 级实例意味着**用例间共享 UI 状态**。因此：
 * - 每个 spec 文件内部用例应设计成「可串行、互不依赖前序导航结果」——统一从 `gotoModule` 进入；
 * - 会改变持久化状态的用例（如设置保存）放在文件末尾，或自己负责复原。
 */
import { test as base, expect } from '@playwright/test'
import type { Page, ElectronApplication } from '@playwright/test'
import { launchApp, type LaunchOptions, type LaunchedApp } from './launch'
import { startFakeGateway, type FakeGateway, type GatewayReply } from './fakeGateway'
import { gatewayModelSeed } from './seed'
import type { DialogRecorder } from '../helpers/confirm'

export interface AppFixtures {
  /** 被测应用句柄（含 tempHome / paths，供隔离断言与 store 读取） */
  launched: LaunchedApp
  /** 渲染层页面 */
  page: Page
  /** 主进程句柄（少数用例需 app.evaluate） */
  electronApp: ElectronApplication
  /** window.confirm 记录器（默认自动 accept） */
  dialogs: DialogRecorder
  /** 离线桩网关：应用启动即连上它（见 fakeGateway.ts）。用例可读 `requests` 断言上下文 */
  gateway: FakeGateway
}

/**
 * 创建一个绑定了特定启动选项的 test 实例。
 * 大多数 spec 用默认 `test`；需要自定义 seed/dialog 的用 `makeTest({ ... })`。
 */
export function makeTest(options: LaunchOptions = {}) {
  return base.extend<AppFixtures>({
    // worker 级：同文件内所有用例共享
    launched: [
      async ({}, use) => {
        const launched = await launchApp(options)
        await use(launched)
        await launched.cleanup()
      },
      { scope: 'worker' }
    ],
    // test 级：复用 launch 时注册的**唯一** handler，每条用例开始前清空记录。
    // 不在这里 page.on('dialog')——那会导致多 handler 抢答（见 confirm.ts 约束）。
    dialogs: async ({ launched }, use) => {
      launched.dialogs.reset()
      await use(launched.dialogs)
    },
    page: async ({ launched }, use) => {
      await use(launched.page)
    },
    electronApp: async ({ launched }, use) => {
      await use(launched.app)
    }
  })
}

/** 默认 test（标准 seed：1 个科研空间 + 空设置）。 */
export const test = makeTest()

/**
 * 带桩网关的 test：启动前先起桩，并把它的地址写进 seed 的模型配置。
 *
 * 为什么网关要 worker 级：一个 worker 只起一个桩（省端口、省启动），
 * 用例之间用 `resetRequests()` + `setReplies()` 隔离状态（见各 spec 的 beforeEach）。
 *
 * `replies` 里的**默认应答**可被用例通过 `gateway.setReplies()` 覆盖，因此
 * 只有需要特殊应答（报错、特定文案）的用例才需要关心它。
 */
export function makeGatewayTest(replies?: GatewayReply[], options: LaunchOptions = {}) {
  return base.extend<AppFixtures>({
    gateway: [
      async ({}, use) => {
        const gw = await startFakeGateway(replies)
        await use(gw)
        await gw.close()
      },
      { scope: 'worker' }
    ],
    launched: [
      async ({ gateway }, use) => {
        // 用 transformSeed 而非自建 seed：默认 seed 的空间根依赖临时 HOME 路径，
        // 只有 launchApp 内部算得出（见 LaunchOptions.transformSeed 说明）。
        const launched = await launchApp({
          ...options,
          transformSeed: (seed) => ({
            ...seed,
            settings: { ...(seed.settings ?? {}), ...gatewayModelSeed(gateway.baseUrl) }
          })
        })
        await use(launched)
        await launched.cleanup()
      },
      { scope: 'worker' }
    ],
    dialogs: async ({ launched }, use) => {
      launched.dialogs.reset()
      await use(launched.dialogs)
    },
    page: async ({ launched }, use) => {
      await use(launched.page)
    },
    electronApp: async ({ launched }, use) => {
      await use(launched.app)
    }
  })
}

export { expect }
