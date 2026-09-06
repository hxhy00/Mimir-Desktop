import { useEffect, useRef, useCallback } from 'react'
import { Terminal as XTerminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface TerminalProps {
  id: string
  className?: string
  ssh?: { host: string; port: number; user: string; keyPath?: string }
}

export function Terminal({ id, className, ssh }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)

  const cleanup = useCallback(() => {
    if (termRef.current) {
      termRef.current.dispose()
      termRef.current = null
    }
    if (window.electronAPI) {
      window.electronAPI.closeTerminal(id)
    }
  }, [id])

  useEffect(() => {
    if (!containerRef.current || !window.electronAPI) return

    const term = new XTerminal({
      fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Cascadia Code', monospace",
      fontSize: 12,
      lineHeight: 1.3,
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
        cursorAccent: '#1e1e1e',
        selectionBackground: '#264f78',
        black: '#000000',
        red: '#cd3131',
        green: '#00bc00',
        yellow: '#949800',
        blue: '#0451a5',
        magenta: '#bc05bc',
        cyan: '#0598bc',
        white: '#a5a5a5',
        brightBlack: '#666666',
        brightRed: '#f14c4c',
        brightGreen: '#23d917',
        brightYellow: '#d5d543',
        brightBlue: '#0451a5',
        brightMagenta: '#bc05bc',
        brightCyan: '#0598bc',
        brightWhite: '#a5a5a5'
      },
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)
    fitAddon.fit()

    termRef.current = term
    fitAddonRef.current = fitAddon

    const { cols, rows } = term
    window.electronAPI.createTerminal(id, { cols, rows, ssh })

    // Receive data from PTY
    window.electronAPI.onTerminalData(id, (data) => {
      term.write(data)
    })

    // Handle terminal exit
    window.electronAPI.onTerminalExit(id, () => {
      term.write('\r\n\x1b[33m[终端已关闭]\x1b[0m\r\n')
    })

    // Send user input to PTY
    term.onData((data) => {
      window.electronAPI?.writeTerminal(id, data)
    })

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
      const newTerm = termRef.current
      if (newTerm) {
        const { cols: c, rows: r } = newTerm
        window.electronAPI?.resizeTerminal(id, c, r)
      }
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      cleanup()
    }
  }, [id, cleanup, ssh])

  return (
    <div
      ref={containerRef}
      className={className}
      onClick={() => termRef.current?.focus()}
    />
  )
}
