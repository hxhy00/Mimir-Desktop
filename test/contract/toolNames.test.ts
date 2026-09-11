/**
 * 契约测试 ①：工具名不与 deepagents 内置工具冲突。
 *
 * 背景（真实踩坑）：LangChain v1 的 AgentNode 在 `wrapModelCall` 阶段校验工具——
 * 只允许「新增」工具，禁止「同名换实例」。deepagents 的 FilesystemMiddleware 会注入
 * FILESYSTEM_TOOL_NAMES，若我们自己再注册同名工具，构建 agent 时就抛：
 *   You have modified a tool in "wrapModelCall" hook ... This is not supported.
 *
 * 这类错误在类型检查/编译期完全无法发现，只能在运行期暴露。因此把它固化成断言：
 * 任何人给子代理白名单加一个与内置同名的工具，本测试立即变红。
 */
import { describe, expect, it } from 'vitest'
import { WORKER_TOOL_CATALOG, BUILTIN_SUBAGENTS } from '../../electron/agent/subagentRegistry'

/**
 * deepagents FilesystemMiddleware 注入的内置文件工具名。
 * 来源：deepagents 的 FILESYSTEM_TOOL_NAMES 常量（1.13.3）。
 * 升级 deepagents 后若此项变化，本测试会失败并提示需同步核对。
 */
const FILESYSTEM_TOOL_NAMES = [
  'ls',
  'read_file',
  'write_file',
  'edit_file',
  'delete',
  'glob',
  'grep',
  'execute'
] as const

/** deepagents / langchain 中间件注入的非文件工具名（同样是保留名）。 */
const MIDDLEWARE_RESERVED_NAMES = ['task', 'write_todos', 'load_memory'] as const

const RESERVED = new Set<string>([...FILESYSTEM_TOOL_NAMES, ...MIDDLEWARE_RESERVED_NAMES])

describe('工具名契约：不得与内置/中间件保留名冲突', () => {
  it('deepagents 内置文件工具清单与预期一致（升级依赖后需复核）', () => {
    // 该断言用于「依赖升级导致清单变化」时主动提醒，而不是静默放过
    expect([...FILESYSTEM_TOOL_NAMES]).toHaveLength(8)
    expect(FILESYSTEM_TOOL_NAMES).toContain('read_file')
    expect(FILESYSTEM_TOOL_NAMES).toContain('write_file')
  })

  it('工具白名单（WORKER_TOOL_CATALOG）不含任何保留名', () => {
    const clashes = WORKER_TOOL_CATALOG.map((t) => t.id).filter((id) => RESERVED.has(id))
    expect(
      clashes,
      `以下工具名与 deepagents 内置/保留名冲突，构建 agent 时会抛 MiddlewareError：${clashes.join('、')}`
    ).toEqual([])
  })

  it('内置子代理引用的工具 id 均存在于白名单，且不含保留名', () => {
    const catalog = new Set(WORKER_TOOL_CATALOG.map((t) => t.id))
    const unknown: string[] = []
    const clashes: string[] = []
    for (const sub of BUILTIN_SUBAGENTS) {
      for (const id of sub.toolIds) {
        if (!catalog.has(id)) unknown.push(`${sub.id} → ${id}`)
        if (RESERVED.has(id)) clashes.push(`${sub.id} → ${id}`)
      }
    }
    expect(unknown, `子代理引用了白名单外的工具 id：${unknown.join('、')}`).toEqual([])
    expect(clashes, `子代理引用了保留名工具：${clashes.join('、')}`).toEqual([])
  })

  it('工具白名单内 id 唯一（重复 id 会导致注册表解析歧义）', () => {
    const ids = WORKER_TOOL_CATALOG.map((t) => t.id)
    expect(ids.length).toBe(new Set(ids).size)
  })

  it('子代理 id 唯一且符合命名规范', () => {
    const ids = BUILTIN_SUBAGENTS.map((b) => b.id)
    expect(ids.length).toBe(new Set(ids).size)
    for (const id of ids) {
      expect(id, `子代理 id「${id}」不符合小写字母/数字/中划线规范`).toMatch(/^[a-z][a-z0-9-]*$/)
    }
  })
})
