import {
  createSessionCoreState,
  setSessionAgentBinding,
  transitionSessionStage,
} from './sessionState.js';
import type {
  AgentCoreState,
  CoreEvent,
  CoreState,
  SessionCoreState,
} from './types.js';

function createDefaultAgent(id: number, at: number): AgentCoreState {
  return {
    id,
    status: 'idle',
    activeToolId: null,
    activeToolLabel: null,
    permissionWaiting: false,
    updatedAt: at,
  };
}

export function createInitialCoreState(now: number = Date.now()): CoreState {
  return {
    agents: {},
    sessions: {},
    layout: null,
    updatedAt: now,
  };
}

function requireSession(state: CoreState, sessionId: string): SessionCoreState {
  const session = state.sessions[sessionId];
  if (!session) {
    throw new Error(`Unknown session: ${sessionId}`);
  }
  return session;
}

export function reduceCoreState(state: CoreState, event: CoreEvent): CoreState {
  switch (event.type) {
    case 'agentAdded': {
      const existing = state.agents[event.id];
      const agent = existing
        ? { ...existing, updatedAt: event.at }
        : createDefaultAgent(event.id, event.at);
      return {
        ...state,
        agents: { ...state.agents, [event.id]: agent },
        updatedAt: event.at,
      };
    }
    case 'agentRemoved': {
      if (!(event.id in state.agents)) {
        return { ...state, updatedAt: event.at };
      }
      const nextAgents = { ...state.agents };
      delete nextAgents[event.id];
      return {
        ...state,
        agents: nextAgents,
        updatedAt: event.at,
      };
    }
    case 'agentStatusSet': {
      const current = state.agents[event.id] ?? createDefaultAgent(event.id, event.at);
      return {
        ...state,
        agents: {
          ...state.agents,
          [event.id]: {
            ...current,
            status: event.status,
            updatedAt: event.at,
          },
        },
        updatedAt: event.at,
      };
    }
    case 'agentToolSet': {
      const current = state.agents[event.id] ?? createDefaultAgent(event.id, event.at);
      return {
        ...state,
        agents: {
          ...state.agents,
          [event.id]: {
            ...current,
            activeToolId: event.toolId,
            activeToolLabel: event.label,
            updatedAt: event.at,
          },
        },
        updatedAt: event.at,
      };
    }
    case 'agentPermissionWaitingSet': {
      const current = state.agents[event.id] ?? createDefaultAgent(event.id, event.at);
      return {
        ...state,
        agents: {
          ...state.agents,
          [event.id]: {
            ...current,
            permissionWaiting: event.waiting,
            updatedAt: event.at,
          },
        },
        updatedAt: event.at,
      };
    }
    case 'layoutReplaced': {
      return {
        ...state,
        layout: event.layout,
        updatedAt: event.at,
      };
    }
    case 'sessionUpserted': {
      const current = state.sessions[event.session.sessionId];
      const nextSession = current
        ? { ...current, ...event.session, updatedAt: event.at }
        : createSessionCoreState({
            sessionId: event.session.sessionId,
            jsonlPath: event.session.jsonlPath,
            at: event.at,
            terminalId: event.session.terminalId,
            agentId: event.session.agentId,
          });

      return {
        ...state,
        sessions: {
          ...state.sessions,
          [nextSession.sessionId]: {
            ...nextSession,
            stage: event.session.stage,
          },
        },
        updatedAt: event.at,
      };
    }
    case 'sessionStageChanged': {
      const session = requireSession(state, event.sessionId);
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [event.sessionId]: transitionSessionStage(session, event.stage, event.at),
        },
        updatedAt: event.at,
      };
    }
    case 'sessionLinkedToAgent': {
      const session = requireSession(state, event.sessionId);
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [event.sessionId]: setSessionAgentBinding(session, event.agentId, event.at),
        },
        updatedAt: event.at,
      };
    }
    case 'sessionUnlinkedFromAgent': {
      const session = requireSession(state, event.sessionId);
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [event.sessionId]: setSessionAgentBinding(session, undefined, event.at),
        },
        updatedAt: event.at,
      };
    }
    default:
      return state;
  }
}

export class CoreStore {
  private state: CoreState;

  constructor(initialState: CoreState = createInitialCoreState()) {
    this.state = initialState;
  }

  dispatch(event: CoreEvent): void {
    this.state = reduceCoreState(this.state, event);
  }

  snapshot(): CoreState {
    return this.state;
  }
}
