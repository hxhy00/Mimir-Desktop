/**
 * C4 控制平面写保护单元测试：Agent 不得改写宿主配置/能力定义（防自我提权）。
 */
import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isControlPlanePath, controlPlaneRejectMessage } from '../../electron/agent/controlPlane'

describe('controlPlane：控制平面路径判定', () => {
  it('~/.mimir 下的文件（桥接配置/运行时凭据）受保护', () => {
    expect(isControlPlanePath(join(homedir(), '.mimir', 'bridge.json'))).toBe(true)
    expect(isControlPlanePath(join(homedir(), '.mimir'))).toBe(true)
  })

  it('应用配置目录（settings / plugins 落点）受保护', () => {
    const appData =
      process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : process.platform === 'win32'
          ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
          : (process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'))
    expect(isControlPlanePath(join(appData, 'mimir-desktop', 'config.json'))).toBe(true)
  })

  it('普通科研空间/桌面文档不受保护（正常写入不受影响）', () => {
    expect(isControlPlanePath(join(homedir(), 'Desktop', 'paper.tex'))).toBe(false)
    expect(isControlPlanePath('/tmp/notes.md')).toBe(false)
  })

  it('前缀相近但不属于受保护目录的路径不误杀（防前缀绕过/误伤）', () => {
    expect(isControlPlanePath('/tmp/.mimir-backup/x.json')).toBe(false)
    expect(isControlPlanePath('/tmp/mimir-desktop-notes.md')).toBe(false)
  })

  it('拒绝文案说明原因与正确路径（不是简单报错）', () => {
    const msg = controlPlaneRejectMessage('/tmp/x')
    expect(msg).toContain('控制平面')
    expect(msg).toContain('自我提权')
  })
})
