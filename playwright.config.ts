/**
 * Playwright 配置 —— 端到端（E2E）测试。
 *
 * 与 vitest 完全独立：vitest 跑 node/jsdom 下的模块级测试（test/），
 * 本配置跑真实 Electron 进程 + 真实 UI 操作（e2e/specs/）。
 * 两者目录与文件命名（*.test.ts vs *.spec.ts）互不重叠，互不干扰。
 */
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e/specs',
  // 启动 Electron 要装载 LangChain 全家桶，冷启慢；给足超时。
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // 全量串行：每个 spec 文件各自启动一个 Electron 实例，并行会争抢 CPU 与端口。
  fullyParallel: false,
  workers: 1,
  // 本地偶发抖动（如首次构建后文件系统缓存冷）允许重试一次，CI 上不重试以暴露真实不稳。
  retries: process.env.CI ? 0 : 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    // 失败时留痕，便于定位到具体 UI 状态。
    // trace 是主要诊断手段：它逐帧记录了 DOM 快照 + 网络 + 控制台，比单张截图信息量大。
    // 注：Electron 下 screenshot 常不产出 PNG（底层合成器限制），实测失败产物只有
    // trace.zip + error-context.md。这是预期现象，不是配置失效——排查请用 show-trace。
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off'
  },
  outputDir: './test-results'
})
