import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import type { AgentId, AgentState, PersistedAgent } from './types.js';
import { cancelWaitingTimer, cancelPermissionTimer } from './timerManager.js';
import { startFileWatching, readNewLines, ensureProjectScan } from './fileWatcher.js';
import { JSONL_POLL_INTERVAL_MS, TERMINAL_NAME_PREFIX, WORKSPACE_KEY_AGENTS, WORKSPACE_KEY_AGENT_SEATS } from './constants.js';
import { migrateAndLoadLayout } from './layoutPersistence.js';
import { postToWebview } from './contracts/postMessage.js';
import { formatToolStatus } from './transcriptParser.js';

function normalizeWorkspacePath(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length <= 1) return trimmed;
	return trimmed.replace(/[\\/]+$/, '');
}

function currentDirNameForWorkspace(value: string): string {
	return value.replace(/[^A-Za-z0-9]/g, '-');
}

function legacyDirNameForWorkspace(value: string): string {
	return value.replace(/[:\\/]/g, '-');
}

function hydrateAgentStateFromJsonl(agent: AgentState): void {
	if (!fs.existsSync(agent.jsonlFile)) return;
	try {
		agent.activeToolIds.clear();
		agent.activeToolStatuses.clear();
		agent.activeToolNames.clear();
		agent.activeSubagentToolIds.clear();
		agent.activeSubagentToolNames.clear();
		agent.isWaiting = false;
		agent.permissionSent = false;
		agent.hadToolsInTurn = false;

		const content = fs.readFileSync(agent.jsonlFile, 'utf-8');
		for (const line of content.split('\n')) {
			if (!line.trim()) continue;
			let record: Record<string, unknown>;
			try {
				record = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}

			if (record.type === 'assistant' && Array.isArray((record.message as Record<string, unknown> | undefined)?.content)) {
				const blocks = ((record.message as Record<string, unknown>).content || []) as Array<{
					type: string; id?: string; name?: string; input?: Record<string, unknown>;
				}>;
				let hasToolUse = false;
				for (const block of blocks) {
					if (block.type !== 'tool_use' || !block.id) continue;
					hasToolUse = true;
					const toolName = block.name || '';
					const status = formatToolStatus(toolName, block.input || {});
					agent.activeToolIds.add(block.id);
					agent.activeToolStatuses.set(block.id, status);
					agent.activeToolNames.set(block.id, toolName);
				}
				if (hasToolUse) {
					agent.isWaiting = false;
					agent.hadToolsInTurn = true;
				}
				continue;
			}

			if (record.type === 'user') {
				const message = record.message as Record<string, unknown> | undefined;
				const userContent = message?.content;
				if (Array.isArray(userContent)) {
					for (const block of userContent as Array<{ type?: string; tool_use_id?: string }>) {
						if (block.type !== 'tool_result' || !block.tool_use_id) continue;
						const completedToolId = block.tool_use_id;
						agent.activeToolIds.delete(completedToolId);
						agent.activeToolStatuses.delete(completedToolId);
						agent.activeToolNames.delete(completedToolId);
					}
					if (agent.activeToolIds.size === 0) {
						agent.hadToolsInTurn = false;
					}
				}
				continue;
			}

			if (record.type === 'system' && record.subtype === 'turn_duration') {
				agent.activeToolIds.clear();
				agent.activeToolStatuses.clear();
				agent.activeToolNames.clear();
				agent.activeSubagentToolIds.clear();
				agent.activeSubagentToolNames.clear();
				agent.isWaiting = true;
				agent.permissionSent = false;
				agent.hadToolsInTurn = false;
			}
		}
	} catch (e) {
		console.log(`[Pixel Agents] Failed to hydrate state from JSONL for agent ${agent.id}: ${e}`);
	}
}

