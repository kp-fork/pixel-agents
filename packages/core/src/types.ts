export type SessionStage = 'discovered' | 'candidate' | 'bound' | 'tracking' | 'closed';

export type AgentActivityStatus = 'active' | 'waiting' | 'idle' | 'closed';

export interface SessionCoreState {
  sessionId: string;
  jsonlPath: string;
  stage: SessionStage;
  terminalId?: string;
  agentId?: number;
  discoveredAt: number;
  updatedAt: number;
}

export interface AgentCoreState {
  id: number;
  status: AgentActivityStatus;
  activeToolId: string | null;
  activeToolLabel: string | null;
  permissionWaiting: boolean;
  updatedAt: number;
}

export type OfficeLayoutState = Record<string, unknown>;

export interface CoreState {
  agents: Record<number, AgentCoreState>;
  sessions: Record<string, SessionCoreState>;
  layout: OfficeLayoutState | null;
  updatedAt: number;
}

export type CoreEvent =
  | { type: 'agentAdded'; id: number; at: number }
  | { type: 'agentRemoved'; id: number; at: number }
  | { type: 'agentStatusSet'; id: number; status: AgentActivityStatus; at: number }
  | { type: 'agentToolSet'; id: number; toolId: string | null; label: string | null; at: number }
  | { type: 'agentPermissionWaitingSet'; id: number; waiting: boolean; at: number }
  | { type: 'layoutReplaced'; layout: OfficeLayoutState | null; at: number }
  | { type: 'sessionUpserted'; session: SessionCoreState; at: number }
  | { type: 'sessionStageChanged'; sessionId: string; stage: SessionStage; at: number }
  | { type: 'sessionLinkedToAgent'; sessionId: string; agentId: number; at: number }
  | { type: 'sessionUnlinkedFromAgent'; sessionId: string; at: number };
