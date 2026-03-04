import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BrowserWindow } from 'electrobun';
import { canResumeHistorySession, collectHistorySessions } from '../../../../src/historySessions.js';
import {
	HISTORY_SESSIONS_ENABLED_DEFAULT,
	HISTORY_SESSIONS_LOOKBACK_DAYS_DEFAULT,
	HISTORY_SESSIONS_MAX_VISIBLE_DEFAULT,
} from '../../../../src/constants.js';
import type {
	AgentRuntimeStatus,
	ExistingAgentMeta,
	ExtensionToWebviewMessage,
	HistorySessionSummary,
	WebviewToExtensionMessage,
} from '../../../../src/contracts/messages.js';

const LIVE_SESSION_LOOKBACK_HOURS = 12;
const LIVE_SESSION_MAX_VISIBLE = 8;
const REFRESH_INTERVAL_MS = 4000;
const ACTIVE_RECENT_THRESHOLD_MS = 30 * 1000;
const BASH_COMMAND_DISPLAY_MAX_LENGTH = 30;
const TASK_DESCRIPTION_DISPLAY_MAX_LENGTH = 40;

interface DesktopAgent {
	id: string;
	sessionId: string;
	jsonlPath: string;
	folderName: string;
	status: AgentRuntimeStatus;
	toolStatus: string | null;
	lastActivityAtMs: number;
	palette: number;
	hueShift: number;
	seatId: string | null;
}

interface DesktopSettingsState {
	soundEnabled: boolean;
	alwaysStatusBubblesEnabled: boolean;
	eventBubblesEnabled: boolean;
	historySessionsEnabled: boolean;
}

interface SessionRuntimeSnapshot {
	status: AgentRuntimeStatus;
	toolStatus: string | null;
	lastActivityAtMs: number;
}

interface DesktopHostState {
	workspaceRoot: string | null;
	projectDir: string | null;
	workspaceFolderName: string;
	settingsFilePath: string | null;
	agents: Map<string, DesktopAgent>;
	historySessions: HistorySessionSummary[];
	settings: DesktopSettingsState;
	historyLookbackDays: number;
	historyMaxVisible: number;
	selectedAgentId: string | null;
	hiddenSessionIds: Set<string>;
	forcedLiveSessionIds: Set<string>;
	refreshTimer: ReturnType<typeof setInterval> | null;
	didInitialize: boolean;
}

function postToWebview(window: BrowserWindow, message: ExtensionToWebviewMessage): void {
	const payload = JSON.stringify(message);
	window.webview.executeJavascript(`window.dispatchEvent(new MessageEvent('message', { data: ${payload} }));`);
}

function parseHostMessage(event: unknown): WebviewToExtensionMessage | null {
	const root = event as { data?: { detail?: unknown }; detail?: unknown } | null;
	const detail = root?.data?.detail ?? root?.detail;
	let candidate = detail;

	if (typeof candidate === 'string') {
		try {
			candidate = JSON.parse(candidate) as unknown;
		} catch {
			return null;
		}
	}

	if (!candidate || typeof candidate !== 'object') return null;
	if (typeof (candidate as { type?: unknown }).type !== 'string') return null;
	return candidate as WebviewToExtensionMessage;
}

function parseTimestampMs(value: unknown): number {
	if (typeof value !== 'string' || value.trim() === '') return 0;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : 0;
}

function readFileTail(filePath: string, maxBytes: number): string {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, 'r');
		const stat = fs.fstatSync(fd);
		const size = stat.size;
		if (!Number.isFinite(size) || size <= 0) return '';
		const length = Math.min(maxBytes, size);
		const start = Math.max(0, size - length);
		const buffer = Buffer.alloc(length);
		const bytesRead = fs.readSync(fd, buffer, 0, length, start);
		return buffer.toString('utf-8', 0, bytesRead);
	} catch {
		return '';
	} finally {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch { /* noop */ }
		}
	}
}

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

