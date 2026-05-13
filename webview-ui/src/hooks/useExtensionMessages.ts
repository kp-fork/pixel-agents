import { useState, useEffect, useRef } from 'react'
import type { OfficeState } from '../office/engine/officeState.js'
import type { AgentId, OfficeLayout, ToolActivity } from '../office/types.js'
import { extractToolName } from '../office/toolUtils.js'
import { migrateLayoutColors } from '../office/layout/layoutSerializer.js'
import { buildDynamicCatalog } from '../office/layout/furnitureCatalog.js'
import { setFloorSprites } from '../office/floorTiles.js'
import { setWallSprites } from '../office/wallTiles.js'
import { setCharacterTemplates } from '../office/sprites/spriteData.js'
import { vscode } from '../vscodeApi.js'
import { playDoneSound, setSoundEnabled } from '../notificationSound.js'
import { setAlwaysStatusBubblesEnabled, setEventBubblesEnabled } from '../speechBubbles.js'
import { asTypedHostMessage } from '../adapter/hostMessage.js'

export interface SubagentCharacter {
  id: AgentId
  parentAgentId: AgentId
  parentToolId: string
  label: string
}

export interface HistorySessionCharacter {
  id: string
  sessionId: string
  jsonlPath: string
  createdAt: string
  lastActivityAt: string
  title: string
  summary: string
}

export interface FurnitureAsset {
  id: string
  name: string
  label: string
  category: string
  file: string
  width: number
  height: number
  footprintW: number
  footprintH: number
  isDesk: boolean
  canPlaceOnWalls: boolean
  partOfGroup?: boolean
  groupId?: string
  canPlaceOnSurfaces?: boolean
  backgroundTiles?: number
}

export interface WorkspaceFolder {
  name: string
  path: string
}

export interface ExtensionMessageState {
  agents: AgentId[]
  selectedAgent: AgentId | null
  historySessions: HistorySessionCharacter[]
  historySessionsEnabled: boolean
  agentTools: Record<string, ToolActivity[]>
  agentStatuses: Record<string, string>
  subagentTools: Record<string, Record<string, ToolActivity[]>>
  subagentCharacters: SubagentCharacter[]
  layoutReady: boolean
  loadedAssets?: { catalog: FurnitureAsset[]; sprites: Record<string, string[][]> }
  workspaceFolders: WorkspaceFolder[]
}

function saveAgentSeats(os: OfficeState): void {
  const seats: Record<string, { palette: number; hueShift: number; seatId: string | null }> = {}
  for (const ch of os.characters.values()) {
    if (ch.isSubagent || ch.isHistorical) continue
    seats[ch.id] = { palette: ch.palette, hueShift: ch.hueShift, seatId: ch.seatId }
  }
  vscode.postMessage({ type: 'saveAgentSeats', seats })
}

