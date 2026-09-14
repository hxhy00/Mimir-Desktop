/**
 * 设置 → 权限与安全。
 *
 * 这里回答三个问题：
 * 1. **允许 Agent 动哪里** —— 沙箱档位（只读 / 工作区可写 / 全权）；
 * 2. **哪些目录已经免问** —— 「允许并记住」攒下来的允许列表，可随时撤销；
 * 3. **它到底动过什么** —— 审计日志。
 *
 * 第 3 条不是锦上添花：权限矩阵把「每次都问」换成「问一次、以后放行」，
 * 前提就是用户能事后看见 Agent 动了他哪些文件；否则放行等于把控制权交进黑箱。
 *
 * 说明：档位文案与判定逻辑的权威定义在 `electron/agent/permissions.ts`
 * （`SANDBOX_LABELS` / `decidePermission`）。渲染层不 import electron 模块（会拖入主进程依赖链），
 * 因此这里复述一份展示文案，保持一致即可。
 */
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { FolderLock, FolderOpen, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'

type SandboxLevel = 'read-only' | 'workspace-write' | 'danger-full-access'

interface Policy {
  sandbox: SandboxLevel
  askInsideSpace: boolean
  allowedWriteRoots: string[]
  allowedReadRoots: string[]
}

interface AuditEntry {
  at: string
  action: 'read' | 'write'
  target: string
  decision: 'allow' | 'deny' | 'ask'
  resolved?: 'allow' | 'deny' | 'remember'
}

const SANDBOX_OPTIONS: { value: SandboxLevel; label: string; desc: string; danger?: boolean }[] = [
  {
    value: 'read-only',
    label: '只读档',
    desc: '禁止任何写盘；空间外读取仍需逐个批准。'
  },
  {
    value: 'workspace-write',
    label: '工作区可写（默认）',
    desc: '科研空间与「已记住的目录」可写；空间外写入逐个批准。'
  },
  {
    value: 'danger-full-access',
    label: '全权档',
    desc: '除配置目录外均可写、空间外可读。请确认你清楚风险。',
    danger: true
  }
]

const DECISION_LABEL: Record<string, string> = {
  allow: '放行',
  deny: '拒绝',
  ask: '询问'
}

const RESOLVED_LABEL: Record<string, string> = {
  allow: '允许一次',
  deny: '拒绝',
  remember: '允许并记住'
}

export function SettingsPermissionsCard() {
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [spaceRoot, setSpaceRoot] = useState('')
  const [msg, setMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)
  const [loading, setLoading] = useState(false)
  /** 待授权目录输入框（可用系统对话框选，也可直接粘贴路径）。 */
  const [pendingDir, setPendingDir] = useState('')

  const refresh = useCallback(async () => {
    const api = window.electronAPI?.permissions
    if (!api) {
      setMsg({ type: 'error', text: '权限设置仅在 Electron 运行环境中可用。' })
      return
    }
    setLoading(true)
    try {
      const state = await api.get()
      setPolicy(state.policy)
      setAudit(state.audit)
      setSpaceRoot(state.spaceRoot)
    } catch (error) {
      setMsg({ type: 'error', text: `读取失败：${error instanceof Error ? error.message : '未知错误'}` })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** 保存策略补丁（只提交白名单字段，主进程还会再收敛一次）。 */
  const save = useCallback(
    async (patch: Partial<Policy>) => {
      const api = window.electronAPI?.permissions
      if (!api) return
      try {
        const next = (await api.set(patch as Record<string, unknown>)) as Policy
        setPolicy(next)
        setMsg({ type: 'ok', text: '已保存，立即生效。' })
      } catch (error) {
        setMsg({ type: 'error', text: `保存失败：${error instanceof Error ? error.message : '未知错误'}` })
      }
    },
    []
  )

  const revoke = useCallback(
    async (dir: string) => {
      const api = window.electronAPI?.permissions
      if (!api) return
      const res = await api.revokeRoot(dir)
      setMsg({ type: res.ok ? 'ok' : 'error', text: res.message })
      await refresh()
    },
    [refresh]
  )

  /**
   * 直接在设置里加一个「免问目录」。
   *
   * 为什么需要它：原来只有在批准卡弹出时点「允许并记住」才能攒下允许列表 ——
   * 也就是**必须先被打断一次**。用户如果已经清楚要让 Agent 动哪个目录（比如自己的
   * 代码仓库），应该能主动、提前授权，而不是一次次点批准卡。
   */
  const allowRoot = useCallback(
    async (action: 'read' | 'write'): Promise<void> => {
      const api = window.electronAPI?.permissions
      const dir = pendingDir.trim()
      if (api === undefined || dir === '') return
      try {
        const res = await api.allowRoot(dir, action)
        setMsg({ type: res.ok ? 'ok' : 'error', text: res.message })
        if (res.ok) {
          setPendingDir('')
          await refresh()
        }
      } catch (error) {
        setMsg({ type: 'error', text: `添加失败：${error instanceof Error ? error.message : '未知错误'}` })
      }
    },
    [pendingDir, refresh]
  )

  /** 用系统对话框选目录（与「科研空间」选择一致的原生体验）。 */
  const pickDir = useCallback(async (): Promise<void> => {
    const res = await window.electronAPI?.showOpenDialog?.({
      title: '选择要免问的目录',
      buttonLabel: '选择此目录',
      properties: ['openDirectory', 'createDirectory']
    })
    if (res?.canceled === false && Array.isArray(res.filePaths) && res.filePaths.length > 0) {
      setPendingDir(String(res.filePaths[0] ?? ''))
    }
  }, [])

  const roots: { dir: string; kind: '写' | '读' }[] = [
    ...(policy?.allowedWriteRoots ?? []).map((dir) => ({ dir, kind: '写' as const })),
    ...(policy?.allowedReadRoots ?? []).map((dir) => ({ dir, kind: '读' as const }))
  ]

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">权限与安全</h2>
        </div>
        <Button size="sm" variant="outline" className="h-7" disabled={loading} onClick={() => void refresh()}>
          <RefreshCw className={cn('h-3.5 w-3.5 mr-1', loading && 'animate-spin')} />
          刷新
        </Button>
      </div>

      {msg !== null && (
        <p
          className={cn(
            'rounded-md px-2.5 py-1.5 text-[10px]',
            msg.type === 'ok' ? 'bg-emerald-500/10 text-emerald-600' : 'bg-amber-500/10 text-amber-600'
          )}
        >
          {msg.text}
        </p>
      )}

      {/* 沙箱档位 */}
      <div className="space-y-2 rounded-lg border border-border bg-card p-4">
        <div>
          <p className="text-[12px] font-medium text-foreground">Sandbox 档位</p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            决定 Agent 被允许改动哪里。当前科研空间：<span className="font-mono">{spaceRoot || '（未设置）'}</span>
          </p>
        </div>
        <div className="space-y-1.5">
          {SANDBOX_OPTIONS.map((opt) => {
            const active = policy?.sandbox === opt.value
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => void save({ sandbox: opt.value })}
                className={cn(
                  'w-full rounded-md border px-3 py-2 text-left transition-colors',
                  active ? 'border-primary/60 bg-primary/5' : 'border-border hover:bg-accent',
                  opt.danger === true && !active && 'border-destructive/30'
                )}
              >
                <p className={cn('text-[12px] font-medium', opt.danger === true ? 'text-destructive' : 'text-foreground')}>
                  {opt.label}
                  {active && <span className="ml-1.5 text-[9px] font-normal text-primary">当前</span>}
                </p>
                <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">{opt.desc}</p>
              </button>
            )
          })}
        </div>

        <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border px-3 py-2">
          <input
            type="checkbox"
            className="mt-0.5 h-3.5 w-3.5 rounded accent-primary"
            checked={policy?.askInsideSpace === true}
            onChange={(e) => void save({ askInsideSpace: e.target.checked })}
          />
          <span>
            <span className="text-[12px] text-foreground">科研空间内写盘也要确认</span>
            <span className="ml-1.5 text-[10px] text-muted-foreground">
              （默认关闭：空间是你自己的资料库，逐次确认会把人训练成无脑点是）
            </span>
          </span>
        </label>
      </div>

      {/* 已记住的目录 */}
      <div className="space-y-2 rounded-lg border border-border bg-card p-4">
        <div className="flex items-center gap-2">
          <FolderLock className="h-3.5 w-3.5 text-muted-foreground" />
          <Label className="text-[12px] font-medium">已记住的目录 · {roots.length}</Label>
        </div>

        {/* 主动授权：不必先被批准卡打断一次 */}
        <div className="space-y-1.5 rounded-md border border-dashed border-border/70 p-2">
          <div className="flex items-center gap-1.5">
            <Input
              value={pendingDir}
              onChange={(e) => setPendingDir(e.target.value)}
              placeholder="目录路径，如 /Users/you/code/my-project"
              className="h-7 font-mono text-[10px]"
            />
            <Button
              variant="outline"
              size="sm"
              className="h-7 shrink-0 px-2 text-[10px]"
              onClick={() => void pickDir()}
            >
              <FolderOpen className="mr-1 h-3 w-3" />
              选择…
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              className="h-7 px-2 text-[10px]"
              disabled={pendingDir.trim() === ''}
              onClick={() => void allowRoot('write')}
            >
              允许写入该目录
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[10px]"
              disabled={pendingDir.trim() === ''}
              onClick={() => void allowRoot('read')}
            >
              允许读取该目录
            </Button>
            <span className="text-[10px] text-muted-foreground">含子目录；之后同类操作不再弹批准卡</span>
          </div>
        </div>

        {roots.length === 0 ? (
          <p className="text-[10px] text-muted-foreground">
            还没有。可在上方直接添加，或在批准卡上点「允许并记住此目录」——两种方式都会出现在这里。
          </p>
        ) : (
          <div className="space-y-1">
            {roots.map((r) => (
              <div
                key={`${r.kind}-${r.dir}`}
                className="flex items-center gap-2 rounded-md border border-border/70 px-2.5 py-1.5"
              >
                <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[9px] text-muted-foreground">
                  免批准{r.kind}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[10px]" title={r.dir}>
                  {r.dir}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[10px] text-destructive hover:text-destructive"
                  onClick={() => void revoke(r.dir)}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        )}
        <p className="text-[10px] text-muted-foreground">
          配置目录（如 <span className="font-mono">~/.mimir</span>）永远不可写，任何档位都无法绕过。
        </p>
      </div>

      {/* 审计日志 */}
      <div className="space-y-2 rounded-lg border border-border bg-card p-4">
        <Label className="text-[12px] font-medium">审计日志（最近 {Math.min(audit.length, 30)} 条）</Label>
        {audit.length === 0 ? (
          <p className="text-[10px] text-muted-foreground">还没有记录。Agent 每次读取或写入文件都会留一条。</p>
        ) : (
          <div className="max-h-64 space-y-0.5 overflow-y-auto">
            {audit.slice(0, 30).map((e, i) => (
              <div key={`${e.at}-${i}`} className="flex items-baseline gap-1.5 text-[10px]">
                <span className="shrink-0 font-mono text-muted-foreground/70">{e.at.slice(11, 19)}</span>
                <span
                  className={cn(
                    'shrink-0 rounded px-1 py-px',
                    e.decision === 'allow'
                      ? 'bg-emerald-500/10 text-emerald-600'
                      : e.decision === 'deny'
                        ? 'bg-destructive/10 text-destructive'
                        : 'bg-amber-500/10 text-amber-600'
                  )}
                >
                  {e.action === 'write' ? '写' : '读'}
                  {DECISION_LABEL[e.decision] ?? e.decision}
                  {e.resolved !== undefined ? `·${RESOLVED_LABEL[e.resolved] ?? e.resolved}` : ''}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-foreground/80" title={e.target}>
                  {e.target}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
