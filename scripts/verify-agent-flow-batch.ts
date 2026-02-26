import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { processTranscriptLine } from '../src/transcriptParser.js';

interface AgentStateLike {
	id: number;
	terminalRef: unknown;
	projectDir: string;
	jsonlFile: string;
	fileOffset: number;
	lineBuffer: string;
	activeToolIds: Set<string>;
	activeToolStatuses: Map<string, string>;
	activeToolNames: Map<string, string>;
	activeSubagentToolIds: Map<string, Set<string>>;
	activeSubagentToolNames: Map<string, Map<string, string>>;
	isWaiting: boolean;
	permissionSent: boolean;
	hadToolsInTurn: boolean;
}

type Message = { type?: string; [key: string]: unknown };

interface FlowStats {
	jsonlFile: string;
	lineCount: number;
	rawToolUseCount: number;
	rawSubagentToolUseCount: number;
	toolStartCount: number;
	subagentToolStartCount: number;
	activeStatusCount: number;
	waitingStatusCount: number;
	pass: boolean;
	failures: string[];
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

function resolveProjectDir(cwd: string): string | null {
	const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
	const normalizedPath = normalizeWorkspacePath(cwd);
	const candidates = new Set<string>([
		path.join(projectsRoot, currentDirNameForWorkspace(normalizedPath)),
		path.join(projectsRoot, legacyDirNameForWorkspace(normalizedPath)),
	]);

	try {
		const real = fs.realpathSync(normalizedPath);
		const normalizedReal = normalizeWorkspacePath(real);
		candidates.add(path.join(projectsRoot, currentDirNameForWorkspace(normalizedReal)));
		candidates.add(path.join(projectsRoot, legacyDirNameForWorkspace(normalizedReal)));
	} catch {
		// ignore
	}

	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}

	return null;
}

function pickLatestJsonl(projectDir: string, limit: number): string[] {
	return fs
		.readdirSync(projectDir)
		.filter((name) => name.endsWith('.jsonl'))
		.map((name) => path.join(projectDir, name))
		.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
		.slice(0, Math.max(1, limit));
}

function clearAllTimers(timers: Map<number, ReturnType<typeof setTimeout>>): void {
	for (const timer of timers.values()) {
		clearTimeout(timer);
	}
	timers.clear();
}

function countRawSignals(lines: string[]): { rawToolUseCount: number; rawSubagentToolUseCount: number } {
	let rawToolUseCount = 0;
	let rawSubagentToolUseCount = 0;
	for (const line of lines) {
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}

		if (record.type === 'assistant' && Array.isArray((record.message as Record<string, unknown> | undefined)?.content)) {
			const content = ((record.message as Record<string, unknown>).content || []) as Array<{ type?: string }>;
			rawToolUseCount += content.filter((block) => block.type === 'tool_use').length;
		}

		if (record.type === 'progress') {
			const data = record.data as Record<string, unknown> | undefined;
			const msg = data?.message as Record<string, unknown> | undefined;
			if (msg?.type !== 'assistant') continue;
			const inner = msg.message as Record<string, unknown> | undefined;
			const content = inner?.content;
			if (!Array.isArray(content)) continue;
			rawSubagentToolUseCount += (content as Array<{ type?: string }>).filter((block) => block.type === 'tool_use').length;
		}
	}
	return { rawToolUseCount, rawSubagentToolUseCount };
}

