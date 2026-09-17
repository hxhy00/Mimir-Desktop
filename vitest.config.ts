import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

/**
 * Vitest 配置（主进程侧）。
 *
 * 测试目标：electron/ 下的纯 TS 模块（agent 装配、工具契约、网关探测、无头冒烟）。
 * 这些模块依赖 Electron 运行时（app.getPath）与 electron-store；测试里用别名把它们
 * 替换成桩实现（test/stubs/*），从而无需启动 Electron 即可跑。
 */
export default defineConfig({
  // 与 electron.vite.config.ts 用同一个 React 插件：渲染层用例需要它做 JSX 转换
  // （缺了会报 `React is not defined`，因为 tsconfig 用的是 react-jsx 运行时）。
  plugins: [react()],
  test: {
    environment: 'node',
    // 渲染层用例（test/unit/*.test.tsx）走文件头 `@vitest-environment jsdom` 覆盖环境，
    // 主进程侧用例仍是 node。两者共用一份 include，避免维护两套配置。
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    // 每个用例后清空内存 store / 解绑批准通道：切断「全权档等策略泄漏到后续文件」
    // 导致的「单文件跑绿、全量跑红」（见 test/setup/resetState.ts 的说明）。
    setupFiles: ['test/setup/resetState.ts'],
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
      // 渲染层别名：与 tsconfig.web.json 的 `@/* -> src/*` 对齐。
      // 渲染层组件内部用 `@/lib/utils` 之类的路径导入，缺了这条渲染层用例无法加载。
      // 用函数式 replacement（正则捕获组需要手工拼接，静态字符串里的 $1 不会被替换）。
      {
        find: /^@\//,
        replacement: `${new URL('./src/', import.meta.url).pathname}`
      },
      // 让 electron/library/store 在测试环境走内存桩。
      //
      // 关键：alias 匹配的是**导入字符串**（未经路径解析），所以不能只列举
      // `../library/store` 这类写法——测试文件自身的相对深度各不相同
      // （`test/unit/x.test.ts` 写 `../../electron/library/store`），漏掉就会命中
      // **真实 store**（写 ~/.mimir 与磁盘），与测试里 seed 的内存桩各写各的，
      // 表现为「setStoreValue 之后立刻 getStoreValue 得到 undefined」。
      { find: /^\.\/store$/, replacement: new URL('./test/stubs/store.ts', import.meta.url).pathname },
      { find: /^\.\.\/library\/store$/, replacement: new URL('./test/stubs/store.ts', import.meta.url).pathname },
      { find: /^\.\.\/\.\.\/library\/store$/, replacement: new URL('./test/stubs/store.ts', import.meta.url).pathname },
      // 测试自身从 test/unit 视角导入 electron 侧 store 的写法
      { find: /^\.\.\/\.\.\/electron\/library\/store$/, replacement: new URL('./test/stubs/store.ts', import.meta.url).pathname },
      // **test/setup/ 视角**（如 resetState.ts）要纳入：漏掉它的后果非常隐蔽——
      // resetState 会加载**真实 store**（真写磁盘），而测试用的内存 stub 从未被清空，
      // 上一用例写在 `settings` 里的权限策略便残留到下一个测试文件，
      // 表现为「单独跑绿、全量跑红」（approvalFlow 的默认档用例即此症状）。
      { find: /^\.\.\/stubs\/store$/, replacement: new URL('./test/stubs/store.ts', import.meta.url).pathname },
      { find: /^electron$/, replacement: new URL('./test/stubs/electron.ts', import.meta.url).pathname },
      {
        find: /^electron-store$/,
        replacement: new URL('./test/stubs/electron-store.ts', import.meta.url).pathname
      }
    ]
  }
})
