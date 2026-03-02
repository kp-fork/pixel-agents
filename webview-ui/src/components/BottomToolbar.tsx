import { useState, useEffect, useRef } from 'react'
import type { WorkspaceFolder } from '../hooks/useExtensionMessages.js'
import { SettingsModal } from './SettingsModal.js'
import { LayoutModal } from './LayoutModal.js'
import { ZOOM_MIN, ZOOM_MAX } from '../constants.js'
import { vscode } from '../vscodeApi.js'

interface BottomToolbarProps {
  isEditMode: boolean
  onOpenClaude: () => void
  onToggleEditMode: () => void
  isDebugMode: boolean
  onToggleDebugMode: () => void
  zoom: number
  onZoomChange: (zoom: number) => void
  historySessionsEnabled: boolean
  onToggleHistorySessions: (enabled: boolean) => void
  workspaceFolders: WorkspaceFolder[]
}

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 10,
  left: 10,
  zIndex: 'var(--pixel-controls-z)',
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  background: 'var(--pixel-bg)',
  border: '2px solid var(--pixel-border)',
  borderRadius: 0,
  padding: '4px 6px',
  boxShadow: 'var(--pixel-shadow)',
}

const btnBase: React.CSSProperties = {
  padding: '5px 10px',
  fontSize: 'var(--pixel-font-lg)',
  color: 'var(--pixel-text)',
  background: 'var(--pixel-btn-bg)',
  border: '2px solid transparent',
  borderRadius: 0,
  cursor: 'pointer',
}

const btnActive: React.CSSProperties = {
  ...btnBase,
  background: 'var(--pixel-active-bg)',
  border: '2px solid var(--pixel-accent)',
}

export function BottomToolbar({
  isEditMode,
  onOpenClaude,
  onToggleEditMode,
  isDebugMode,
  onToggleDebugMode,
  zoom,
  onZoomChange,
  historySessionsEnabled,
  onToggleHistorySessions,
  workspaceFolders,
}: BottomToolbarProps) {
  const [hovered, setHovered] = useState<string | null>(null)
  const [isLayoutOpen, setIsLayoutOpen] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false)
  const [hoveredFolder, setHoveredFolder] = useState<number | null>(null)
  const folderPickerRef = useRef<HTMLDivElement>(null)
  const minDisabled = zoom <= ZOOM_MIN
  const maxDisabled = zoom >= ZOOM_MAX
  const hasMultipleFolders = workspaceFolders.length > 1

  useEffect(() => {
    if (!isFolderPickerOpen) return
    const handleClick = (e: MouseEvent) => {
      if (folderPickerRef.current && !folderPickerRef.current.contains(e.target as Node)) {
        setIsFolderPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isFolderPickerOpen])

  const handleAgentClick = () => {
    if (hasMultipleFolders) {
      setIsFolderPickerOpen((v) => !v)
      return
    }
    onOpenClaude()
  }

  const handleFolderSelect = (folder: WorkspaceFolder) => {
    setIsFolderPickerOpen(false)
    vscode.postMessage({ type: 'openClaude', folderPath: folder.path })
  }

  return (
    <div style={panelStyle}>
      <div ref={folderPickerRef} style={{ position: 'relative' }}>
        <button
          onClick={handleAgentClick}
          onMouseEnter={() => setHovered('agent')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...btnBase,
            padding: '5px 12px',
            background:
              hovered === 'agent' || isFolderPickerOpen
                ? 'var(--pixel-agent-hover-bg)'
                : 'var(--pixel-agent-bg)',
            border: '2px solid var(--pixel-agent-border)',
            color: 'var(--pixel-agent-text)',
          }}
        >
          + Agent
        </button>
        {isFolderPickerOpen && hasMultipleFolders && (
          <div
            style={{
              position: 'absolute',
              bottom: '100%',
              left: 0,
              marginBottom: 4,
              background: 'var(--pixel-bg)',
              border: '2px solid var(--pixel-border)',
              borderRadius: 0,
              boxShadow: 'var(--pixel-shadow)',
              minWidth: 160,
              zIndex: 'var(--pixel-controls-z)',
            }}
          >
            {workspaceFolders.map((folder, i) => (
              <button
                key={folder.path}
                onClick={() => handleFolderSelect(folder)}
                onMouseEnter={() => setHoveredFolder(i)}
                onMouseLeave={() => setHoveredFolder(null)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '6px 10px',
                  fontSize: 'var(--pixel-font-sm)',
                  color: 'var(--pixel-text)',
                  background: hoveredFolder === i ? 'var(--pixel-btn-hover-bg)' : 'transparent',
                  border: 'none',
                  borderRadius: 0,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {folder.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        onClick={() => {
          setIsLayoutOpen((v) => {
            const next = !v
            if (next) setIsSettingsOpen(false)
            return next
          })
        }}
        onMouseEnter={() => setHovered('edit')}
        onMouseLeave={() => setHovered(null)}
        style={
          isEditMode || isLayoutOpen
            ? { ...btnActive }
            : {
                ...btnBase,
                background: hovered === 'edit' ? 'var(--pixel-btn-hover-bg)' : btnBase.background,
              }
        }
        title="Layout menu"
      >
        Layout
      </button>
      <LayoutModal
        isOpen={isLayoutOpen}
        onClose={() => setIsLayoutOpen(false)}
        isEditMode={isEditMode}
        onToggleEditMode={onToggleEditMode}
      />
      <div style={{ position: 'relative' }}>
        <button
          onClick={() => setIsSettingsOpen((v) => {
            const next = !v
            if (next) setIsLayoutOpen(false)
            return next
          })}
          onMouseEnter={() => setHovered('settings')}
          onMouseLeave={() => setHovered(null)}
          style={
            isSettingsOpen
              ? { ...btnActive }
              : {
                  ...btnBase,
                  background: hovered === 'settings' ? 'var(--pixel-btn-hover-bg)' : btnBase.background,
                }
          }
          title="Settings"
        >
          Settings
        </button>
        <SettingsModal
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          isDebugMode={isDebugMode}
          onToggleDebugMode={onToggleDebugMode}
          historySessionsEnabled={historySessionsEnabled}
          onToggleHistorySessions={onToggleHistorySessions}
        />
      </div>
      <div style={{ display: 'flex', gap: 2, marginLeft: 2 }}>
        <button
          onClick={() => onZoomChange(zoom - 1)}
          disabled={minDisabled}
          onMouseEnter={() => setHovered('zoom-minus')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...btnBase,
            width: 28,
            padding: '5px 0',
            background: hovered === 'zoom-minus' && !minDisabled ? 'var(--pixel-btn-hover-bg)' : btnBase.background,
            cursor: minDisabled ? 'default' : 'pointer',
            opacity: minDisabled ? 'var(--pixel-btn-disabled-opacity)' : 1,
          }}
          title="Zoom out (Ctrl+Scroll)"
        >
          -
        </button>
        <button
          onClick={() => onZoomChange(zoom + 1)}
          disabled={maxDisabled}
          onMouseEnter={() => setHovered('zoom-plus')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...btnBase,
            width: 28,
            padding: '5px 0',
            background: hovered === 'zoom-plus' && !maxDisabled ? 'var(--pixel-btn-hover-bg)' : btnBase.background,
            cursor: maxDisabled ? 'default' : 'pointer',
            opacity: maxDisabled ? 'var(--pixel-btn-disabled-opacity)' : 1,
          }}
          title="Zoom in (Ctrl+Scroll)"
        >
          +
        </button>
      </div>
    </div>
  )
}
