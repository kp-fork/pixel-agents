import { useState } from 'react'
import { SettingsModal } from './SettingsModal.js'
import { LayoutModal } from './LayoutModal.js'

interface BottomToolbarProps {
  isEditMode: boolean
  onOpenClaude: () => void
  onToggleEditMode: () => void
  isDebugMode: boolean
  onToggleDebugMode: () => void
  historySessionsEnabled: boolean
  onToggleHistorySessions: (enabled: boolean) => void
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
  historySessionsEnabled,
  onToggleHistorySessions,
}: BottomToolbarProps) {
  const [hovered, setHovered] = useState<string | null>(null)
  const [isLayoutOpen, setIsLayoutOpen] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)

  return (
    <div style={panelStyle}>
      <button
        onClick={onOpenClaude}
        onMouseEnter={() => setHovered('agent')}
        onMouseLeave={() => setHovered(null)}
        style={{
          ...btnBase,
          padding: '5px 12px',
          background:
            hovered === 'agent'
              ? 'var(--pixel-agent-hover-bg)'
              : 'var(--pixel-agent-bg)',
          border: '2px solid var(--pixel-agent-border)',
          color: 'var(--pixel-agent-text)',
        }}
      >
        + Agent
      </button>
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
    </div>
  )
}