export function useExtensionMessages(
  getOfficeState: () => OfficeState,
  onLayoutLoaded?: (layout: OfficeLayout) => void,
  isEditDirty?: () => boolean,
): ExtensionMessageState {
  const [agents, setAgents] = useState<AgentId[]>([])
  const [selectedAgent, setSelectedAgent] = useState<AgentId | null>(null)
  const [historySessions, setHistorySessions] = useState<HistorySessionCharacter[]>([])
  const [historySessionsEnabled, setHistorySessionsEnabled] = useState(true)
  const [agentTools, setAgentTools] = useState<Record<string, ToolActivity[]>>({})
  const [agentStatuses, setAgentStatuses] = useState<Record<string, string>>({})
  const [subagentTools, setSubagentTools] = useState<Record<string, Record<string, ToolActivity[]>>>({})
  const [subagentCharacters, setSubagentCharacters] = useState<SubagentCharacter[]>([])
  const [layoutReady, setLayoutReady] = useState(false)
  const [loadedAssets, setLoadedAssets] = useState<{ catalog: FurnitureAsset[]; sprites: Record<string, string[][]> } | undefined>()
  const [workspaceFolders, setWorkspaceFolders] = useState<WorkspaceFolder[]>([])

  // Track whether initial layout has been loaded (ref to avoid re-render)
  const layoutReadyRef = useRef(false)
  const historySessionsRef = useRef<HistorySessionCharacter[]>([])

  useEffect(() => {
    // Buffer agents from existingAgents until layout is loaded
    let pendingAgents: Array<{ id: AgentId; palette?: number; hueShift?: number; seatId?: string; folderName?: string }> = []
    let pendingHistorySessions: HistorySessionCharacter[] = []

    const syncHistoryCharacters = (
      os: OfficeState,
      prev: HistorySessionCharacter[],
      next: HistorySessionCharacter[],
    ): void => {
      const prevIds = new Set(prev.map((s) => s.id))
      const nextIds = new Set(next.map((s) => s.id))
      for (const id of prevIds) {
        if (!nextIds.has(id)) {
          os.removeHistoricalAgent(id)
        }
      }
      for (const id of nextIds) {
        if (!prevIds.has(id)) {
          os.addHistoricalAgent(id)
        }
      }
    }

    const host = globalThis as { acquireVsCodeApi?: unknown; __electrobunSendToHost?: unknown }
    const standaloneMode =
      typeof host.acquireVsCodeApi !== 'function' &&
      typeof host.__electrobunSendToHost !== 'function'
    if (standaloneMode) {
      const os = getOfficeState()
      const demoAgents = [
        { id: 'desktop-alpha', palette: 0, hueShift: 0, active: true, tool: 'Plan architecture', folder: 'workspace/core' },
        { id: 'desktop-beta', palette: 1, hueShift: 0, active: true, tool: 'Coordinate subtasks', folder: 'workspace/core' },
        { id: 'desktop-gamma', palette: 2, hueShift: 0, active: false, tool: null, folder: 'workspace/ui' },
        { id: 'desktop-delta', palette: 3, hueShift: 0, active: true, tool: 'Implement renderer', folder: 'workspace/ui' },
        { id: 'desktop-epsilon', palette: 4, hueShift: 0, active: true, tool: 'Write integration tests', folder: 'workspace/tests' },
        { id: 'desktop-zeta', palette: 5, hueShift: 0, active: true, tool: 'Run migration', folder: 'workspace/ops' },
        { id: 'desktop-eta', palette: 0, hueShift: 80, active: true, tool: 'Review changes', folder: 'workspace/review' },
        { id: 'desktop-theta', palette: 2, hueShift: 140, active: false, tool: null, folder: 'workspace/ops' },
      ] as const

      const agentStatusSeed: Record<string, string> = {}
      const agentToolSeed: Record<string, ToolActivity[]> = {}

      for (const demo of demoAgents) {
        os.addAgent(demo.id, demo.palette, demo.hueShift, undefined, true, demo.folder)
        os.setAgentActive(demo.id, demo.active)
        os.setAgentTool(demo.id, demo.tool)
        if (demo.tool) {
          agentToolSeed[demo.id] = [{ toolId: `tool:${demo.id}:1`, status: demo.tool, done: false }]
        }
      }

      // Waiting examples
      os.showWaitingBubble('desktop-gamma')
      os.showWaitingBubble('desktop-theta')
      agentStatusSeed['desktop-gamma'] = 'waiting'
      agentStatusSeed['desktop-theta'] = 'waiting'

      // Permission-waiting example
      os.showPermissionBubble('desktop-zeta')
      agentToolSeed['desktop-zeta'] = [
        { toolId: 'tool:desktop-zeta:1', status: 'Run migration', done: false, permissionWait: true },
      ]

      // Sub-agent examples under desktop-beta
      const demoSubagentTools: Record<string, Record<string, ToolActivity[]>> = {
        'desktop-beta': {
          'task-refactor': [{ toolId: 'subtool:task-refactor:1', status: 'Refactor parser', done: false }],
          'task-tests': [{ toolId: 'subtool:task-tests:1', status: 'Regression tests', done: true }],
        },
      }
      const demoSubagentCharacters: SubagentCharacter[] = []
      const subagentSpecs = [
        { parentAgentId: 'desktop-beta', parentToolId: 'task-refactor', label: 'Refactor parser' },
        { parentAgentId: 'desktop-beta', parentToolId: 'task-tests', label: 'Regression tests' },
      ] as const
      for (const spec of subagentSpecs) {
        const subId = os.addSubagent(spec.parentAgentId, spec.parentToolId)
        os.setAgentActive(subId, true)
        os.setAgentTool(subId, 'Subtask')
        demoSubagentCharacters.push({
          id: subId,
          parentAgentId: spec.parentAgentId,
          parentToolId: spec.parentToolId,
          label: spec.label,
        })
      }

      const now = Date.now()
      const historySeed: HistorySessionCharacter[] = [
        {
          id: 'history:desktop:1',
          sessionId: '67ee32c7-a1cd-47c2-a8fa-9473fc1f44af',
          jsonlPath: '/demo/sessions/alpha.jsonl',
          createdAt: new Date(now - 1000 * 60 * 60 * 36).toISOString(),
          lastActivityAt: new Date(now - 1000 * 60 * 60 * 3).toISOString(),
          title: 'Stabilize desktop bridge',
          summary: 'Refined standalone boot path and runtime flow.',
        },
        {
          id: 'history:desktop:2',
          sessionId: '9ef6f357-c387-4f67-a59e-6fe2e0a7bf0a',
          jsonlPath: '/demo/sessions/beta.jsonl',
          createdAt: new Date(now - 1000 * 60 * 60 * 52).toISOString(),
          lastActivityAt: new Date(now - 1000 * 60 * 60 * 26).toISOString(),
          title: 'Tune layout pack loading',
          summary: 'Validated pack structure and import/export paths.',
        },
        {
          id: 'history:desktop:3',
          sessionId: '0f1f0b8f-df43-4a51-911a-6f3f25a69f79',
          jsonlPath: '/demo/sessions/gamma.jsonl',
          createdAt: new Date(now - 1000 * 60 * 60 * 80).toISOString(),
          lastActivityAt: new Date(now - 1000 * 60 * 60 * 47).toISOString(),
          title: 'Investigate session tracking drift',
          summary: 'Compared live/session ids and dedupe behavior.',
        },
      ]
      syncHistoryCharacters(os, historySessionsRef.current, historySeed)
      historySessionsRef.current = historySeed

      setAgents(demoAgents.map((agent) => agent.id))
      setSelectedAgent('desktop-alpha')
      setAgentStatuses(agentStatusSeed)
      setAgentTools(agentToolSeed)
      setSubagentTools(demoSubagentTools)
      setSubagentCharacters(demoSubagentCharacters)
      setHistorySessions(historySeed)
      setHistorySessionsEnabled(true)
      setWorkspaceFolders([
        { name: 'workspace/core', path: 'desktop://workspace/core' },
        { name: 'workspace/ui', path: 'desktop://workspace/ui' },
        { name: 'workspace/ops', path: 'desktop://workspace/ops' },
      ])
      onLayoutLoaded?.(os.getLayout())
      layoutReadyRef.current = true
      setLayoutReady(true)
      console.log('[Webview] Standalone mode initialized with extended demo characters')

      return () => {
        // No host message wiring in standalone mode.
      }
    }

    const handler = (e: MessageEvent) => {
      const msg = asTypedHostMessage<{ type?: string; [key: string]: unknown }>(e.data)
      if (!msg) return
      const os = getOfficeState()

      if (msg.type === 'layoutLoaded') {
        // Skip external layout updates while editor has unsaved changes
        if (layoutReadyRef.current && isEditDirty?.()) {
          console.log('[Webview] Skipping external layout update — editor has unsaved changes')
          return
        }
        const rawLayout = msg.layout as OfficeLayout | null
        const layout = rawLayout && rawLayout.version === 1 ? migrateLayoutColors(rawLayout) : null
        if (layout) {
          os.rebuildFromLayout(layout)
          onLayoutLoaded?.(layout)
        } else {
          // Default layout — snapshot whatever OfficeState built
          onLayoutLoaded?.(os.getLayout())
        }
        // Add buffered agents now that layout (and seats) are correct
        for (const p of pendingAgents) {
          os.addAgent(p.id, p.palette, p.hueShift, p.seatId, true, p.folderName)
        }
        pendingAgents = []
        if (pendingHistorySessions.length > 0) {
          syncHistoryCharacters(os, historySessionsRef.current, pendingHistorySessions)
          historySessionsRef.current = pendingHistorySessions
          setHistorySessions(pendingHistorySessions)
          pendingHistorySessions = []
        }
        layoutReadyRef.current = true
        setLayoutReady(true)
        if (os.characters.size > 0) {
          saveAgentSeats(os)
        }
      } else if (msg.type === 'agentCreated') {
        const id = msg.id as AgentId
        const folderName = msg.folderName as string | undefined
        const isTeammate = msg.isTeammate as boolean | undefined
        const teammateName = msg.teammateName as string | undefined
        const teammateParentId = msg.parentAgentId as AgentId | undefined
        const teamName = msg.teamName as string | undefined
        setAgents((prev) => (prev.includes(id) ? prev : [...prev, id]))
        // Don't auto-select teammates (keep focus on lead)
        if (!isTeammate) {
          setSelectedAgent(id)
        }
        if (isTeammate && teammateParentId !== undefined) {
          // Teammate: inherit parent's palette and workspace folderName (teammate runs
          // in the same workspace as the lead). Name shown via agentName (teamRoleLabel).
          const parentCh = os.characters.get(teammateParentId);
          const palette = parentCh ? parentCh.palette : undefined
          const hueShift = parentCh ? parentCh.hueShift : undefined
          os.addAgent(id, palette, hueShift, undefined, undefined, parentCh?.folderName)
          // Set team metadata on the character
          const ch = os.characters.get(id)
          if (ch) {
            ch.leadAgentId = teammateParentId
            ch.teamName = teamName ?? parentCh?.teamName
            ch.agentName = teammateName
          }
        } else {
          os.addAgent(id, undefined, undefined, undefined, undefined, folderName)
        }
        saveAgentSeats(os)
      } else if (msg.type === 'agentClosed') {
        const id = msg.id as AgentId
        setAgents((prev) => prev.filter((a) => a !== id))
        setSelectedAgent((prev) => (prev === id ? null : prev))
        setAgentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setAgentStatuses((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setSubagentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        // Remove all sub-agent characters belonging to this agent
        os.removeAllSubagents(id)
        setSubagentCharacters((prev) => prev.filter((s) => s.parentAgentId !== id))
        os.removeAgent(id)
      } else if (msg.type === 'existingAgents') {
        const incoming = msg.agents as AgentId[]
        const meta = (msg.agentMeta || {}) as Record<string, { palette?: number; hueShift?: number; seatId?: string }>
        const folderNames = (msg.folderNames || {}) as Record<string, string>
        // Buffer agents — they'll be added in layoutLoaded after seats are built
        for (const id of incoming) {
          const m = meta[id]
          pendingAgents.push({ id, palette: m?.palette, hueShift: m?.hueShift, seatId: m?.seatId, folderName: folderNames[id] })
        }
        setAgents((prev) => {
          const ids = new Set(prev)
          const merged = [...prev]
          for (const id of incoming) {
            if (!ids.has(id)) {
              merged.push(id)
            }
          }
          return merged.sort((a, b) => a.localeCompare(b))
        })
      } else if (msg.type === 'historySessionsLoaded') {
        const incoming = Array.isArray(msg.sessions)
          ? (msg.sessions as Array<HistorySessionCharacter & { preview?: string }>).map((s) => {
              const baseTitle = (s.title || s.preview || s.sessionId || '').trim()
              const baseSummary = (s.summary || '').trim()
              return {
                ...s,
                title: baseTitle,
                summary: baseSummary,
              }
            })
          : []
        if (!layoutReadyRef.current) {
          pendingHistorySessions = incoming
        } else {
          syncHistoryCharacters(os, historySessionsRef.current, incoming)
          historySessionsRef.current = incoming
          setHistorySessions(incoming)
        }
      } else if (msg.type === 'agentToolStart') {
        const id = msg.id as AgentId
        const toolId = msg.toolId as string
        const status = msg.status as string
        const toolName = typeof msg.toolName === 'string' ? msg.toolName : extractToolName(status)
        setAgentTools((prev) => {
          const list = prev[id] || []
          if (list.some((t) => t.toolId === toolId)) return prev
          return { ...prev, [id]: [...list, { toolId, status, done: false }] }
        })
        os.setAgentTool(id, toolName)
        os.setAgentActive(id, true)
        os.clearPermissionBubble(id)
        // Create sub-agent character for Task/Agent tool subtasks.
        // In tmux / inline teams mode, Agent tool has run_in_background=true -- those
        // are handled via the independent teammate path (onTeammateDetected), not here.
        // runInBackground gates them out so we don't create ghost sub-agents for them.
        //
        // Skip creation for synthetic hook-ids. Later SubagentStop/subagentClear use
        // the REAL tool id from JSONL; creating with a synthetic id would orphan the
        // sub-agent (mismatched keys). JSONL's agentToolStart (with real id) handles
        // creation in both hooks and heuristic modes -- ~500ms delay vs instant hook.
        const runInBackground = msg.runInBackground as boolean | undefined
        if (
          (toolName === 'Task' || toolName === 'Agent') &&
          !runInBackground &&
          !toolId.startsWith('hook-')
        ) {
          const label = status.startsWith('Subtask:') ? status.slice('Subtask:'.length).trim() : ''
          const subId = os.addSubagent(id, toolId)
          setSubagentCharacters((prev) => {
            if (prev.some((s) => s.id === subId)) return prev
            return [...prev, { id: subId, parentAgentId: id, parentToolId: toolId, label }]
          })
        }
      } else if (msg.type === 'agentToolDone') {
        const id = msg.id as AgentId
        const toolId = msg.toolId as string
        setAgentTools((prev) => {
          const list = prev[id]
          if (!list) return prev
          return {
            ...prev,
            [id]: list.map((t) => (t.toolId === toolId ? { ...t, done: true } : t)),
          }
        })
      } else if (msg.type === 'agentToolsClear') {
        const id = msg.id as AgentId
        setAgentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setSubagentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        // Remove all sub-agent characters belonging to this agent
        os.removeAllSubagents(id)
        setSubagentCharacters((prev) => prev.filter((s) => s.parentAgentId !== id))
        os.setAgentTool(id, null)
        os.clearPermissionBubble(id)
        const clearCh = os.characters.get(id)
        const hasInlineTeammates =
          clearCh?.teamName && clearCh?.isTeamLead && !clearCh?.teamUsesTmux
        if (!hasInlineTeammates) {
          os.removeAllSubagents(id)
          setSubagentCharacters((prev) => prev.filter((s) => s.parentAgentId !== id))
        }
        os.setAgentTool(id, null)
        os.clearPermissionBubble(id)
      } else if (msg.type === 'agentSelected') {
        const id = msg.id as AgentId
        setSelectedAgent(id)
      } else if (msg.type === 'agentStatus') {
        const id = msg.id as AgentId
        const status = msg.status as string
        setAgentStatuses((prev) => {
          if (status === 'active') {
            if (!(id in prev)) return prev
            const next = { ...prev }
            delete next[id]
            return next
          }
          return { ...prev, [id]: status }
        })
        os.setAgentActive(id, status === 'active')
        if (status === 'waiting') {
          os.showWaitingBubble(id)
          playDoneSound()
        }
      } else if (msg.type === 'agentToolPermission') {
        const id = msg.id as AgentId
        setAgentTools((prev) => {
          const list = prev[id]
          if (!list) return prev
          return {
            ...prev,
            [id]: list.map((t) => (t.done ? t : { ...t, permissionWait: true })),
          }
        })
        os.showPermissionBubble(id)
      } else if (msg.type === 'subagentToolPermission') {
        const id = msg.id as AgentId
        const parentToolId = msg.parentToolId as string
        // Show permission bubble on the sub-agent character
        const subId = os.getSubagentId(id, parentToolId)
        if (subId !== null) {
          os.showPermissionBubble(subId)
        }
      } else if (msg.type === 'agentToolPermissionClear') {
        const id = msg.id as AgentId
        setAgentTools((prev) => {
          const list = prev[id]
          if (!list) return prev
          const hasPermission = list.some((t) => t.permissionWait)
          if (!hasPermission) return prev
          return {
            ...prev,
            [id]: list.map((t) => (t.permissionWait ? { ...t, permissionWait: false } : t)),
          }
        })
        os.clearPermissionBubble(id)
        // Also clear permission bubbles on all sub-agent characters of this parent
        for (const [subId, meta] of os.subagentMeta) {
          if (meta.parentAgentId === id) {
            os.clearPermissionBubble(subId)
          }
        }
      } else if (msg.type === 'subagentToolStart') {
        const id = msg.id as AgentId
        const parentToolId = msg.parentToolId as string
        const toolId = msg.toolId as string
        const status = msg.status as string
        setSubagentTools((prev) => {
          const agentSubs = prev[id] || {}
          const list = agentSubs[parentToolId] || []
          if (list.some((t) => t.toolId === toolId)) return prev
          return { ...prev, [id]: { ...agentSubs, [parentToolId]: [...list, { toolId, status, done: false }] } }
        })
        // Update sub-agent character's tool and active state
        const subId = os.getSubagentId(id, parentToolId)
        if (subId !== null) {
          const subToolName = extractToolName(status)
          os.setAgentTool(subId, subToolName)
          os.setAgentActive(subId, true)
        }
      } else if (msg.type === 'subagentToolDone') {
        const id = msg.id as AgentId
        const parentToolId = msg.parentToolId as string
        const toolId = msg.toolId as string
        setSubagentTools((prev) => {
          const agentSubs = prev[id]
          if (!agentSubs) return prev
          const list = agentSubs[parentToolId]
          if (!list) return prev
          return {
            ...prev,
            [id]: { ...agentSubs, [parentToolId]: list.map((t) => (t.toolId === toolId ? { ...t, done: true } : t)) },
          }
        })
      } else if (msg.type === 'subagentClear') {
        const id = msg.id as AgentId
        const parentToolId = msg.parentToolId as string
        setSubagentTools((prev) => {
          const agentSubs = prev[id]
          if (!agentSubs || !(parentToolId in agentSubs)) return prev
          const next = { ...agentSubs }
          delete next[parentToolId]
          if (Object.keys(next).length === 0) {
            const outer = { ...prev }
            delete outer[id]
            return outer
          }
          return { ...prev, [id]: next }
        })
        // Remove sub-agent character
        os.removeSubagent(id, parentToolId)
        setSubagentCharacters((prev) => prev.filter((s) => !(s.parentAgentId === id && s.parentToolId === parentToolId)))
      } else if (msg.type === 'characterSpritesLoaded') {
        const characters = msg.characters as Array<{ down: string[][][]; up: string[][][]; right: string[][][] }>
        console.log(`[Webview] Received ${characters.length} pre-colored character sprites`)
        setCharacterTemplates(characters as any)
      } else if (msg.type === 'floorTilesLoaded') {
        const sprites = msg.sprites as string[][][]
        console.log(`[Webview] Received ${sprites.length} floor tile patterns`)
        setFloorSprites(sprites as any)
      } else if (msg.type === 'wallTilesLoaded') {
        const sprites = msg.sprites as string[][][]
        console.log(`[Webview] Received ${sprites.length} wall tile sprites`)
        setWallSprites(sprites as any)
      } else if (msg.type === 'workspaceFolders') {
        const folders = msg.folders as WorkspaceFolder[]
        setWorkspaceFolders(folders)
      } else if (msg.type === 'settingsLoaded') {
        const soundOn = msg.soundEnabled as boolean
        const legacySpeechBubblesOn = typeof msg.speechBubblesEnabled === 'boolean' ? msg.speechBubblesEnabled : true
        const alwaysStatusBubblesOn = typeof msg.alwaysStatusBubblesEnabled === 'boolean'
          ? msg.alwaysStatusBubblesEnabled
          : legacySpeechBubblesOn
        const eventBubblesOn = typeof msg.eventBubblesEnabled === 'boolean'
          ? msg.eventBubblesEnabled
          : true
        const historyEnabled = typeof msg.historySessionsEnabled === 'boolean'
          ? msg.historySessionsEnabled
          : true
        setSoundEnabled(soundOn)
        setAlwaysStatusBubblesEnabled(alwaysStatusBubblesOn)
        setEventBubblesEnabled(eventBubblesOn)
        setHistorySessionsEnabled(historyEnabled)
        if (!historyEnabled) {
          syncHistoryCharacters(os, historySessionsRef.current, [])
          historySessionsRef.current = []
          setHistorySessions([])
        }
      } else if (msg.type === 'furnitureAssetsLoaded') {
        try {
          const catalog = msg.catalog as FurnitureAsset[]
          const sprites = msg.sprites as Record<string, string[][]>
          console.log(`📦 Webview: Loaded ${catalog.length} furniture assets`)
          // Build dynamic catalog immediately so getCatalogEntry() works when layoutLoaded arrives next
          buildDynamicCatalog({ catalog, sprites })
          setLoadedAssets({ catalog, sprites })
        } catch (err) {
          console.error(`❌ Webview: Error processing furnitureAssetsLoaded:`, err)
        }
      } else if (msg.type === 'agentTeamInfo') {
        const id = msg.id as AgentId;
        os.setTeamInfo(
          id,
          msg.teamName as string | undefined,
          msg.agentName as string | undefined,
          msg.isTeamLead as boolean | undefined,
          msg.leadAgentId as AgentId | undefined,
          msg.teamUsesTmux as boolean | undefined,
        );
      } else if (msg.type === 'agentTokenUsage') {
        const id = msg.id as AgentId;
        os.setAgentTokens(id, msg.inputTokens as number, msg.outputTokens as number);
      }
    }
    window.addEventListener('message', handler)
    vscode.postMessage({ type: 'webviewReady' })
    return () => window.removeEventListener('message', handler)
  }, [getOfficeState])

  return {
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
  }
}
