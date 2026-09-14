/**
 * 对话内产物识别单元测试：从工具返回文本/对象里解析真实落盘的产物。
 *
 * 关键约束：
 * 1. 只认「磁盘上真实存在」的文件（避免把示例路径、文档里的路径误判为产物）；
 * 2. 只认白名单扩展名 + 绝对路径；
 * 3. 同一段文本里同一文件只出现一次。
 */
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { extractArtifacts } from '../../electron/agent/artifactExtract'

let dir = ''
let pptxPath = ''
let pyPath = ''

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mimir-artifact-'))
  pptxPath = join(dir, '组会汇报.pptx')
  writeFileSync(pptxPath, 'fake-pptx-bytes')
  pyPath = join(dir, 'model.py')
  writeFileSync(pyPath, 'print(1)')
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('artifactExtract：从工具返回识别产物', () => {
  it('代码产出 .py 计入产物（白名单此前漏收，致「写6个只显示2个」）', () => {
    const out = extractArtifacts(`已写入 ${pyPath}`)
    expect(out.map((a) => a.path)).toContain(pyPath)
    expect(out[0].ext).toBe('.py')
  })

  it('识别「路径：」前缀后的真实文件', () => {
    const out = extractArtifacts(`演示文稿已生成。\n路径：${pptxPath}`)
    expect(out).toHaveLength(1)
    expect(out[0].path).toBe(pptxPath)
    expect(out[0].name).toBe('组会汇报.pptx')
    expect(out[0].ext).toBe('.pptx')
    expect(out[0].sizeBytes).toBeGreaterThan(0)
  })

  it('识别「已保存到」等口语化前缀', () => {
    const out = extractArtifacts(`笔记已保存到 ${pptxPath}`)
    expect(out.map((a) => a.path)).toEqual([pptxPath])
  })

  it('识别反引号包裹的路径', () => {
    const out = extractArtifacts(`产出文件：\`${pptxPath}\``)
    expect(out.map((a) => a.path)).toEqual([pptxPath])
  })

  it('不存在的文件不算产物（避免示例路径误判）', () => {
    const out = extractArtifacts(`路径：${join(dir, '不存在的文件.pptx')}`)
    expect(out).toHaveLength(0)
  })

  it('不在白名单的扩展名不算产物', () => {
    const weird = join(dir, 'note.xyz')
    writeFileSync(weird, 'x')
    expect(extractArtifacts(`路径：${weird}`)).toHaveLength(0)
  })

  it('相对路径不算产物', () => {
    expect(extractArtifacts('路径：output/report.pptx')).toHaveLength(0)
  })

  it('同一文件重复出现只返回一次', () => {
    const text = `路径：${pptxPath}\n再次保存到 ${pptxPath}`
    expect(extractArtifacts(text)).toHaveLength(1)
  })

  it('对象返回（JSON）里的路径同样可被识别', () => {
    const out = extractArtifacts({ ok: true, path: pptxPath })
    expect(out.map((a) => a.path)).toEqual([pptxPath])
  })

  it('空输入返回空数组，不抛错', () => {
    expect(extractArtifacts(undefined)).toEqual([])
    expect(extractArtifacts('')).toEqual([])
    expect(extractArtifacts(null)).toEqual([])
  })
})
