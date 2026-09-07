import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Square, Plus, Mic, MicOff, Bot, ArrowUp, X, Paperclip, Loader2, Command } from 'lucide-react'
import { cn } from '@/lib/utils'
import { filterSlashEntries, SLASH_ENTRIES } from '@/lib/slash'
import type { SlashEntry } from '@/lib/slash/types'

// ─── Ultra 星屑粒子（方案 C）：开启时输入卡四周散布微光粒子，发送瞬间爆发 ──
interface UltraStar {
  key: string
  x: number
  y: number
  size: number
  color: string
  kind: 'tw' | 'fl' | 'burst'
  dur: number
  delay: number
  dx: number
  dy: number
}

/** 深色主题粒子色：亮紫/白，发光感强。 */
const ULTRA_COLORS_DARK = ['#c4b5fd', '#e9d5ff', '#f0abfc', '#ffffff']
/** 浅色主题粒子色：深紫罗兰系，保证在浅色 card 上的对比度。 */
const ULTRA_COLORS_LIGHT = ['#7c3aed', '#6d28d9', '#9333ea', '#a21caf']

function makeUltraStar(index: number, burst: boolean, colors: string[]): UltraStar {
  const r = Math.random()
  const kind: UltraStar['kind'] = burst ? 'burst' : r < 0.7 ? 'tw' : 'fl'
  const x = burst
    ? 42 + Math.random() * 54
    : r < 0.5
      ? 2 + Math.random() * 96 // 上沿带
      : r < 0.85
        ? 58 + Math.random() * 40 // 右侧带
        : 2 + Math.random() * 94 // 底部带
  const y = burst
    ? 28 + Math.random() * 55
    : r < 0.5
      ? 0.5 + Math.random() * 17
      : r < 0.85
        ? 6 + Math.random() * 78
        : 72 + Math.random() * 24
  const dur = burst ? 0.55 + Math.random() * 0.25 : kind === 'tw' ? 1.6 + Math.random() * 1.6 : 3 + Math.random() * 2
  const delay = burst ? Math.random() * 0.08 : -(Math.random() * dur)
  return {
    key: `${burst ? 'b' : 'a'}-${index}-${Math.random().toString(36).slice(2, 6)}`,
    x,
    y,
    size: burst ? 3.5 + Math.random() * 2.5 : 2 + Math.random() * 2.2,
    color: colors[Math.floor(Math.random() * colors.length)],
    kind,
    dur,
    delay,
    dx: (Math.random() - 0.5) * 46,
    dy: burst ? -(16 + Math.random() * 34) : (Math.random() - 0.5) * 10
  }
}

function ultraStarStyle(s: UltraStar): React.CSSProperties {
  const anim =
    s.kind === 'burst'
      ? `ultra-burst ${s.dur}s cubic-bezier(0.2,0.7,0.3,1) ${s.delay}s forwards`
      : s.kind === 'tw'
        ? `ultra-twinkle ${s.dur}s ease-in-out ${s.delay}s infinite`
        : `ultra-float ${s.dur}s ease-in-out ${s.delay}s infinite`
  return {
    left: `${s.x}%`,
    top: `${s.y}%`,
    width: `${s.size}px`,
    height: `${s.size}px`,
    backgroundColor: s.color,
    // 彩色辉光 + 白色内芯：浅色主题下“深色点+亮点核”对比清晰，深色下保持发光感
    boxShadow: `0 0 ${Math.round(s.size * 2.5)}px ${s.color}59, inset 0 0 1.5px rgba(255, 255, 255, 0.95)`,
    animation: anim,
    ['--bx' as string]: `${s.dx}px`,
    ['--by' as string]: `${s.dy}px`
  } as React.CSSProperties
}

export interface Attachment {
  id: string
  name: string
  path: string
  content?: string
  size: number
}

interface ChatInputProps {
  onSend: (message: string, attachments?: Attachment[]) => void
  onModelChange?: (modelId: string) => void
  onStop?: () => void
  /** 斜杠「技能与指令」条目列表；缺省为内置注册表（含由上层合并的自定义技能）。 */
  entries?: readonly SlashEntry[]
  disabled?: boolean
  isStreaming?: boolean
  /** Ultra 增强开启：输入框显示星屑粒子特效，发送时轻微爆发。 */
  ultraEnabled?: boolean
  /** Ultra 当前选中的增强策略（开启时展示在底部提示语中）。 */
  ultraStrategyLabel?: string
}

