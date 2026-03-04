import { BrowserWindow } from 'electrobun';
import type {
	AgentRuntimeStatus,
	ExistingAgentMeta,
	ExtensionToWebviewMessage,
	HistorySessionSummary,
	WebviewToExtensionMessage,
} from '../../../../src/contracts/messages.js';

interface DesktopAgent {
	id: string;
	folderName: string;
	status: AgentRuntimeStatus;
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

interface DesktopHostState {
	agents: Map<string, DesktopAgent>;
	historySessions: HistorySessionSummary[];
	settings: DesktopSettingsState;
	selectedAgentId: string | null;
	nextAgentSeq: number;
}

function postToWebview(window: BrowserWindow, message: ExtensionToWebviewMessage): void {
	const payload = JSON.stringify(message);
	window.webview.executeJavascript(
		`window.dispatchEvent(new MessageEvent('message', { data: ${payload} }));`,
	);
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

function makeHistorySession(index: number): HistorySessionSummary {
	const now = Date.now();
	return {
		id: `history:desktop:${index}`,
		sessionId: crypto.randomUUID(),
		jsonlPath: `/desktop/sessions/session-${index}.jsonl`,
		createdAt: new Date(now - (index + 1) * 1000 * 60 * 60 * 24).toISOString(),
		lastActivityAt: new Date(now - (index + 1) * 1000 * 60 * 60 * 6).toISOString(),
		title: `Desktop Session ${index}`,
		summary: 'Standalone desktop host event stream',
	};
}

function createInitialState(): DesktopHostState {
	const seedAgents: DesktopAgent[] = [
		{ id: 'desktop-alpha', folderName: 'workspace/core', status: 'active', palette: 0, hueShift: 0, seatId: null },
		{ id: 'desktop-beta', folderName: 'workspace/core', status: 'active', palette: 1, hueShift: 0, seatId: null },
		{ id: 'desktop-gamma', folderName: 'workspace/ui', status: 'waiting', palette: 2, hueShift: 0, seatId: null },
		{ id: 'desktop-delta', folderName: 'workspace/ui', status: 'active', palette: 3, hueShift: 0, seatId: null },
		{ id: 'desktop-epsilon', folderName: 'workspace/tests', status: 'active', palette: 4, hueShift: 0, seatId: null },
		{ id: 'desktop-zeta', folderName: 'workspace/ops', status: 'active', palette: 5, hueShift: 0, seatId: null },
	];

	return {
		agents: new Map(seedAgents.map((agent) => [agent.id, agent])),
		historySessions: [makeHistorySession(1), makeHistorySession(2), makeHistorySession(3)],
		settings: {
			soundEnabled: true,
			alwaysStatusBubblesEnabled: true,
			eventBubblesEnabled: true,
			historySessionsEnabled: true,
		},
		selectedAgentId: seedAgents[0]?.id ?? null,
		nextAgentSeq: 7,
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

function sendWorkspace(window: BrowserWindow): void {
	postToWebview(window, {
		type: 'workspaceFolders',
		folders: [
			{ name: 'workspace/core', path: 'desktop://workspace/core' },
			{ name: 'workspace/ui', path: 'desktop://workspace/ui' },
			{ name: 'workspace/ops', path: 'desktop://workspace/ops' },
		],
	});
}

function sendExistingAgents(window: BrowserWindow, state: DesktopHostState): void {
	const agents = Array.from(state.agents.values());
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

function sendAgentActivity(window: BrowserWindow, state: DesktopHostState): void {
	for (const agent of state.agents.values()) {
		const toolId = `tool:${agent.id}:main`;
		const toolStatus = agent.status === 'waiting' ? 'Waiting for input' : 'Working';
		postToWebview(window, {
			type: 'agentToolStart',
			id: agent.id,
			toolId,
			status: toolStatus,
		});
		if (agent.status === 'waiting') {
			postToWebview(window, { type: 'agentStatus', id: agent.id, status: 'waiting' });
		}
	}

	// Sub-agent example for desktop-beta.
	postToWebview(window, {
		type: 'agentToolStart',
		id: 'desktop-beta',
		toolId: 'task-refactor',
		status: 'Subtask: Refactor parser',
	});
	postToWebview(window, {
		type: 'subagentToolStart',
		id: 'desktop-beta',
		parentToolId: 'task-refactor',
		toolId: 'subtool-task-refactor-1',
		status: 'Refactor parser',
	});
}

function syncSnapshot(window: BrowserWindow, state: DesktopHostState): void {
	sendWorkspace(window);
	sendSettings(window, state);
	sendExistingAgents(window, state);
	sendHistorySessions(window, state);
	postToWebview(window, { type: 'layoutLoaded', layout: null });
	sendAgentActivity(window, state);
	if (state.selectedAgentId && state.agents.has(state.selectedAgentId)) {
		postToWebview(window, { type: 'agentSelected', id: state.selectedAgentId });
	}
}

function nextDesktopAgentId(state: DesktopHostState): string {
	const id = `desktop-live-${state.nextAgentSeq}`;
	state.nextAgentSeq += 1;
	return id;
}

function addLiveAgent(window: BrowserWindow, state: DesktopHostState, folderPath?: string): void {
	const id = nextDesktopAgentId(state);
	const palette = state.agents.size % 6;
	const folderName = folderPath ? folderPath.split(/[\\/]/).filter(Boolean).pop() || 'workspace/live' : 'workspace/live';
	const agent: DesktopAgent = {
		id,
		folderName,
		status: 'active',
		palette,
		hueShift: state.agents.size >= 6 ? 70 : 0,
		seatId: null,
	};
	state.agents.set(id, agent);
	state.selectedAgentId = id;
	postToWebview(window, { type: 'agentCreated', id, folderName });
	postToWebview(window, {
		type: 'agentToolStart',
		id,
		toolId: `tool:${id}:main`,
		status: 'Working',
	});
	postToWebview(window, { type: 'agentSelected', id });
	console.log(`[desktop-electrobun] agent created: ${id}`);
}

function closeLiveAgent(window: BrowserWindow, state: DesktopHostState, id: string): void {
	const agent = state.agents.get(id);
	if (!agent) return;
	state.agents.delete(id);
	postToWebview(window, { type: 'agentClosed', id });

	state.historySessions.unshift({
		id: `history:desktop:${id}`,
		sessionId: crypto.randomUUID(),
		jsonlPath: `/desktop/sessions/${id}.jsonl`,
		createdAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
		lastActivityAt: new Date().toISOString(),
		title: `Closed ${id}`,
		summary: `Session closed from ${agent.folderName}`,
	});
	if (state.historySessions.length > 12) {
		state.historySessions.length = 12;
	}
	sendHistorySessions(window, state);
}

function handleWebviewMessage(
	window: BrowserWindow,
	state: DesktopHostState,
	message: WebviewToExtensionMessage,
): void {
	switch (message.type) {
		case 'webviewReady':
			console.log('[desktop-electrobun] webviewReady');
			syncSnapshot(window, state);
			return;
		case 'openClaude':
			addLiveAgent(window, state, message.folderPath);
			return;
		case 'focusAgent':
			if (!state.agents.has(message.id)) return;
			state.selectedAgentId = message.id;
			postToWebview(window, { type: 'agentSelected', id: message.id });
			return;
		case 'closeAgent':
			closeLiveAgent(window, state, message.id);
			return;
		case 'setSoundEnabled':
			state.settings.soundEnabled = message.enabled;
			sendSettings(window, state);
			return;
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
		case 'openHistorySession': {
			const history = state.historySessions.find((entry) => entry.id === message.historyId);
			if (!history) return;
			const existing = state.agents.get(message.historyId);
			if (!existing) {
				const agent: DesktopAgent = {
					id: message.historyId,
					folderName: 'workspace/history',
					status: 'active',
					palette: state.agents.size % 6,
					hueShift: 0,
					seatId: null,
				};
				state.agents.set(agent.id, agent);
				postToWebview(window, {
					type: 'agentCreated',
					id: agent.id,
					folderName: agent.folderName,
				});
				postToWebview(window, {
					type: 'agentToolStart',
					id: agent.id,
					toolId: `tool:${agent.id}:resume`,
					status: `Resume ${history.sessionId.slice(0, 8)}...`,
				});
			}
			state.selectedAgentId = message.historyId;
			postToWebview(window, { type: 'agentSelected', id: message.historyId });
			return;
		}
		default:
			console.log(`[desktop-electrobun] webview message ignored: ${message.type}`);
			return;
	}
}

function run(): void {
	const state = createInitialState();

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

	console.log('[desktop-electrobun] loading views://pixel/index.html');
}

run();
