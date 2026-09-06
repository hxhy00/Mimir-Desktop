import { useState } from 'react'
import { FolderPlus, Folder, Pencil, Trash2, Check, X, FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { ProjectRecord } from './types'

interface ProjectBarProps {
  projects: ProjectRecord[]
  selectedProjectId: string | null
  onSelect: (id: string | null) => void
  onCreate: (title: string, paperDir?: string) => Promise<void>
  onRename: (id: string, title: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
}

export function ProjectBar({
  projects,
  selectedProjectId,
  onSelect,
  onCreate,
  onRename,
  onDelete
}: ProjectBarProps) {
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameTitle, setRenameTitle] = useState('')
  const [busy, setBusy] = useState(false)

  const submitCreate = async () => {
    if (!newTitle.trim() || busy) return
    setBusy(true)
    try {
      await onCreate(newTitle.trim())
      setNewTitle('')
      setCreating(false)
    } finally {
      setBusy(false)
    }
  }

  const submitRename = async () => {
    if (!renamingId || !renameTitle.trim() || busy) return
    setBusy(true)
    try {
      await onRename(renamingId, renameTitle.trim())
      setRenamingId(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <button
        onClick={() => onSelect(null)}
        className={cn(
          'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors',
          selectedProjectId === null
            ? 'bg-primary/10 text-primary'
            : 'text-muted-foreground hover:bg-muted'
        )}
        title="全部项目"
      >
        <FolderOpen className="h-3.5 w-3.5" />
        全部
      </button>

      {projects.map((project) => (
        <div
          key={project.id}
          className={cn(
            'group flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
            selectedProjectId === project.id
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:bg-muted'
          )}
        >
          {renamingId === project.id ? (
            <div className="flex items-center gap-1">
              <Input
                value={renameTitle}
                onChange={(e) => setRenameTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitRename()
                  if (e.key === 'Escape') setRenamingId(null)
                }}
                className="h-6 w-28 text-[11px] px-1.5"
                autoFocus
              />
              <button onClick={submitRename} className="text-green-600 hover:text-green-700" title="保存">
                <Check className="h-3 w-3" />
              </button>
              <button onClick={() => setRenamingId(null)} className="text-muted-foreground hover:text-foreground" title="取消">
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : (
            <>
              <button
                onClick={() => onSelect(project.id)}
                className="flex items-center gap-1.5"
                title={project.paperDir ? `论文目录: ${project.paperDir}` : project.title}
              >
                <Folder className="h-3.5 w-3.5" />
                {project.title}
              </button>
              <div className="hidden group-hover:flex items-center gap-0.5">
                <button
                  onClick={() => {
                    setRenamingId(project.id)
                    setRenameTitle(project.title)
                  }}
                  className="text-muted-foreground/60 hover:text-foreground"
                  title="重命名"
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  onClick={() => {
                    if (window.confirm(`删除项目「${project.title}」？论文不会被删除，仅解除关联。`)) {
                      onDelete(project.id)
                    }
                  }}
                  className="text-muted-foreground/60 hover:text-destructive"
                  title="删除"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            </>
          )}
        </div>
      ))}

      {creating ? (
        <div className="flex items-center gap-1">
          <Input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitCreate()
              if (e.key === 'Escape') setCreating(false)
            }}
            placeholder="项目名称"
            className="h-6 w-28 text-[11px] px-1.5"
            autoFocus
          />
          <button onClick={submitCreate} className="text-green-600 hover:text-green-700" title="创建">
            <Check className="h-3 w-3" />
          </button>
          <button onClick={() => setCreating(false)} className="text-muted-foreground hover:text-foreground" title="取消">
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => setCreating(true)}
        >
          <FolderPlus className="h-3.5 w-3.5 mr-1" />
          新建项目
        </Button>
      )}
    </div>
  )
}