interface ModelConfig {
  id: string
  baseUrl: string
  modelId: string
  apiKey: string
  supportsImages: boolean
}

// ─── Attachments ────────────────────────────────────────────────────────
// TODO: 图片附件（非文本文件）的 size 为 -1（未知），因为当前无 fs:stat IPC。
// 后续需在 preload / ipc 中新增 fs:getFileSize 桥接，或在导入时读取文件头获取大小。
// 图片附件的 base64 内容通道也尚未接入：非文本文件只存储 path，不读取内容——
// 消息发送时需通过 mimir-img:// 协议或 readImageDataUrl 将图片内联进消息。

// Text-like file extensions we can read
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'tex', 'bib', 'py', 'js', 'ts', 'tsx', 'jsx', 'json', 'yaml', 'yml', 'toml',
  'csv', 'xml', 'html', 'css', 'scss', 'sql', 'sh', 'bat', 'r', 'java', 'c', 'cpp', 'h',
  'go', 'rs', 'rb', 'php', 'swift', 'kt', 'dart', 'vue', 'svelte', 'conf', 'cfg', 'ini',
  'env', 'gitignore', 'dockerfile', 'makefile', 'readme', 'license', 'log', 'ipynb'
])

function isTextFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  return TEXT_EXTENSIONS.has(ext) || !filename.includes('.')
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function ChatInput({ onSend, onModelChange, onStop, entries, disabled, isStreaming, ultraEnabled = false, ultraStrategyLabel }: ChatInputProps) {
  const [value, setValue] = useState('')
  const [models, setModels] = useState<ModelConfig[]>([])
  const [selectedModelId, setSelectedModelId] = useState<string>('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [listening, setListening] = useState(false)
  /** Ultra 星屑：常驻微光粒子（开启时渲染）+ 发送瞬间的爆发粒子。 */
  // 跟随 <html class="dark"> 主题切换，浅色用深紫粒子、深色用亮紫/白
  const [isDark, setIsDark] = useState(() =>
    typeof document === 'undefined' ? true : document.documentElement.classList.contains('dark')
  )
  useEffect(() => {
    const root = document.documentElement
    const update = () => setIsDark(root.classList.contains('dark'))
    update()
    const observer = new MutationObserver(update)
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  const starColors = isDark ? ULTRA_COLORS_DARK : ULTRA_COLORS_LIGHT
  const ambientStars = useMemo(
    () => Array.from({ length: 18 }, (_, i) => makeUltraStar(i, false, starColors)),
    [starColors]
  )
  const [burstStars, setBurstStars] = useState<UltraStar[]>([])
  const fireBurst = useCallback(() => {
    if (!ultraEnabled) return
    setBurstStars(Array.from({ length: 10 }, (_, i) => makeUltraStar(i, true, starColors)))
    window.setTimeout(() => setBurstStars([]), 800)
  }, [ultraEnabled, starColors])
  const [transcribing, setTranscribing] = useState(false)
  const [speechEngine, setSpeechEngine] = useState<'local' | 'web'>('web')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const recognitionRef = useRef<{ stop: () => void } | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const caretRef = useRef(0)

  /** 生效的「技能与指令」列表：内置注册表 + 上层合并的自定义技能。 */
  const activeEntries = entries ?? SLASH_ENTRIES

  // ── 斜杠「技能与指令」菜单 ──────────────────────────────────────
  const [slash, setSlash] = useState<{ query: string; items: SlashEntry[]; index: number } | null>(null)

  const refreshSlashMenu = useCallback(
    (raw: string, caret: number) => {
      const before = raw.slice(0, caret)
      const token = before.split(/[\s\n]/).pop() ?? ''
      if (token.startsWith('/')) {
        const query = token.slice(1)
        const items = filterSlashEntries(query, activeEntries)
        // 查询不变时保留当前高亮（↑↓ 切换不会被打断）；查询变化或列表变短时收拢 index。
        setSlash((prev) => {
          if (prev !== null && prev.query === query) {
            const last = items.length - 1
            return { query, items, index: Math.min(prev.index, Math.max(last, 0)) }
          }
          return { query, items, index: 0 }
        })
      } else {
        setSlash(null)
      }
    },
    [activeEntries]
  )

  const closeSlashMenu = useCallback(() => setSlash(null), [])

  // 点击菜单外部或失焦时收起
  useEffect(() => {
    function handlePointer(e: MouseEvent) {
      if (slashWrapRef.current && !slashWrapRef.current.contains(e.target as Node)) {
        setSlash(null)
      }
    }
    document.addEventListener('mousedown', handlePointer)
    return () => document.removeEventListener('mousedown', handlePointer)
  }, [])

  const slashWrapRef = useRef<HTMLDivElement>(null)
  /** 技能列表的滚动容器：高亮项移出可视区时自动滚回视野。 */
  const slashListRef = useRef<HTMLDivElement>(null)

  // 高亮项变化时，让菜单列表跟随滚动到当前项（配合 ↑↓ 切换）。
  useEffect(() => {
    const list = slashListRef.current
    if (slash === null || !list) return
    const el = list.querySelector<HTMLElement>(`[data-slash-index="${slash.index}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [slash])

  /** 把当前 `/xxx` 词替换成选中的 `/<trigger> `。 */
  const applySlashSelection = useCallback(
    (item: SlashEntry) => {
      const textarea = textareaRef.current
      const raw = textarea?.value ?? value
      const caret = textarea?.selectionStart ?? raw.length
      const before = raw.slice(0, caret)
      const token = before.split(/[\s\n]/).pop() ?? ''
      const start = caret - token.length
      const insertion = `/${item.trigger} `
      const next = raw.slice(0, start) + insertion + raw.slice(caret)
      setValue(next)
      setSlash(null)
      requestAnimationFrame(() => {
        const el = textareaRef.current
        if (el) {
          el.focus()
          const pos = start + insertion.length
          el.setSelectionRange(pos, pos)
          el.style.height = 'auto'
          el.style.height = `${Math.min(el.scrollHeight, 200)}px`
        }
      })
    },
    [value],
  )

  // 加载/同步「模型列表 + 当前选中」：与设置页「模型管理」共用 settings.selectedModelId，
  // 通过跨模块事件保持一致——任一端变更后都会广播，本端监听后重新读取最新配置。
  const reloadModels = useCallback(async () => {
    let settings: Record<string, unknown> = {}
    if (window.electronAPI) {
      settings = (await window.electronAPI.getSettings()) as Record<string, unknown>
    } else {
      try {
        const cached = localStorage.getItem('mimir-settings')
        if (cached) settings = JSON.parse(cached)
      } catch {
        // ignore
      }
    }
    const modelList = (settings.models as ModelConfig[] | undefined) || []
    setModels(modelList)
    setSelectedModelId((settings.selectedModelId as string) || modelList[0]?.id || '')
    setSpeechEngine((settings.speechEngine as 'local' | 'web') || 'web')
  }, [])

  useEffect(() => {
    void reloadModels()
    // 设置页模型管理增删改/切换后，即时同步本下拉的列表与选中项
    const onModelsChanged = (): void => {
      void reloadModels()
    }
    window.addEventListener('mimir:models-config-changed', onModelsChanged)
    return () => window.removeEventListener('mimir:models-config-changed', onModelsChanged)
  }, [reloadModels])

  // Save model selection to settings
  const handleModelChange = useCallback(
    async (modelId: string) => {
      setSelectedModelId(modelId)
      let settings: Record<string, unknown> = {}
      if (window.electronAPI) {
        settings = (await window.electronAPI.getSettings()) as Record<string, unknown>
      } else {
        try {
          const cached = localStorage.getItem('mimir-settings')
          if (cached) settings = JSON.parse(cached)
        } catch {
          // ignore
        }
      }
      settings.selectedModelId = modelId
      if (window.electronAPI) {
        await window.electronAPI.setSettings(settings)
      } else {
        localStorage.setItem('mimir-settings', JSON.stringify(settings))
      }
      onModelChange?.(modelId)
      // 通知其它模型选择入口（设置 → 模型管理）即时同步当前模型
      window.dispatchEvent(new Event('mimir:models-config-changed'))
    },
    [onModelChange]
  )

  // ─── Attachments ───────────────────────────────────────────────
  const handleAddAttachments = useCallback(async () => {
    if (!window.electronAPI) {
      alert('文件选择仅在 Electron 桌面端可用')
      return
    }
    const result = await window.electronAPI.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      title: '选择附件文件'
    })
    if (result.canceled || !result.filePaths?.length) return

    const newAttachments: Attachment[] = []
    for (const filePath of result.filePaths) {
      // Skip duplicates
      if (attachments.some((a) => a.path === filePath)) continue

      const name = filePath.split('/').filter(Boolean).pop() || filePath
      const attachment: Attachment = {
        id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        path: filePath,
        size: -1 // unknown until populated below
      }

      // Read text content for text-like files; use content length as approximate size
      if (isTextFile(name)) {
        try {
          const content = await window.electronAPI.readFile(filePath)
          attachment.content = content.slice(0, 30000) // cap at 30k chars
          attachment.size = content.length
        } catch {
          // file read failed, attach without content
        }
      }
      newAttachments.push(attachment)
    }

    if (newAttachments.length > 0) {
      setAttachments((prev) => [...prev, ...newAttachments])
    }
  }, [attachments])

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }, [])

  // ─── Voice recording ──────────────────────────────────────────
  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
      })
      audioChunksRef.current = []

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data)
      }

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        if (audioChunksRef.current.length === 0) return

        const mimeType = mediaRecorder.mimeType || 'audio/webm'

        // 本地 SenseVoice 识别（Electron 主进程）
        if (window.electronAPI?.transcribeLocal) {
          setTranscribing(true)
          try {
            const blob = new Blob(audioChunksRef.current, { type: mimeType })
            const arrayBuffer = await blob.arrayBuffer()
            const uint8Array = new Uint8Array(arrayBuffer)
            let binary = ''
            for (let i = 0; i < uint8Array.length; i++) {
              binary += String.fromCharCode(uint8Array[i])
            }
            const audioBase64 = btoa(binary)

            const result = await window.electronAPI.transcribeLocal(audioBase64)

            if (result.error) {
              console.warn('Local transcription error:', result.error)
              // 模型未下载或识别失败，降级到 Web Speech API
              startWebSpeech()
            } else if (result.text) {
              const text = result.text
              setValue((prev) => (prev ? prev + text : text))
            }
          } catch (err) {
            console.warn('Transcription failed, falling back to Web Speech:', err)
            startWebSpeech()
          } finally {
            setTranscribing(false)
          }
        } else {
          // 浏览器降级：使用 Web Speech API
          startWebSpeech()
        }
      }

      mediaRecorderRef.current = mediaRecorder
      mediaRecorder.start()
      setListening(true)
    } catch {
      // Microphone access denied or unavailable, try Web Speech API
      startWebSpeech()
    }
  }, [])

  const startWebSpeech = useCallback(() => {
    const SpeechRecognition =
      (window as unknown as { SpeechRecognition?: new () => { start: () => void; stop: () => void; onresult: ((e: { results: Array<Array<{ transcript: string }>> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null } }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => { start: () => void; stop: () => void; onresult: ((e: { results: Array<Array<{ transcript: string }>> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null } }).webkitSpeechRecognition

    if (!SpeechRecognition) {
      alert('当前环境不支持语音识别，请在设置中配置 API Key 并确保麦克风权限已开启')
      return
    }

    const recognition = new SpeechRecognition()
    recognitionRef.current = recognition
    recognition.onresult = (e) => {
      const transcript = Array.from(e.results)
        .map((r) => r[0]?.transcript || '')
        .join('')
      setValue((prev) => (prev ? prev + transcript : transcript))
    }
    recognition.onend = () => setListening(false)
    recognition.onerror = () => setListening(false)
    recognition.start()
    setListening(true)
  }, [])

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop()
    }
    if (recognitionRef.current) {
      recognitionRef.current.stop()
    }
    setListening(false)
  }, [])

  const toggleListening = useCallback(() => {
    if (listening) {
      stopRecording()
      return
    }
    // 本地引擎：录音后由主进程 SenseVoice 识别；Web 引擎：直接使用浏览器 Web Speech API
    if (speechEngine === 'local' && window.electronAPI) {
      startRecording()
    } else {
      startWebSpeech()
    }
  }, [listening, speechEngine, startRecording, stopRecording, startWebSpeech])

  // ─── Submit ───────────────────────────────────────────────────
  const handleSubmit = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault()
      if (!value.trim() || disabled) return
      fireBurst()
      onSend(value, attachments.length > 0 ? attachments : undefined)
      setValue('')
      setAttachments([])
      setSlash(null)
      caretRef.current = 0
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
      }
    },
    [value, disabled, onSend, attachments, fireBurst]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const menu = slash
      if (menu !== null && menu.items.length > 0) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const step = e.key === 'ArrowDown' ? 1 : -1
          const len = menu.items.length
          setSlash({ ...menu, index: (menu.index + step + len) % len })
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          applySlashSelection(menu.items[menu.index] ?? menu.items[0]!)
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setSlash(null)
          return
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSubmit()
        return
      }
      // 普通方向键移动光标：同步刷新斜杠检测
      const el = e.currentTarget as HTMLTextAreaElement
      caretRef.current = el.selectionStart
      refreshSlashMenu(el.value, el.selectionStart)
    },
    [slash, handleSubmit, applySlashSelection, refreshSlashMenu]
  )

  const handleSlashTrack = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement> | React.MouseEvent<HTMLTextAreaElement>) => {
      const el = e.currentTarget
      caretRef.current = el.selectionStart
      refreshSlashMenu(el.value, el.selectionStart)
    },
    [refreshSlashMenu]
  )

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const textarea = e.target
      setValue(textarea.value)
      caretRef.current = textarea.selectionStart
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
      refreshSlashMenu(textarea.value, textarea.selectionStart)
    },
    [refreshSlashMenu]
  )

  return (
    <div className="relative bg-background px-4 py-3">
      <form onSubmit={handleSubmit} className="mx-auto max-w-3xl">
        {/* Large rounded input card */}
        <div className="relative rounded-2xl border border-border bg-card shadow-sm transition-all focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/10">
          {/* Textarea area */}
          <div className="px-4 pt-3.5">
            <div className="relative" ref={slashWrapRef}>
              <textarea
                ref={textareaRef}
                value={value}
                onChange={handleInput}
                onKeyDown={handleKeyDown}
                onKeyUp={handleSlashTrack}
                onMouseUp={handleSlashTrack}
                placeholder="今天帮你做些什么？输入 / 可调用技能与指令"
                disabled={disabled}
                rows={1}
                className="w-full resize-none bg-transparent text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/70 disabled:opacity-50 min-h-[52px] max-h-[200px]"
              />

              {/* Slash 技能与指令菜单（下沿略高于输入框上沿，悬浮于输入框上方） */}
              {slash !== null && !disabled && (
                <div className="absolute left-0 bottom-full z-50 mb-[24px] w-[min(26rem,calc(100%))] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg">
                  <div className="flex items-center gap-1.5 border-b border-border/60 px-3 py-1.5 text-[10px] text-muted-foreground">
                    <Command className="h-3 w-3" />
                    <span>技能与指令 {slash.items.length} 项</span>
                    <span className="ml-auto hidden sm:inline">
                      <kbd className="rounded border border-border/70 px-1">↑↓</kbd> 选择
                      <kbd className="ml-1 rounded border border-border/70 px-1">↵</kbd> 补全
                      <kbd className="ml-1 rounded border border-border/70 px-1">Esc</kbd> 关闭
                    </span>
                  </div>
                  <div ref={slashListRef} className="max-h-[230px] overflow-y-auto py-1">
                    {slash.items.length === 0 ? (
                      <div className="px-3 py-2 text-[11px] text-muted-foreground">没有匹配的技能或指令</div>
                    ) : (
                      slash.items.map((item, i) => (
                        <button
                          key={`${item.kind}-${item.trigger}`}
                          data-slash-index={i}
                          type="button"
                          onMouseEnter={() => setSlash((prev) => (prev === null ? prev : { ...prev, index: i }))}
                          onClick={() => applySlashSelection(item)}
                          className={cn(
                            'flex w-full items-start gap-2 px-3 py-1.5 text-left text-[12px] transition-colors',
                            i === slash.index ? 'bg-accent' : 'hover:bg-accent/60'
                          )}
                        >
                          <span
                            className={cn(
                              'mt-0.5 shrink-0 rounded px-1 py-px text-[9px] font-medium',
                              item.kind === 'command'
                                ? 'bg-primary/10 text-primary'
                                : 'bg-emerald-500/10 text-emerald-600'
                            )}
                          >
                            {item.kind === 'command' ? '指令' : '技能'}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">
                              <span className="text-muted-foreground">/</span>
                              {item.trigger}
                              <span className="ml-1.5 font-normal text-muted-foreground/80">{item.title.replace(/（.*）/, '')}</span>
                            </span>
                            <span className="block truncate text-[10px] text-muted-foreground/80">
                              {item.description}
                              {item.argsHint !== '' ? ` · ${item.argsHint}` : ''}
                            </span>
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Attachments strip */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-4 pb-2 pt-1">
              {attachments.map((att) => (
                <div
                  key={att.id}
                  className="flex items-center gap-1 rounded-md border border-border/60 bg-muted/30 px-2 py-0.5 text-[11px]"
                  title={att.path}
                >
                  <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="max-w-[120px] truncate text-foreground/80">{att.name}</span>
                  <span className="text-muted-foreground/60">{formatFileSize(att.size)}</span>
                  <button
                    type="button"
                    onClick={() => handleRemoveAttachment(att.id)}
                    className="ml-0.5 rounded-sm text-muted-foreground/60 hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Controls row: + (left) | model, mic, send (right) */}
          <div className="flex items-center justify-between px-3 pb-2.5 pt-1">
            {/* Left: attach button */}
            <button
              type="button"
              onClick={handleAddAttachments}
              className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="添加附件"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>

            {/* Right: model dropdown + mic + send */}
            <div className="flex items-center gap-1.5">
              <Select value={selectedModelId} onValueChange={handleModelChange}>
                <SelectTrigger className="h-7 w-auto max-w-[170px] gap-1.5 rounded-full border-border bg-muted/50 px-3 text-[11px] text-muted-foreground hover:border-primary/40 hover:text-primary">
                  <Bot className="h-3.5 w-3.5 shrink-0" />
                  <SelectValue placeholder="选择模型" />
                </SelectTrigger>
                <SelectContent>
                  {models.length === 0 ? (
                    <div className="px-3 py-2 text-[11px] text-muted-foreground">暂无模型，请先在设置中添加</div>
                  ) : (
                    models.map((model) => (
                      <SelectItem key={model.id} value={model.id} className="text-[12px]">
                        {model.modelId}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>

              <button
                type="button"
                onClick={toggleListening}
                disabled={transcribing}
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-full transition-colors',
                  transcribing
                    ? 'bg-primary/10 text-primary animate-pulse'
                    : listening
                      ? 'bg-destructive/10 text-destructive animate-pulse'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
                title={transcribing ? '识别中...' : listening ? '停止录音' : '语音转文本'}
              >
                {transcribing ? <Loader2 className="h-4 w-4 animate-spin" /> : listening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              </button>

              {isStreaming ? (
                <Button
                  type="button"
                  size="icon"
                  onClick={onStop}
                  className="h-7 w-7 shrink-0 rounded-full bg-destructive hover:bg-destructive/90"
                  title="停止生成"
                >
                  <Square className="h-3.5 w-3.5" />
                </Button>
              ) : (
                <Button
                  type="submit"
                  size="icon"
                  disabled={disabled || !value.trim()}
                  className="h-7 w-7 shrink-0 rounded-full brand-gradient hover:opacity-90"
                  title="发送"
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>

          {/* Ultra 特效层（开启时）：绕圈灯带 + 外围光晕 + 星屑粒子 + 发送瞬间爆发 */}
          {ultraEnabled && (
            <>
              <div
                className="pointer-events-none absolute inset-0 z-10 overflow-hidden rounded-2xl"
                aria-hidden="true"
              >
                {/* 开启瞬间“点亮”过渡（挂载时播放一次） */}
                <span className="ultra-power-on" />
                {/* 常驻星屑粒子 */}
                {ambientStars.map((s) => (
                  <span key={s.key} className="ultra-particle" style={ultraStarStyle(s)} />
                ))}
                {/* 发送瞬间爆发粒子 */}
                {burstStars.map((s) => (
                  <span key={s.key} className="ultra-particle" style={ultraStarStyle(s)} />
                ))}
              </div>
              {/* 输入框外围金色光晕（不被圆角裁切） */}
              <span className="ultra-halo" aria-hidden="true" />
            </>
          )}

        </div>

        <p className="mt-1.5 text-center text-[10px] text-muted-foreground/60">
          {ultraEnabled
            ? `Ultra 增强已开启 · 策略：${ultraStrategyLabel ?? '自动选择'} · Mimir 可能出错，请核查重要信息`
            : 'Supervisor 编排 · Mimir 可能出错，请核查重要信息'}
        </p>
      </form>

      {/* 任务执行中：输入区薄幕锁定（视觉提示；文本区已 disabled，停止按钮仍可点） */}
      {isStreaming && (
        <div
          className="chat-input-busy pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-2xl"
          aria-hidden="true"
        >
          <span className="busy-chip">
            <span className="busy-dot" />
            任务执行中… 输入已锁定
          </span>
        </div>
      )}
    </div>
  )
}
