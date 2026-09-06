import { useEffect, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { FileText, BookOpen, BarChart3, Image, Server, Clock, ArrowRight, FolderKanban } from 'lucide-react'
import type { ModuleId } from '@/components/layout/Sidebar'

interface StatItem {
  title: string
  value: number
  icon: React.ElementType
}

interface OverviewProps {
  onNavigate: (id: ModuleId) => void
}

interface QuickAction {
  label: string
  desc: string
  icon: React.ElementType
  target: ModuleId
}

const QUICK_ACTIONS: QuickAction[] = [
  { label: '管理文献', desc: '文献库搜索与项目', icon: BookOpen, target: 'library' },
  { label: '记录实验', desc: '新建实验', icon: BarChart3, target: 'experiments' },
  { label: '生成 PPT', desc: '组会准备', icon: FileText, target: 'meetings' },
  { label: '管理图表', desc: '上传与管理图片', icon: Image, target: 'figures' },
  { label: '添加服务器', desc: 'GPU 管理', icon: Server, target: 'servers' },
  { label: '记录进展', desc: '成长记录时间线', icon: Clock, target: 'ledger' }
]

export function Overview({ onNavigate }: OverviewProps) {
  const [stats, setStats] = useState<StatItem[]>([
    { title: '论文', value: 0, icon: FileText },
    { title: '项目', value: 0, icon: FolderKanban },
    { title: '实验', value: 0, icon: BarChart3 },
    { title: '记录', value: 0, icon: Clock }
  ])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        let paperCount = 0
        let projectCount = 0
        let experimentCount = 0
        let ledgerCount = 0
        const api = window.electronAPI
        if (api?.library) {
          const [papersRes, projectsRes] = await Promise.all([
            api.library.listPapers(),
            api.library.listProjects()
          ])
          if (papersRes.ok && papersRes.papers) paperCount = papersRes.papers.length
          if (projectsRes.ok && projectsRes.projects) projectCount = projectsRes.projects.length
        }
        if (api?.getStoreValue) {
          const [expData, ledgerData] = await Promise.all([
            api.getStoreValue<unknown[]>('experiments:list'),
            api.getStoreValue<unknown[]>('ledger:entries')
          ])
          if (Array.isArray(expData)) experimentCount = expData.length
          if (Array.isArray(ledgerData)) ledgerCount = ledgerData.length
        } else {
          // 浏览器降级
          try {
            const cached = localStorage.getItem('mimir-experiments')
            if (cached) experimentCount = (JSON.parse(cached) as unknown[]).length
          } catch {
            // ignore
          }
          try {
            const cached = localStorage.getItem('mimir-ledger')
            if (cached) ledgerCount = (JSON.parse(cached) as unknown[]).length
          } catch {
            // ignore
          }
        }
        if (!alive) return
        setStats([
          { title: '论文', value: paperCount, icon: FileText },
          { title: '项目', value: projectCount, icon: FolderKanban },
          { title: '实验', value: experimentCount, icon: BarChart3 },
          { title: '记录', value: ledgerCount, icon: Clock }
        ])
        setLoaded(true)
      } catch {
        if (alive) setLoaded(true)
      }
    }
    load()
    return () => {
      alive = false
    }
  }, [])

  const hasContent = loaded && stats.some((s) => s.value > 0)

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="module-header">
        <span className="module-title">研究总览</span>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        {/* Stats */}
        <div className="grid grid-cols-4 gap-3">
          {stats.map((stat) => {
            const StatIcon = stat.icon
            return (
              <Card key={stat.title}>
                <CardContent className="p-3.5">
                  <div className="flex items-center justify-between">
                    <span className="metric-label">{stat.title}</span>
                    <StatIcon className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="metric-value mt-1 tabular-nums">{String(stat.value)}</div>
                </CardContent>
              </Card>
            )
          })}
        </div>

        {/* Quick Actions */}
        <Card>
          <CardContent className="p-4">
            <h3 className="text-[12px] font-semibold mb-3">快捷操作</h3>
            <div className="grid grid-cols-3 gap-2">
              {QUICK_ACTIONS.map((action) => {
                const ActionIcon = action.icon
                return (
                  <button
                    key={action.label}
                    onClick={() => onNavigate(action.target)}
                    className="flex items-center gap-2.5 rounded-lg border border-border p-2.5 hover:bg-accent hover:border-primary/20 transition-all text-left group"
                  >
                    <div className="h-7 w-7 rounded-md bg-muted flex items-center justify-center group-hover:bg-primary/10 transition-colors">
                      <ActionIcon className="h-3.5 w-3.5 text-muted-foreground group-hover:text-primary transition-colors" />
                    </div>
                    <div>
                      <p className="text-[12px] font-medium">{action.label}</p>
                      <p className="text-[10px] text-muted-foreground">{action.desc}</p>
                    </div>
                  </button>
                )
              })}
            </div>
          </CardContent>
        </Card>

        {/* Getting Started / hint */}
        <div className="flex items-center justify-center py-8 text-center">
          {hasContent ? (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <ArrowRight className="h-3 w-3" />
              数据来自文献库 / 实验管理 / 成长记录，保持实时同步
            </div>
          ) : (
            <div>
              <div className="flex h-10 w-10 rounded-lg brand-gradient items-center justify-center mb-2.5 mx-auto shadow-sm">
                <span className="text-white font-bold text-sm">M</span>
              </div>
              <p className="text-[12px] font-medium">开始你的研究之旅</p>
              <p className="text-[11px] text-muted-foreground mt-1 max-w-sm">
                在「对话」中与 Mimir 交互，或在左侧模块中添加文献、实验与记录。
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
