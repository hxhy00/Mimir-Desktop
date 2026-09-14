/**
 * 权限策略单元测试（纯函数，不碰文件系统、不读 store）。
 *
 * 覆盖点：
 * 1. 判定优先级（控制平面 > 只读档 > 全权档 > 空间内 > 记忆根 > 兜底）；
 * 2. 「已记住的写根 ≠ 可读根」——两个列表互不越权；
 * 3. 路径边界（前缀相近不误判：`/a/bc` 不在 `/a/b` 之下）；
 * 4. `coercePolicy` 对脏数据的收敛；
 * 5. `normalizeAllowedRoot` 对危险输入（`/`、home、控制平面、相对路径）的拒绝。
 *
 * 这些规则的意义：它们决定「Agent 能不能不经用户同意就动磁盘」。写错一条就是安全问题，
 * 所以每条都要有可执行断言守着。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_POLICY,
  coercePolicy,
  decidePermission,
  normalizeAllowedRoot,
  type PermissionInput,
  type PermissionPolicy
} from '../../electron/agent/permissions'

/** 测试用控制平面判定：把 `/.mimir` 视为控制平面。 */
const isControlPlane = (p: string): boolean => p === '/.mimir' || p.startsWith('/.mimir/')

const SPACE = '/home/u/Mimir/默认空间'

function input(over: Partial<PermissionInput> & { target: string }): PermissionInput {
  return {
    action: 'read',
    spaceRoot: SPACE,
    policy: { ...DEFAULT_POLICY },
    isControlPlane,
    ...over
  }
}

function policy(over: Partial<PermissionPolicy> = {}): PermissionPolicy {
  return { ...DEFAULT_POLICY, ...over }
}

describe('decidePermission：优先级顺序', () => {
  it('控制平面在任何档位下都硬拒绝（含全权档与已记住的根）', () => {
    const targets = ['/.mimir/store.json', '/.mimir/logs/x.jsonl']
    const policies: PermissionPolicy[] = [
      policy({ sandbox: 'read-only' }),
      policy({ sandbox: 'workspace-write' }),
      policy({ sandbox: 'danger-full-access' }),
      // 即便用户把控制平面写进了允许列表，也必须被规则 1 拦下（防御脏数据/人为误改）
      policy({ sandbox: 'danger-full-access', allowedWriteRoots: ['/'], allowedReadRoots: ['/'] })
    ]
    for (const t of targets) {
      for (const p of policies) {
        expect(decidePermission(input({ target: t, action: 'write', policy: p })), `${t} 写入`).toBe('deny')
        expect(decidePermission(input({ target: t, action: 'read', policy: p })), `${t} 读取`).toBe('deny')
      }
    }
  })

  it('只读档：写入一律拒绝（空间内也不行）', () => {
    const p = policy({ sandbox: 'read-only' })
    expect(decidePermission(input({ target: `${SPACE}/note.md`, action: 'write', policy: p }))).toBe('deny')
    expect(decidePermission(input({ target: '/tmp/out.md', action: 'write', policy: p }))).toBe('deny')
    expect(
      decidePermission(input({ target: '/tmp/out.md', action: 'write', policy: p, isControlPlane: () => false }))
    ).toBe('deny')
  })

  it('只读档：空间内读取放行，空间外读取仍要批准', () => {
    const p = policy({ sandbox: 'read-only' })
    expect(decidePermission(input({ target: `${SPACE}/a.md`, policy: p }))).toBe('allow')
    expect(decidePermission(input({ target: '/tmp/a.md', policy: p }))).toBe('ask')
  })

  it('全权档：空间外读写都放行（控制平面除外，见第一条）', () => {
    const p = policy({ sandbox: 'danger-full-access' })
    expect(decidePermission(input({ target: '/tmp/a.md', action: 'write', policy: p }))).toBe('allow')
    expect(decidePermission(input({ target: '/tmp/a.md', policy: p }))).toBe('allow')
  })
})

describe('decidePermission：工作区可写（默认档）', () => {
  it('空间内写入默认免批准；askInsideSpace=true 时才弹卡', () => {
    expect(decidePermission(input({ target: `${SPACE}/note.md`, action: 'write' }))).toBe('allow')
    expect(
      decidePermission(input({ target: `${SPACE}/note.md`, action: 'write', policy: policy({ askInsideSpace: true }) }))
    ).toBe('ask')
  })

  it('空间外写入 → 弹批准卡（默认档）', () => {
    expect(decidePermission(input({ target: '/tmp/out.md', action: 'write' }))).toBe('ask')
  })

  it('已记住的可写根：其下写入放行，但读取不受益（两个列表互不越权）', () => {
    const p = policy({ allowedWriteRoots: ['/work/proj'] })
    expect(decidePermission(input({ target: '/work/proj/a.md', action: 'write', policy: p }))).toBe('allow')
    expect(decidePermission(input({ target: '/work/proj/a.md', action: 'read', policy: p }))).toBe('ask')
  })

  it('已记住的可读根：其下读取放行，但写入不受益', () => {
    const p = policy({ allowedReadRoots: ['/data/refs'] })
    expect(decidePermission(input({ target: '/data/refs/a.md', action: 'read', policy: p }))).toBe('allow')
    expect(decidePermission(input({ target: '/data/refs/a.md', action: 'write', policy: p }))).toBe('ask')
  })

  it('未记忆的路径 → 弹卡', () => {
    const p = policy({ allowedWriteRoots: ['/work/proj'] })
    expect(decidePermission(input({ target: '/work/other/a.md', action: 'write', policy: p }))).toBe('ask')
  })
})

