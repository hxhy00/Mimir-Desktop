import { ipcMain, shell } from 'electron'
import {
  activeMeetingModel,
  deleteMeetingDeck,
  generateMeetingDeck,
  listMeetingDecks,
  meetingDeckPath
} from '../meetings/service'
import type { GenerateDeckRequest } from '../meetings/types'
import { appendLedger } from '../ledger/ledgerService'

/** 组会演示文稿（`meetings:*`）。 */
export function registerMeetingsHandlers(): void {
  ipcMain.handle('meetings:generate', async (_event, request: GenerateDeckRequest) => {
    try {
      const deck = await generateMeetingDeck(request)
      // 自动沉淀：组会演示文稿生成成功
      appendLedger({
        title: `生成组会演示文稿：${deck.title ?? deck.file}`,
        content: `文件：${deck.file}`,
        type: 'milestone',
        auto: { source: 'meeting-deck', refKey: deck.file }
      })
      return { ok: true, deck }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '生成演示文稿失败' }
    }
  })

  ipcMain.handle('meetings:list', async () => {
    try {
      const decks = await listMeetingDecks()
      return { ok: true, decks }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取演示文稿失败' }
    }
  })

  ipcMain.handle('meetings:delete', async (_event, file: string) => {
    try {
      await deleteMeetingDeck(file)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '删除失败' }
    }
  })

  ipcMain.handle('meetings:reveal', async (_event, file: string) => {
    const path = meetingDeckPath(file)
    if (path === null) return { ok: false, message: '非法文件名' }
    shell.showItemInFolder(path)
    return { ok: true }
  })

  ipcMain.handle('meetings:config', async () => {
    const active = activeMeetingModel()
    return { ok: true, available: active !== null, modelName: active?.name }
  })
}
