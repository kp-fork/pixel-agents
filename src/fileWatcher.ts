import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { decideJsonlRouting } from './application/tracking/jsonlRouting.js';
import { FILE_WATCHER_POLL_INTERVAL_MS, PROJECT_SCAN_INTERVAL_MS, TERMINAL_NAME_PREFIX } from './constants.js';
import { postToWebview } from './contracts/postMessage.js';
import { cancelPermissionTimer, cancelWaitingTimer, clearAgentActivity } from './timerManager.js';
import { processTranscriptLine } from './transcriptParser.js';
import type { AgentId, AgentState } from './types.js';

export function startFileWatching(
	agentId: AgentId,
	filePath: string,
	agents: Map<AgentId, AgentState>,
	fileWatchers: Map<AgentId, fs.FSWatcher>,
	pollingTimers: Map<AgentId, ReturnType<typeof setInterval>>,
	waitingTimers: Map<AgentId, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<AgentId, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	// Primary: fs.watch (unreliable on macOS — may miss events)
	try {
		const watcher = fs.watch(filePath, () => {
			readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);
		});
		fileWatchers.set(agentId, watcher);
	} catch (e) {
		console.log(`[Pixel Agents] fs.watch failed for agent ${agentId}: ${e}`);
	}

	// Secondary: fs.watchFile (stat-based polling, reliable on macOS)
	try {
		fs.watchFile(filePath, { interval: FILE_WATCHER_POLL_INTERVAL_MS }, () => {
			readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);
		});
	} catch (e) {
		console.log(`[Pixel Agents] fs.watchFile failed for agent ${agentId}: ${e}`);
	}

	// Tertiary: manual poll as last resort
	const interval = setInterval(() => {
		if (!agents.has(agentId)) {
			clearInterval(interval);
			try { fs.unwatchFile(filePath); } catch { /* ignore */ }
			return;
		}
		readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);
	}, FILE_WATCHER_POLL_INTERVAL_MS);
	pollingTimers.set(agentId, interval);
}

export function readNewLines(
	agentId: AgentId,
	agents: Map<AgentId, AgentState>,
	waitingTimers: Map<AgentId, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<AgentId, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;
	try {
		const stat = fs.statSync(agent.jsonlFile);
		if (stat.size <= agent.fileOffset) return;

		const buf = Buffer.alloc(stat.size - agent.fileOffset);
		const fd = fs.openSync(agent.jsonlFile, 'r');
		fs.readSync(fd, buf, 0, buf.length, agent.fileOffset);
		fs.closeSync(fd);
		agent.fileOffset = stat.size;

		const text = agent.lineBuffer + buf.toString('utf-8');
		const lines = text.split('\n');
		agent.lineBuffer = lines.pop() || '';

		const hasLines = lines.some(l => l.trim());
		if (hasLines) {
			// New data arriving — cancel timers (data flowing means agent is still active)
			cancelWaitingTimer(agentId, waitingTimers);
			cancelPermissionTimer(agentId, permissionTimers);
			if (agent.permissionSent) {
				agent.permissionSent = false;
				postToWebview(webview, { type: 'agentToolPermissionClear', id: agentId });
			}
		}

		for (const line of lines) {
			if (!line.trim()) continue;
			processTranscriptLine(agentId, line, agents, waitingTimers, permissionTimers, webview);
		}
	} catch (e) {
		console.log(`[Pixel Agents] Read error for agent ${agentId}: ${e}`);
	}
}

export function ensureProjectScan(
	projectDir: string,
	knownJsonlFiles: Set<string>,
	projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
	activeAgentIdRef: { current: AgentId | null },
	agents: Map<AgentId, AgentState>,
	fileWatchers: Map<AgentId, fs.FSWatcher>,
	pollingTimers: Map<AgentId, ReturnType<typeof setInterval>>,
	waitingTimers: Map<AgentId, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<AgentId, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
): void {
	if (projectScanTimerRef.current) return;
	// Seed with all existing JSONL files so we only react to truly new ones
	try {
		const files = fs.readdirSync(projectDir)
			.filter(f => f.endsWith('.jsonl'))
			.map(f => path.join(projectDir, f));
		for (const f of files) {
			knownJsonlFiles.add(f);
		}
	} catch { /* dir may not exist yet */ }

	projectScanTimerRef.current = setInterval(() => {
		scanForNewJsonlFiles(
			projectDir, knownJsonlFiles, activeAgentIdRef,
			agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers,
			webview, persistAgents,
		);
	}, PROJECT_SCAN_INTERVAL_MS);
}

