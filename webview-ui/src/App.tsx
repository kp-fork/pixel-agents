import { useState, useCallback, useRef, useEffect } from 'react'
import { OfficeState } from './office/engine/officeState.js'
import { OfficeCanvas } from './office/components/OfficeCanvas.js'
import { ToolOverlay } from './office/components/ToolOverlay.js'
import { EditorToolbar } from './office/editor/EditorToolbar.js'
import { EditorState } from './office/editor/editorState.js'
import { EditTool } from './office/types.js'
import type { AgentId } from './office/types.js'
import { isRotatable } from './office/layout/furnitureCatalog.js'
import { vscode } from './vscodeApi.js'
import { useExtensionMessages } from './hooks/useExtensionMessages.js'
import { PULSE_ANIMATION_DURATION_SEC } from './constants.js'
import { useEditorActions } from './hooks/useEditorActions.js'
import { useEditorKeyboard } from './hooks/useEditorKeyboard.js'
import { BottomToolbar } from './components/BottomToolbar.js'
import { DebugView } from './components/DebugView.js'
import { EmbeddedTerminal } from './components/EmbeddedTerminal.js'
import { parseHostMessage } from './adapter/hostMessage.js'
import { toHistoryTitleSnippet, toHistorySummaryText } from './historyText.js'

// Game state lives outside React — updated imperatively by message handlers
const officeStateRef = { current: null as OfficeState | null }
const editorState = new EditorState()

function getOfficeState(): OfficeState {
  if (!officeStateRef.current) {
    officeStateRef.current = new OfficeState()
  }
  return officeStateRef.current
}

const actionBarBtnStyle: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: 'var(--pixel-font-md)',
  background: 'var(--pixel-btn-bg)',
  color: 'var(--pixel-text-dim)',
  border: '2px solid transparent',
  borderRadius: 0,
  cursor: 'pointer',
}

const actionBarBtnDisabled: React.CSSProperties = {
  ...actionBarBtnStyle,
  opacity: 'var(--pixel-btn-disabled-opacity)',
  cursor: 'default',
}

function parseIsoToMs(iso: string): number {
  if (!iso) return 0
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : 0
}

function formatHistoryAgeAgo(targetMs: number): string {
  if (!Number.isFinite(targetMs) || targetMs <= 0) return '-'
  const diffHours = Math.max(1, Math.floor((Date.now() - targetMs) / (1000 * 60 * 60)))
  if (diffHours < 24) {
    return `${diffHours} ${diffHours === 1 ? 'hour' : 'hours'} ago`
  }
  const diffDays = Math.floor(diffHours / 24)
  return `${diffDays} ${diffDays === 1 ? 'day' : 'days'} ago`
}

function formatDateTimeCompact(iso: string): string {
  const ms = parseIsoToMs(iso)
  if (ms <= 0) return '-'
  const d = new Date(ms)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const HH = String(d.getHours()).padStart(2, '0')
  const MM = String(d.getMinutes()).padStart(2, '0')
  const SS = String(d.getSeconds()).padStart(2, '0')
  return `${yyyy}.${mm}.${dd} ${HH}:${MM}:${SS}`
}

function createTraceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `trace-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function EditActionBar({ editor, editorState: es }: { editor: ReturnType<typeof useEditorActions>; editorState: EditorState }) {
  const [showResetConfirm, setShowResetConfirm] = useState(false)

  const undoDisabled = es.undoStack.length === 0
  const redoDisabled = es.redoStack.length === 0

  return (
    <div
      style={{
        position: 'absolute',
        top: 8,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 'var(--pixel-controls-z)',
        display: 'flex',
        gap: 4,
        alignItems: 'center',
        background: 'var(--pixel-bg)',
        border: '2px solid var(--pixel-border)',
        borderRadius: 0,
        padding: '4px 8px',
        boxShadow: 'var(--pixel-shadow)',
      }}
    >
      <button
        style={undoDisabled ? actionBarBtnDisabled : actionBarBtnStyle}
        onClick={undoDisabled ? undefined : editor.handleUndo}
        title="Undo (Ctrl+Z)"
      >
        Undo
      </button>
      <button
        style={redoDisabled ? actionBarBtnDisabled : actionBarBtnStyle}
        onClick={redoDisabled ? undefined : editor.handleRedo}
        title="Redo (Ctrl+Y)"
      >
        Redo
      </button>
      <button
        style={actionBarBtnStyle}
        onClick={editor.handleSave}
        title="Save layout"
      >
        Save
      </button>
      {!showResetConfirm ? (
        <button
          style={actionBarBtnStyle}
          onClick={() => setShowResetConfirm(true)}
          title="Reset to last saved layout"
        >
          Reset
        </button>
      ) : (
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span style={{ fontSize: 'var(--pixel-font-md)', color: 'var(--pixel-reset-text)' }}>Reset?</span>
          <button
            style={{ ...actionBarBtnStyle, background: 'var(--pixel-danger-bg)', color: '#fff' }}
            onClick={() => { setShowResetConfirm(false); editor.handleReset() }}
          >
            Yes
          </button>
          <button
            style={actionBarBtnStyle}
            onClick={() => setShowResetConfirm(false)}
          >
            No
          </button>
        </div>
      )}
    </div>
  )
}

function App() {
  const editor = useEditorActions(getOfficeState, editorState)

  const isEditDirty = useCallback(() => editor.isEditMode && editor.isDirty, [editor.isEditMode, editor.isDirty])

  const {
    agents,
    selectedAgent,
    historySessions,
    historySessionsEnabled,
    agentTools,
    agentStatuses,
    subagentTools,
    subagentCharacters,
    layoutReady,
    loadedAssets,
    workspaceFolders,
  } = useExtensionMessages(getOfficeState, editor.setLastSavedLayout, isEditDirty)

  const [isDebugMode, setIsDebugMode] = useState(false)
  const [isTerminalOpen, setIsTerminalOpen] = useState(false)
  const [activeTerminalTraceId, setActiveTerminalTraceId] = useState<string | null>(null)
  const [traceContractProbe, setTraceContractProbe] = useState(false)
  const [hoveredAgentId, setHoveredAgentId] = useState<AgentId | null>(null)
  const isDesktopHost = typeof (globalThis as { __electrobunSendToHost?: unknown }).__electrobunSendToHost === 'function'

  useEffect(() => {
    if (!isDesktopHost) return
    const host = globalThis as typeof globalThis & {
      __electrobun?: { receiveMessageFromBun?: (msg: unknown) => void }
    }
    const electrobun = host.__electrobun
    if (!electrobun) return

    const prev = electrobun.receiveMessageFromBun
    electrobun.receiveMessageFromBun = (msg: unknown) => {
      const parsed = parseHostMessage(msg)
      window.dispatchEvent(new MessageEvent('message', { data: parsed ?? msg }))
    }

    return () => {
      electrobun.receiveMessageFromBun = prev
    }
  }, [isDesktopHost])

  useEffect(() => {
    if (!isDesktopHost) return
    const onMessage = (event: MessageEvent) => {
      const msg = parseHostMessage(event.data) as { type?: string; traceId?: unknown; contractProbe?: unknown } | null
      if (!msg || msg.type !== 'traceSmokeStart') return
      if (typeof msg.traceId !== 'string' || msg.traceId.trim().length === 0) return
      setActiveTerminalTraceId(msg.traceId.trim())
      setTraceContractProbe(msg.contractProbe === true)
      setIsTerminalOpen(true)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [isDesktopHost])

  const handleToggleDebugMode = useCallback(() => setIsDebugMode((prev) => !prev), [])

  const handleOpenClaude = useCallback((folderPath?: string) => {
    const traceId = createTraceId()
    setActiveTerminalTraceId(traceId)
    setTraceContractProbe(false)
    if (isDesktopHost) {
      setIsTerminalOpen(true)
    }
    vscode.postMessage({ type: 'openClaude', folderPath, traceId })
  }, [isDesktopHost])

  const handleSelectAgent = useCallback((id: AgentId) => {
    vscode.postMessage({ type: 'focusAgent', id })
  }, [])

  const containerRef = useRef<HTMLDivElement>(null)

  const [editorTickForKeyboard, setEditorTickForKeyboard] = useState(0)
  useEditorKeyboard(
    editor.isEditMode,
    editorState,
    editor.handleDeleteSelected,
    editor.handleRotateSelected,
    editor.handleToggleState,
    editor.handleUndo,
    editor.handleRedo,
    useCallback(() => setEditorTickForKeyboard((n) => n + 1), []),
    editor.handleToggleEditMode,
  )

  const handleCloseAgent = useCallback((id: AgentId) => {
    vscode.postMessage({ type: 'closeAgent', id })
  }, [])

  const handleClick = useCallback((agentId: AgentId) => {
    const history = historySessions.find((session) => session.id === agentId)
    if (history) {
      if (isDesktopHost) {
        setIsTerminalOpen(true)
      }
      vscode.postMessage({
        type: 'openHistorySession',
        historyId: history.id,
        sessionId: history.sessionId,
        jsonlPath: history.jsonlPath,
      })
      return
    }
    // If clicked agent is a sub-agent, focus the parent's terminal instead
    const os = getOfficeState()
    const meta = os.subagentMeta.get(agentId)
    const focusId = meta ? meta.parentAgentId : agentId
    vscode.postMessage({ type: 'focusAgent', id: focusId })
  }, [historySessions, isDesktopHost])

  const handleToggleHistorySessions = useCallback((enabled: boolean) => {
    vscode.postMessage({ type: 'setHistorySessionsEnabled', enabled })
  }, [])

  const officeState = getOfficeState()
  const hoveredHistory = !editor.isEditMode
    ? historySessions.find((session) => session.id === hoveredAgentId) || null
    : null

  // Force dependency on editorTickForKeyboard to propagate keyboard-triggered re-renders
  void editorTickForKeyboard

  // Show "Press R to rotate" hint when a rotatable item is selected or being placed
  const showRotateHint = editor.isEditMode && (() => {
    if (editorState.selectedFurnitureUid) {
      const item = officeState.getLayout().furniture.find((f) => f.uid === editorState.selectedFurnitureUid)
      if (item && isRotatable(item.type)) return true
    }
    if (editorState.activeTool === EditTool.FURNITURE_PLACE && isRotatable(editorState.selectedFurnitureType)) {
      return true
    }
    return false
  })()

  if (!layoutReady) {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--vscode-foreground)' }}>
        Loading...
      </div>
    )
  }

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      <style>{`
        @keyframes pixel-agents-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        .pixel-agents-pulse { animation: pixel-agents-pulse ${PULSE_ANIMATION_DURATION_SEC}s ease-in-out infinite; }
      `}</style>

      <OfficeCanvas
        officeState={officeState}
        onClick={handleClick}
        onHoverAgent={setHoveredAgentId}
        isEditMode={editor.isEditMode}
        editorState={editorState}
        onEditorTileAction={editor.handleEditorTileAction}
        onEditorEraseAction={editor.handleEditorEraseAction}
        onEditorSelectionChange={editor.handleEditorSelectionChange}
        onDeleteSelected={editor.handleDeleteSelected}
        onRotateSelected={editor.handleRotateSelected}
        onDragMove={editor.handleDragMove}
        editorTick={editor.editorTick}
        zoom={editor.zoom}
        onZoomChange={editor.handleZoomChange}
        panRef={editor.panRef}
      />

      {hoveredHistory && (() => {
        const title = toHistoryTitleSnippet(hoveredHistory.title, hoveredHistory.sessionId) || hoveredHistory.sessionId
        const summary = toHistorySummaryText(hoveredHistory.summary)
        return (
        <div
          style={{
            position: 'absolute',
            right: 10,
            top: 10,
            zIndex: 'var(--pixel-controls-z)',
            background: 'var(--pixel-hover-card-bg)',
            border: '2px solid var(--pixel-hover-card-border)',
            boxShadow: 'var(--pixel-shadow)',
            backdropFilter: 'blur(1.5px)',
            padding: '8px 10px',
            width: 320,
            pointerEvents: 'none',
            textAlign: 'left',
          }}
        >
          <div style={{ fontSize: 'var(--pixel-font-sm)', color: 'var(--pixel-hover-card-fg)', marginBottom: 4 }}>
            <div style={{ textAlign: 'left' }}>
              <div
                style={{
                  fontSize: 'var(--pixel-font-md)',
                  color: 'var(--pixel-hover-card-fg)',
                  fontWeight: 'var(--pixel-font-weight)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {title}
              </div>
              <div
                style={{
                  whiteSpace: 'nowrap',
                  fontSize: 'var(--pixel-font-xxs)',
                  fontWeight: 'var(--pixel-font-weight)',
                  letterSpacing: 'var(--pixel-letter-spacing)',
                  color: 'var(--pixel-hover-card-fg)',
                  fontFamily: 'var(--vscode-font-family)',
                }}
              >
                {formatHistoryAgeAgo(parseIsoToMs(hoveredHistory.lastActivityAt))}
              </div>
            </div>
          </div>
          <div style={{ fontSize: 'var(--pixel-font-xxs)', color: 'var(--pixel-hover-card-dim)', marginBottom: 4, textAlign: 'left' }}>
            Last active: {formatDateTimeCompact(hoveredHistory.lastActivityAt)}
          </div>
          <div style={{ fontSize: 'var(--pixel-font-xxs)', color: 'var(--pixel-hover-card-dim)', marginBottom: 6, textAlign: 'left' }}>
            Created: {formatDateTimeCompact(hoveredHistory.createdAt)}
          </div>
          <div
            style={{
              fontSize: 'var(--pixel-font-sm)',
              color: 'var(--pixel-hover-card-fg)',
              whiteSpace: 'pre-line',
              overflowWrap: 'anywhere',
              wordBreak: 'break-word',
              lineHeight: 1.3,
              textAlign: 'left',
              maxHeight: 132,
              overflowY: 'auto',
            }}
          >
            {summary}
          </div>
        </div>
        )
      })()}

      {/* Vignette overlay */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'var(--pixel-vignette)',
          pointerEvents: 'none',
          zIndex: 40,
        }}
      />

      <BottomToolbar
        isEditMode={editor.isEditMode}
        onOpenClaude={handleOpenClaude}
        onToggleEditMode={editor.handleToggleEditMode}
        isDebugMode={isDebugMode}
        onToggleDebugMode={handleToggleDebugMode}
        zoom={editor.zoom}
        onZoomChange={editor.handleZoomChange}
        historySessionsEnabled={historySessionsEnabled}
        onToggleHistorySessions={handleToggleHistorySessions}
        workspaceFolders={workspaceFolders}
        showTerminalToggle={isDesktopHost}
        isTerminalOpen={isTerminalOpen}
        onToggleTerminal={() => setIsTerminalOpen((prev) => !prev)}
      />
      {isDesktopHost && (
        <EmbeddedTerminal
          isOpen={isTerminalOpen}
          traceId={activeTerminalTraceId}
          contractProbe={traceContractProbe}
        />
      )}

      {editor.isEditMode && editor.isDirty && (
        <EditActionBar editor={editor} editorState={editorState} />
      )}

      {showRotateHint && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            left: '50%',
            transform: editor.isDirty ? 'translateX(calc(-50% + 100px))' : 'translateX(-50%)',
            zIndex: 49,
            background: 'var(--pixel-hint-bg)',
            color: '#fff',
            fontSize: 'var(--pixel-font-sm)',
            padding: '3px 8px',
            borderRadius: 0,
            border: '2px solid var(--pixel-accent)',
            boxShadow: 'var(--pixel-shadow)',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          Press <b>R</b> to rotate
        </div>
      )}

      {editor.isEditMode && (() => {
        // Compute selected furniture color from current layout
        const selUid = editorState.selectedFurnitureUid
        const selColor = selUid
          ? officeState.getLayout().furniture.find((f) => f.uid === selUid)?.color ?? null
          : null
        return (
          <EditorToolbar
            activeTool={editorState.activeTool}
            selectedTileType={editorState.selectedTileType}
            selectedFurnitureType={editorState.selectedFurnitureType}
            selectedFurnitureUid={selUid}
            selectedFurnitureColor={selColor}
            floorColor={editorState.floorColor}
            wallColor={editorState.wallColor}
            onToolChange={editor.handleToolChange}
            onTileTypeChange={editor.handleTileTypeChange}
            onFloorColorChange={editor.handleFloorColorChange}
            onWallColorChange={editor.handleWallColorChange}
            onSelectedFurnitureColorChange={editor.handleSelectedFurnitureColorChange}
            onFurnitureTypeChange={editor.handleFurnitureTypeChange}
            loadedAssets={loadedAssets}
          />
        )
      })()}

      <ToolOverlay
        officeState={officeState}
        agents={agents}
        historySessions={historySessions}
        agentTools={agentTools}
        subagentTools={subagentTools}
        subagentCharacters={subagentCharacters}
        containerRef={containerRef}
        zoom={editor.zoom}
        panRef={editor.panRef}
        onCloseAgent={handleCloseAgent}
      />

      {isDebugMode && (
        <DebugView
          agents={agents}
          selectedAgent={selectedAgent}
          agentTools={agentTools}
          agentStatuses={agentStatuses}
          subagentTools={subagentTools}
          onSelectAgent={handleSelectAgent}
        />
      )}
    </div>
  )
}

export default App