describe('decidePermission：路径边界', () => {
  it('前缀相近但不在根之下 → 不误放行', () => {
    const p = policy({ allowedWriteRoots: ['/a/b'] })
    expect(decidePermission(input({ target: '/a/bc/x.md', action: 'write', policy: p }))).toBe('ask')
    expect(decidePermission(input({ target: '/a/b/x.md', action: 'write', policy: p }))).toBe('allow')
  })

  it('根自身即目标 → 视为在根之下', () => {
    const p = policy({ allowedWriteRoots: ['/a/b'] })
    expect(decidePermission(input({ target: '/a/b', action: 'write', policy: p }))).toBe('allow')
  })

  it('末尾斜杠 / 重复斜杠 / 相对片段被归一化后判定一致', () => {
    const p = policy({ allowedWriteRoots: ['/a/b/'] })
    expect(decidePermission(input({ target: '/a//b/./c.md', action: 'write', policy: p }))).toBe('allow')
    expect(decidePermission(input({ target: '/a/b/../c.md', action: 'write', policy: p }))).toBe('ask')
  })

  it('科研空间自身的判定同样做归一化（避免因写法差异绕过「空间内」）', () => {
    expect(decidePermission(input({ target: `${SPACE}/`, action: 'write' }))).toBe('allow')
    expect(decidePermission(input({ target: `${SPACE}/sub/../note.md`, action: 'write' }))).toBe('allow')
  })
})

describe('coercePolicy：脏数据收敛', () => {
  it('缺失/非法输入 → 回落默认策略', () => {
    expect(coercePolicy(undefined)).toEqual(DEFAULT_POLICY)
    expect(coercePolicy(null)).toEqual(DEFAULT_POLICY)
    expect(coercePolicy('nope')).toEqual(DEFAULT_POLICY)
    expect(coercePolicy({ sandbox: 'root' })).toEqual(DEFAULT_POLICY)
  })

  it('askInsideSpace 只有显式 true 才为 true（默认不打扰）', () => {
    expect(coercePolicy({ askInsideSpace: 'true' }).askInsideSpace).toBe(false)
    expect(coercePolicy({ askInsideSpace: true }).askInsideSpace).toBe(true)
  })

  it('允许列表过滤非字符串与空串，并做规范化', () => {
    const p = coercePolicy({ allowedWriteRoots: ['/a/b/', '', 42, null, '/c//d'] })
    expect(p.allowedWriteRoots).toEqual(['/a/b', '/c/d'])
  })

  it('非数组的允许列表按空处理', () => {
    expect(coercePolicy({ allowedWriteRoots: '/a' }).allowedWriteRoots).toEqual([])
  })
})

describe('normalizeAllowedRoot：拒绝危险输入', () => {
  const ctx = { home: '/home/u', isControlPlane }

  it('拒绝空值、相对路径、根目录、主目录本身、控制平面', () => {
    expect(normalizeAllowedRoot('', ctx).ok).toBe(false)
    expect(normalizeAllowedRoot('  ', ctx).ok).toBe(false)
    expect(normalizeAllowedRoot('work/proj', ctx).ok).toBe(false)
    expect(normalizeAllowedRoot('/', ctx).ok).toBe(false)
    expect(normalizeAllowedRoot('/home/u', ctx).ok).toBe(false)
    expect(normalizeAllowedRoot('/.mimir', ctx).ok).toBe(false)
    expect(normalizeAllowedRoot('/.mimir/sub', ctx).ok).toBe(false)
  })

  it('拒绝原因面向用户可读（不是「invalid input」）', () => {
    expect(normalizeAllowedRoot('/', ctx).reason).toContain('整个文件系统')
    expect(normalizeAllowedRoot('/home/u', ctx).reason).toContain('主目录')
    expect(normalizeAllowedRoot('/.mimir', ctx).reason).toContain('控制平面')
    expect(normalizeAllowedRoot('work', ctx).reason).toContain('绝对路径')
  })

  it('接受具体子目录，并规范化末尾斜杠', () => {
    expect(normalizeAllowedRoot('/work/proj/', ctx)).toEqual({ ok: true, root: '/work/proj' })
    expect(normalizeAllowedRoot('/home/u/papers', ctx)).toEqual({ ok: true, root: '/home/u/papers' })
  })
})
