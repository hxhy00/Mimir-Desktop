import { ipcMain } from 'electron'
import * as library from '../library/libraryService'
import { agentService } from '../agent/agentService'
import type { AssertRendererPath } from './guards'

/** 文献库：论文 / 项目 / 订阅 / Zotero / BibTeX 导出 / AI 相关性评分（`library:*`）。 */
export function registerLibraryHandlers(deps: { assertRendererPath: AssertRendererPath }): void {
  const { assertRendererPath } = deps

  ipcMain.handle('library:listPapers', async () => {
    try {
      return { ok: true, papers: library.listPapers() }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取文献库失败' }
    }
  })

  ipcMain.handle('library:searchArxiv', async (_event, query: string, maxResults?: number, sortBy?: 'relevance' | 'submittedDate') => {
    try {
      const entries = await library.searchArxiv(query, maxResults, sortBy)
      return { ok: true, entries }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'arXiv 搜索失败' }
    }
  })

  ipcMain.handle('library:searchWeb', async (_event, query: string, maxResults?: number) => {
    try {
      const entries = await library.searchWeb(query, maxResults)
      return { ok: true, entries }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Web 搜索失败' }
    }
  })

  ipcMain.handle('library:importPaper', async (_event, entry: unknown, projectId?: string) => {
    try {
      const result = await library.importPaper(entry as Parameters<typeof library.importPaper>[0], projectId)
      return { ok: true, ...result }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '导入论文失败' }
    }
  })

  ipcMain.handle('library:removePaper', async (_event, arxivId: string) => {
    try {
      await library.removePaper(arxivId)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '删除论文失败' }
    }
  })

  ipcMain.handle('library:updatePaper', async (_event, request: unknown) => {
    try {
      const paper = await library.updatePaper(request as Parameters<typeof library.updatePaper>[0])
      return { ok: true, paper }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '更新论文失败' }
    }
  })

  ipcMain.handle('library:fetchPaperPdf', async (_event, arxivId: string) => {
    try {
      const paper = await library.fetchPaperPdf(arxivId)
      return { ok: true, paper }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'PDF 下载失败' }
    }
  })

  // 项目
  ipcMain.handle('library:listProjects', async () => {
    try {
      return { ok: true, projects: library.listProjects() }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取项目失败' }
    }
  })

  ipcMain.handle('library:createProject', async (_event, title: string, paperDir?: string) => {
    try {
      const target = paperDir === undefined || paperDir === '' ? undefined : assertRendererPath(paperDir, 'write')
      const project = library.createProject(title, target)
      return { ok: true, project }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '创建项目失败' }
    }
  })

  ipcMain.handle('library:updateProject', async (_event, id: string, patch: unknown) => {
    try {
      const project = library.updateProject(id, patch as Parameters<typeof library.updateProject>[1])
      return { ok: true, project }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '更新项目失败' }
    }
  })

  ipcMain.handle('library:deleteProject', async (_event, id: string) => {
    try {
      await library.deleteProject(id)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '删除项目失败' }
    }
  })

  // BibTeX 导出
  ipcMain.handle('library:importPapersToBib', async (_event, projectId: string, arxivIds: string[]) => {
    try {
      const result = await library.importPapersToBib(projectId, arxivIds)
      return { ok: true, ...result }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'BibTeX 导出失败' }
    }
  })

  // arXiv 订阅
  ipcMain.handle('library:listSubscriptions', async () => {
    try {
      const subscriptions = await library.listArxivSubscriptions()
      return { ok: true, subscriptions }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取订阅失败' }
    }
  })

  ipcMain.handle('library:saveSubscription', async (_event, query: string) => {
    try {
      const subscription = await library.saveArxivSubscription(query)
      return { ok: true, subscription }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '保存订阅失败' }
    }
  })

  ipcMain.handle('library:deleteSubscription', async (_event, id: string) => {
    try {
      await library.deleteArxivSubscription(id)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '删除订阅失败' }
    }
  })

  ipcMain.handle('library:checkSubscriptions', async (_event, id?: string) => {
    try {
      const outcomes = await library.checkArxivSubscriptions(id)
      return { ok: true, outcomes }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '检查订阅失败' }
    }
  })

  // Zotero
  ipcMain.handle('library:checkZotero', async () => {
    try {
      return { ok: true, ...library.checkZotero() }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Zotero 检查失败' }
    }
  })

  ipcMain.handle('library:listZoteroCollections', async () => {
    try {
      const collections = await library.listZoteroCollections()
      return { ok: true, collections }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取 Zotero 集合失败' }
    }
  })

  ipcMain.handle('library:searchZotero', async (_event, query: string) => {
    try {
      const items = await library.searchZotero(query)
      return { ok: true, items }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Zotero 搜索失败' }
    }
  })

  ipcMain.handle('library:exportZoteroCollectionToBib', async (_event, projectId: string, collectionKey: string) => {
    try {
      const result = await library.exportZoteroCollectionToBib(projectId, collectionKey)
      return { ok: true, ...result }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Zotero 导出失败' }
    }
  })

  // AI 相关性评分：让 Agent 用 set_paper 工具写入评分
  ipcMain.handle(
    'library:scoreRelevance',
    async (_event, paper: unknown, projectId: string, projectTitle: string) => {
      try {
        if (!agentService.isInitialized()) {
          return { ok: false, message: '请先在设置中配置 API Key 和模型' }
        }
        const p = paper as { arxivId: string; title: string; authors: string[]; summary: string }
        const prompt = `请评估以下论文与项目「${projectTitle}」的相关性，并调用 set_paper 工具写入评分（0-10 分）和理由。

论文标题: ${p.title}
作者: ${p.authors.join(', ')}
摘要: ${p.summary}

项目主题: ${projectTitle}

评分标准：
- 9-10: 直接相关，是项目核心工作
- 7-8: 高度相关，方法/结论直接可用
- 4-6: 部分相关，背景或方法有参考价值
- 1-3: 弱相关，仅一般背景
- 0: 无关

调用 set_paper 工具，参数：
- arxivId: ${p.arxivId}
- projectId: ${projectId}
- relevanceScore: 0-10 的整数
- relevanceReason: 一句话简要理由`
        const response = await agentService.sendMessage(prompt, `score-${p.arxivId}-${projectId}`)
        // 启发式校验：Agent 响应过短（<10 字）或不包含评分关键词时，标记为可能未实际写入
        const isSuspicious = response.length < 10 || !/\d/.test(response)
        return {
          ok: true,
          message: isSuspicious
            ? `[警告] Agent 响应可能未包含评分，请手动检查项目「${projectTitle}」中 arxiv:${p.arxivId} 的评分。\n${response}`
            : response,
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'AI 评分失败' }
      }
    }
  )
}