function nativePath(value: string): string {
	return process.platform === 'win32' ? value.replace(/\//g, '\\') : value;
}

function getProjectDirPath(workspaceRoot: string | null): string | null {
	if (!workspaceRoot) return null;
	const normalizedPath = normalizeWorkspacePath(workspaceRoot);
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
		// noop
	}
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return path.join(projectsRoot, currentDirNameForWorkspace(normalizedPath));
}

function resolveWorkspaceRoot(): string | null {
	const candidates = [
		process.env['PIXEL_AGENTS_WORKSPACE'],
		process.env['INIT_CWD'],
		process.env['PWD'],
	].filter((value): value is string => !!value && value.trim().length > 0);
	for (const candidate of candidates) {
		const resolved = path.resolve(candidate);
		if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
			return resolved;
		}
	}
	return null;
}

function parseJsonObject(input: string): Record<string, unknown> | null {
	try {
		return JSON.parse(input) as Record<string, unknown>;
	} catch {
		// Tolerate simple JSONC-style comments/trailing commas from VS Code settings files.
		try {
			const withoutBlockComments = input.replace(/\/\*[\s\S]*?\*\//g, '');
			const withoutLineComments = withoutBlockComments.replace(/^\s*\/\/.*$/gm, '');
			const withoutTrailingCommas = withoutLineComments.replace(/,\s*([}\]])/g, '$1');
			return JSON.parse(withoutTrailingCommas) as Record<string, unknown>;
		} catch {
			return null;
		}
	}
}

function toBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

