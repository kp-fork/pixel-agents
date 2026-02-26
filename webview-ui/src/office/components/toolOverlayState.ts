import type { ToolActivity } from '../types.js'

type BubbleType = 'permission' | 'waiting' | null

export interface OverlayStateInput {
  isSubagent: boolean
  isActive: boolean
  bubbleType: BubbleType
  tools?: ToolActivity[]
  subToolGroups?: Record<string, ToolActivity[]>
  subLabel?: string
}

export interface OverlayState {
  activityText: string
  hasPermission: boolean
  hasActiveTools: boolean
}

function findLatestActiveTool(tools: ToolActivity[] | undefined): ToolActivity | undefined {
  if (!tools || tools.length === 0) return undefined
  return [...tools].reverse().find((tool) => !tool.done)
}

function countToolStats(toolGroups: Array<ToolActivity[] | undefined>): { total: number; done: number; active: number; hasPermission: boolean } {
  let total = 0
  let done = 0
  let active = 0
  let hasPermission = false
  for (const group of toolGroups) {
    if (!group) continue
    for (const tool of group) {
      total += 1
      if (tool.done) {
        done += 1
      } else {
        active += 1
        if (tool.permissionWait) hasPermission = true
      }
    }
  }
  return { total, done, active, hasPermission }
}

export function deriveOverlayState(input: OverlayStateInput): OverlayState {
  if (input.isSubagent) {
    const hasPermission = input.bubbleType === 'permission'
    return {
      activityText: hasPermission ? 'Needs approval' : (input.subLabel || 'Subtask'),
      hasPermission,
      hasActiveTools: input.isActive,
    }
  }

  const ownStats = countToolStats([input.tools])
  const subLists = input.subToolGroups ? Object.values(input.subToolGroups) : []
  const subStats = countToolStats(subLists)
  const hasPermission = ownStats.hasPermission || subStats.hasPermission
  const hasActiveTools = ownStats.active > 0 || subStats.active > 0

  if (hasPermission) {
    return { activityText: 'Needs approval', hasPermission, hasActiveTools }
  }

  if (subStats.total > 0) {
    if (subStats.active > 0) {
      return {
        activityText: `Coordinating ${subStats.done}/${subStats.total}`,
        hasPermission,
        hasActiveTools,
      }
    }
    return {
      activityText: input.isActive || ownStats.active > 0 ? 'Finalizing subtasks' : 'Subtasks complete',
      hasPermission,
      hasActiveTools,
    }
  }

  const activeTool = findLatestActiveTool(input.tools)
  if (activeTool) {
    return {
      activityText: activeTool.permissionWait ? 'Needs approval' : activeTool.status,
      hasPermission,
      hasActiveTools,
    }
  }

  if (input.isActive) {
    return { activityText: 'Working', hasPermission, hasActiveTools: true }
  }

  return { activityText: 'Idle', hasPermission, hasActiveTools }
}
