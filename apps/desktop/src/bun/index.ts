import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BrowserWindow } from 'electrobun';
import pty from '@lydell/node-pty';
import {
	createZigPtyBridge,
	resolveZigPtyBinaryPath,
	type TerminalPtyLike,
} from './zigPtyBridge.js';
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
const DESKTOP_PTY_DEFAULT_COLS = 120;
const DESKTOP_PTY_DEFAULT_ROWS = 32;
const DEFAULT_CLAUDE_LAUNCH_COMMAND = 'claude';
const DEFAULT_CLAUDE_RESUME_COMMAND = 'claude --resume {sessionId}';
const TERMINAL_REPLAY_MAX_BYTES = 128 * 1024;
const TERMINAL_MIN_COLS = 40;
const TERMINAL_MIN_ROWS = 8;
const TRACE_SMOKE_ENV = 'PIXEL_AGENTS_TRACE_SMOKE';
const TRACE_CONTRACT_ENV = 'PIXEL_AGENTS_TRACE_CONTRACT';
const TRACE_SMOKE_MARKER_PREFIX = '__PA_TRACE_ACK__';
const DESKTOP_TERMINAL_EVENT = 'pixel-agents:terminal';

type TerminalLifecycleState = 'stopped' | 'starting' | 'running' | 'closing';

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
	claudeLaunchCommand: string;
	claudeResumeCommand: string;
	terminalPty: TerminalPtyLike | null;
	terminalBackend: 'zig' | 'node-pty' | null;
	terminalCols: number;
	terminalRows: number;
	terminalCwd: string;
	terminalReplay: string;
	terminalInstanceId: string | null;
	terminalTraceId: string | null;
	terminalLifecycle: TerminalLifecycleState;
	activeTerminalSessionId: string | null;
	traceSmokeMode: boolean;
	traceContractProbe: boolean;
	traceSmokeId: string | null;
	traceSmokeAck: boolean;
	traceSmokeStarted: boolean;
	refreshTimer: ReturnType<typeof setInterval> | null;
	didInitialize: boolean;
	isShuttingDown: boolean;
}

type TerminalHostToWebviewMessage = Extract<
	ExtensionToWebviewMessage,
	{ type: 'terminalReady' | 'terminalData' | 'terminalExit' }
>;

function isTerminalHostToWebviewMessage(
	message: ExtensionToWebviewMessage,
): message is TerminalHostToWebviewMessage {
	return message.type === 'terminalReady' || message.type === 'terminalData' || message.type === 'terminalExit';
}

