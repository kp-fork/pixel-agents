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

export type WebviewToExtensionMessage =
	| { type: 'openClaude' }
	| { type: 'focusAgent'; id: number }
	| { type: 'closeAgent'; id: number }
	| { type: 'saveAgentSeats'; seats: Record<number, AgentSeatAssignment> }
	| { type: 'saveLayout'; layout: Record<string, unknown> }
	| { type: 'setSoundEnabled'; enabled: boolean }
	| { type: 'setSpeechBubblesEnabled'; enabled: boolean }
	| { type: 'setAlwaysStatusBubblesEnabled'; enabled: boolean }
	| { type: 'setEventBubblesEnabled'; enabled: boolean }
	| { type: 'webviewReady' }
	| { type: 'openSessionsFolder' }
	| { type: 'openExternal'; target: string }
	| { type: 'exportLayout' }
	| { type: 'importLayout' };

export type ExtensionToWebviewMessage =
	| { type: 'layoutLoaded'; layout: Record<string, unknown> | null }
	| { type: 'agentCreated'; id: number }
	| { type: 'agentClosed'; id: number }
	| { type: 'existingAgents'; agents: number[]; agentMeta?: Record<string, ExistingAgentMeta> }
	| { type: 'agentSelected'; id: number }
	| { type: 'agentToolStart'; id: number; toolId: string; status: string }
	| { type: 'agentToolDone'; id: number; toolId: string }
	| { type: 'agentToolsClear'; id: number }
	| { type: 'agentStatus'; id: number; status: AgentRuntimeStatus }
	| { type: 'agentToolPermission'; id: number }
	| { type: 'agentToolPermissionClear'; id: number }
	| { type: 'subagentToolStart'; id: number; parentToolId: string; toolId: string; status: string }
	| { type: 'subagentToolDone'; id: number; parentToolId: string; toolId: string }
	| { type: 'subagentClear'; id: number; parentToolId: string }
	| { type: 'subagentToolPermission'; id: number; parentToolId: string }
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
	}
	| { type: 'trackingEvent'; event: TrackingEvent };