async function analyzeJsonl(jsonlFile: string): Promise<FlowStats> {
	const projectDir = path.dirname(jsonlFile);
	const content = fs.readFileSync(jsonlFile, 'utf-8');
	const lines = content.split('\n').filter((line) => line.trim().length > 0);
	const { rawToolUseCount, rawSubagentToolUseCount } = countRawSignals(lines);

	const agents = new Map<number, AgentStateLike>();
	agents.set(1, {
		id: 1,
		terminalRef: null,
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
	});

	const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
	const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
	const emitted: Message[] = [];
	const webview = {
		postMessage(message: unknown): void {
			emitted.push((message || {}) as Message);
		},
	};

	for (const line of lines) {
		processTranscriptLine(
			1,
			line,
			agents as unknown as Map<number, never>,
			waitingTimers,
			permissionTimers,
			webview as never,
		);
	}

	// flush delayed events
	await new Promise((resolve) => setTimeout(resolve, 350));
	clearAllTimers(waitingTimers);
	clearAllTimers(permissionTimers);

	const toolStartCount = emitted.filter((m) => m.type === 'agentToolStart').length;
	const subagentToolStartCount = emitted.filter((m) => m.type === 'subagentToolStart').length;
	const activeStatusCount = emitted.filter((m) => m.type === 'agentStatus' && m.status === 'active').length;
	const waitingStatusCount = emitted.filter((m) => m.type === 'agentStatus' && m.status === 'waiting').length;

	const failures: string[] = [];
	if (rawToolUseCount > 0 && toolStartCount === 0) {
		failures.push('raw tool_use exists but no agentToolStart emitted');
	}
	if (toolStartCount > 0 && activeStatusCount === 0) {
		failures.push('agentToolStart exists but no agentStatus(active) emitted');
	}
	if (rawSubagentToolUseCount > 0 && subagentToolStartCount === 0) {
		failures.push('raw subagent tool_use exists but no subagentToolStart emitted');
	}

	return {
		jsonlFile,
		lineCount: lines.length,
		rawToolUseCount,
		rawSubagentToolUseCount,
		toolStartCount,
		subagentToolStartCount,
		activeStatusCount,
		waitingStatusCount,
		pass: failures.length === 0,
		failures,
	};
}

function parseArgs(): { projectDirArg: string | null; limit: number } {
	const args = process.argv.slice(2);
	let projectDirArg: string | null = null;
	let limit = 5;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '--limit' && args[i + 1]) {
			const parsed = Number.parseInt(args[i + 1], 10);
			if (Number.isFinite(parsed) && parsed > 0) {
				limit = parsed;
			}
			i++;
			continue;
		}
		if (!arg.startsWith('--') && !projectDirArg) {
			projectDirArg = arg;
		}
	}
	return { projectDirArg, limit };
}

async function main(): Promise<void> {
	const { projectDirArg, limit } = parseArgs();
	const cwd = process.cwd();
	const projectDir = projectDirArg || resolveProjectDir(cwd);
	if (!projectDir) {
		console.error('[verify-agent-flow-batch] FAIL: project dir not found');
		process.exit(1);
	}
	if (!fs.existsSync(projectDir)) {
		console.error(`[verify-agent-flow-batch] FAIL: project dir does not exist: ${projectDir}`);
		process.exit(1);
	}

	const jsonlFiles = pickLatestJsonl(projectDir, limit);
	if (jsonlFiles.length === 0) {
		console.error(`[verify-agent-flow-batch] FAIL: no jsonl files found in ${projectDir}`);
		process.exit(1);
	}

	console.log(`[verify-agent-flow-batch] projectDir=${projectDir}`);
	console.log(`[verify-agent-flow-batch] files=${jsonlFiles.length} limit=${limit}`);

	const results: FlowStats[] = [];
	for (const jsonlFile of jsonlFiles) {
		results.push(await analyzeJsonl(jsonlFile));
	}

	let failed = 0;
	for (const result of results) {
		const status = result.pass ? 'PASS' : 'FAIL';
		const name = path.basename(result.jsonlFile);
		console.log(`[verify-agent-flow-batch] ${status} ${name} lines=${result.lineCount} rawToolUse=${result.rawToolUseCount} toolStart=${result.toolStartCount} rawSubToolUse=${result.rawSubagentToolUseCount} subToolStart=${result.subagentToolStartCount} active=${result.activeStatusCount} waiting=${result.waitingStatusCount}`);
		if (!result.pass) {
			failed++;
			for (const failure of result.failures) {
				console.log(`[verify-agent-flow-batch]   -> ${failure}`);
			}
		}
	}

	if (failed > 0) {
		console.error(`[verify-agent-flow-batch] FAIL: ${failed}/${results.length} files failed`);
		process.exit(1);
	}

	console.log('[verify-agent-flow-batch] PASS');
}

main().catch((error) => {
	console.error('[verify-agent-flow-batch] FAIL:', error);
	process.exit(1);
});