function postToWebview(window: BrowserWindow, message: ExtensionToWebviewMessage): void {
	const webview = window.webview as unknown as {
		executeJavascript: (js: string) => void;
	};

	const payload = JSON.stringify(message);
	if (isTerminalHostToWebviewMessage(message)) {
		// Keep terminal traffic on a dedicated channel to avoid generic message-wrapper
		// payload transformations that can drop `type`/`data` semantics.
		webview.executeJavascript(
			`window.dispatchEvent(new CustomEvent('${DESKTOP_TERMINAL_EVENT}', { detail: ${payload} }));`,
		);
		return;
	}
	// Non-terminal messages continue through the generic message bus.
	webview.executeJavascript(`window.dispatchEvent(new MessageEvent('message', { data: ${payload} }));`);
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

function loadWorkspaceDesktopSettings(workspaceRoot: string | null): {
	settingsFilePath: string | null;
	enabled: boolean;
	lookbackDays: number;
	maxVisible: number;
	claudeLaunchCommand: string;
	claudeResumeCommand: string;
} {
	const defaults = {
		enabled: HISTORY_SESSIONS_ENABLED_DEFAULT,
		lookbackDays: HISTORY_SESSIONS_LOOKBACK_DAYS_DEFAULT,
		maxVisible: HISTORY_SESSIONS_MAX_VISIBLE_DEFAULT,
		claudeLaunchCommand: DEFAULT_CLAUDE_LAUNCH_COMMAND,
		claudeResumeCommand: DEFAULT_CLAUDE_RESUME_COMMAND,
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
		claudeLaunchCommand: typeof parsed['pixel-agents.claudeLaunchCommand'] === 'string'
			? ((parsed['pixel-agents.claudeLaunchCommand'] as string).trim() || defaults.claudeLaunchCommand)
			: defaults.claudeLaunchCommand,
		claudeResumeCommand: typeof parsed['pixel-agents.claudeResumeCommand'] === 'string'
			? ((parsed['pixel-agents.claudeResumeCommand'] as string).trim() || defaults.claudeResumeCommand)
			: defaults.claudeResumeCommand,
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
	const config = loadWorkspaceDesktopSettings(workspaceRoot);
	const traceSmokeMode = process.env[TRACE_SMOKE_ENV] === '1';
	const traceContractProbe = process.env[TRACE_CONTRACT_ENV] === '1';
	return {
		workspaceRoot,
		projectDir,
		workspaceFolderName,
		settingsFilePath: config.settingsFilePath,
		agents: new Map(),
		historySessions: [],
		settings: {
			soundEnabled: true,
			alwaysStatusBubblesEnabled: true,
			eventBubblesEnabled: true,
			historySessionsEnabled: config.enabled,
		},
		historyLookbackDays: config.lookbackDays,
		historyMaxVisible: config.maxVisible,
		selectedAgentId: null,
		hiddenSessionIds: new Set(),
		forcedLiveSessionIds: new Set(),
		claudeLaunchCommand: config.claudeLaunchCommand,
		claudeResumeCommand: config.claudeResumeCommand,
		terminalPty: null,
		terminalBackend: null,
		terminalCols: DESKTOP_PTY_DEFAULT_COLS,
		terminalRows: DESKTOP_PTY_DEFAULT_ROWS,
		terminalCwd: workspaceRoot || process.cwd(),
		terminalReplay: '',
		terminalInstanceId: null,
		terminalTraceId: null,
		terminalLifecycle: 'stopped',
		activeTerminalSessionId: null,
		traceSmokeMode,
		traceContractProbe,
		traceSmokeId: null,
		traceSmokeAck: false,
		traceSmokeStarted: false,
		refreshTimer: null,
		didInitialize: false,
		isShuttingDown: false,
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
		console.log(`[desktop] publish initial snapshot: live=${liveAgents.length}, history=${state.historySessions.length}`);
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
		console.log(`[desktop] failed to open target: ${target} (${error})`);
	}
}

function resolveShell(): { executable: string; args: string[] } {
	if (process.platform === 'win32') {
		return { executable: 'powershell.exe', args: ['-NoLogo'] };
	}
	const shell = (process.env['SHELL'] || '').trim();
	if (shell.length > 0) {
		const base = path.basename(shell).toLowerCase();
		if (base.includes('fish')) {
			return { executable: shell, args: ['--interactive', '--no-config'] };
		}
		if (base.includes('zsh')) {
			return { executable: shell, args: ['-if'] };
		}
		if (base.includes('bash')) {
			return { executable: shell, args: ['--noprofile', '--norc', '-i'] };
		}
		return { executable: shell, args: ['-i'] };
	}
	return { executable: '/bin/zsh', args: ['-if'] };
}

function buildClaudeCommand(template: string, sessionId?: string): string {
	const safeTemplate = template.trim() || (sessionId ? DEFAULT_CLAUDE_RESUME_COMMAND : DEFAULT_CLAUDE_LAUNCH_COMMAND);
	const resolved = safeTemplate
		.replace(/\{sessionId\}/g, sessionId || '')
		.replace(/\$\{sessionId\}/g, sessionId || '')
		.replace(/\$SESSION_ID/g, sessionId || '')
		.replace(/%SESSION_ID%/g, sessionId || '');
	if (resolved !== safeTemplate) {
		return resolved.trim().replace(/\s+/g, ' ');
	}
	if (sessionId) {
		return `${safeTemplate} --resume ${sessionId}`;
	}
	return safeTemplate;
}

function normalizeTerminalSize(value: unknown, fallback: number, min: number): number {
	const safeFallback = Number.isFinite(fallback) ? fallback : min;
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return Math.max(min, Math.floor(safeFallback));
	}
	return Math.max(min, Math.floor(value));
}

function normalizeTraceId(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function normalizeInstanceId(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function shortInstanceId(value: string | null): string {
	if (!value) return '-';
	if (value.length <= 12) return value;
	return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function setAttachedTerminalInstance(state: DesktopHostState, instanceId: string | null): void {
	const next = normalizeInstanceId(instanceId);
	const prev = state.terminalInstanceId;
	state.terminalInstanceId = next;
	if (prev && next && prev !== next) {
		console.log(`[desktop] terminal attachment switched: ${prev.slice(0, 8)} -> ${next.slice(0, 8)}`);
	}
}

function isActiveTerminalAttachment(state: DesktopHostState, instanceId: unknown): boolean {
	const incoming = normalizeInstanceId(instanceId);
	return Boolean(incoming && state.terminalInstanceId && incoming === state.terminalInstanceId);
}

function traceLabel(traceId: string | null): string {
	return traceId ? `trace:${traceId}` : 'trace:none';
}

function postTerminalReady(
	window: BrowserWindow,
	state: DesktopHostState,
	cols: number,
	rows: number,
	cwd: string,
	shell: string,
): void {
	if (!state.terminalInstanceId) return;
	postToWebview(window, {
		type: 'terminalReady',
		cols,
		rows,
		cwd,
		shell,
		instanceId: state.terminalInstanceId,
		traceId: state.terminalTraceId ?? undefined,
	});
}

function postTerminalData(window: BrowserWindow, state: DesktopHostState, data: string): void {
	if (!state.terminalInstanceId) return;
	postToWebview(window, {
		type: 'terminalData',
		data,
		instanceId: state.terminalInstanceId,
		traceId: state.terminalTraceId ?? undefined,
	});
}

function postTerminalExit(
	window: BrowserWindow,
	state: DesktopHostState,
	exitCode: number,
	signal?: number,
): void {
	if (!state.terminalInstanceId) return;
	postToWebview(window, {
		type: 'terminalExit',
		exitCode,
		signal,
		instanceId: state.terminalInstanceId,
		traceId: state.terminalTraceId ?? undefined,
	});
}

function writeTerminalCommand(state: DesktopHostState, command: string): boolean {
	if (!state.terminalPty) return false;
	const trimmed = command.trim();
	if (!trimmed) return true;
	try {
		state.terminalPty.write(`${trimmed}\r`);
		return true;
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error);
		console.log(`[desktop] terminal write failed: ${text}`);
		state.terminalPty = null;
		state.terminalBackend = null;
		state.terminalLifecycle = 'stopped';
		state.activeTerminalSessionId = null;
		return false;
	}
}

function runTerminalCommand(window: BrowserWindow, state: DesktopHostState, command: string): void {
	console.log(`[desktop] runTerminalCommand (${traceLabel(state.terminalTraceId)}): ${command}`);
	ensureTerminalPty(window, state);
	if (writeTerminalCommand(state, command)) return;
	// Retry once with a fresh PTY when write failed on a stale handle.
	ensureTerminalPty(window, state);
	writeTerminalCommand(state, command);
}

function appendTerminalReplay(state: DesktopHostState, chunk: string): void {
	if (!chunk) return;
	const next = state.terminalReplay + chunk;
	if (next.length <= TERMINAL_REPLAY_MAX_BYTES) {
		state.terminalReplay = next;
		return;
	}
	state.terminalReplay = next.slice(next.length - TERMINAL_REPLAY_MAX_BYTES);
}

function attachTerminalListeners(window: BrowserWindow, state: DesktopHostState, terminal: TerminalPtyLike): void {
	terminal.onData((data) => {
		appendTerminalReplay(state, data);
		postTerminalData(window, state, data);
	});

	terminal.onExit((event) => {
		const wasClosing = state.terminalLifecycle === 'closing';
		postTerminalExit(window, state, event.exitCode, event.signal);
		state.terminalPty = null;
		state.terminalBackend = null;
		state.terminalLifecycle = 'stopped';
		state.activeTerminalSessionId = null;
		console.log(
			`[desktop] PTY exited (${traceLabel(state.terminalTraceId)}) code=${event.exitCode} signal=${event.signal ?? 0}`,
		);
		if (!wasClosing) {
			postTerminalData(window, state, '\r\n[desktop] terminal exited; restarting shell...\r\n');
			ensureTerminalPty(window, state, {
				instanceId: state.terminalInstanceId ?? undefined,
				traceId: state.terminalTraceId ?? undefined,
			});
		}
	});
}

function createTerminalBackend(
	window: BrowserWindow,
	state: DesktopHostState,
	cwd: string,
	cols: number,
	rows: number,
	shell: { executable: string; args: string[] },
): TerminalPtyLike {
	const zigBinaryPath = resolveZigPtyBinaryPath();
	if (zigBinaryPath) {
		try {
			const zig = createZigPtyBridge({
				binaryPath: zigBinaryPath,
				shell: shell.executable,
				shellArgs: shell.args,
				cwd,
				cols,
				rows,
				onLog: (text) => console.log(`[desktop] ${text}`),
			});
			state.terminalBackend = 'zig';
			console.log(`[desktop] terminal backend=zig (${zigBinaryPath})`);
			attachTerminalListeners(window, state, zig);
			return zig;
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			console.log(`[desktop] zig PTY unavailable (${text}); falling back to node-pty`);
		}
	} else {
		console.log(`[desktop] zig PTY binary not found (cwd=${process.cwd()}); falling back to node-pty`);
	}

	const fallback = pty.spawn(shell.executable, shell.args, {
		name: 'xterm-256color',
		cols,
		rows,
		cwd,
		env: {
			...process.env,
			TERM: 'xterm-256color',
			TERM_PROGRAM: 'pixel-agents',
			TERM_PROGRAM_VERSION: 'desktop-node-pty',
		},
	});
	state.terminalBackend = 'node-pty';
	console.log('[desktop] terminal backend=node-pty');
	attachTerminalListeners(window, state, fallback as unknown as TerminalPtyLike);
	return fallback as unknown as TerminalPtyLike;
}

function ensureTerminalPty(
	window: BrowserWindow,
	state: DesktopHostState,
	opts?: { cols?: number; rows?: number; cwd?: string; instanceId?: string; traceId?: string },
): void {
	const nextInstanceId = normalizeInstanceId(opts?.instanceId);
	if (nextInstanceId) {
		setAttachedTerminalInstance(state, nextInstanceId);
	}
	if (opts?.traceId) {
		state.terminalTraceId = opts.traceId;
	}

		if (state.terminalPty) {
			const cols = normalizeTerminalSize(opts?.cols, state.terminalCols, TERMINAL_MIN_COLS);
			const rows = normalizeTerminalSize(opts?.rows, state.terminalRows, TERMINAL_MIN_ROWS);
			if (cols !== state.terminalCols || rows !== state.terminalRows) {
				try {
					state.terminalPty.resize(cols, rows);
				} catch (error) {
					const text = error instanceof Error ? error.message : String(error);
					if (process.env['PIXEL_AGENTS_DEBUG_TERMINAL'] === '1') {
						console.log(`[desktop] terminal resize failed on existing PTY: ${text}`);
					} else {
						console.log('[desktop] terminal resize failed on existing PTY; keeping current size');
					}
					// Keep PTY alive even when a resize event fails.
					// Some runtimes emit transient resize errors while the shell remains usable.
					state.terminalLifecycle = 'running';
					postTerminalReady(window, state, state.terminalCols, state.terminalRows, state.terminalCwd, resolveShell().executable);
					return;
				}
				state.terminalCols = cols;
				state.terminalRows = rows;
			}
		state.terminalLifecycle = 'running';
			postTerminalReady(window, state, state.terminalCols, state.terminalRows, state.terminalCwd, resolveShell().executable);
			if (state.terminalReplay) {
				postTerminalData(window, state, state.terminalReplay);
			}
			return;
		}

	const cwd = opts?.cwd || state.workspaceRoot || process.cwd();
	const cols = normalizeTerminalSize(opts?.cols, state.terminalCols, TERMINAL_MIN_COLS);
	const rows = normalizeTerminalSize(opts?.rows, state.terminalRows, TERMINAL_MIN_ROWS);
	const shell = resolveShell();

	try {
		state.terminalLifecycle = 'starting';
			state.terminalPty = createTerminalBackend(window, state, cwd, cols, rows, shell);
		state.terminalCols = cols;
		state.terminalRows = rows;
		state.terminalCwd = cwd;
		state.terminalLifecycle = 'running';

			postTerminalReady(window, state, cols, rows, cwd, shell.executable);
			if (state.terminalReplay) {
				postTerminalData(window, state, state.terminalReplay);
			}
		} catch (error) {
		const text = error instanceof Error ? error.message : String(error);
		state.terminalLifecycle = 'stopped';
			postTerminalData(window, state, `\r\n[desktop] failed to start terminal: ${text}\r\n`);
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

function cleanupHostResources(state: DesktopHostState, reason: string): void {
	if (state.isShuttingDown) return;
	state.isShuttingDown = true;
	stopRefreshLoop(state);
	state.terminalLifecycle = 'closing';
	if (state.terminalPty) {
		try {
			state.terminalPty.kill();
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			console.log(`[desktop] terminal PTY kill failed during ${reason}: ${text}`);
		}
		state.terminalPty = null;
		state.terminalBackend = null;
	}
	state.terminalLifecycle = 'stopped';
	state.terminalInstanceId = null;
	state.terminalTraceId = null;
	state.activeTerminalSessionId = null;
	state.traceSmokeId = null;
	state.traceSmokeAck = false;
	state.traceSmokeStarted = false;
	console.log(`[desktop] cleanup complete (${reason})`);
}

function handleWebviewMessage(window: BrowserWindow, state: DesktopHostState, message: WebviewToExtensionMessage): void {
	switch (message.type) {
		case 'webviewReady':
			console.log('[desktop] webviewReady');
			refreshAndPublish(window, state, true);
			if (state.traceSmokeMode && !state.traceSmokeStarted) {
				const traceId = `trace-smoke-${Date.now().toString(36)}`;
				state.traceSmokeId = traceId;
				state.traceSmokeStarted = true;
				state.traceSmokeAck = false;
				console.log(`[desktop] trace smoke start ${traceId} marker=${TRACE_SMOKE_MARKER_PREFIX}:${traceId}`);
				postToWebview(window, { type: 'traceSmokeStart', traceId, contractProbe: state.traceContractProbe });
				let announceCount = 1;
				const announceTimer = setInterval(() => {
					if (!state.traceSmokeMode || state.traceSmokeAck || !state.traceSmokeId || announceCount >= 10) {
						clearInterval(announceTimer);
						return;
					}
					announceCount += 1;
					postToWebview(window, {
						type: 'traceSmokeStart',
						traceId: state.traceSmokeId,
						contractProbe: state.traceContractProbe,
					});
				}, 500);
				setTimeout(() => {
					if (!state.traceSmokeMode) return;
					if (state.traceSmokeAck) return;
					if (!state.traceSmokeId) return;
					const marker = `${TRACE_SMOKE_MARKER_PREFIX}:${state.traceSmokeId}`;
					console.log(`[desktop] trace smoke probe command ${marker}`);
					ensureTerminalPty(window, state, {
						instanceId: state.terminalInstanceId ?? undefined,
						traceId: state.traceSmokeId,
					});
					runTerminalCommand(window, state, `echo ${marker}`);
				}, 1200);
			}
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
				ensureTerminalPty(window, state, {
					instanceId: state.terminalInstanceId ?? undefined,
					traceId: state.terminalTraceId ?? undefined,
				});
				if (state.activeTerminalSessionId !== message.sessionId) {
					runTerminalCommand(window, state, buildClaudeCommand(state.claudeResumeCommand, message.sessionId));
					state.activeTerminalSessionId = message.sessionId;
				} else {
					postTerminalData(window, state, `\r\n[desktop] session ${message.sessionId} is already attached in this terminal.\r\n`);
				}
					refreshAndPublish(window, state, false);
					return;
			case 'terminalCreate':
				{
					const traceId = normalizeTraceId(message.traceId);
					if (traceId) state.terminalTraceId = traceId;
				}
				console.log(`[desktop] terminalCreate (${traceLabel(state.terminalTraceId)})`);
				{
					const requestedInstanceId = normalizeInstanceId(message.instanceId);
					if (requestedInstanceId) {
						setAttachedTerminalInstance(state, requestedInstanceId);
					} else if (!state.terminalInstanceId) {
						setAttachedTerminalInstance(state, `term-${Date.now().toString(36)}`);
					}
				}
				ensureTerminalPty(window, state, {
					cols: normalizeTerminalSize(message.cols, state.terminalCols, TERMINAL_MIN_COLS),
					rows: normalizeTerminalSize(message.rows, state.terminalRows, TERMINAL_MIN_ROWS),
					cwd: message.cwd,
					instanceId: state.terminalInstanceId ?? undefined,
					traceId: state.terminalTraceId ?? undefined,
				});
				if (state.traceSmokeMode && state.traceSmokeId && state.terminalTraceId === state.traceSmokeId) {
					const marker = `${TRACE_SMOKE_MARKER_PREFIX}:${state.traceSmokeId}`;
					postTerminalData(window, state, `${marker}\r\n`);
				}
				return;
			case 'terminalInput':
				{
					const traceId = normalizeTraceId(message.traceId);
					if (traceId) state.terminalTraceId = traceId;
				}
				if (!isActiveTerminalAttachment(state, message.instanceId)) {
					const incoming = normalizeInstanceId(message.instanceId);
					console.log(
						`[desktop] stale terminalInput ignored incoming=${shortInstanceId(incoming)} active=${shortInstanceId(state.terminalInstanceId)}`,
					);
					return;
				}
				if (!state.terminalPty) return;
				if (state.terminalLifecycle !== 'running') return;
				try {
					state.terminalPty.write(message.data);
			} catch (error) {
				const text = error instanceof Error ? error.message : String(error);
				console.log(`[desktop] terminalInput write failed: ${text}`);
				state.terminalPty = null;
				state.terminalBackend = null;
				state.terminalLifecycle = 'stopped';
				state.activeTerminalSessionId = null;
				}
				return;
			case 'terminalResize':
				{
					const traceId = normalizeTraceId(message.traceId);
					if (traceId) state.terminalTraceId = traceId;
				}
				if (!isActiveTerminalAttachment(state, message.instanceId)) {
					const incoming = normalizeInstanceId(message.instanceId);
					console.log(
						`[desktop] stale terminalResize ignored incoming=${shortInstanceId(incoming)} active=${shortInstanceId(state.terminalInstanceId)}`,
					);
					return;
				}
				if (!state.terminalPty) return;
				if (state.terminalLifecycle !== 'running') return;
				const nextCols = normalizeTerminalSize(message.cols, state.terminalCols, TERMINAL_MIN_COLS);
				const nextRows = normalizeTerminalSize(message.rows, state.terminalRows, TERMINAL_MIN_ROWS);
				if (nextCols === state.terminalCols && nextRows === state.terminalRows) {
					return;
				}
				try {
					state.terminalPty.resize(nextCols, nextRows);
					state.terminalCols = nextCols;
					state.terminalRows = nextRows;
				} catch (error) {
					const text = error instanceof Error ? error.message : String(error);
					if (process.env['PIXEL_AGENTS_DEBUG_TERMINAL'] === '1') {
						console.log(`[desktop] terminalResize message failed: ${text}`);
					} else {
						console.log('[desktop] terminalResize failed; keeping previous PTY size');
					}
				}
				return;
			case 'terminalClose':
				{
					const traceId = normalizeTraceId(message.traceId);
					if (traceId) state.terminalTraceId = traceId;
				}
				if (!isActiveTerminalAttachment(state, message.instanceId)) {
					const incoming = normalizeInstanceId(message.instanceId);
					console.log(
						`[desktop] stale terminalClose ignored incoming=${shortInstanceId(incoming)} active=${shortInstanceId(state.terminalInstanceId)}`,
					);
					return;
				}
				// Keep PTY process alive across transient webview remounts.
				// The host window close handler still performs final cleanup.
				state.terminalLifecycle = state.terminalPty ? 'running' : 'stopped';
				setAttachedTerminalInstance(state, null);
				return;
			case 'terminalTraceAck':
				{
					const traceId = normalizeTraceId(message.traceId);
					if (!traceId) return;
					if (state.traceSmokeMode && state.traceSmokeId === traceId && message.markerSeen) {
						state.traceSmokeAck = true;
					}
					console.log(`[desktop] trace ack (${traceId}) markerSeen=${message.markerSeen ? 'yes' : 'no'}`);
				}
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
				{
					const traceId = normalizeTraceId(message.traceId);
					if (traceId) state.terminalTraceId = traceId;
					else if (!state.terminalTraceId) state.terminalTraceId = `trace-${Date.now().toString(36)}`;
				}
				ensureTerminalPty(window, state, {
					cwd: message.folderPath || state.workspaceRoot || process.cwd(),
					instanceId: state.terminalInstanceId ?? undefined,
					traceId: state.terminalTraceId ?? undefined,
				});
				runTerminalCommand(window, state, buildClaudeCommand(state.claudeLaunchCommand));
				state.activeTerminalSessionId = null;
			refreshAndPublish(window, state, false);
			return;
		default:
			console.log(`[desktop] webview message ignored: ${message.type}`);
			return;
	}
}

function run(): void {
	const state = createInitialState();
	console.log(`[desktop] workspace=${state.workspaceRoot ?? '<unset>'}`);
	console.log(`[desktop] projectDir=${state.projectDir ?? '<missing>'}`);
	console.log(
		`[desktop] history options: enabled=${state.settings.historySessionsEnabled}, lookbackDays=${state.historyLookbackDays}, maxVisible=${state.historyMaxVisible}, settingsFile=${state.settingsFilePath ?? '<none>'}`,
	);
	console.log(
		`[desktop] claude commands: launch="${state.claudeLaunchCommand}" resume="${state.claudeResumeCommand}"`,
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
			console.log('[desktop] ignored unknown host-message payload');
			return;
		}
		handleWebviewMessage(window, state, message);
	});

	window.on('dom-ready', () => {
		console.log('[desktop] webview DOM ready');
	});

	window.on('close', () => {
		cleanupHostResources(state, 'window-close');
	});

	process.once('SIGINT', () => cleanupHostResources(state, 'SIGINT'));
	process.once('SIGTERM', () => cleanupHostResources(state, 'SIGTERM'));
	process.once('beforeExit', () => cleanupHostResources(state, 'beforeExit'));
	process.once('exit', () => cleanupHostResources(state, 'exit'));

	console.log('[desktop] loading views://pixel/index.html');
}

run();
