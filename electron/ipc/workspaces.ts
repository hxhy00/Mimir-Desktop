import { ipcMain } from 'electron'
import {
  createWorkspace,
  getActiveWorkspace,
  getDefaultWorkspace,
  listWorkspaces,
  removeWorkspace,
  renameWorkspace,
  setDefaultWorkspace,
  switchWorkspace
} from '../library/store'
import type { AssertRendererPath } from './guards'

/** 科研空间：列表 / 创建 / 重命名 / 移除 / 切换 / 设默认（`workspaces:*`）。 */
export function registerWorkspacesHandlers(deps: { assertRendererPath: AssertRendererPath }): void {
  const { assertRendererPath } = deps

  ipcMain.handle('workspaces:list', async () => {
    try {
      const workspaces = listWorkspaces()
      const activeId = getActiveWorkspace()?.id ?? null
      const defaultId = getDefaultWorkspace()?.id ?? null
      return { ok: true, workspaces, activeId, defaultId }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取科研空间失败' }
    }
  })

  ipcMain.handle('workspaces:current', async () => {
    try {
      const active = getActiveWorkspace()
      return { ok: true, active: active === null ? null : { ...active } }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取当前空间失败' }
    }
  })

  ipcMain.handle('workspaces:create', async (_event, name: string, dir?: string) => {
    try {
      // 空间根是用户自选的目录（缺省 ~/Mimir/<名称>）；显式传入时按写边界校验。
      const target = dir === undefined || dir === '' ? undefined : assertRendererPath(dir, 'write')
      const workspace = createWorkspace(name, target)
      return { ok: true, workspace: { ...workspace } }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '创建科研空间失败' }
    }
  })

  ipcMain.handle('workspaces:rename', async (_event, id: string, name: string) => {
    try {
      const workspace = renameWorkspace(id, name)
      return { ok: true, workspace: { ...workspace } }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '重命名失败' }
    }
  })

  ipcMain.handle('workspaces:remove', async (_event, id: string) => {
    try {
      removeWorkspace(id)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '移除科研空间失败' }
    }
  })

  ipcMain.handle('workspaces:switch', async (_event, id: string) => {
    try {
      const workspace = switchWorkspace(id)
      return { ok: true, workspace: { ...workspace } }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '切换科研空间失败' }
    }
  })

  ipcMain.handle('workspaces:setDefault', async (_event, id: string) => {
    try {
      setDefaultWorkspace(id)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '设置默认空间失败' }
    }
  })
}
