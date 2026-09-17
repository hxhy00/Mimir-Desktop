import { ipcMain } from 'electron'
import {
  listVenueDeadlines,
  refreshVenueDeadlines,
  setVenueWatch
} from '../venues/venuesService'

/** 会议截稿：目录 / 刷新 / 关注（`venues:*`）。 */
export function registerVenuesHandlers(): void {
  ipcMain.handle('venues:list', async () => {
    try {
      const payload = await listVenueDeadlines()
      return { ok: true, ...payload }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取截稿目录失败' }
    }
  })

  ipcMain.handle('venues:refresh', async () => {
    try {
      const fetchedAt = await refreshVenueDeadlines()
      return { ok: true, fetchedAt }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '刷新失败（旧缓存已保留）' }
    }
  })

  ipcMain.handle('venues:setWatch', async (_event, seriesKey: string, watched: boolean) => {
    try {
      setVenueWatch(seriesKey, watched)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '更新关注失败' }
    }
  })
}
