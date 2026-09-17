import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

/**
 * main / preload 的依赖处理是**分类策略**，两边都踩过坑，改动前请读 README「构建注意」。
 *
 * 1) **数据型依赖必须外置**：`electron/agent/tokenizer.ts` 引入的 `gpt-tokenizer` 词表是两张
 *    共约 30 万行的**字符串数组**（BPE 词表，元素本身就是 `"\timport"`、`" corrupt"` 这类
 *    「源码片段」）。一旦打进 chunk，electron-vite 的 `vite:esm-shim` 插件会用**不识别字符串
 *    边界**的正则（`ESMStaticImportRe`）去找 CJS shim 的插入点，命中词表里的伪
 *    `import … from " "` 序列，把 shim 插进字符串字面量中间 → 构建以
 *    `[vite:esbuild-transpile] … Unterminated string literal` 失败。
 *
 * 2) **LangChain 生态必须打进 bundle（不能外置）**：`@langchain/langgraph-sdk@1.10.2` 的发布
 *    产物里带着一棵**被剥掉 package.json 的 pnpm 嵌套 node_modules**
 *    （`dist/node_modules/.pnpm/p-retry@7.1.1/node_modules/p-retry/` 只有 `index.js`(ESM) 与
 *    `index.cjs`，没有 package.json）。Electron 33 内置 Node 20 无法按语法嗅探 ESM，于是把
 *    `index.js` 当 CJS 解析并抛 `SyntaxError: Cannot use import statement outside a module`。
 *    打进 bundle 后由 Rollup 解析并内联，运行时不再读那棵坏树。
 *
 * 3) **OpenTelemetry 生态必须打进 bundle（不能外置）**：`@opentelemetry/sdk-node` 会去
 *    `require` 一批「可选 instrumentation」包（grpc、http 等），外置时 Electron 会把它们当
 *    运行时依赖去 node_modules 找，没装就抛 `Cannot find module`。OTel 官方对 Electron 的
 *    建议即是打进 bundle（见 OTel JS「Bundling」文档）。另外 `@langchain/*` 已被强制内联，
 *    插桩包必须与它同时内联，否则会出现**两份 `@langchain/core` 实例**，插桩的
 *    `register()` 会 hook 到另一份上而完全不生效。
 *
 * 其余依赖保持外置（electron-vite 的默认行为）。
 */
const BUNDLE_INSTEAD_OF_EXTERNAL = [
  'langchain',
  'langsmith',
  'deepagents',
  '@langchain/core',
  '@langchain/langgraph',
  '@langchain/openai',
  // OpenTelemetry 核心 + 导出器 + 插桩：理由见上文第 3 点
  '@opentelemetry/',
  '@arizeai/openinference-',
  // zod 必须一起内联：LangChain 生态内部用的是 zod **4**（`zod/v4/core` 里的 `$ZodNever`、
  // `toJSONSchema` 等内部符号），而本项目的顶层 zod 是 **3.25.x**（`^3.23.8`，只提供 v3 API）。
  // 若 zod 外置，被 bundle 的 LangChain 代码会在运行时去顶层 zod 解析 `zod/v4/core`，
  // 版本对不上就会以「does not provide an export named …」在启动时崩溃。
  // 内联后每个导入方各自解析到自己依赖的 zod 版本，与改动前行为一致。
  'zod'
]

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: BUNDLE_INSTEAD_OF_EXTERNAL })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main.ts')
        },
        // 原生 / 二进制依赖必须外置。externalizeDepsPlugin 已覆盖 dependencies，
        // 这里显式再列一次，防止将来被误移到 devDependencies 导致构建悄悄回归。
        external: ['electron', 'node-pty', 'sherpa-onnx', 'ffmpeg-static']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/preload.ts')
        },
        external: ['electron']
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@renderer': resolve(__dirname, 'src/renderer')
      }
    },
    plugins: [react()]
  }
})
