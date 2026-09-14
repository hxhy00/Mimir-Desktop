import { useState } from 'react'
import {
  Presentation,
  FileText,
  Image as ImageIcon,
  FileSpreadsheet,
  FileArchive,
  FileCode2,
  FolderOpen,
  ExternalLink,
  Check
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChatArtifact } from './ChatView'

/** 按扩展名归类图标与配色（与模块页产物卡的视觉语言一致）。 */
function iconFor(ext: string): { Icon: React.ElementType; tone: string } {
  switch (ext) {
    case '.pptx':
    case '.ppt':
      return { Icon: Presentation, tone: 'text-orange-500 bg-orange-500/10' }
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.svg':
    case '.gif':
    case '.webp':
      return { Icon: ImageIcon, tone: 'text-purple-500 bg-purple-500/10' }
    case '.csv':
    case '.xlsx':
      return { Icon: FileSpreadsheet, tone: 'text-green-600 bg-green-500/10' }
    case '.zip':
    case '.tar':
    case '.gz':
      return { Icon: FileArchive, tone: 'text-amber-600 bg-amber-500/10' }
    case '.json':
    case '.ipynb':
      return { Icon: FileCode2, tone: 'text-sky-600 bg-sky-500/10' }
    default:
      return { Icon: FileText, tone: 'text-blue-500 bg-blue-500/10' }
  }
}

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

interface ArtifactCardProps {
  artifacts: ChatArtifact[]
}

/**
 * 对话内产物验收卡：Agent 回复过程中落盘的文件，在气泡下方列出，
 * 提供「打开」与「打开所在文件夹」——均复用既有 shell 通道，不新增无校验入口。
 */
export function ArtifactCard({ artifacts }: ArtifactCardProps) {
  const [opened, setOpened] = useState<Record<string, boolean>>({})

  if (artifacts.length === 0) return null

  const handleOpen = (path: string): void => {
    window.electronAPI?.openPath?.(path).catch(() => {})
    setOpened((prev) => ({ ...prev, [path]: true }))
    setTimeout(() => setOpened((prev) => ({ ...prev, [path]: false })), 1500)
  }

  const handleReveal = (path: string): void => {
    // 复用组会模块的「打开所在文件夹」通道（主进程 shell.showItemInFolder）
    window.electronAPI?.revealPath?.(path).catch(() => {})
  }

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
        <Check className="h-3 w-3 text-green-500" />
        产出 {artifacts.length} 个文件
      </div>
      {artifacts.map((art) => {
        const { Icon, tone } = iconFor(art.ext)
        const size = formatSize(art.sizeBytes)
        return (
          <div
            key={art.path}
            className="flex items-center gap-2 rounded-md border border-border bg-card/60 px-2.5 py-1.5"
          >
            <div className={cn('flex h-6 w-6 items-center justify-center rounded shrink-0', tone)}>
              <Icon className="h-3.5 w-3.5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-medium text-foreground">{art.name}</div>
              {size !== '' && <div className="text-[10px] text-muted-foreground">{size}</div>}
            </div>
            <div className="flex items-center gap-0.5 shrink-0">
              <button
                onClick={() => handleOpen(art.path)}
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                title="打开文件"
              >
                {opened[art.path] ? (
                  <Check className="h-3.5 w-3.5 text-green-500" />
                ) : (
                  <ExternalLink className="h-3.5 w-3.5" />
                )}
              </button>
              <button
                onClick={() => handleReveal(art.path)}
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                title="打开所在文件夹"
              >
                <FolderOpen className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
