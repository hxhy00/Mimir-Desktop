import { useState } from 'react'
import { Search, Loader2, Globe, FileText, Bookmark, BookmarkCheck, ExternalLink, Sparkles } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ArxivEntry, SearchResult, WebSearchEntry } from './types'
import { isArxivEntry, formatDate } from './types'

export type SearchSource = 'arxiv' | 'web'

interface SearchPanelProps {
  query: string
  onQueryChange: (q: string) => void
  source: SearchSource
  onSourceChange: (s: SearchSource) => void
  sortBy: 'relevance' | 'submittedDate'
  onSortByChange: (s: 'relevance' | 'submittedDate') => void
  results: SearchResult[]
  isSearching: boolean
  error: string
  onSearch: () => void
  savedIds: Set<string>
  onImport: (entry: ArxivEntry | WebSearchEntry) => void
  onRemove: (arxivId: string) => void
  onOpenExternal: (url: string) => void
}

export function SearchPanel({
  query,
  onQueryChange,
  source,
  onSourceChange,
  sortBy,
  onSortByChange,
  results,
  isSearching,
  error,
  onSearch,
  savedIds,
  onImport,
  onRemove,
  onOpenExternal
}: SearchPanelProps) {
  const [importing, setImporting] = useState<string | null>(null)

  const handleImport = async (entry: ArxivEntry | WebSearchEntry) => {
    setImporting(isArxivEntry(entry) ? entry.id : entry.url)
    try {
      await onImport(entry)
    } finally {
      setImporting(null)
    }
  }

  return (
    <div className="shrink-0 px-5 py-2.5 border-b border-border">
      <div className="flex gap-2 max-w-2xl mb-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder={source === 'arxiv' ? '搜索 arXiv 论文...' : '搜索网页文献...'}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onSearch()}
            className="pl-8 h-8 text-[13px]"
          />
        </div>
        {source === 'arxiv' && (
          <select
            value={sortBy}
            onChange={(e) => onSortByChange(e.target.value as 'relevance' | 'submittedDate')}
            className="h-8 rounded-md border border-border bg-background px-2 text-[11px] text-muted-foreground"
          >
            <option value="relevance">相关度</option>
            <option value="submittedDate">最新</option>
          </select>
        )}
        <Button onClick={onSearch} disabled={isSearching || !query.trim()} size="sm" className="h-8">
          {isSearching ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Search className="h-3.5 w-3.5 mr-1" />}
          {isSearching ? '搜索中' : '搜索'}
        </Button>
      </div>

      <div className="flex gap-1">
        <button
          onClick={() => onSourceChange('arxiv')}
          className={cn(
            'px-3 py-1 rounded-md text-[11px] font-medium transition-colors',
            source === 'arxiv' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted'
          )}
        >
          <FileText className="h-3 w-3 mr-1 inline" />
          arXiv
        </button>
        <button
          onClick={() => onSourceChange('web')}
          className={cn(
            'px-3 py-1 rounded-md text-[11px] font-medium transition-colors',
            source === 'web' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted'
          )}
        >
          <Globe className="h-3 w-3 mr-1 inline" />
          Web
        </button>
        {results.length > 0 && (
          <span className="ml-1 self-center text-[11px] text-muted-foreground">{results.length} 条结果</span>
        )}
      </div>

      {error && (
        <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-[11px] text-destructive">
          {error}
        </div>
      )}

      {!isSearching && results.length > 0 && (
        <div className="mt-2 space-y-1.5 max-h-72 overflow-y-auto pr-1">
          {results.map((entry) => {
            const key = isArxivEntry(entry) ? entry.id : entry.url
            const isSaved = isArxivEntry(entry) && savedIds.has(entry.id)
            return (
              <div
                key={key}
                className="group rounded-md border border-border bg-card p-2.5 hover:border-primary/20 transition-colors"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <h4 className="text-[12px] font-medium leading-snug line-clamp-2">{entry.title}</h4>
                    <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground">
                      {isArxivEntry(entry) ? (
                        <>
                          <span className="truncate">{entry.authors.slice(0, 3).join(', ')}{entry.authors.length > 3 ? ' et al.' : ''}</span>
                          <span className="shrink-0">{formatDate(entry.published)}</span>
                        </>
                      ) : (
                        <span className="truncate">{entry.url}</span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground/70 mt-1 line-clamp-2 leading-relaxed">
                      {isArxivEntry(entry) ? entry.summary : entry.content}
                    </p>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      onClick={() => (isSaved ? onRemove(entry.id) : handleImport(entry))}
                      disabled={importing === key}
                      className={cn(
                        'flex h-6 w-6 items-center justify-center rounded transition-colors',
                        isSaved
                          ? 'text-primary hover:text-destructive'
                          : 'text-muted-foreground/50 hover:text-muted-foreground'
                      )}
                      title={isSaved ? '已导入（点击移除）' : isArxivEntry(entry) ? '导入文献库' : '按标题匹配 arXiv 并导入'}
                    >
                      {importing === key ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : isSaved ? (
                        <BookmarkCheck className="h-3.5 w-3.5" />
                      ) : (
                        <Bookmark className="h-3.5 w-3.5" />
                      )}
                    </button>
                    <button
                      onClick={() => onOpenExternal(isArxivEntry(entry) ? entry.url : entry.url)}
                      className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                      title="打开原文"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {!isSearching && results.length === 0 && !error && (
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground/60">
          <Sparkles className="h-3 w-3" />
          {source === 'arxiv' ? '输入关键词搜索 arXiv 论文，导入后自动关联当前项目' : '输入关键词搜索网页文献'}
        </div>
      )}
    </div>
  )
}