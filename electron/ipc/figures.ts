import { ipcMain } from 'electron'
import {
  applyFigureRename,
  importFigure,
  listFigures,
  previewFigureRename,
  removeFigure
} from '../figures/figuresService'
import { appendLedger } from '../ledger/ledgerService'
import type { AssertProjectDirs } from './guards'

/** 图表管理：入库 / 删除 / 改名（`figures:*`）。 */
export function registerFiguresHandlers(deps: { assertProjectDirs: AssertProjectDirs }): void {
  const { assertProjectDirs } = deps

  ipcMain.handle('figures:list', async () => {
    try {
      const figures = await listFigures()
      return { ok: true, figures }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取图片失败' }
    }
  })

  ipcMain.handle('figures:add', async (_event, name: string, dataUrl: string) => {
    try {
      const figure = await importFigure(name, dataUrl)
      // 自动沉淀：图片入库（按 fileName 幂等）
      appendLedger({
        title: `图表入库：${figure.name}`,
        content: `文件：${figure.fileName}`,
        type: 'progress',
        auto: { source: 'figure-import', refKey: figure.fileName }
      })
      return { ok: true, figure }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '保存图片失败' }
    }
  })

  ipcMain.handle('figures:remove', async (_event, fileName: string) => {
    try {
      await removeFigure(fileName)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '删除图片失败' }
    }
  })

  ipcMain.handle(
    'figures:renamePreview',
    async (_event, oldFile: string, newName: string, projectDirs: string[]) => {
      try {
        // 改名会回写引用了该图的 .tex，按写边界逐个校验项目目录。
        const plan = await previewFigureRename(oldFile, newName, assertProjectDirs(projectDirs))
        return { ok: true, ...plan }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : '预览失败' }
      }
    }
  )

  ipcMain.handle(
    'figures:renameApply',
    async (_event, oldFile: string, newName: string, projectDirs: string[]) => {
      try {
        const result = await applyFigureRename(oldFile, newName, assertProjectDirs(projectDirs))
        return { ok: true, ...result }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : '改名失败' }
      }
    }
  )
}
