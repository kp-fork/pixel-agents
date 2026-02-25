import type {
  CoreStateForViewModel,
  OverlayViewModel,
  PixelAgentsViewModel,
  SessionStage,
  SessionSummaryViewModel,
} from './types.js';

const SESSION_STAGE_ORDER: SessionStage[] = [
  'discovered',
  'candidate',
  'bound',
  'tracking',
  'closed',
];

function toSessionSummary(state: CoreStateForViewModel): SessionSummaryViewModel[] {
  const counts: Record<SessionStage, number> = {
    discovered: 0,
    candidate: 0,
    bound: 0,
    tracking: 0,
    closed: 0,
  };

  for (const session of Object.values(state.sessions)) {
    counts[session.stage] += 1;
  }

  return SESSION_STAGE_ORDER.map((stage) => ({
    stage,
    count: counts[stage],
  }));
}

function toOverlays(state: CoreStateForViewModel): OverlayViewModel[] {
  const overlays: OverlayViewModel[] = [];

  for (const agent of Object.values(state.agents)) {
    if (agent.status === 'waiting') {
      overlays.push({
        id: `waiting-${agent.id}`,
        kind: 'waiting',
        agentId: agent.id,
        text: 'Waiting for input',
      });
    }
    if (agent.permissionWaiting) {
      overlays.push({
        id: `permission-${agent.id}`,
        kind: 'permission',
        agentId: agent.id,
        text: 'Permission required',
      });
    }
  }

  return overlays;
}

export function mapToViewModel(state: CoreStateForViewModel): PixelAgentsViewModel {
  const characters = Object.values(state.agents)
    .sort((a, b) => a.id - b.id)
    .map((agent) => ({
      id: agent.id,
      isActive: agent.status === 'active',
      status: agent.status,
      activeToolLabel: agent.activeToolLabel,
    }));

  const waitingAgentCount = characters.filter((agent) => agent.status === 'waiting').length;

  return {
    characters,
    overlays: toOverlays(state),
    toolbar: {
      trackedAgentCount: characters.length,
      waitingAgentCount,
      canOpenAgent: true,
    },
    sessionSummary: toSessionSummary(state),
  };
}
