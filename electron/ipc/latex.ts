import { ipcMain } from 'electron'
import { readdir, readFile, writeFile } from 'fs/promises'
import { existsSync, mkdirSync } from 'fs'
import { basename, dirname, extname, join, relative } from 'path'
import { compileLatex, registerLatexPdfDir } from '../latex'
import { availableEngine, pickEngineExecutable } from '../latex/runtime'
import { appendLedger } from '../ledger/ledgerService'
import type { AssertRendererPath } from './guards'

const LATEX_COMPILE_TIMEOUT_MS = 120_000

/** 递归收集目录内所有 .tex 相对路径，跳过产物与隐藏目录。 */
async function collectTexFiles(dir: string, base: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.isDirectory()) {
      if (LATEX_SKIP_DIRS.has(entry.name)) continue
      await collectTexFiles(join(dir, entry.name), base, out)
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.tex') {
      out.push(relative(base, join(dir, entry.name)))
    }
  }
}

const LATEX_SKIP_DIRS = new Set(['build', 'aux', 'out', 'dist', 'node_modules', '.git', '.vscode'])

/** 把客户端传来的相对 .tex 路径解析到项目目录内；非法输入返回 null。 */
function resolveTexPath(projectDir: string, fileName: string): string | null {
  if (fileName === '' || fileName.includes('\0')) return null
  if (fileName.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(fileName)) return null
  const parts = fileName.split(/[\\/]/)
  if (parts.some((p) => p === '..' || p === '.')) return null
  const full = join(projectDir, fileName)
  if (!full.startsWith(join(projectDir)) || extname(full).toLowerCase() !== '.tex') return null
  return full
}

/** LaTeX 论文编译 + 论文项目文件管理（`latex:*`）。 */
export function registerLatexHandlers(deps: { assertRendererPath: AssertRendererPath }): void {
  const { assertRendererPath } = deps

  // 探测可用的 LaTeX 引擎（系统 latexmk / tectonic，其次内置 Tectonic）
  ipcMain.handle('latex:detectEngine', async () => {
    const engine = await availableEngine()
    if (engine === null) {
      return {
        ok: false,
        message: '未找到 LaTeX 引擎，请到「设置 → 资源下载」下载 Tectonic 引擎或安装 TeX 发行版'
      }
    }
    return { ok: true, engine: engine.kind as 'latexmk' | 'tectonic', executable: engine.executable }
  })

  // 编译项目目录中的 main.tex（自动选择系统引擎或内置 Tectonic）
  ipcMain.handle('latex:compile', async (_event, projectDir: string) => {
    try {
      // 编译会在项目目录里落产物（main.pdf / 日志），按写边界校验。
      const dir = assertRendererPath(projectDir, 'write')
      const engineExecutable = await pickEngineExecutable()
      const result = await compileLatex(dir, engineExecutable, LATEX_COMPILE_TIMEOUT_MS)
      // 存在可预览的编译产物（main.pdf）时登记该目录，供 mimir-tex 协议白名单校验
      if (result.pdfPath !== null) {
        registerLatexPdfDir(dir)
        // 自动沉淀：编译成功记入科研记录（同一项目同一天只记一次，避免频繁编译刷屏）
        const projectName = basename(dir)
        appendLedger({
          title: `论文编译成功：${projectName}`,
          content: `项目目录：${dir}`,
          type: 'paper',
          auto: { source: 'latex-compile', refKey: `${dir}#${new Date().toISOString().slice(0, 10)}` }
        })
      }
      return { ok: true, ...result }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '编译失败' }
    }
  })

  // 列出项目目录中的 .tex 文件（递归，跳过产物与隐藏目录；main.tex 优先）
  ipcMain.handle('latex:listFiles', async (_event, projectDir: string) => {
    try {
      const dir = assertRendererPath(projectDir, 'read')
      const files: string[] = []
      await collectTexFiles(dir, dir, files)
      files.sort((a, b) => {
        const mainA = basename(a) === 'main.tex' ? 0 : 1
        const mainB = basename(b) === 'main.tex' ? 0 : 1
        if (mainA !== mainB) return mainA - mainB
        return a.localeCompare(b)
      })
      return { ok: true, files }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取目录失败' }
    }
  })

  // 读取项目内的 .tex 文件（相对路径，支持子目录章节文件）
  ipcMain.handle('latex:readFile', async (_event, projectDir: string, fileName: string) => {
    try {
      // 项目目录先过统一边界；fileName 由 resolveTexPath 约束在项目目录内。
      // 校验放在 try 内：越界时也要走 { ok:false, message } 契约，而不是把异常抛给渲染层。
      const full = resolveTexPath(assertRendererPath(projectDir, 'read'), fileName)
      if (full === null) {
        return { ok: false, message: '非法文件路径：仅允许项目目录内的 .tex 相对路径' }
      }
      const content = await readFile(full, 'utf-8')
      return { ok: true, content }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取文件失败' }
    }
  })

  // 写入项目内的 .tex 文件（相对路径，支持子目录章节文件）
  ipcMain.handle('latex:writeFile', async (_event, projectDir: string, fileName: string, content: string) => {
    try {
      // 同上：越界也要走 { ok:false, message } 契约。
      const full = resolveTexPath(assertRendererPath(projectDir, 'write'), fileName)
      if (full === null) {
        return { ok: false, message: '非法文件路径：仅允许项目目录内的 .tex 相对路径' }
      }
      const dir = dirname(full)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      await writeFile(full, content, 'utf-8')
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '写入文件失败' }
    }
  })

  // 在父目录下创建新论文项目（main.tex 模板）
  ipcMain.handle('latex:createProject', async (_event, parentDir: string, name: string) => {
    try {
      const safeName = name.trim().replace(/[\\/:*?"<>|]/g, '_')
      if (!safeName) return { ok: false, message: '项目名不能为空' }
      // 新建项目会在该父目录下 mkdir，按写边界校验（父目录来自用户的原生选择对话框）。
      const parent = assertRendererPath(parentDir, 'write')
      const projectDir = join(parent, safeName)
      if (existsSync(projectDir)) {
        return { ok: false, message: `目录已存在: ${projectDir}` }
      }
      mkdirSync(projectDir, { recursive: true })
      const template = `\\documentclass[12pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage{graphicx}
\\usepackage{amsmath}
\\usepackage{hyperref}

\\title{${safeName}}
\\author{Author Name\\\\\\texttt{author@example.com}}
\\date{\\today}

\\begin{document}

\\maketitle

\\begin{abstract}
Write your abstract here.
\\end{abstract}

\\section{Introduction}
% Start writing here...

\\section{Related Work}
% Discuss related work...

\\section{Method}
% Describe your method...

\\section{Experiments}
% Present your experiments...

\\section{Conclusion}
% Conclude your work...

\\bibliographystyle{plain}
\\bibliography{references}

\\end{document}`
      await writeFile(join(projectDir, 'main.tex'), template, 'utf-8')
      return { ok: true, projectDir }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '创建项目失败' }
    }
  })
}
