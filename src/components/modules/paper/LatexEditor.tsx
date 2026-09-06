/**
 * LaTeX 源码编辑器：透明文字的 textarea（可编辑层）+ 语法高亮 pre 覆盖层 +
 * 行号列。三个层共享同一套字体度量（ui-monospace 12px / line-height 20px）。
 *
 * 滚动策略沿用 Mimir monorepo PaperView 的做法：textarea 是唯一的原生滚动
 * 源，行号列与高亮覆盖层都是 `overflow: hidden` 的可滚动层，收到
 * textarea 的滚动事件后把 scrollTop/scrollLeft 镜像过去，保证三层永不错位。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, UIEvent } from 'react'
import type { LatexToken } from '@/lib/latex-highlight'
import { HIGHLIGHT_MAX_LENGTH, tokenizeLatex } from '@/lib/latex-highlight'
import { cn } from '@/lib/utils'

/** 行高（px），三层共享；跳转/滚动换算都依赖它。 */
export const EDITOR_LINE_HEIGHT = 20

/** 编辑区垂直内边距（px），行号列/覆盖层须与 textarea 完全一致。 */
const EDITOR_PAD_Y = 10
/** 编辑区水平内边距（px），须与 textarea 完全一致。 */
const EDITOR_PAD_X = 12

/** 三层共用的字体度量；行号列文字略小的部分由行高撑起。 */
const EDITOR_TEXT_STYLE: CSSProperties = {
  fontFamily: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: '12px',
  lineHeight: `${EDITOR_LINE_HEIGHT}px`,
  fontVariantLigatures: 'none',
  letterSpacing: 'normal',
}

/** 高亮覆盖层全量渲染的源码长度上限；超过则退化为纯行号模式以保住输入响应。 */
const HIGHLIGHT_RENDER_LIMIT = 80_000

/** 触发一次行跳转：`line` 为 1-based 行号，`nonce` 用于重复点击同一行。 */
export interface EditorFlashRequest {
  readonly line: number
  readonly nonce: number
}

interface LatexEditorProps {
  value: string
  onChange: (next: string) => void
  /** 非空时把视口滚动到该行并短暂高亮（如问题面板/大纲跳转）。 */
  flash: EditorFlashRequest | null
  /** 光标位置变化（报告给顶栏的状态栏）。 */
  onCursorChange?: (cursor: { line: number; column: number }) => void
  className?: string
}

const TEXTAREA_CLASSES = 'resize-none overflow-auto whitespace-pre break-normal text-[12px] leading-[20px]'

/** 覆盖层滚动镜像：把行号列与高亮 pre 同步到 textarea 的滚动位置。 */
function mirrorScroll(
  textarea: HTMLTextAreaElement,
  gutter: HTMLDivElement | null,
  highlight: HTMLPreElement | null
): void {
  if (gutter !== null) gutter.scrollTop = textarea.scrollTop
  if (highlight !== null) {
    highlight.scrollTop = textarea.scrollTop
    highlight.scrollLeft = textarea.scrollLeft
  }
}

