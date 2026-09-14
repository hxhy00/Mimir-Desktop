import { cn } from '@/lib/utils'
import type { Message } from './ChatView'
import { AgentTimeline } from './AgentTimeline'
import { ArtifactCard } from './ArtifactCard'
import { Bot, User, Copy, Check, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MessageBubbleProps {
  message: Message
  onRetry?: () => void
  /** 当前待批准的工具名（标注到对应步骤上）。 */
  pendingApprovalTool?: string
}

export function MessageBubble({ message, onRetry, pendingApprovalTool }: MessageBubbleProps) {
  const isUser = message.role === 'user'
  const isAssistant = message.role === 'assistant'
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(message.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className={cn('flex gap-3 message-appear', isUser ? 'flex-row-reverse' : 'flex-row')}>
      {/* Avatar */}
      <div
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-md mt-0.5',
          isUser
            ? 'bg-secondary text-secondary-foreground'
            : 'brand-gradient text-white'
        )}
      >
        {isUser ? <User className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
      </div>

      {/* Content */}
      <div className={cn('max-w-[85%] min-w-0', isUser && 'flex flex-col items-end')}>
        <div
          className={cn(
            'chat-message rounded-lg px-3.5 py-2 text-[13px] leading-relaxed',
            isUser
              ? 'bg-primary text-primary-foreground'
              : 'bg-card border border-border'
          )}
        >
          {/* Agent 执行过程：步骤时间线（工具调用与返回合并成一行；内部阶段默认隐藏）。
              **只要还在生成就显示**，哪怕一步都还没发生 —— 否则模型写大文件的那几十秒里
              界面上什么都看不到（用户无法判断"在思考"还是"卡死了"）。 */}
          {!isUser &&
            message.run !== undefined &&
            (message.run.steps.length > 0 || message.isStreaming === true) && (
              <div className="mb-2">
                <AgentTimeline
                  run={message.run}
                  isStreaming={message.isStreaming}
                  {...(pendingApprovalTool !== undefined ? { pendingApprovalTool } : {})}
                />
              </div>
            )}

          {message.content ? (
            isUser ? (
              <div className="whitespace-pre-wrap">{message.content}</div>
            ) : (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
            )
          ) : message.isStreaming ? (
            <div className="flex items-center gap-1.5 py-1">
              <TypingDot delay="0s" />
              <TypingDot delay="0.15s" />
              <TypingDot delay="0.3s" />
            </div>
          ) : null}

          {/* Streaming cursor */}
          {message.isStreaming && message.content && (
            <span className="inline-block w-0.5 h-4 animate-pulse bg-primary ml-0.5 align-text-bottom" />
          )}

          {/* 产物验收卡：本条回复落盘的文件（打开 / 打开所在文件夹） */}
          {!isUser && message.artifacts !== undefined && message.artifacts.length > 0 && (
            <ArtifactCard artifacts={message.artifacts} />
          )}
        </div>

        {/* Actions */}
        {isAssistant && !message.isStreaming && message.content && (
          <div className="flex items-center gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
              {copied ? '已复制' : '复制'}
            </button>
            {onRetry && (
              <button
                onClick={onRetry}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              >
                <RefreshCw className="h-3 w-3" />
                重试
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function TypingDot({ delay }: { delay: string }) {
  return (
    <div
      className="h-1.5 w-1.5 rounded-full bg-muted-foreground"
      style={{ animation: `typing-dot 1.2s ease-in-out infinite`, animationDelay: delay }}
    />
  )
}
