import { defineConfig } from 'vitest/config'

/**
 * Vitest 配置（主进程侧）。
 *
 * 测试目标：electron/ 下的纯 TS 模块（agent 装配、工具契约、网关探测、无头冒烟）。
 * 这些模块依赖 Electron 运行时（app.getPath）与 electron-store；测试里用别名把它们
 * 替换成桩实现（test/stubs/*），从而无需启动 Electron 即可跑。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // 网关矩阵 / 冒烟测试要打真实网络，给足超时
    testTimeout: 60_000,
    hookTimeout: 30_000,
    reporters: ['verbose'],
    // 网关矩阵需要真实 API Key；默认跳过，用 test:gateway 脚本显式跑
    env: {
      MIMIR_TEST: '1'
    }
  },
  resolve: {
    alias: [
      // 让 library/store 在测试环境走内存桩（必须在 electron 之前匹配，避免被前缀命中）
      { find: /^\.\.\/library\/store$/, replacement: new URL('./test/stubs/store.ts', import.meta.url).pathname },
      { find: /^\.\.\/\.\.\/library\/store$/, replacement: new URL('./test/stubs/store.ts', import.meta.url).pathname },
      { find: /^electron$/, replacement: new URL('./test/stubs/electron.ts', import.meta.url).pathname },
      {
        find: /^electron-store$/,
        replacement: new URL('./test/stubs/electron-store.ts', import.meta.url).pathname
      }
    ]
  }
})
