import { useEffect, useRef, useState } from 'react'
import { vscode } from '../vscodeApi.js'
import { asTypedHostMessage } from '../adapter/hostMessage.js'

interface EmbeddedTerminalProps {
  instanceId: string
  isVisible: boolean
  panelBottom: number
  panelHeight: number
  traceId?: string | null
  contractProbe?: boolean
}

interface GhosttyTerminalLike {
  cols: number
  rows: number
  open(container: HTMLElement): void
  write(data: string | Uint8Array): void
  focus(): void
  dispose(): void
  resize(cols: number, rows: number): void
  onData(listener: (data: string) => void): { dispose(): void }
  onResize(listener: (size: { cols: number; rows: number }) => void): { dispose(): void }
  loadAddon(addon: unknown): void
  attachCustomKeyEventHandler?(customKeyEventHandler: (event: KeyboardEvent) => boolean): void
}

interface GhosttyFitAddonLike {
  fit(): void
  dispose?(): void
}

interface GhosttyModuleLike {
  init?: () => Promise<void>
  Terminal: new (options?: Record<string, unknown>) => GhosttyTerminalLike
  FitAddon: new () => GhosttyFitAddonLike
}

const TRACE_SMOKE_PREFIX = 'trace-smoke-'
const TRACE_SMOKE_MARKER_PREFIX = '__PA_TRACE_ACK__'
const DESKTOP_TERMINAL_EVENT = 'pixel-agents:terminal'

let ghosttyRuntimePromise: Promise<GhosttyModuleLike> | null = null

function loadGhosttyRuntime(): Promise<GhosttyModuleLike> {
  if (!ghosttyRuntimePromise) {
    ghosttyRuntimePromise = import('ghostty-web').then(async (module) => {
      const ghosttyModule = module as unknown as GhosttyModuleLike
      if (typeof ghosttyModule.init === 'function') {
        await ghosttyModule.init()
      }
      return ghosttyModule
    })
  }
  return ghosttyRuntimePromise
}

