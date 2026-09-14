/**
 * 时间线「文件动作 / 命令动作」提取单测。
 *
 * 锁定三个真实修复：
 * 1. edit_file 必须带出 old_string/new_string，渲染层才能显示具体改动（红绿 diff），
 *    而不是只有一坨截断的 JSON 入参；
 * 2. execute 工具能从 { command } 入参提出命令行，时间线据此显示「运行 <命令>」；
 * 3. write_file 仍按 content 行数报 added（回归守护，别把已有行为改坏）。
 */
import { describe, expect, it } from 'vitest'
import { commandActionOf, fileActionOf } from '../../electron/agent/agentService'

describe('fileActionOf：edit_file 带出改动内容', () => {
  it('edit 提取 path/action/added/removed 与 old/new 原文', () => {
    const out = fileActionOf('edit_file', {
      file_path: '/tmp/a.py',
      old_string: 'x = 1',
      new_string: 'x = 2\ny = 3'
    })
    expect(out).toBeDefined()
    expect(out?.path).toBe('/tmp/a.py')
    expect(out?.action).toBe('edit')
    expect(out?.removed).toBe(1) // old_string 1 行
    expect(out?.added).toBe(2) // new_string 2 行
    expect(out?.oldString).toBe('x = 1')
    expect(out?.newString).toBe('x = 2\ny = 3')
  })

  it('write_file 按 content 行数报 added（回归守护）', () => {
    const out = fileActionOf('write_file', { file_path: '/tmp/b.md', content: 'a\nb\nc' })
    expect(out?.action).toBe('write')
    expect(out?.added).toBe(3)
    expect(out?.oldString).toBeUndefined()
  })

  it('非文件工具返回 undefined', () => {
    expect(fileActionOf('paper_search', { query: 'clip' })).toBeUndefined()
  })
})

describe('commandActionOf：execute 命令行提取', () => {
  it('从 { command } 提出完整命令', () => {
    const cmd = 'python train.py --arch resnet34 --epochs 100'
    expect(commandActionOf('execute', { command: cmd })).toBe(cmd)
  })

  it('非 execute 工具不产命令', () => {
    expect(commandActionOf('write_file', { command: 'ls' })).toBeUndefined()
  })

  it('空/缺失 command 返回 undefined', () => {
    expect(commandActionOf('execute', { command: '   ' })).toBeUndefined()
    expect(commandActionOf('execute', {})).toBeUndefined()
    expect(commandActionOf('execute', null)).toBeUndefined()
  })
})