function toNumber(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function loadWorkspaceHistorySettings(workspaceRoot: string | null): {
	settingsFilePath: string | null;
	enabled: boolean;
	lookbackDays: number;
	maxVisible: number;
} {
	const defaults = {
		enabled: HISTORY_SESSIONS_ENABLED_DEFAULT,
		lookbackDays: HISTORY_SESSIONS_LOOKBACK_DAYS_DEFAULT,
		maxVisible: HISTORY_SESSIONS_MAX_VISIBLE_DEFAULT,
	};
	if (!workspaceRoot) {
		return { settingsFilePath: null, ...defaults };
	}

	const settingsFilePath = path.join(workspaceRoot, 'settings.json');
	if (!fs.existsSync(settingsFilePath)) {
		return { settingsFilePath, ...defaults };
	}

	let raw = '';
	try {
		raw = fs.readFileSync(settingsFilePath, 'utf8');
	} catch {
		return { settingsFilePath, ...defaults };
	}
	const parsed = parseJsonObject(raw);
	if (!parsed) {
		return { settingsFilePath, ...defaults };
	}

	return {
		settingsFilePath,
		enabled: toBoolean(parsed['pixel-agents.historySessions.enabled'], defaults.enabled),
		lookbackDays: toNumber(parsed['pixel-agents.historySessions.lookbackDays'], defaults.lookbackDays),
		maxVisible: toNumber(parsed['pixel-agents.historySessions.maxVisible'], defaults.maxVisible),
	};
}

function looksLikeSessionId(value: string): boolean {
	return /^[0-9a-fA-F-]{36}$/.test(value);
}

function hashString(input: string): number {
	let h = 2166136261;
	for (let i = 0; i < input.length; i += 1) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

function appearanceForSession(sessionId: string): { palette: number; hueShift: number } {
	const hash = hashString(sessionId);
	const palette = hash % 6;
	const cycle = Math.floor(hash / 6) % 4;
	const hueShift = cycle === 0 ? 0 : 55 + cycle * 30;
	return { palette, hueShift };
}

function formatToolStatus(toolName: string, input: Record<string, unknown>): string {
	const base = (p: unknown) => typeof p === 'string' ? path.basename(p) : '';
	if (toolName === 'Task' || toolName.startsWith('Team')) {
		const desc = typeof input.description === 'string' ? input.description : '';
		return desc
			? `Subtask: ${desc.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH ? `${desc.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH)}…` : desc}`
			: 'Running subtask';
	}
	switch (toolName) {
		case 'Read': return `Reading ${base(input.file_path)}`;
		case 'Edit': return `Editing ${base(input.file_path)}`;
		case 'Write': return `Writing ${base(input.file_path)}`;
		case 'Bash': {
			const cmd = (input.command as string) || '';
			return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? `${cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH)}…` : cmd}`;
		}
		case 'Glob': return 'Searching files';
		case 'Grep': return 'Searching code';
		case 'WebFetch': return 'Fetching web content';
		case 'WebSearch': return 'Searching the web';
		case 'AskUserQuestion': return 'Waiting for your answer';
		case 'EnterPlanMode': return 'Planning';
		case 'NotebookEdit': return 'Editing notebook';
		default: return `Using ${toolName}`;
	}
}

function parseSessionRuntime(jsonlPath: string, sessionId: string): SessionRuntimeSnapshot {
	const tail = readFileTail(jsonlPath, 256 * 1024);
	const activeToolStatuses = new Map<string, string>();
	let lastActivityAtMs = 0;
	let lastSawTurnDuration = false;

	if (tail) {
		const lines = tail.split('\n');
		for (const raw of lines) {
			const line = raw.trim();
			if (!line || line[0] !== '{') continue;
			let record: Record<string, unknown>;
			try {
				record = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			const recordSessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
			if (recordSessionId && recordSessionId !== sessionId) continue;

			const tsMs = parseTimestampMs(record.timestamp);
			if (tsMs > lastActivityAtMs) lastActivityAtMs = tsMs;

			const type = typeof record.type === 'string' ? record.type : '';
			if (type === 'assistant') {
				const message = record.message as { content?: unknown } | undefined;
				const content = message?.content;
				if (!Array.isArray(content)) continue;
				let hasToolUse = false;
				for (const block of content as Array<{ type?: unknown; id?: unknown; name?: unknown; input?: unknown }>) {
					if (block.type !== 'tool_use' || typeof block.id !== 'string') continue;
					const toolName = typeof block.name === 'string' ? block.name : '';
					const toolInput = (typeof block.input === 'object' && block.input !== null)
						? (block.input as Record<string, unknown>)
						: {};
					if (activeToolStatuses.has(block.id)) {
						activeToolStatuses.delete(block.id);
					}
					activeToolStatuses.set(block.id, formatToolStatus(toolName, toolInput));
					hasToolUse = true;
				}
				if (hasToolUse) {
					lastSawTurnDuration = false;
				}
				continue;
			}

			if (type === 'user') {
				const message = record.message as { content?: unknown } | undefined;
				const content = message?.content;
				if (!Array.isArray(content)) continue;
				for (const block of content as Array<{ type?: unknown; tool_use_id?: unknown }>) {
					if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
					activeToolStatuses.delete(block.tool_use_id);
				}
				continue;
			}

			if (type === 'system' && record.subtype === 'turn_duration') {
				activeToolStatuses.clear();
				lastSawTurnDuration = true;
			}
		}
	}

	try {
		const stat = fs.statSync(jsonlPath);
		if (Number.isFinite(stat.mtimeMs)) {
			lastActivityAtMs = Math.max(lastActivityAtMs, stat.mtimeMs);
		}
	} catch {
		// noop
	}

	const latestToolStatus = activeToolStatuses.size > 0
		? Array.from(activeToolStatuses.values())[activeToolStatuses.size - 1]!
		: null;
	const isActiveByRecentWrite = !lastSawTurnDuration && (Date.now() - lastActivityAtMs) <= ACTIVE_RECENT_THRESHOLD_MS;
	const status: AgentRuntimeStatus = (latestToolStatus || isActiveByRecentWrite) ? 'active' : 'waiting';

	return {
		status,
		toolStatus: latestToolStatus,
		lastActivityAtMs,
	};
}

function collectLiveAgents(
	projectDir: string,
	folderName: string,
	hiddenSessionIds: ReadonlySet<string>,
	forcedLiveSessionIds: ReadonlySet<string>,
): DesktopAgent[] {
	let names: string[] = [];
	try {
		names = fs.readdirSync(projectDir);
	} catch {
		return [];
	}

	const thresholdMs = Date.now() - LIVE_SESSION_LOOKBACK_HOURS * 60 * 60 * 1000;
	const agents: DesktopAgent[] = [];

	for (const name of names) {
		if (!name.endsWith('.jsonl')) continue;
		const sessionId = name.slice(0, -'.jsonl'.length);
		if (!looksLikeSessionId(sessionId)) continue;
		if (hiddenSessionIds.has(sessionId)) continue;

		const jsonlPath = path.join(projectDir, name);
		if (!canResumeHistorySession(jsonlPath, sessionId)) continue;

		const runtime = parseSessionRuntime(jsonlPath, sessionId);
		const appearance = appearanceForSession(sessionId);
		if (runtime.lastActivityAtMs < thresholdMs && !forcedLiveSessionIds.has(sessionId)) {
			continue;
		}

		agents.push({
			id: sessionId,
			sessionId,
			jsonlPath,
			folderName,
			status: runtime.status,
			toolStatus: runtime.toolStatus,
			lastActivityAtMs: runtime.lastActivityAtMs,
			palette: appearance.palette,
			hueShift: appearance.hueShift,
			seatId: null,
		});
	}

	agents.sort((a, b) => b.lastActivityAtMs - a.lastActivityAtMs);
	return agents.slice(0, LIVE_SESSION_MAX_VISIBLE);
}

function toHistorySummary(records: ReturnType<typeof collectHistorySessions>): HistorySessionSummary[] {
	return records.map((session) => ({
		id: session.id,
		sessionId: session.sessionId,
		jsonlPath: session.jsonlPath,
		createdAt: new Date(session.createdAtMs).toISOString(),
		lastActivityAt: new Date(session.lastActivityAtMs).toISOString(),
		title: session.title,
		summary: session.summary,
	}));
}

function createInitialState(): DesktopHostState {
	const workspaceRoot = resolveWorkspaceRoot();
	const workspaceFolderName = workspaceRoot ? path.basename(workspaceRoot) || 'workspace' : 'workspace';
	const projectDir = getProjectDirPath(workspaceRoot);
	const historyConfig = loadWorkspaceHistorySettings(workspaceRoot);
	return {
		workspaceRoot,
		projectDir,
		workspaceFolderName,
		settingsFilePath: historyConfig.settingsFilePath,
		agents: new Map(),
		historySessions: [],
		settings: {
			soundEnabled: true,
			alwaysStatusBubblesEnabled: true,
			eventBubblesEnabled: true,
			historySessionsEnabled: historyConfig.enabled,
		},
		historyLookbackDays: historyConfig.lookbackDays,
		historyMaxVisible: historyConfig.maxVisible,
		selectedAgentId: null,
		hiddenSessionIds: new Set(),
		forcedLiveSessionIds: new Set(),
		refreshTimer: null,
		didInitialize: false,
	};
}

function sendSettings(window: BrowserWindow, state: DesktopHostState): void {
	postToWebview(window, {
		type: 'settingsLoaded',
		soundEnabled: state.settings.soundEnabled,
		speechBubblesEnabled: state.settings.alwaysStatusBubblesEnabled,
		alwaysStatusBubblesEnabled: state.settings.alwaysStatusBubblesEnabled,
		eventBubblesEnabled: state.settings.eventBubblesEnabled,
		historySessionsEnabled: state.settings.historySessionsEnabled,
	});
}

function sendWorkspace(window: BrowserWindow, state: DesktopHostState): void {
	const root = state.workspaceRoot ?? 'desktop://workspace';
	postToWebview(window, {
		type: 'workspaceFolders',
		folders: [{ name: state.workspaceFolderName, path: root }],
	});
}

function sendExistingAgents(window: BrowserWindow, agents: DesktopAgent[]): void {
	const agentIds = agents.map((agent) => agent.id);
	const agentMeta: Record<string, ExistingAgentMeta> = {};
	const folderNames: Record<string, string> = {};
	for (const agent of agents) {
		agentMeta[agent.id] = {
			palette: agent.palette,
			hueShift: agent.hueShift,
			seatId: agent.seatId,
		};
		folderNames[agent.id] = agent.folderName;
	}
	postToWebview(window, {
		type: 'existingAgents',
		agents: agentIds,
		agentMeta,
		folderNames,
	});
}

function sendHistorySessions(window: BrowserWindow, state: DesktopHostState): void {
	postToWebview(window, {
		type: 'historySessionsLoaded',
		sessions: state.settings.historySessionsEnabled ? state.historySessions : [],
	});
}

function applyAgentRuntime(window: BrowserWindow, agent: DesktopAgent): void {
	postToWebview(window, { type: 'agentToolsClear', id: agent.id });
	if (agent.status === 'active' && agent.toolStatus) {
		postToWebview(window, {
			type: 'agentToolStart',
			id: agent.id,
			toolId: `tool:${agent.id}:live`,
			status: agent.toolStatus,
		});
	}
	postToWebview(window, {
		type: 'agentStatus',
		id: agent.id,
		status: agent.status,
	});
}

function refreshAndPublish(window: BrowserWindow, state: DesktopHostState, initial = false): void {
	if (!state.projectDir || !fs.existsSync(state.projectDir)) {
		if (initial && !state.didInitialize) {
			sendWorkspace(window, state);
			sendSettings(window, state);
			postToWebview(window, { type: 'layoutLoaded', layout: null });
			postToWebview(window, { type: 'historySessionsLoaded', sessions: [] });
			state.didInitialize = true;
		}
		return;
	}

	const liveAgents = collectLiveAgents(
		state.projectDir,
		state.workspaceFolderName,
		state.hiddenSessionIds,
		state.forcedLiveSessionIds,
	);
	const liveSessionIds = liveAgents.map((agent) => agent.sessionId.toLowerCase());
	const liveJsonlPaths = liveAgents.map((agent) => agent.jsonlPath);
	const historyRecords = collectHistorySessions(
		state.projectDir,
		liveJsonlPaths,
		{
			enabled: true,
			lookbackDays: state.historyLookbackDays,
			maxVisible: state.historyMaxVisible,
		},
		liveSessionIds,
	);
	state.historySessions = toHistorySummary(historyRecords);

	const prevAgents = state.agents;
	const nextAgents = new Map(liveAgents.map((agent) => [agent.id, agent]));
	state.agents = nextAgents;

	if (initial && !state.didInitialize) {
		console.log(`[desktop-electrobun] publish initial snapshot: live=${liveAgents.length}, history=${state.historySessions.length}`);
		sendWorkspace(window, state);
		sendSettings(window, state);
		sendExistingAgents(window, liveAgents);
		postToWebview(window, { type: 'layoutLoaded', layout: null });
		sendHistorySessions(window, state);
		for (const agent of liveAgents) {
			applyAgentRuntime(window, agent);
		}
		state.didInitialize = true;
	} else {
		for (const id of prevAgents.keys()) {
			if (!nextAgents.has(id)) {
				postToWebview(window, { type: 'agentClosed', id });
			}
		}
		for (const agent of liveAgents) {
			if (!prevAgents.has(agent.id)) {
				postToWebview(window, { type: 'agentCreated', id: agent.id, folderName: agent.folderName });
			}
			applyAgentRuntime(window, agent);
		}
		sendHistorySessions(window, state);
	}

	if (state.selectedAgentId && !nextAgents.has(state.selectedAgentId)) {
		state.selectedAgentId = null;
	}
	if (!state.selectedAgentId && liveAgents[0]) {
		state.selectedAgentId = liveAgents[0].id;
	}
	if (state.selectedAgentId) {
		postToWebview(window, { type: 'agentSelected', id: state.selectedAgentId });
	}
}

function openExternalTarget(target: string): void {
	try {
		if (process.platform === 'darwin') {
			spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
			return;
		}
		if (process.platform === 'win32') {
			spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore' }).unref();
			return;
		}
		spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
	} catch (error) {
		console.log(`[desktop-electrobun] failed to open target: ${target} (${error})`);
	}
}

function startRefreshLoop(window: BrowserWindow, state: DesktopHostState): void {
	if (state.refreshTimer) return;
	state.refreshTimer = setInterval(() => {
		refreshAndPublish(window, state, false);
	}, REFRESH_INTERVAL_MS);
}

function stopRefreshLoop(state: DesktopHostState): void {
	if (!state.refreshTimer) return;
	clearInterval(state.refreshTimer);
	state.refreshTimer = null;
}

function handleWebviewMessage(window: BrowserWindow, state: DesktopHostState, message: WebviewToExtensionMessage): void {
	switch (message.type) {
		case 'webviewReady':
			console.log('[desktop-electrobun] webviewReady');
			refreshAndPublish(window, state, true);
			startRefreshLoop(window, state);
			return;
		case 'focusAgent':
			if (!state.agents.has(message.id)) return;
			state.selectedAgentId = message.id;
			postToWebview(window, { type: 'agentSelected', id: message.id });
			return;
		case 'closeAgent':
			state.hiddenSessionIds.add(message.id);
			state.forcedLiveSessionIds.delete(message.id);
			if (state.agents.has(message.id)) {
				postToWebview(window, { type: 'agentClosed', id: message.id });
			}
			state.agents.delete(message.id);
			refreshAndPublish(window, state, false);
			return;
		case 'openHistorySession':
			state.hiddenSessionIds.delete(message.sessionId);
			state.forcedLiveSessionIds.add(message.sessionId);
			state.selectedAgentId = message.sessionId;
			refreshAndPublish(window, state, false);
			return;
		case 'setSoundEnabled':
			state.settings.soundEnabled = message.enabled;
			sendSettings(window, state);
			return;
		case 'setSpeechBubblesEnabled':
		case 'setAlwaysStatusBubblesEnabled':
			state.settings.alwaysStatusBubblesEnabled = message.enabled;
			sendSettings(window, state);
			return;
		case 'setEventBubblesEnabled':
			state.settings.eventBubblesEnabled = message.enabled;
			sendSettings(window, state);
			return;
		case 'setHistorySessionsEnabled':
			state.settings.historySessionsEnabled = message.enabled;
			sendSettings(window, state);
			sendHistorySessions(window, state);
			return;
		case 'openSessionsFolder':
			if (state.projectDir) {
				openExternalTarget(state.projectDir);
			}
			return;
		case 'openExternal':
			openExternalTarget(message.target);
			return;
		case 'openClaude':
			console.log('[desktop-electrobun] openClaude requested (terminal launch is not wired in desktop host yet)');
			refreshAndPublish(window, state, false);
			return;
		default:
			console.log(`[desktop-electrobun] webview message ignored: ${message.type}`);
			return;
	}
}

function run(): void {
	const state = createInitialState();
	console.log(`[desktop-electrobun] workspace=${state.workspaceRoot ?? '<unset>'}`);
	console.log(`[desktop-electrobun] projectDir=${state.projectDir ?? '<missing>'}`);
	console.log(
		`[desktop-electrobun] history options: enabled=${state.settings.historySessionsEnabled}, lookbackDays=${state.historyLookbackDays}, maxVisible=${state.historyMaxVisible}, settingsFile=${state.settingsFilePath ?? '<none>'}`,
	);

	const window = new BrowserWindow({
		title: 'Pixel Agents Desktop',
		frame: { x: 120, y: 80, width: 1280, height: 840 },
		url: 'views://pixel/index.html',
		renderer: 'native',
		titleBarStyle: 'default',
		transparent: false,
	});

	window.on('host-message', (event) => {
		const message = parseHostMessage(event);
		if (!message) {
			console.log('[desktop-electrobun] ignored unknown host-message payload');
			return;
		}
		handleWebviewMessage(window, state, message);
	});

	window.on('dom-ready', () => {
		console.log('[desktop-electrobun] webview DOM ready');
	});

	window.on('close', () => {
		stopRefreshLoop(state);
	});

	console.log('[desktop-electrobun] loading views://pixel/index.html');
}

run();
