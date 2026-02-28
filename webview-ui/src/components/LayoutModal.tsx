import { useState } from 'react'
import { vscode } from '../vscodeApi.js'

interface LayoutModalProps {
  isOpen: boolean
  onClose: () => void
  isEditMode: boolean
  onToggleEditMode: () => void
}

const menuItemBase: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  width: '100%',
  padding: '6px 10px',
  fontSize: 'var(--pixel-font-lg)',
  color: 'rgba(255, 255, 255, 0.8)',
  background: 'transparent',
  border: 'none',
  borderRadius: 0,
  cursor: 'pointer',
  textAlign: 'left',
}

export function LayoutModal({
  isOpen,
  onClose,
  isEditMode,
  onToggleEditMode,
}: LayoutModalProps) {
  const [hovered, setHovered] = useState<string | null>(null)

  if (!isOpen) return null

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          background: 'rgba(0, 0, 0, 0.5)',
          zIndex: 900,
        }}
      />
      <div
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 901,
          background: 'var(--pixel-bg)',
          border: '2px solid var(--pixel-border)',
          borderRadius: 0,
          padding: '4px',
          boxShadow: 'var(--pixel-shadow)',
          minWidth: 220,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '4px 10px',
            borderBottom: '1px solid var(--pixel-border)',
            marginBottom: '4px',
          }}
        >
          <span style={{ fontSize: 'var(--pixel-font-lg)', color: 'rgba(255, 255, 255, 0.9)' }}>Layout</span>
          <button
            onClick={onClose}
            onMouseEnter={() => setHovered('close')}
            onMouseLeave={() => setHovered(null)}
            style={{
              background: hovered === 'close' ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
              border: 'none',
              borderRadius: 0,
              color: 'rgba(255, 255, 255, 0.6)',
              fontSize: 'var(--pixel-font-lg)',
              cursor: 'pointer',
              padding: '0 4px',
              lineHeight: 1,
            }}
          >
            X
          </button>
        </div>

        <button
          onClick={() => {
            onToggleEditMode()
            onClose()
          }}
          onMouseEnter={() => setHovered('edit-mode')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...menuItemBase,
            background: hovered === 'edit-mode' ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
          }}
        >
          {isEditMode ? 'Exit Edit Mode' : 'Enter Edit Mode'}
        </button>

        <button
          onClick={() => {
            vscode.postMessage({ type: 'importPack' })
            onClose()
          }}
          onMouseEnter={() => setHovered('from-pack')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...menuItemBase,
            background: hovered === 'from-pack' ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
          }}
        >
          From Pack (.zip)
        </button>

        <button
          onClick={() => {
            vscode.postMessage({ type: 'exportPack' })
            onClose()
          }}
          onMouseEnter={() => setHovered('to-pack')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...menuItemBase,
            background: hovered === 'to-pack' ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
          }}
        >
          To Pack (.zip)
        </button>

        <button
          onClick={() => {
            vscode.postMessage({ type: 'importLayout' })
            onClose()
          }}
          onMouseEnter={() => setHovered('from-layout')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...menuItemBase,
            background: hovered === 'from-layout' ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
          }}
        >
          From Layout (.json)
        </button>
      </div>
    </>
  )
}