export function getProjectDirPath(cwd?: string): string | null {
	const workspacePath = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspacePath) return null;

	const normalizedPath = normalizeWorkspacePath(workspacePath);

	// Claude has used multiple path sanitization formats across versions and path representations.
	const projectsRoot = path.join(os.homedir(), '.claude', 'projects');

	const candidates = new Set<string>([
		path.join(projectsRoot, currentDirNameForWorkspace(normalizedPath)),
		path.join(projectsRoot, legacyDirNameForWorkspace(normalizedPath)),
	]);

	try {
		const real = fs.realpathSync(nativePath(normalizedPath));
		const normalizedReal = normalizeWorkspacePath(real);
		candidates.add(path.join(projectsRoot, currentDirNameForWorkspace(normalizedReal)));
		candidates.add(path.join(projectsRoot, legacyDirNameForWorkspace(normalizedReal)));
	} catch {
		// Ignore realpath failures (path may not exist yet).
	}

	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}

	// Default to current format for new sessions.
	return path.join(projectsRoot, currentDirNameForWorkspace(normalizedPath));
}

function nativePath(value: string): string {
	return process.platform === 'win32' ? value.replace(/\//g, '\\') : value;
}

function sessionIdFromTerminalName(terminalName: string): string | null {
	const match = terminalName.match(/\(([0-9a-fA-F-]{36})\)$/);
	return match ? match[1] : null;
}

function buildClaudeLaunchCommand(): string {
	return buildClaudeCommand('claudeLaunchCommand', 'claude');
}

function buildClaudeResumeCommand(sessionId: string): string {
	return buildClaudeCommand('claudeResumeCommand', 'claude --resume {sessionId}', '--resume', sessionId);
}

function buildClaudeCommand(
	configKey: string,
	defaultTemplate: string,
	appendFlag?: string,
	sessionId?: string,
): string {
	const config = vscode.workspace.getConfiguration('pixel-agents');
	const template = (config.get<string>(configKey, defaultTemplate) || '').trim();
	const safeTemplate = template || defaultTemplate;
	const resolved = safeTemplate
		.replace(/\{sessionId\}/g, sessionId || '')
		.replace(/\$\{sessionId\}/g, sessionId || '')
		.replace(/\$SESSION_ID/g, sessionId || '')
		.replace(/%SESSION_ID%/g, sessionId || '');
	if (resolved !== safeTemplate) {
		return resolved.trim().replace(/\s+/g, ' ');
	}
	if (appendFlag && sessionId) {
		return `${safeTemplate} ${appendFlag} ${sessionId}`;
	}
	return safeTemplate;
}

export function launchNewTerminal(
	nextTerminalIndexRef: { current: number },
	agents: Map<AgentId, AgentState>,
	activeAgentIdRef: { current: AgentId | null },
	knownJsonlFiles: Set<string>,
	fileWatchers: Map<AgentId, fs.FSWatcher>,
	pollingTimers: Map<AgentId, ReturnType<typeof setInterval>>,
	waitingTimers: Map<AgentId, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<AgentId, ReturnType<typeof setTimeout>>,
	jsonlPollTimers: Map<AgentId, ReturnType<typeof setInterval>>,
	projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
): void {
	const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const projectDir = getProjectDirPath(cwd);
	if (!projectDir) {
		console.log('[Pixel Agents] No project dir, waiting for workspace scan');
		return;
	}

	// Start project scan BEFORE launching Claude so new session jsonl won't be seeded as "known".
	ensureProjectScan(
		projectDir, knownJsonlFiles, projectScanTimerRef, activeAgentIdRef,
		agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers,
		webview, persistAgents,
	);

	const idx = nextTerminalIndexRef.current++;
	const terminal = vscode.window.createTerminal({
		name: `${TERMINAL_NAME_PREFIX} #${idx}`,
		cwd,
	});
	terminal.show();
	terminal.sendText(buildClaudeLaunchCommand());
}

export function launchTerminalForSession(
	sessionId: string,
	nextTerminalIndexRef: { current: number },
	agents: Map<AgentId, AgentState>,
	activeAgentIdRef: { current: AgentId | null },
	knownJsonlFiles: Set<string>,
	fileWatchers: Map<AgentId, fs.FSWatcher>,
	pollingTimers: Map<AgentId, ReturnType<typeof setInterval>>,
	waitingTimers: Map<AgentId, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<AgentId, ReturnType<typeof setTimeout>>,
	jsonlPollTimers: Map<AgentId, ReturnType<typeof setInterval>>,
	projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
	options?: {
		resumeSession?: boolean;
		terminal?: vscode.Terminal;
		sendCommand?: boolean;
	},
): AgentId | null {
	const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const id: AgentId = sessionId;
	if (agents.has(id)) {
		activeAgentIdRef.current = id;
		postToWebview(webview, { type: 'agentSelected', id });
		return id;
	}
	const terminal = options?.terminal ?? (() => {
		const idx = nextTerminalIndexRef.current++;
		return vscode.window.createTerminal({
			name: `${TERMINAL_NAME_PREFIX} #${idx} (${sessionId})`,
			cwd,
		});
	})();
	terminal.show();

	if (options?.sendCommand !== false) {
		terminal.sendText(options?.resumeSession ? buildClaudeResumeCommand(sessionId) : buildClaudeLaunchCommand());
	}

	const projectDir = getProjectDirPath(cwd);
	if (!projectDir) {
		console.log(`[Pixel Agents] No project dir, cannot track agent`);
		return null;
	}

	// Pre-register expected JSONL file so project scan won't treat it as a /clear file
	const expectedFile = path.join(projectDir, `${sessionId}.jsonl`);
	knownJsonlFiles.add(expectedFile);

	// Create agent immediately (before JSONL file exists)
	const agent: AgentState = {
		id,
		terminalRef: terminal,
		projectDir,
		jsonlFile: expectedFile,
		fileOffset: 0,
		lineBuffer: '',
		activeToolIds: new Set(),
		activeToolStatuses: new Map(),
		activeToolNames: new Map(),
		activeSubagentToolIds: new Map(),
		activeSubagentToolNames: new Map(),
		isWaiting: false,
		permissionSent: false,
		hadToolsInTurn: false,
	};

	agents.set(id, agent);
	activeAgentIdRef.current = id;
	persistAgents();
	console.log(`[Pixel Agents] Agent ${id}: created for terminal ${terminal.name}`);
	postToWebview(webview, { type: 'agentCreated', id });

	ensureProjectScan(
		projectDir, knownJsonlFiles, projectScanTimerRef, activeAgentIdRef,
		agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers,
		webview, persistAgents,
	);

	if (fs.existsSync(agent.jsonlFile)) {
		startFileWatching(id, agent.jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
		readNewLines(id, agents, waitingTimers, permissionTimers, webview);
		return id;
	}

	// Poll for the specific JSONL file to appear
	const pollTimer = setInterval(() => {
		try {
			if (fs.existsSync(agent.jsonlFile)) {
				console.log(`[Pixel Agents] Agent ${id}: found JSONL file ${path.basename(agent.jsonlFile)}`);
				clearInterval(pollTimer);
				jsonlPollTimers.delete(id);
				startFileWatching(id, agent.jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
				readNewLines(id, agents, waitingTimers, permissionTimers, webview);
			}
		} catch { /* file may not exist yet */ }
	}, JSONL_POLL_INTERVAL_MS);
	jsonlPollTimers.set(id, pollTimer);
	return id;
}

export function removeAgent(
	agentId: AgentId,
	agents: Map<AgentId, AgentState>,
	fileWatchers: Map<AgentId, fs.FSWatcher>,
	pollingTimers: Map<AgentId, ReturnType<typeof setInterval>>,
	waitingTimers: Map<AgentId, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<AgentId, ReturnType<typeof setTimeout>>,
	jsonlPollTimers: Map<AgentId, ReturnType<typeof setInterval>>,
	persistAgents: () => void,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;

	// Stop JSONL poll timer
	const jpTimer = jsonlPollTimers.get(agentId);
	if (jpTimer) { clearInterval(jpTimer); }
	jsonlPollTimers.delete(agentId);

	// Stop file watching
	fileWatchers.get(agentId)?.close();
	fileWatchers.delete(agentId);
	const pt = pollingTimers.get(agentId);
	if (pt) { clearInterval(pt); }
	pollingTimers.delete(agentId);

	// Cancel timers
	cancelWaitingTimer(agentId, waitingTimers);
	cancelPermissionTimer(agentId, permissionTimers);

	// Remove from maps
	agents.delete(agentId);
	persistAgents();
}

export function persistAgents(
	agents: Map<AgentId, AgentState>,
	context: vscode.ExtensionContext,
): void {
	const persisted: PersistedAgent[] = [];
	for (const agent of agents.values()) {
		persisted.push({
			id: agent.id,
			terminalName: agent.terminalRef.name,
			jsonlFile: agent.jsonlFile,
			projectDir: agent.projectDir,
		});
	}
	context.workspaceState.update(WORKSPACE_KEY_AGENTS, persisted);
}

export function restoreAgents(
	context: vscode.ExtensionContext,
	nextTerminalIndexRef: { current: number },
	agents: Map<AgentId, AgentState>,
	knownJsonlFiles: Set<string>,
	fileWatchers: Map<AgentId, fs.FSWatcher>,
	pollingTimers: Map<AgentId, ReturnType<typeof setInterval>>,
	waitingTimers: Map<AgentId, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<AgentId, ReturnType<typeof setTimeout>>,
	jsonlPollTimers: Map<AgentId, ReturnType<typeof setInterval>>,
	projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
	activeAgentIdRef: { current: AgentId | null },
	webview: vscode.Webview | undefined,
	doPersist: () => void,
): void {
	const persisted = context.workspaceState.get<PersistedAgent[]>(WORKSPACE_KEY_AGENTS, []);
	if (persisted.length === 0) return;
	const workspaceProjectDir = getProjectDirPath();

	const liveTerminals = vscode.window.terminals;
	let maxIdx = 0;
	let restoredProjectDir: string | null = null;

	for (const p of persisted) {
		const terminal = liveTerminals.find(t => t.name === p.terminalName);
		if (!terminal) continue;
		let projectDir = p.projectDir;
		if ((!projectDir || !fs.existsSync(projectDir)) && workspaceProjectDir) {
			projectDir = workspaceProjectDir;
		}

		let jsonlFile = p.jsonlFile;
		const sessionId = sessionIdFromTerminalName(p.terminalName);
		if (sessionId && projectDir) {
			const bySessionId = path.join(projectDir, `${sessionId}.jsonl`);
			// Prefer deterministic mapping from terminal -> session file when available.
			if (fs.existsSync(bySessionId) || !fs.existsSync(jsonlFile)) {
				jsonlFile = bySessionId;
			}
		}
		if (!fs.existsSync(jsonlFile) && projectDir) {
			const migrated = path.join(projectDir, path.basename(jsonlFile));
			if (fs.existsSync(migrated)) {
				console.log(`[Pixel Agents] Restored agent ${p.id}: migrated JSONL path -> ${migrated}`);
				jsonlFile = migrated;
			}
		}

		const restoredId = typeof p.id === 'string' && p.id.length > 0
			? p.id
			: (sessionIdFromTerminalName(p.terminalName) || path.basename(jsonlFile, '.jsonl'));
		const agent: AgentState = {
			id: restoredId,
			terminalRef: terminal,
			projectDir,
			jsonlFile,
			fileOffset: 0,
			lineBuffer: '',
			activeToolIds: new Set(),
			activeToolStatuses: new Map(),
			activeToolNames: new Map(),
			activeSubagentToolIds: new Map(),
			activeSubagentToolNames: new Map(),
			isWaiting: false,
			permissionSent: false,
			hadToolsInTurn: false,
		};

		agents.set(restoredId, agent);
		knownJsonlFiles.add(jsonlFile);
		console.log(`[Pixel Agents] Restored agent ${restoredId} → terminal "${p.terminalName}"`);
		// Extract terminal index from name like "Claude Code #3" or "Claude Code #3 (<session-id>)"
		const match = p.terminalName.match(/#(\d+)/);
		if (match) {
			const idx = parseInt(match[1], 10);
			if (idx > maxIdx) maxIdx = idx;
		}

		restoredProjectDir = projectDir;

		// Start file watching if JSONL exists, skipping to end of file
		try {
			if (fs.existsSync(jsonlFile)) {
				hydrateAgentStateFromJsonl(agent);
				const stat = fs.statSync(jsonlFile);
				agent.fileOffset = stat.size;
				startFileWatching(restoredId, jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
			} else {
				// Poll for the file to appear
				const pollTimer = setInterval(() => {
					try {
						if (fs.existsSync(agent.jsonlFile)) {
							console.log(`[Pixel Agents] Restored agent ${restoredId}: found JSONL file`);
							clearInterval(pollTimer);
							jsonlPollTimers.delete(restoredId);
							const stat = fs.statSync(agent.jsonlFile);
							agent.fileOffset = stat.size;
							startFileWatching(restoredId, agent.jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
						}
					} catch { /* file may not exist yet */ }
				}, JSONL_POLL_INTERVAL_MS);
				jsonlPollTimers.set(restoredId, pollTimer);
			}
		} catch { /* ignore errors during restore */ }
	}

	if (maxIdx >= nextTerminalIndexRef.current) {
		nextTerminalIndexRef.current = maxIdx + 1;
	}

	// Re-persist cleaned-up list (removes entries whose terminals are gone)
	doPersist();

	// Seed active agent after restore so /clear reassignment has a target.
	if (activeAgentIdRef.current === null) {
		const activeTerminal = vscode.window.activeTerminal;
		if (activeTerminal) {
			for (const [agentId, agent] of agents) {
				if (agent.terminalRef === activeTerminal) {
					activeAgentIdRef.current = agentId;
					break;
				}
			}
		}
		if (activeAgentIdRef.current === null && agents.size === 1) {
			activeAgentIdRef.current = Array.from(agents.keys())[0] ?? null;
		}
	}

	// Start project scan for /clear detection
	if (restoredProjectDir && fs.existsSync(restoredProjectDir) && !projectScanTimerRef.current) {
		ensureProjectScan(
			restoredProjectDir, knownJsonlFiles, projectScanTimerRef, activeAgentIdRef,
			agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers,
			webview, doPersist,
		);
	}
}

export function sendExistingAgents(
	agents: Map<AgentId, AgentState>,
	context: vscode.ExtensionContext,
	webview: vscode.Webview | undefined,
): void {
	if (!webview) return;
	const agentIds: AgentId[] = [];
	for (const id of agents.keys()) {
		agentIds.push(id);
	}
	agentIds.sort((a, b) => a.localeCompare(b));

	// Include persisted palette/seatId from separate key
	const agentMeta = context.workspaceState.get<Record<string, { palette?: number; hueShift?: number; seatId?: string | null }>>(WORKSPACE_KEY_AGENT_SEATS, {});
	console.log(`[Pixel Agents] sendExistingAgents: agents=${JSON.stringify(agentIds)}, meta=${JSON.stringify(agentMeta)}`);

	postToWebview(webview, {
		type: 'existingAgents',
		agents: agentIds,
		agentMeta,
	});

	sendCurrentAgentStatuses(agents, webview);
}

export function sendCurrentAgentStatuses(
	agents: Map<AgentId, AgentState>,
	webview: vscode.Webview | undefined,
): void {
	if (!webview) return;
	for (const [agentId, agent] of agents) {
		// Re-send active tools
		for (const [toolId, status] of agent.activeToolStatuses) {
			postToWebview(webview, {
				type: 'agentToolStart',
				id: agentId,
				toolId,
				status,
			});
		}
		// Re-send waiting status
		if (agent.isWaiting) {
			postToWebview(webview, {
				type: 'agentStatus',
				id: agentId,
				status: 'waiting',
			});
		}
	}
}

export function sendLayout(
	context: vscode.ExtensionContext,
	webview: vscode.Webview | undefined,
	defaultLayout?: Record<string, unknown> | null,
): void {
	if (!webview) return;
	const layout = migrateAndLoadLayout(context, defaultLayout);
	postToWebview(webview, {
		type: 'layoutLoaded',
		layout,
	});
}
