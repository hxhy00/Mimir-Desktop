/**
 * LaTeX 论文模块桥工具：Agent 对用户的论文项目目录执行真实编译并解析诊断。
 * 只读编译，不修改源文件；编译产物 main.pdf 会登记进 mimir-tex 预览白名单
 * （用户随后可在「论文」模块预览）。无本地引擎时返回安装引导，不自动下载。
 */
import { tool } from 'langchain/tools'
import { z } from 'zod'
import { existsSync } from 'fs'
import { compileLatex } from '../../latex'
import { pickEngineExecutable } from '../../latex/runtime'
import { registerLatexPdfDir } from '../../latex'
import { requireUserApproval } from '../approval'

const LATEX_COMPILE_TIMEOUT_MS = 120_000

export const latexCompileTool = tool(
  async ({ projectDir }) => {
    try {
      if (typeof projectDir !== 'string' || projectDir.trim() === '') {
        return '编译失败：projectDir 不能为空（需为含 main.tex 的项目目录绝对路径）。'
      }
      if (!existsSync(projectDir)) return `编译失败：目录不存在：${projectDir}`

      // 副作用确认：真实编译（可长耗时、会生成产物）需用户放行
      const allowed = await requireUserApproval({
        tool: 'latex_compile',
        summary: `编译 LaTeX 项目 ${projectDir.trim()}`,
        detail: '将调用本机 latexmk/Tectonic 编译 main.tex（最长 120 秒），产物 PDF 会同步到「论文」模块预览。不修改你的源文件。',
      })
      if (!allowed) return '已取消：编译未获得用户确认（或等待超时）。请先向用户说明并再次发起。'

      let engine: string
      try {
        engine = await pickEngineExecutable()
      } catch (error) {
        return `编译失败：${error instanceof Error ? error.message : '未找到 LaTeX 引擎'}`
      }

      const result = await compileLatex(projectDir.trim(), engine, LATEX_COMPILE_TIMEOUT_MS)
      if (result.pdfPath !== null) registerLatexPdfDir(projectDir.trim())

      const lines: string[] = []
      lines.push(`引擎：${result.engine} · 编译${result.success ? '通过' : '失败'}`)
      if (result.pdfPath !== null) lines.push(`产物：${result.pdfPath}`)

      const render = (issue: { severity?: 'error' | 'warning'; file?: string; line?: number; message: string }): string => {
        const at = issue.file !== undefined
          ? `${issue.file}${issue.line !== undefined ? `:${String(issue.line)}` : ''}`
          : `行 ${issue.line !== undefined ? String(issue.line) : '?'}`
        return `- ${at} · ${issue.message}`
      }

      if (result.errors.length > 0) {
        lines.push(`\n错误 ${result.errors.length} 条：`)
        lines.push(...result.errors.map(render))
      } else if (!result.success) {
        lines.push('\n（未能从日志解析出结构化错误，见末尾日志摘录）')
      }
      if (result.warnings.length > 0) {
        lines.push(`\n警告 ${result.warnings.length} 条：`)
        lines.push(...result.warnings.map(render))
      }
      if (lines.length < 3) lines.push('\n无错误、无警告。')
      if (result.logExcerpt !== '') {
        lines.push(`\n--- 日志尾部摘录 ---\n${result.logExcerpt}`)
      }
      return lines.join('\n')
    } catch (error) {
      return `编译失败：${error instanceof Error ? error.message : '未知错误'}`
    }
  },
  {
    name: 'latex_compile',
    description:
      '编译一个 LaTeX 论文项目目录（需包含 main.tex，传入其绝对路径），返回错误/警告诊断与产物 PDF 路径。' +
      '编译不修改源文件，产物会同步到「论文」模块预览。编译可能耗时较长（最长 120 秒）。请先与用户确认要编译的目录。',
    schema: z.object({
      projectDir: z.string().describe('包含 main.tex 的项目目录绝对路径'),
    }),
  },
)