export function EmbeddedTerminal({
  instanceId,
  isVisible,
  panelBottom,
  panelHeight,
  traceId,
  contractProbe,
}: EmbeddedTerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<GhosttyTerminalLike | null>(null)
  const fitAddonRef = useRef<GhosttyFitAddonLike | null>(null)
  const disposeRef = useRef<(() => void) | null>(null)
  const smokeCommandSentRef = useRef<Set<string>>(new Set())
  const contractProbeSentRef = useRef<Set<string>>(new Set())
  const traceAckSentRef = useRef<Set<string>>(new Set())
  const traceIdRef = useRef<string | null>(traceId ?? null)
  const contractProbeRef = useRef<boolean>(Boolean(contractProbe))
  const instanceIdRef = useRef<string>(instanceId)
  const [readyText, setReadyText] = useState('Initializing...')

  useEffect(() => {
    instanceIdRef.current = instanceId
  }, [instanceId])

  useEffect(() => {
    traceIdRef.current = traceId ?? null
  }, [traceId])

  useEffect(() => {
    contractProbeRef.current = Boolean(contractProbe)
  }, [contractProbe])

  useEffect(() => {
    let cancelled = false

    const sendTraceSmokeMarker = (nextTraceId: string): void => {
      if (!nextTraceId.startsWith(TRACE_SMOKE_PREFIX)) return
      if (smokeCommandSentRef.current.has(nextTraceId)) return
      smokeCommandSentRef.current.add(nextTraceId)
      const marker = `${TRACE_SMOKE_MARKER_PREFIX}:${nextTraceId}`
      const command = `echo ${marker}\r`
      window.setTimeout(() => {
        vscode.postMessage({
          type: 'terminalInput',
          data: command,
          instanceId: instanceIdRef.current,
          traceId: nextTraceId,
        })
      }, 300)
    }

    const sendContractProbeMessages = (nextTraceId: string): void => {
      if (!nextTraceId.startsWith(TRACE_SMOKE_PREFIX)) return
      if (!contractProbeRef.current) return
      if (contractProbeSentRef.current.has(nextTraceId)) return
      contractProbeSentRef.current.add(nextTraceId)

      const staleInstanceId = `${instanceIdRef.current}-stale`
      const staleRows = Math.max(8, terminalRef.current?.rows ?? 24)
      const staleCols = Math.max(40, terminalRef.current?.cols ?? 120)

      window.setTimeout(() => {
        vscode.postMessage({
          type: 'terminalResize',
          cols: staleCols,
          rows: staleRows,
          instanceId: staleInstanceId,
          traceId: nextTraceId,
        })
        vscode.postMessage({
          type: 'terminalInput',
          data: 'echo __PA_STALE_SHOULD_NOT_RUN__\r',
          instanceId: staleInstanceId,
          traceId: nextTraceId,
        })
        vscode.postMessage({
          type: 'terminalClose',
          instanceId: staleInstanceId,
          traceId: nextTraceId,
        })
      }, 120)
    }

    const handleTerminalHostMessage = (msg: {
      type?: string
      data?: string
      cols?: number
      rows?: number
      cwd?: string
      shell?: string
      exitCode?: number
      instanceId?: string
      traceId?: string
    }) => {
      const terminal = terminalRef.current
      if (!terminal) return
      if (typeof msg.instanceId !== 'string' || msg.instanceId !== instanceIdRef.current) {
        return
      }

      if (msg.type === 'terminalData' && typeof msg.data === 'string') {
        terminal.write(msg.data)
        if (typeof msg.traceId === 'string' && msg.traceId.trim().length > 0) {
          const trace = msg.traceId.trim()
          const marker = `${TRACE_SMOKE_MARKER_PREFIX}:${trace}`
          if (msg.data.includes(marker) && !traceAckSentRef.current.has(trace)) {
            traceAckSentRef.current.add(trace)
            vscode.postMessage({ type: 'terminalTraceAck', traceId: trace, markerSeen: true })
          }
        }
        return
      }

      if (msg.type === 'terminalReady') {
        const cols = typeof msg.cols === 'number' ? msg.cols : terminal.cols
        const rows = typeof msg.rows === 'number' ? msg.rows : terminal.rows
        terminal.resize(cols, rows)
        const traceText = msg.traceId ? ` • trace:${msg.traceId.slice(0, 8)}` : ''
        setReadyText(`PTY ${cols}x${rows} • ${msg.shell || 'shell'} • ${msg.cwd || ''}${traceText}`)
        const activeTrace = typeof msg.traceId === 'string' && msg.traceId.trim().length > 0
          ? msg.traceId.trim()
          : (traceIdRef.current?.trim() || '')
        if (activeTrace.length > 0) {
          sendTraceSmokeMarker(activeTrace)
          sendContractProbeMessages(activeTrace)
        }
        return
      }

      if (msg.type === 'terminalExit') {
        const code = msg.exitCode ?? 0
        if (code !== 0) {
          terminal.write(`\r\n\x1b[33m[terminal exited: code ${code}]\x1b[0m\r\n`)
        } else {
          setReadyText('Terminal restarted')
        }
      }
    }

    const boot = async () => {
      const ghosttyModule = await loadGhosttyRuntime()
      if (cancelled || !hostRef.current) return

      const term = new ghosttyModule.Terminal({
        convertEol: false,
        cursorBlink: true,
        cols: 120,
        rows: 30,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        fontSize: 12,
        theme: {
          background: '#020617',
          foreground: '#e2e8f0',
          cursor: '#e2e8f0',
        },
      })
      const fitAddon = new ghosttyModule.FitAddon()
      term.loadAddon(fitAddon)
      term.open(hostRef.current)
      term.attachCustomKeyEventHandler?.((event) => {
        if (event.key !== 'Tab') return false
        event.preventDefault()
        event.stopPropagation()
        if (event.shiftKey) {
          vscode.postMessage({
            type: 'terminalInput',
            data: '\u001b[Z',
            instanceId: instanceIdRef.current,
            traceId: traceIdRef.current || undefined,
          })
        } else {
          vscode.postMessage({
            type: 'terminalInput',
            data: '\t',
            instanceId: instanceIdRef.current,
            traceId: traceIdRef.current || undefined,
          })
        }
        return true
      })
      fitAddon.fit()
      if (isVisible) {
        term.focus()
      }

      terminalRef.current = term
      fitAddonRef.current = fitAddon
      setReadyText('Connected')

      const onMessage = (e: MessageEvent) => {
        const msg = asTypedHostMessage<{
          type?: string
          data?: string
          cols?: number
          rows?: number
          cwd?: string
          shell?: string
          exitCode?: number
          instanceId?: string
          traceId?: string
        }>(e.data)
        if (!msg) return
        handleTerminalHostMessage(msg)
      }

      const onDesktopTerminalEvent = (e: Event) => {
        const detail = (e as CustomEvent<unknown>).detail
        const msg = asTypedHostMessage<{
          type?: string
          data?: string
          cols?: number
          rows?: number
          cwd?: string
          shell?: string
          exitCode?: number
          instanceId?: string
          traceId?: string
        }>(detail)
        if (!msg) return
        handleTerminalHostMessage(msg)
      }

      window.addEventListener('message', onMessage)
      window.addEventListener(DESKTOP_TERMINAL_EVENT, onDesktopTerminalEvent as EventListener)

      vscode.postMessage({
        type: 'terminalCreate',
        cols: term.cols,
        rows: term.rows,
        instanceId: instanceIdRef.current,
        traceId: traceIdRef.current || undefined,
      })

      const dataDisposable = term.onData((data) => {
        vscode.postMessage({
          type: 'terminalInput',
          data,
          instanceId: instanceIdRef.current,
          traceId: traceIdRef.current || undefined,
        })
      })

      const resizeDisposable = term.onResize((size) => {
        vscode.postMessage({
          type: 'terminalResize',
          cols: size.cols,
          rows: size.rows,
          instanceId: instanceIdRef.current,
          traceId: traceIdRef.current || undefined,
        })
      })

      disposeRef.current = () => {
        dataDisposable.dispose()
        resizeDisposable.dispose()
        window.removeEventListener('message', onMessage)
        window.removeEventListener(DESKTOP_TERMINAL_EVENT, onDesktopTerminalEvent as EventListener)
        try {
          fitAddonRef.current?.dispose?.()
        } catch {
          // noop
        }
        terminalRef.current?.dispose()
        terminalRef.current = null
        fitAddonRef.current = null
        vscode.postMessage({
          type: 'terminalClose',
          instanceId: instanceIdRef.current,
          traceId: traceIdRef.current || undefined,
        })
      }
    }

    void boot()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    return () => {
      disposeRef.current?.()
      disposeRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!isVisible) return
    const fitAddon = fitAddonRef.current
    const term = terminalRef.current
    if (!fitAddon || !term) return
    fitAddon.fit()
    term.focus()
    vscode.postMessage({
      type: 'terminalResize',
      cols: term.cols,
      rows: term.rows,
      instanceId: instanceIdRef.current,
      traceId: traceIdRef.current || undefined,
    })
  }, [isVisible, panelHeight, traceId])

  useEffect(() => {
    if (!traceId || !traceId.startsWith(TRACE_SMOKE_PREFIX)) return
    const term = terminalRef.current
    if (!term) return
    if (smokeCommandSentRef.current.has(traceId)) return
    const marker = `${TRACE_SMOKE_MARKER_PREFIX}:${traceId}`
    smokeCommandSentRef.current.add(traceId)
    window.setTimeout(() => {
      vscode.postMessage({
        type: 'terminalInput',
        data: `echo ${marker}\r`,
        instanceId: instanceIdRef.current,
        traceId,
      })
    }, 450)
  }, [traceId])

  return (
    <div
      style={{
        position: 'absolute',
        left: 10,
        right: 10,
        bottom: panelBottom,
        height: panelHeight,
        zIndex: 'var(--pixel-controls-z)',
        background: '#020617',
        border: '1px solid rgba(148, 163, 184, 0.3)',
        boxShadow: '0 10px 30px rgba(2, 6, 23, 0.5)',
        borderRadius: 8,
        overflow: 'hidden',
        display: isVisible ? 'flex' : 'none',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          height: 26,
          display: 'flex',
          alignItems: 'center',
          padding: '0 10px',
          fontSize: '12px',
          color: '#e2e8f0',
          borderBottom: '1px solid rgba(148, 163, 184, 0.28)',
          background: '#0b1222',
          textAlign: 'left',
          letterSpacing: '0.05px',
        }}
      >
        {readyText}
      </div>
      <div
        ref={hostRef}
        onMouseDown={() => terminalRef.current?.focus()}
        style={{ flex: 1, minHeight: 0, outline: 'none' }}
      />
    </div>
  )
}
