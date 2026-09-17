/**
 * 首启动绕过：在 Electron 启动**之前**把「已创建科研空间」写入隔离 store，
 * 使 App.tsx 的 `syncSpaces()` 判定为「已有空间」而不弹「选择科研空间」Dialog。
 *
 * 为什么用写文件而不是模拟点击向导：
 * - 向导（App.tsx L445–557，含「添加模型」「选择外观」两步）不是被测对象，
 *   让每条用例都从它走一遍既慢又引入无关失败点；
 * - 向导本身由 P0 用例的**反向断言**守护（`00-smoke.spec.ts` 断言它不出现）。
 *
 * 结构对照 electron/library/store.ts：
 * - 全局层 `~/.mimir/store.json` 的键：`workspaces:list` / `activeWorkspaceId` / `defaultWorkspaceId`
 * - 空间层 `<空间根>/.mimir/store.json`：该空间的业务数据
 */
import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import type { TempHome } from '../helpers/tempHome'

export interface WorkspaceSeed {
  id: string
  name: string
  path: string
  createdAt: string
  updatedAt: string
}

export interface SeedData {
  /** 全局层 settings（跨空间共享）。空对象即可让应用不弹「添加模型」以外的引导。 */
  settings?: Record<string, unknown>
  /** 预置的科研空间列表 */
  workspaces: WorkspaceSeed[]
  /** 激活的空间 id */
  activeId: string
  /** 默认空间 id */
  defaultId: string
  /** 空间层预置业务数据（如 ledger:entries） */
  spaceData?: Record<string, unknown>
}

const FIXED_TIME = '2026-01-01T00:00:00.000Z'

/**
 * 预置一条指向**本地桩网关**的模型配置，使应用启动即连上桩而非真实上游。
 *
 * 依据：`initAgentFromSettings()`（electron/main.ts L50–72）在启动时读
 * `settings.models` + `selectedModelId`，取中选条目初始化 Agent。因此只要 seed 里有
 * 一条 `apiKey` 非空的条目，应用就会自动连到 `baseUrl`——产品代码零改动。
 *
 * 字段名严格对齐主进程读取处：`id` / `modelId` / `baseUrl` / `apiKey`
 * （`supportsReasoning: false` 以避免开启思考模式后请求体多出非标准字段）。
 */
export function gatewayModelSeed(baseUrl: string): {
  models: Record<string, unknown>[]
  selectedModelId: string
} {
  const id = 'e2e-fake-model'
  return {
    models: [
      {
        id,
        name: 'E2E 桩模型',
        baseUrl,
        apiKey: 'e2e-fake-key',
        modelId: 'fake-model',
        supportsImages: false,
        supportsReasoning: false
      }
    ],
    selectedModelId: id
  }
}

/** 从环境变量读真实网关凭据（三个齐备才启用真实 e2e，缺省则整组跳过）。 */
export function readRealGatewayEnv(): { baseUrl: string; apiKey: string; modelId: string } | null {
  const baseUrl = process.env.MIMIR_GW_URL
  const apiKey = process.env.MIMIR_GW_KEY
  const modelId = process.env.MIMIR_GW_MODEL
  if (baseUrl && apiKey && modelId) return { baseUrl, apiKey, modelId }
  return null
}

/**
 * 预置一条指向**真实网关**的模型配置（与 gatewayModelSeed 同构）。
 *
 * 仅在显式提供 `MIMIR_GW_URL` / `MIMIR_GW_KEY` / `MIMIR_GW_MODEL` 时使用 ——
 * 真实模型不可控（输出内容随模型而变），因此配套断言只验证**协议性质**
 * （回显完整性、流式收尾、落盘），不验证具体文案（见 14-chat-real-gateway.spec.ts）。
 */
export function realGatewayModelSeed(cfg: {
  baseUrl: string
  apiKey: string
  modelId: string
}): { models: Record<string, unknown>[]; selectedModelId: string } {
  const id = 'e2e-real-model'
  return {
    models: [
      {
        id,
        name: 'E2E 真实模型',
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        modelId: cfg.modelId,
        supportsImages: false,
        supportsReasoning: false
      }
    ],
    selectedModelId: id
  }
}

/**
 * 默认 seed：1 个科研空间 + 空设置。
 *
 * 空间根落在临时 HOME 下的 `Mimir/<名称>`，与真实默认值（`~/Mimir/...`）同构，
 * 但整体被 HOME 重定向罩住，不会写到开发者真实磁盘。
 */
export function defaultSeed(homeDir: string): SeedData {
  const spacePath = join(homeDir, 'Mimir', '科研空间')
  const id = 'e2e-space-0001'
  return {
    // settings 预置 theme，避免应用等待 localStorage 兜底时的不确定态。
    settings: { theme: 'light' },
    workspaces: [
      {
        id,
        name: '科研空间',
        path: spacePath,
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME
      }
    ],
    activeId: id,
    defaultId: id
  }
}

/** 全局层 store 文件路径（与 store.ts 的 globalFilePath() 保持一致） */
function globalStorePath(homeDir: string): string {
  return join(homeDir, '.mimir', 'store.json')
}

/** 空间层 store 文件路径（与 store.ts 的 spaceDataPath() 保持一致） */
function spaceStorePath(spaceRoot: string): string {
  return join(spaceRoot, '.mimir', 'store.json')
}

/** 把 seed 写入隔离磁盘。必须在 launchApp() 之前调用。 */
export function writeSeed(tempHome: TempHome, seed: SeedData): void {
  const globalPath = globalStorePath(tempHome.home)
  mkdirSync(dirname(globalPath), { recursive: true })

  const globalData = {
    settings: seed.settings ?? {},
    'workspaces:list': seed.workspaces,
    activeWorkspaceId: seed.activeId,
    defaultWorkspaceId: seed.defaultId
  }
  writeFileSync(globalPath, JSON.stringify(globalData, null, 2), { encoding: 'utf8', mode: 0o600 })

  // 空间层：目录必须存在（应用会直接读该路径）
  for (const ws of seed.workspaces) {
    const spacePath = spaceStorePath(ws.path)
    mkdirSync(dirname(spacePath), { recursive: true })
    if (!existsSync(spacePath)) {
      writeFileSync(spacePath, JSON.stringify(seed.spaceData ?? {}, null, 2), 'utf8')
    }
    // 空间内的业务子目录，供依赖它们的模块使用（缺目录时各模块自行创建，这里提前铺好更稳）
    for (const sub of ['papers', 'figures', 'meetings', 'projects']) {
      mkdirSync(join(ws.path, sub), { recursive: true })
    }
  }
}
