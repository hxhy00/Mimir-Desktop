/**
 * 研究项目工具：包装 libraryService 的项目 CRUD，与「研究项目」模块同一份数据。
 *
 * 形态对齐 experiment / figure / ledger：**一个工具 + action 枚举**，不拆成 5 个工具
 * （避免工具面板膨胀、也避免模型在多个近义工具间选错）。
 *
 * 关于「当前项目」：后端 listProjects() 只按 updatedAt 倒序，**没有「当前项目」概念**。
 * 因此本工具不维护任何当前项目状态；需要项目上下文时先 action='list' 拿列表，
 * 按标题匹配后仍不确定就向用户确认 projectId。
 */
import { tool } from 'langchain/tools'
import { z } from 'zod'
import { listProjects, createProject, updateProject, deleteProject } from '../../library/libraryService'
import type { ProjectRecord } from '../../library/types'
import { currentSpaceEpoch, assertSpaceUnchanged } from '../../library/store'
import { requireBusinessApproval } from '../approval'

/** 把项目渲染成一行摘要（列表与确认卡共用，口径一致）。 */
function describe(project: ProjectRecord): string {
  const dir = project.paperDir ? ` · 论文目录: ${project.paperDir}` : ''
  return `${project.id} | ${project.title}${dir}`
}

function describeList(projects: ProjectRecord[]): string {
  if (projects.length === 0) {
    return '当前空间暂无研究项目。可用 project(action="create") 新建。'
  }
  const lines = projects.map((p) => `- ${describe(p)}`)
  return `当前空间共 ${projects.length} 个项目（按最近更新倒序）：\n${lines.join('\n')}`
}

export const projectTool = tool(
  async ({ action, projectId, title, paperDir }) => {
    try {
      const epoch = currentSpaceEpoch()

      if (action === 'list') {
        return describeList(await listProjects())
      }

      if (action === 'get') {
        if (!projectId) return '读取失败：需要 projectId。先用 action="list" 查看可用项目。'
        const target = (await listProjects()).find((p) => p.id === projectId)
        if (target === undefined) {
          return `找不到项目 id「${projectId}」。可用项目：\n${(await listProjects()).map(describe).join('\n') || '(无)'}`
        }
        return `项目详情：\n- id: ${target.id}\n- 标题: ${target.title}\n- 论文目录: ${target.paperDir || '(未设置)'}\n- 创建: ${target.createdAt}\n- 更新: ${target.updatedAt}`
      }

      if (action === 'create') {
        if (!title || title.trim() === '') return '创建失败：title 不能为空。'
        const allowed = await requireBusinessApproval({
          tool: 'project',
          summary: `新建研究项目「${title.trim()}」`,
          detail: paperDir ? `论文目录: ${paperDir}` : '未指定论文目录',
        })
        if (!allowed) return '已取消：新建项目操作未获得用户确认。'
        assertSpaceUnchanged(epoch)
        const created = await createProject(title, paperDir)
        return `已创建项目 ${created.id}「${created.title}」${created.paperDir ? `（论文目录: ${created.paperDir}）` : ''}。`
      }

      if (action === 'update') {
        if (!projectId) return '更新失败：需要 projectId。先用 action="list" 查看可用项目。'
        if (title === undefined && paperDir === undefined) {
          return '更新失败：至少提供 title 或 paperDir 其中之一。'
        }
        const current = (await listProjects()).find((p) => p.id === projectId)
        if (current === undefined) {
          return `找不到项目 id「${projectId}」。可用项目：\n${(await listProjects()).map(describe).join('\n') || '(无)'}`
        }
        const changes: string[] = []
        if (title !== undefined) changes.push(`标题: ${current.title} → ${title.trim() || '(不变)'}`)
        if (paperDir !== undefined) changes.push(`论文目录: ${current.paperDir || '(未设置)'} → ${paperDir.trim() || '(清空)'}`)
        const allowed = await requireBusinessApproval({
          tool: 'project',
          summary: `更新研究项目「${current.title}」`,
          detail: changes.join('\n'),
        })
        if (!allowed) return '已取消：更新项目操作未获得用户确认。'
        assertSpaceUnchanged(epoch)
        const updated = await updateProject(projectId, {
          ...(title !== undefined ? { title } : {}),
          ...(paperDir !== undefined ? { paperDir } : {}),
        })
        return `已更新项目 ${updated.id}「${updated.title}」。`
      }

      if (action === 'delete') {
        if (!projectId) return '删除失败：需要 projectId。先用 action="list" 查看可用项目。'
        const target = (await listProjects()).find((p) => p.id === projectId)
        if (target === undefined) {
          return `找不到项目 id「${projectId}」。可用项目：\n${(await listProjects()).map(describe).join('\n') || '(无)'}`
        }
        // summary 必须以「删除」开头：isDestructiveApproval 据此判定，
        // 保证全权档下也仍然弹卡（误删项目会连带清掉论文的项目关联）。
        const allowed = await requireBusinessApproval({
          tool: 'project',
          summary: `删除研究项目「${target.title}」`,
          detail: `id: ${target.id}\n注意：会同时把该项目从所有论文的关联中移除，且不可撤销。`,
        })
        if (!allowed) return '已取消：删除项目操作未获得用户确认。'
        assertSpaceUnchanged(epoch)
        await deleteProject(projectId)
        return `已删除项目 ${target.id}「${target.title}」，并已清理论文中对该项目的关联。`
      }

      return '未知 action（可选：list / get / create / update / delete）。'
    } catch (error) {
      return `项目工具执行失败：${error instanceof Error ? error.message : '未知错误'}`
    }
  },
  {
    name: 'project',
    description:
      '操作当前科研空间的研究项目（与「研究项目」模块同一份数据）。action=list 列出全部（按最近更新倒序）；get 读单个项目详情；create 新建（title 必填，paperDir 可选）；update 改标题/论文目录（projectId 必填，title/paperDir 至少给一个）；delete 删除（会级联清理论文中的项目关联，不可撤销）。写操作前请先与用户确认。',
    schema: z.object({
      action: z.enum(['list', 'get', 'create', 'update', 'delete']),
      projectId: z.string().optional().describe('get / update / delete 时的项目 id'),
      title: z.string().optional().describe('项目标题（create 必填；update 时表示改标题）'),
      paperDir: z.string().optional().describe('项目对应的本地 LaTeX 目录（可选；update 时传空串表示清空）'),
    }),
  },
)