function scanForNewJsonlFiles(
	projectDir: string,
	knownJsonlFiles: Set<string>,
	activeAgentIdRef: { current: AgentId | null },
	agents: Map<AgentId, AgentState>,
	fileWatchers: Map<AgentId, fs.FSWatcher>,
	pollingTimers: Map<AgentId, ReturnType<typeof setInterval>>,
	waitingTimers: Map<AgentId, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<AgentId, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
): void {
	let files: string[];
	try {
		files = fs.readdirSync(projectDir)
			.filter(f => f.endsWith('.jsonl'))
			.map(f => path.join(projectDir, f));
	} catch { return; }

	for (const file of files) {
		if (!knownJsonlFiles.has(file)) {
			knownJsonlFiles.add(file);

			const activeTerminal = vscode.window.activeTerminal;
			const routing = decideJsonlRouting(
				activeAgentIdRef.current,
				activeTerminal,
				Array.from(agents.values())
					.filter((agent) => agent.terminalRef !== undefined)
					.map((agent) => ({ id: agent.id, terminalRef: agent.terminalRef })),
			);
			if (routing.action === 'reassign') {
				console.log(`[Pixel Agents] New JSONL detected: ${path.basename(file)}, reassigning to agent ${routing.agentId}`);
				reassignAgentToFile(
					routing.agentId, file,
					agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers,
					webview, persistAgents,
				);
			} else if (routing.action === 'adopt' && activeTerminal) {
				adoptTerminalForFile(
					activeTerminal, file, projectDir,
					agents, activeAgentIdRef,
					fileWatchers, pollingTimers, waitingTimers, permissionTimers,
					webview, persistAgents,
				);
			} else {
				// Fallback: if exactly one untracked Claude terminal exists, bind it.
				const fallbackTerminal = findSingleUntrackedClaudeTerminal(agents);
				if (fallbackTerminal) {
					adoptTerminalForFile(
						fallbackTerminal, file, projectDir,
						agents, activeAgentIdRef,
						fileWatchers, pollingTimers, waitingTimers, permissionTimers,
						webview, persistAgents,
					);
				}
			}
		}
	}
}

function findSingleUntrackedClaudeTerminal(
	agents: Map<AgentId, AgentState>,
): vscode.Terminal | null {
	const tracked = new Set(
		Array.from(agents.values())
			.map((agent) => agent.terminalRef)
			.filter((terminal): terminal is vscode.Terminal => terminal !== undefined),
	);
	const candidates = vscode.window.terminals.filter((terminal) =>
		terminal.name.startsWith(TERMINAL_NAME_PREFIX) && !tracked.has(terminal),
	);
	return candidates.length === 1 ? candidates[0] : null;
}

function adoptTerminalForFile(
	terminal: vscode.Terminal,
	jsonlFile: string,
	projectDir: string,
	agents: Map<AgentId, AgentState>,
	activeAgentIdRef: { current: AgentId | null },
	fileWatchers: Map<AgentId, fs.FSWatcher>,
	pollingTimers: Map<AgentId, ReturnType<typeof setInterval>>,
	waitingTimers: Map<AgentId, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<AgentId, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
): void {
	const id = path.basename(jsonlFile, '.jsonl');
	if (!/^[0-9a-fA-F-]{36}$/.test(id)) {
		console.log(`[Pixel Agents] Skip adopt: invalid session id from file ${path.basename(jsonlFile)}`);
		return;
	}
	if (agents.has(id)) {
		activeAgentIdRef.current = id;
		return;
	}
	const agent: AgentState = {
		id,
		sessionId: id,
		terminalRef: terminal,
		isExternal: false,
		projectDir,
		jsonlFile,
		fileOffset: 0,
		lineBuffer: '',
		activeToolIds: new Set(),
		activeToolStatuses: new Map(),
		activeToolNames: new Map(),
		activeSubagentToolIds: new Map(),
		activeSubagentToolNames: new Map(),
		backgroundAgentToolIds: new Set(),
		isWaiting: false,
		permissionSent: false,
		hadToolsInTurn: false,
		lastDataAt: 0,
		linesProcessed: 0,
		seenUnknownRecordTypes: new Set(),
		hookDelivered: false,
		inputTokens: 0,
		outputTokens: 0,
	};

	agents.set(id, agent);
	activeAgentIdRef.current = id;
	persistAgents();

	console.log(`[Pixel Agents] Agent ${id}: adopted terminal "${terminal.name}" for ${path.basename(jsonlFile)}`);
	postToWebview(webview, { type: 'agentCreated', id });

	startFileWatching(id, jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
	readNewLines(id, agents, waitingTimers, permissionTimers, webview);
}

export function reassignAgentToFile(
	agentId: AgentId,
	newFilePath: string,
	agents: Map<AgentId, AgentState>,
	fileWatchers: Map<AgentId, fs.FSWatcher>,
	pollingTimers: Map<AgentId, ReturnType<typeof setInterval>>,
	waitingTimers: Map<AgentId, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<AgentId, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;

	// Stop old file watching
	fileWatchers.get(agentId)?.close();
	fileWatchers.delete(agentId);
	const pt = pollingTimers.get(agentId);
	if (pt) { clearInterval(pt); }
	pollingTimers.delete(agentId);
	try { fs.unwatchFile(agent.jsonlFile); } catch { /* ignore */ }

	// Clear activity
	cancelWaitingTimer(agentId, waitingTimers);
	cancelPermissionTimer(agentId, permissionTimers);
	clearAgentActivity(agent, agentId, permissionTimers, webview);

	// Swap to new file
	agent.jsonlFile = newFilePath;
	agent.fileOffset = 0;
	agent.lineBuffer = '';
	persistAgents();

	// Start watching new file
	startFileWatching(agentId, newFilePath, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
	readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);
}
