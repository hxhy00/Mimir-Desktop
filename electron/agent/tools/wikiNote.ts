import { tool } from 'langchain/tools'
import { z } from 'zod'
import { writeFile, mkdir, readFile } from 'fs/promises'
import { join } from 'path'
import { spaceRoot } from '../../library/store'

/**
 * Wiki note tool - save notes to the current research space's wiki directory
 */
export const wikiNoteTool = tool(
  async ({ title, content }) => {
    try {
      const wikiDir = join(spaceRoot(), 'wiki')
      await mkdir(wikiDir, { recursive: true })

      const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_')
      const filePath = join(wikiDir, `${safeTitle}.md`)

      // Check if file exists
      let existing = ''
      try {
        existing = await readFile(filePath, 'utf-8')
      } catch {
        // File doesn't exist yet
      }

      const timestamp = new Date().toISOString()
      const newContent = existing
        ? `${existing}\n\n---\n\n## ${timestamp}\n\n${content}`
        : `# ${title}\n\n> 创建于 ${timestamp}\n\n${content}`

      await writeFile(filePath, newContent, 'utf-8')

      return `笔记已保存到 ${filePath}`
    } catch (error) {
      return `保存笔记失败: ${error instanceof Error ? error.message : '未知错误'}`
    }
  },
  {
    name: 'wiki_note',
    description: '创建或追加 Wiki 笔记。将研究笔记保存到本地 wiki 目录，支持追加内容。',
    schema: z.object({
      title: z.string().describe('笔记标题'),
      content: z.string().describe('笔记内容，支持 Markdown 格式')
    })
  }
)
