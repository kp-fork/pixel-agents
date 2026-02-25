export type SessionStage = 'discovered' | 'candidate' | 'bound' | 'tracking' | 'closed';

export type AgentActivityStatus = 'active' | 'waiting' | 'idle' | 'closed';

export interface AgentStateForViewModel {
  id: number;
  status: AgentActivityStatus;
  activeToolLabel: string | null;
  permissionWaiting: boolean;
}

export interface SessionStateForViewModel {
  stage: SessionStage;
}

export interface CoreStateForViewModel {
  agents: Record<number, AgentStateForViewModel>;
  sessions: Record<string, SessionStateForViewModel>;
}

export interface CharacterViewModel {
  id: number;
  isActive: boolean;
  status: AgentActivityStatus;
  activeToolLabel: string | null;
}

export interface OverlayViewModel {
  id: string;
  kind: 'waiting' | 'permission';
  agentId: number;
  text: string;
}

export interface ToolbarViewModel {
  trackedAgentCount: number;
  waitingAgentCount: number;
  canOpenAgent: boolean;
}

export interface SessionSummaryViewModel {
  stage: SessionStage;
  count: number;
}

export interface PixelAgentsViewModel {
  characters: CharacterViewModel[];
  overlays: OverlayViewModel[];
  toolbar: ToolbarViewModel;
  sessionSummary: SessionSummaryViewModel[];
}