export function LatexEditor({
  value,
  onChange,
  flash,
  onCursorChange,
  className
}: LatexEditorProps): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  const highlightRef = useRef<HTMLPreElement>(null)
  const rafRef = useRef<number | null>(null)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const lineCount = useMemo(() => value.split('\n').length, [value])

  /** 超出渲染上限时为 null：只显示行号，不做高亮。 */
  const tokens = useMemo(() => {
    if (value.length > HIGHLIGHT_MAX_LENGTH) return null
    if (value.length > HIGHLIGHT_RENDER_LIMIT) return null
    return tokenizeLatex(value)
  }, [value])

  /** 闪动行的行号；超时自动熄灭。 */
  const [flashLine, setFlashLine] = useState<number | null>(null)
  /** textarea 当前的垂直滚动偏移，驱动闪动行的视口坐标。 */
  const [scrollTop, setScrollTop] = useState(0)

  const reportCursor = useCallback(() => {
    const textarea = textareaRef.current
    if (textarea === null || onCursorChange === undefined) return
    const pos = textarea.selectionStart ?? 0
    const before = value.slice(0, pos)
    const line = before.split('\n').length
    const column = pos - (before.lastIndexOf('\n') + 1) + 1
    onCursorChange({ line, column })
  }, [onCursorChange, value])

  const handleScroll = useCallback((event: UIEvent<HTMLTextAreaElement>) => {
    const textarea = event.currentTarget
    mirrorScroll(textarea, gutterRef.current, highlightRef.current)
    // rAF 节流：滚动过程不每帧触发 setState，只在帧边界更新闪动行坐标。
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
        setScrollTop(textarea.scrollTop)
      })
    }
  }, [])

  // 行跳转：定位视口 + 聚焦选区 + 短暂闪动该行。
  useEffect(() => {
    if (flash === null) return
    const textarea = textareaRef.current
    if (textarea === null) return
    const line = Math.max(1, Math.min(flash.line, lineCount))
    textarea.focus()
    // 定位光标到目标行首。
    let idx = 0
    for (let i = 1; i < line && i <= lineCount; i += 1) {
      idx = value.indexOf('\n', idx) + 1
    }
    if (idx === 0) idx = value.indexOf('\n') === -1 ? value.length : 0
    try {
      textarea.setSelectionRange(idx, idx)
    } catch {
      // 忽略越界等情况
    }
    // 滚动到让目标行位于视口中部附近。
    textarea.scrollTop = Math.max(0, (line - 1) * EDITOR_LINE_HEIGHT - Math.floor(textarea.clientHeight / 2) + EDITOR_LINE_HEIGHT)
    mirrorScroll(textarea, gutterRef.current, highlightRef.current)
    setScrollTop(textarea.scrollTop)
    setFlashLine(line)
    reportCursor()
    if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current)
    flashTimerRef.current = setTimeout(() => setFlashLine(null), 1800)
  }, [flash, lineCount, value, reportCursor])

  useEffect(() => {
    return () => {
      if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current)
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  // 编辑器宽度变化时（如调整分栏）重算滚动偏移窗口，避免闪动行错位。
  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea === null || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => {
      mirrorScroll(textarea, gutterRef.current, highlightRef.current)
    })
    observer.observe(textarea)
    return () => observer.disconnect()
  }, [])

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Tab') {
      event.preventDefault()
      const textarea = event.currentTarget
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      const indent = event.shiftKey ? '' : '  '
      const next = value.slice(0, start) + indent + value.slice(end)
      onChange(next)
      requestAnimationFrame(() => {
        textarea.setSelectionRange(start + indent.length, start + indent.length)
      })
    }
  }

  const flashY = flashLine === null
    ? null
    : (flashLine - 1) * EDITOR_LINE_HEIGHT + EDITOR_PAD_Y - scrollTop

  return (
    <div className={cn('relative overflow-hidden bg-background', className)}>
      {/* 行号列：内容高度由行数决定，行号随 textarea 滚动同步（overflow hidden + 手动 scrollTop） */}
      <div aria-hidden className="absolute inset-y-0 left-0 w-[46px] overflow-hidden border-r border-border/70 bg-muted/30 select-none">
        <div
          ref={gutterRef}
          className="h-full overflow-hidden pr-2 text-right text-[11px] text-muted-foreground/60 tabular-nums"
          style={{ paddingTop: EDITOR_PAD_Y, paddingBottom: EDITOR_PAD_Y }}
        >
          {Array.from({ length: lineCount }, (_, i) => (
            <div key={i} className="leading-[20px]" style={{ height: EDITOR_LINE_HEIGHT }}>
              {i + 1}
            </div>
          ))}
        </div>
      </div>

      {/* 语法高亮覆盖层：文字着色、渲染在 textarea 之下 */}
      {tokens !== null && (
        <pre
          ref={highlightRef}
          aria-hidden
          className="overflow-hidden font-mono pointer-events-none"
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 46,
            right: 0,
            ...EDITOR_TEXT_STYLE,
            paddingTop: EDITOR_PAD_Y,
            paddingBottom: EDITOR_PAD_Y,
            paddingLeft: EDITOR_PAD_X,
            paddingRight: EDITOR_PAD_X,
            margin: 0,
            whiteSpace: 'pre'
          }}
        >
          {renderTokens(tokens)}
        </pre>
      )}

      {/* 可编辑层：透明文字，仅显示光标与选区 */}
      <textarea
        ref={textareaRef}
        value={value}
        wrap="off"
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        onChange={(event) => onChange(event.target.value)}
        onScroll={handleScroll}
        onClick={reportCursor}
        onKeyUp={reportCursor}
        onKeyDown={handleKeyDown}
        onSelect={reportCursor}
        style={{
          ...EDITOR_TEXT_STYLE,
          paddingTop: EDITOR_PAD_Y,
          paddingBottom: EDITOR_PAD_Y,
          paddingLeft: EDITOR_PAD_X,
          paddingRight: EDITOR_PAD_X,
          caretColor: 'hsl(var(--foreground))',
          color: 'transparent',
          tabSize: 2
        }}
        className={cn(
          TEXTAREA_CLASSES,
          'absolute left-[46px] top-0 bottom-0 right-0 bg-transparent outline-none focus:ring-0 selection:bg-primary/20',
          className
        )}
      />

      {/* 行跳转闪动条：按 textarea 视口坐标绘制 */}
      {flashY !== null && (
        <div
          aria-hidden
          className="pointer-events-none absolute left-[46px] right-0 bg-primary/12"
          style={{ top: flashY, height: EDITOR_LINE_HEIGHT }}
        />
      )}
    </div>
  )
}

/** 把 token 列表渲染为带颜色的行内元素（文本含 \n 时由 pre 的白空格规则换行）。 */
function renderTokens(tokens: readonly LatexToken[]): JSX.Element[] {
  return tokens.map((token, index) => (
    <span
      key={index}
      className={token.type === 'plain' ? undefined : `tok-${token.type}`}
    >
      {token.text}
    </span>
  ))
}
