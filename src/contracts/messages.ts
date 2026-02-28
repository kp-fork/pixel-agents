import type { TrackingEvent } from './session.js';

export type AgentRuntimeStatus = 'active' | 'waiting';

export interface AgentSeatAssignment {
	palette: number;
	hueShift: number;
	seatId: string | null;
}

export interface ExistingAgentMeta {
	palette?: number;
	hueShift?: number;
	seatId?: string | null;
}

export interface CharacterDirectionSprites {
	down: string[][][];
	up: string[][][];
	right: string[][][];
}

export interface FurnitureCatalogAsset {
	id: string;
	name: string;
	label: string;
	category: string;
	file: string;
	width: number;
	height: number;
	footprintW: number;
	footprintH: number;
	isDesk: boolean;
	canPlaceOnWalls: boolean;
	partOfGroup?: boolean;
	groupId?: string;
	canPlaceOnSurfaces?: boolean;
	backgroundTiles?: number;
	orientation?: string;
	state?: string;
}

export interface HistorySessionSummary {
	id: string;
	sessionId: string;
	jsonlPath: string;
	createdAt: string;
	lastActivityAt: string;
	preview: string;
}

export type WebviewToExtensionMessage =
	| { type: 'openClaude' }
	| { type: 'focusAgent'; id: string }
	| { type: 'closeAgent'; id: string }
	| { type: 'saveAgentSeats'; seats: Record<string, AgentSeatAssignment> }
	| { type: 'saveLayout'; layout: Record<string, unknown> }
	| { type: 'setSoundEnabled'; enabled: boolean }
	| { type: 'setSpeechBubblesEnabled'; enabled: boolean }
	| { type: 'setAlwaysStatusBubblesEnabled'; enabled: boolean }
	| { type: 'setEventBubblesEnabled'; enabled: boolean }
	| { type: 'setHistorySessionsEnabled'; enabled: boolean }
	| { type: 'webviewReady' }
	| { type: 'openSessionsFolder' }
	| { type: 'openHistorySession'; historyId: string; sessionId: string; jsonlPath: string }
	| { type: 'openExternal'; target: string }
	| { type: 'exportLayout' }
	| { type: 'exportPack' }
	| { type: 'importPack' }
	| { type: 'importLayout' };

export type ExtensionToWebviewMessage =
	| { type: 'layoutLoaded'; layout: Record<string, unknown> | null }
	| { type: 'agentCreated'; id: string }
	| { type: 'agentClosed'; id: string }
	| { type: 'existingAgents'; agents: string[]; agentMeta?: Record<string, ExistingAgentMeta> }
	| { type: 'historySessionsLoaded'; sessions: HistorySessionSummary[] }
	| { type: 'agentSelected'; id: string }
	| { type: 'agentToolStart'; id: string; toolId: string; status: string }
	| { type: 'agentToolDone'; id: string; toolId: string }
	| { type: 'agentToolsClear'; id: string }
	| { type: 'agentStatus'; id: string; status: AgentRuntimeStatus }
	| { type: 'agentToolPermission'; id: string }
	| { type: 'agentToolPermissionClear'; id: string }
	| { type: 'subagentToolStart'; id: string; parentToolId: string; toolId: string; status: string }
	| { type: 'subagentToolDone'; id: string; parentToolId: string; toolId: string }
	| { type: 'subagentClear'; id: string; parentToolId: string }
	| { type: 'subagentToolPermission'; id: string; parentToolId: string }
	| { type: 'characterSpritesLoaded'; characters: CharacterDirectionSprites[] }
	| { type: 'floorTilesLoaded'; sprites: string[][][] }
	| { type: 'wallTilesLoaded'; sprites: string[][][] }
	| { type: 'furnitureAssetsLoaded'; catalog: FurnitureCatalogAsset[]; sprites: Record<string, string[][]> }
	| {
		type: 'settingsLoaded';
		soundEnabled: boolean;
			speechBubblesEnabled?: boolean;
			alwaysStatusBubblesEnabled?: boolean;
			eventBubblesEnabled?: boolean;
			historySessionsEnabled?: boolean;
		}
	| { type: 'trackingEvent'; event: TrackingEvent };
