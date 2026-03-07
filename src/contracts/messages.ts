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
	title: string;
	summary: string;
}

export type WebviewToExtensionMessage =
	| { type: 'openClaude'; folderPath?: string; traceId?: string }
	| { type: 'focusAgent'; id: string }
	| { type: 'closeAgent'; id: string }
	| { type: 'terminalCreate'; cols?: number; rows?: number; cwd?: string; instanceId?: string; traceId?: string }
	| { type: 'terminalInput'; data: string; instanceId?: string; traceId?: string }
	| { type: 'terminalResize'; cols: number; rows: number; instanceId?: string; traceId?: string }
	| { type: 'terminalClose'; instanceId?: string; traceId?: string }
	| { type: 'terminalTraceAck'; traceId: string; markerSeen: boolean }
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
	| { type: 'agentCreated'; id: string; folderName?: string }
	| { type: 'agentClosed'; id: string }
	| { type: 'existingAgents'; agents: string[]; agentMeta?: Record<string, ExistingAgentMeta>; folderNames?: Record<string, string> }
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
	| { type: 'workspaceFolders'; folders: Array<{ name: string; path: string }> }
	| { type: 'furnitureAssetsLoaded'; catalog: FurnitureCatalogAsset[]; sprites: Record<string, string[][]> }
	| {
		type: 'settingsLoaded';
		soundEnabled: boolean;
			speechBubblesEnabled?: boolean;
			alwaysStatusBubblesEnabled?: boolean;
			eventBubblesEnabled?: boolean;
			historySessionsEnabled?: boolean;
		}
	| { type: 'terminalReady'; cols: number; rows: number; cwd: string; shell: string; instanceId?: string; traceId?: string }
	| { type: 'terminalData'; data: string; instanceId?: string; traceId?: string }
	| { type: 'terminalExit'; exitCode: number; signal?: number; instanceId?: string; traceId?: string }
	| { type: 'traceSmokeStart'; traceId: string; contractProbe?: boolean }
	| { type: 'trackingEvent'; event: TrackingEvent };
