import type { SessionCoreState, SessionStage } from './types.js';

const ALLOWED_STAGE_TRANSITIONS: Record<SessionStage, readonly SessionStage[]> = {
  discovered: ['candidate', 'closed'],
  candidate: ['bound', 'closed'],
  bound: ['tracking', 'closed'],
  tracking: ['closed'],
  closed: [],
};

export function canTransitionSessionStage(from: SessionStage, to: SessionStage): boolean {
  if (from === to) {
    return true;
  }
  return ALLOWED_STAGE_TRANSITIONS[from].includes(to);
}

export function createSessionCoreState(input: {
  sessionId: string;
  jsonlPath: string;
  at: number;
  terminalId?: string;
  agentId?: number;
}): SessionCoreState {
  return {
    sessionId: input.sessionId,
    jsonlPath: input.jsonlPath,
    stage: 'discovered',
    terminalId: input.terminalId,
    agentId: input.agentId,
    discoveredAt: input.at,
    updatedAt: input.at,
  };
}

export function transitionSessionStage(
  session: SessionCoreState,
  to: SessionStage,
  at: number,
): SessionCoreState {
  if (!canTransitionSessionStage(session.stage, to)) {
    throw new Error(
      `Invalid session transition: ${session.sessionId} ${session.stage} -> ${to}`,
    );
  }

  return {
    ...session,
    stage: to,
    updatedAt: at,
  };
}

export function setSessionAgentBinding(
  session: SessionCoreState,
  agentId: number | undefined,
  at: number,
): SessionCoreState {
  return {
    ...session,
    agentId,
    updatedAt: at,
  };
}
