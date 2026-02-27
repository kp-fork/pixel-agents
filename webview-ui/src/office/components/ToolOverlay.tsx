import { useState, useEffect } from 'react'
import type { ToolActivity } from '../types.js'
import type { OfficeState } from '../engine/officeState.js'
import type { SubagentCharacter, HistorySessionCharacter } from '../../hooks/useExtensionMessages.js'
import { TILE_SIZE, CharacterState } from '../types.js'
import type { AgentId } from '../types.js'
import { TOOL_OVERLAY_VERTICAL_OFFSET, CHARACTER_SITTING_OFFSET_PX } from '../../constants.js'
import { isAlwaysStatusBubblesEnabled } from '../../speechBubbles.js'
import { deriveOverlayState } from './toolOverlayState.js'

interface ToolOverlayProps {
  officeState: OfficeState
  agents: AgentId[]
  historySessions: HistorySessionCharacter[]
  agentTools: Record<string, ToolActivity[]>
  subagentTools: Record<string, Record<string, ToolActivity[]>>
  subagentCharacters: SubagentCharacter[]
  containerRef: React.RefObject<HTMLDivElement | null>
  zoom: number
  panRef: React.RefObject<{ x: number; y: number }>
  onCloseAgent: (id: AgentId) => void
}

export function ToolOverlay({
  officeState,
  agents,
  historySessions,
  agentTools,
  subagentTools,
  subagentCharacters,
  containerRef,
  zoom,
  panRef,
  onCloseAgent,
}: ToolOverlayProps) {
  const showBubbles = isAlwaysStatusBubblesEnabled()

  const formatHistoryAgeAgo = (iso: string): string => {
    const ms = Date.parse(iso)
    if (!Number.isFinite(ms)) return '-'
    const diffHours = Math.max(1, Math.floor((Date.now() - ms) / (1000 * 60 * 60)))
    if (diffHours < 24) {
      return `${diffHours} ${diffHours === 1 ? 'hour' : 'hours'} ago`
    }
    const diffDays = Math.floor(diffHours / 24)
    return `${diffDays} ${diffDays === 1 ? 'day' : 'days'} ago`
  }

  const toTitleSnippet = (preview: string, sessionId: string): string => {
    const base = (preview || '').replace(/\s+/g, ' ').trim() || sessionId
    const maxLen = 22
    if (base.length <= maxLen) return base
    return `${base.slice(0, maxLen - 1)}…`
  }

  const [, setTick] = useState(0)
  useEffect(() => {
    let rafId = 0
    const tick = () => {
      setTick((n) => n + 1)
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [])

  const el = containerRef.current
  if (!el) return null
  const rect = el.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const canvasW = Math.round(rect.width * dpr)
  const canvasH = Math.round(rect.height * dpr)
  const layout = officeState.getLayout()
  const mapW = layout.cols * TILE_SIZE * zoom
  const mapH = layout.rows * TILE_SIZE * zoom
  const deviceOffsetX = Math.floor((canvasW - mapW) / 2) + Math.round(panRef.current.x)
  const deviceOffsetY = Math.floor((canvasH - mapH) / 2) + Math.round(panRef.current.y)

  const selectedId = officeState.selectedAgentId
  // All character IDs
  const allIds = [...agents, ...subagentCharacters.map((s) => s.id)]

  const historyById = new Map(historySessions.map((s) => [s.id, s]))
  const historyIds = historySessions.map((s) => s.id)
  if (!showBubbles && historyIds.length === 0) return null

  return (
    <>
      {historyIds.map((id) => {
        const ch = officeState.characters.get(id)
        if (!ch || !ch.isHistorical) return null
        const history = historyById.get(id)
        if (!history) return null
        const title = toTitleSnippet(history.preview, history.sessionId)

        const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0
        const screenX = (deviceOffsetX + ch.x * zoom) / dpr
        const screenY = (deviceOffsetY + (ch.y + sittingOffset - TOOL_OVERLAY_VERTICAL_OFFSET) * zoom) / dpr

        return (
          <div
            key={`history-age-${id}`}
            style={{
              position: 'absolute',
              left: screenX,
              top: screenY - 16,
              transform: 'translateX(-50%)',
              pointerEvents: 'none',
              zIndex: 'var(--pixel-overlay-z)',
            }}
          >
            <div
              style={{
                background: 'rgba(18, 18, 26, 0.88)',
                border: '1px solid rgba(255, 255, 255, 0.22)',
                padding: '2px 6px',
                lineHeight: 1.25,
                color: 'var(--pixel-text-dim)',
                fontSize: '15px',
                minWidth: 170,
                maxWidth: 210,
                textAlign: 'right',
              }}
            >
              <div
                style={{
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  fontSize: '15px',
                  opacity: 0.9,
                }}
              >
                {title}
              </div>
              <div
                style={{
                  whiteSpace: 'nowrap',
                  fontSize: '10px',
                  fontWeight: 400,
                  letterSpacing: '0.1px',
                  color: 'var(--vscode-foreground)',
                  fontFamily: 'var(--vscode-font-family)',
                }}
              >
                {formatHistoryAgeAgo(history.lastActivityAt)}
              </div>
            </div>
          </div>
        )
      })}

      {showBubbles && allIds.map((id) => {
        const ch = officeState.characters.get(id)
        if (!ch) return null

        const isSelected = selectedId === id
        const isSub = ch.isSubagent

        const subToolGroups = !isSub ? subagentTools[id] : undefined

        // Position above character
        const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0
        const screenX = (deviceOffsetX + ch.x * zoom) / dpr
        const screenY = (deviceOffsetY + (ch.y + sittingOffset - TOOL_OVERLAY_VERTICAL_OFFSET) * zoom) / dpr

        const sub = isSub ? subagentCharacters.find((s) => s.id === id) : undefined
        const overlayState = deriveOverlayState({
          isSubagent: isSub,
          isActive: ch.isActive,
          bubbleType: ch.bubbleType,
          tools: agentTools[id],
          subToolGroups,
          subLabel: sub?.label,
        })

        let dotColor: string | null = null
        if (overlayState.hasPermission) {
          dotColor = 'var(--pixel-status-permission)'
        } else if (ch.isActive && overlayState.hasActiveTools) {
          dotColor = 'var(--pixel-status-active)'
        }

        return (
          <div
            key={id}
            style={{
              position: 'absolute',
              left: screenX,
              top: screenY - 24,
              transform: 'translateX(-50%)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              pointerEvents: isSelected ? 'auto' : 'none',
              zIndex: isSelected ? 'var(--pixel-overlay-selected-z)' : 'var(--pixel-overlay-z)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                background: 'var(--pixel-bg)',
                border: isSelected
                  ? '2px solid var(--pixel-border-light)'
                  : '2px solid var(--pixel-border)',
                borderRadius: 0,
                padding: isSelected ? '3px 6px 3px 8px' : '3px 8px',
                boxShadow: 'var(--pixel-shadow)',
                whiteSpace: 'nowrap',
                maxWidth: 220,
              }}
            >
              {dotColor && (
                <span
                  className={ch.isActive && !overlayState.hasPermission ? 'pixel-agents-pulse' : undefined}
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: dotColor,
                    flexShrink: 0,
                  }}
                />
              )}
                <span
                style={{
                  fontSize: isSub ? '20px' : '22px',
                  fontStyle: isSub ? 'italic' : undefined,
                  color: 'var(--vscode-foreground)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                >
                  {overlayState.activityText}
                </span>
              {isSelected && !isSub && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onCloseAgent(id)
                  }}
                  title="Close agent"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--pixel-close-text)',
                    cursor: 'pointer',
                    padding: '0 2px',
                    fontSize: '26px',
                    lineHeight: 1,
                    marginLeft: 2,
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.color = 'var(--pixel-close-hover)'
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.color = 'var(--pixel-close-text)'
                  }}
                >
                  ×
                </button>
              )}
            </div>
          </div>
        )
      })}
    </>
  )
}
