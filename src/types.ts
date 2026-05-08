import type * as vscode from 'vscode';

export type AgentId = string;

export interface AgentState {
	id: AgentId;
	sessionId: string;
	/** Terminal reference — undefined for extension panel sessions */
	terminalRef?: vscode.Terminal;
	/** Whether this agent was detected from an external source (VS Code extension panel, etc.) */
	isExternal: boolean;
	projectDir: string;
	jsonlFile: string;
	fileOffset: number;
	lineBuffer: string;
	activeToolIds: Set<string>;
	activeToolStatuses: Map<string, string>;
	activeToolNames: Map<string, string>;
	activeSubagentToolIds: Map<string, Set<string>>;
	activeSubagentToolNames: Map<string, Map<string, string>>;
	backgroundAgentToolIds: Set<string>;
	isWaiting: boolean;
	permissionSent: boolean;
	hadToolsInTurn: boolean;
	/** Workspace folder name (only set for multi-root workspaces) */
	folderName?: string;
	/** Timestamp of last JSONL data received (ms since epoch) */
	lastDataAt: number;
	/** Total JSONL lines processed for this agent */
	linesProcessed: number;
	/** Set of record.type values we've already warned about (prevents log spam) */
	seenUnknownRecordTypes: Set<string>;
	/** Whether a hook event has been delivered for this agent (suppresses heuristic timers) */
	hookDelivered: boolean;
	/** True when agent has no transcript file (provider doesn't use JSONL). All state from hooks. */
	hooksOnly?: boolean;
	/** Provider that created this agent (defaults to 'claude') */
	providerId?: string;
	/** Set when SessionEnd(reason=clear) fires; cleared when SessionStart(source=clear) reassigns */
	pendingClear?: boolean;
	/** Hook-generated tool ID for PreToolUse/PostToolUse correlation */
	currentHookToolId?: string;
	/** Tool name from PreToolUse for SubagentStart correlation */
	currentHookToolName?: string;
	/** True when the current PreToolUse tool call is a teammate spawn. */
	currentHookIsTeammateSpawn?: boolean;
	inputTokens: number;
	outputTokens: number;
	teamName?: string;
	agentName?: string;
	isTeamLead?: boolean;
	leadAgentId?: AgentId;
	/** True when lead spawns teammates via tmux (run_in_background Agent calls) */
	teamUsesTmux?: boolean;
}

export interface PersistedAgent {
	id: AgentId;
	sessionId?: string;
	/** Terminal name — empty string for extension panel sessions */
	terminalName: string;
	/** Whether this agent was detected from an external source */
	isExternal?: boolean;
	jsonlFile: string;
	projectDir: string;
	/** Workspace folder name (only set for multi-root workspaces) */
	folderName?: string;
	teamName?: string;
	agentName?: string;
	isTeamLead?: boolean;
	leadAgentId?: AgentId;
	teamUsesTmux?: boolean;
}
