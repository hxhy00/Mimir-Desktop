import { ipcMain } from 'electron'
import {
  capturePaperSnapshot,
  deletePaperSnapshot,
  listPaperSnapshots,
  readSnapshotFile,
  revertPaperSnapshot
} from '../paper/snapshots'
import { aiFixIssue } from '../paper/aiFix'
import { readPaperBib, writePaperBib } from '../paper/bib'
import { VENUE_TEMPLATES, applyVenueTemplate } from '../paper/venueTemplates'
import type { AssertRendererPath } from './guards'

/** 论文快照 + AI 修复 + BibTeX + 会议模板（`snapshots:*` / `paper:*`）。 */
export function registerPaperHandlers(deps: { assertRendererPath: AssertRendererPath }): void {
  const { assertRendererPath } = deps

  ipcMain.handle('snapshots:capture', async (_event, projectDir: string) => {
    try {
      const result = await capturePaperSnapshot(assertRendererPath(projectDir, 'write'))
      return { ok: true, ...result }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '快照失败' }
    }
  })

  ipcMain.handle('snapshots:list', async (_event, projectDir: string) => {
    try {
      const snapshots = await listPaperSnapshots(assertRendererPath(projectDir, 'read'))
      return { ok: true, snapshots }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取快照失败' }
    }
  })

  ipcMain.handle('snapshots:read', async (_event, projectDir: string, id: string, rel: string) => {
    try {
      const content = await readSnapshotFile(assertRendererPath(projectDir, 'read'), id, rel)
      return { ok: true, content }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取快照文件失败' }
    }
  })

  ipcMain.handle('snapshots:revert', async (_event, projectDir: string, id: string) => {
    try {
      const result = await revertPaperSnapshot(assertRendererPath(projectDir, 'write'), id)
      return { ok: true, ...result }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '回退失败' }
    }
  })

  ipcMain.handle('snapshots:remove', async (_event, projectDir: string, id: string) => {
    try {
      await deletePaperSnapshot(assertRendererPath(projectDir, 'write'), id)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '删除快照失败' }
    }
  })

  ipcMain.handle(
    'paper:aiFix',
    async (_event, request: { projectDir: string; fileName: string; line: number; message: string }) => {
      try {
        // aiFix 会在项目目录内改写 .tex；projectDir 先过统一边界（内部还会校验 fileName）。
        const result = await aiFixIssue({ ...request, projectDir: assertRendererPath(request.projectDir, 'write') })
        return { ok: true, ...result }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'AI 修复失败' }
      }
    }
  )

  ipcMain.handle('paper:bibRead', async (_event, projectDir: string) => {
    try {
      const result = await readPaperBib(assertRendererPath(projectDir, 'read'))
      return { ok: true, entries: result.entries, path: result.path }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取参考文献失败' }
    }
  })

  ipcMain.handle('paper:bibWrite', async (_event, projectDir: string, entries: unknown) => {
    try {
      await writePaperBib(
        assertRendererPath(projectDir, 'write'),
        entries as Parameters<typeof writePaperBib>[1]
      )
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '保存参考文献失败' }
    }
  })

  ipcMain.handle('paper:venueTemplates', async () => {
    try {
      return { ok: true, templates: VENUE_TEMPLATES }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取会议模板失败' }
    }
  })

  ipcMain.handle('paper:applyVenueTemplate', async (_event, projectDir: string, templateId: string) => {
    try {
      const path = await applyVenueTemplate(assertRendererPath(projectDir, 'write'), templateId)
      return { ok: true, path }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '应用会议模板失败' }
    }
  })
}
