import { useState, useEffect } from 'react'
import type { ToolActivity } from '../types.js'
import type { OfficeState } from '../engine/officeState.js'
import type { SubagentCharacter, HistorySessionCharacter } from '../../hooks/useExtensionMessages.js'
import { TILE_SIZE, CharacterState } from '../types.js'
import type { AgentId } from '../types.js'
import {
  TOOL_OVERLAY_VERTICAL_OFFSET,
  CHARACTER_SITTING_OFFSET_PX,
  FUEL_COLOR_CRITICAL,
  FUEL_COLOR_DANGER,
  FUEL_COLOR_OK,
  FUEL_COLOR_WARN,
  FUEL_GAUGE_BG,
  FUEL_GAUGE_HEIGHT_PX,
  FUEL_GAUGE_WIDTH_PX,
  MAX_CONTEXT_TOKENS,
  TEAM_LEAD_COLOR,
  TEAM_ROLE_COLOR,
  TOKEN_CRITICAL_THRESHOLD,
  TOKEN_DANGER_THRESHOLD,
  TOKEN_WARN_THRESHOLD,
} from '../../constants.js'
import { isAlwaysStatusBubblesEnabled } from '../../speechBubbles.js'
import { deriveOverlayState } from './toolOverlayState.js'
import { toHistoryTitleSnippet } from '../../historyText.js'

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

function getFuelColor(ratio: number): string {
  if (ratio >= TOKEN_CRITICAL_THRESHOLD) return FUEL_COLOR_CRITICAL;
  if (ratio >= TOKEN_DANGER_THRESHOLD) return FUEL_COLOR_DANGER;
  if (ratio >= TOKEN_WARN_THRESHOLD) return FUEL_COLOR_WARN;
  return FUEL_COLOR_OK;
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
        const title = toHistoryTitleSnippet(history.title, history.sessionId, 24) || history.sessionId

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
              transform: 'translateX(0)',
              pointerEvents: 'none',
              zIndex: 'var(--pixel-overlay-z)',
            }}
          >
            <div
              style={{
                background: 'var(--pixel-history-chip-bg)',
                border: '1px solid rgba(255, 255, 255, 0.22)',
                padding: '2px 6px',
                lineHeight: 1.25,
                color: 'var(--pixel-bubble-dim)',
                fontSize: 'var(--pixel-font-md)',
                minWidth: 170,
                maxWidth: 210,
                textAlign: 'left',
              }}
            >
              <div
                style={{
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  fontSize: 'var(--pixel-font-md)',
                  color: 'var(--pixel-bubble-fg)',
                  fontWeight: 'var(--pixel-font-weight)',
                  opacity: 1,
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
                  color: 'var(--pixel-bubble-dim)',
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

        // Team info
        const isTeamAgent = !!ch.teamName;
        const teamRoleLabel = ch.isTeamLead ? 'LEAD' : ch.agentName || null;
        const totalTokens = ch.inputTokens + ch.outputTokens;
        const tokenRatio = totalTokens / MAX_CONTEXT_TOKENS;
        return (
          <div
            key={id}
            style={{
              position: 'absolute',
              left: screenX,
              top: screenY - 24,
              transform: 'translateX(0)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
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
              <div style={{ overflow: 'hidden' }}>
                {teamRoleLabel && (
                  <span
                    style={{
                      fontSize: '18px',
                      color: ch.isTeamLead ? TEAM_LEAD_COLOR : TEAM_ROLE_COLOR,
                      fontWeight: ch.isTeamLead ? 'bold' : undefined,
                    }}
                  >
                    {teamRoleLabel}
                  </span>
                )}
                <span
                  style={{
                    fontSize: isSub ? 'var(--pixel-font-sm)' : 'var(--pixel-font-md)',
                    fontStyle: isSub ? 'italic' : undefined,
                    color: 'var(--pixel-bubble-fg)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    display: 'block',
                  }}
                >
                  {overlayState.activityText}
                </span>
                {ch.folderName && (
                  <span
                    style={{
                      fontSize: 'var(--pixel-font-xxs)',
                      color: 'var(--pixel-text-dim)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      display: 'block',
                    }}
                  >
                    {ch.folderName}
                  </span>
                )}
              </div>
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
                    fontSize: 'var(--pixel-font-lg)',
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
            {isTeamAgent && totalTokens > 0 && (
              <div
                style={{
                  width: FUEL_GAUGE_WIDTH_PX,
                  height: FUEL_GAUGE_HEIGHT_PX,
                  background: FUEL_GAUGE_BG,
                  marginTop: 2,
                }}
                title={`${Math.round(tokenRatio * 100)}% context used (${(totalTokens / 1000).toFixed(0)}k tokens)`}
              >
                <div
                  style={{
                    width: `${Math.min(tokenRatio * 100, 100)}%`,
                    height: '100%',
                    background: getFuelColor(tokenRatio),
                  }}
                />
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}
