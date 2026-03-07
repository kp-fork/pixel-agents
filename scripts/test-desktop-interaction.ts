import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { cleanupDesktopProcesses, requestDesktopChildStop } from './lib/desktopProcessCleanup.js';

const STARTUP_TIMEOUT_MS = 180_000;
const OUTPUT_TAIL_MAX_CHARS = 120_000;
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const REQUIRED_MARKERS = [
	'[desktop] interaction smoke step=terminalCreateA',
	'[desktop] interaction smoke step=openClaude',
	'[desktop] interaction smoke step=terminalToggleOff',
	'[desktop] interaction smoke step=terminalToggleOn',
	'[desktop] interaction smoke step=openHistorySession',
	'[desktop] interaction smoke PASS',
];

function normalizeForMatch(text: string): string {
	return text.replace(ANSI_ESCAPE_PATTERN, '');
}

function appendTail(current: string, chunk: string): string {
	const next = current + chunk;
	if (next.length <= OUTPUT_TAIL_MAX_CHARS) return next;
	return next.slice(next.length - OUTPUT_TAIL_MAX_CHARS);
}

function currentDirNameForWorkspace(value: string): string {
	return value.replace(/[^A-Za-z0-9]/g, '-');
}

function legacyDirNameForWorkspace(value: string): string {
	return value.replace(/[:\\/]/g, '-');
}

function setupFixtureWorkspace(): { tempRoot: string; workspaceRoot: string; homeDir: string } {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-desktop-interaction-'));
	const workspaceRoot = path.join(tempRoot, 'workspace');
	const homeDir = path.join(tempRoot, 'home');
	const projectsRoot = path.join(homeDir, '.claude', 'projects');

	fs.mkdirSync(workspaceRoot, { recursive: true });
	fs.mkdirSync(projectsRoot, { recursive: true });

	const historyDate = new Date(Date.now() - (2 * 24 * 60 * 60 * 1000));
	const nowIso = historyDate.toISOString();
	const historySessionId = '9f25f57e-8b9a-4522-8fff-8dcd7c7f1a5d';
	const historyJsonl = [
		JSON.stringify({
			type: 'user',
			sessionId: historySessionId,
			timestamp: nowIso,
			message: { content: 'Please summarize the latest terminal behavior.' },
		}),
		JSON.stringify({
			type: 'assistant',
			sessionId: historySessionId,
			timestamp: nowIso,
			message: { content: 'Summary: terminal tracing is active and output path is healthy.' },
		}),
	].join('\n');

	const workspaceCandidates = new Set<string>([
		path.join(projectsRoot, currentDirNameForWorkspace(workspaceRoot)),
		path.join(projectsRoot, legacyDirNameForWorkspace(workspaceRoot)),
	]);
	for (const candidate of workspaceCandidates) {
		fs.mkdirSync(candidate, { recursive: true });
		const jsonlPath = path.join(candidate, `${historySessionId}.jsonl`);
		fs.writeFileSync(jsonlPath, historyJsonl, 'utf-8');
		fs.utimesSync(jsonlPath, historyDate, historyDate);
	}

	const settings = {
		'pixel-agents.historySessions.enabled': true,
		'pixel-agents.historySessions.lookbackDays': 14,
		'pixel-agents.historySessions.maxVisible': 8,
		'pixel-agents.claudeLaunchCommand': 'echo __PA_INTERACTION_LAUNCH__',
		'pixel-agents.claudeResumeCommand': 'echo __PA_INTERACTION_RESUME__ {sessionId}',
	};
	fs.writeFileSync(path.join(workspaceRoot, 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8');

	return { tempRoot, workspaceRoot, homeDir };
}

async function runDesktopInteractionGate(
	workspaceRoot: string,
	homeDir: string,
): Promise<{ outputTail: string; exitCode: number | null }> {
	return new Promise((resolve, reject) => {
		const child = spawn('npm', ['run', 'dev:desktop'], {
			cwd: process.cwd(),
			env: {
				...process.env,
				HOME: homeDir,
				PIXEL_AGENTS_WORKSPACE: workspaceRoot,
				PIXEL_AGENTS_INTERACTION_SMOKE: '1',
			},
			stdio: ['ignore', 'pipe', 'pipe'],
			shell: process.platform === 'win32',
			detached: process.platform !== 'win32',
		});

		let outputTail = '';
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
			if (settled) return;
			settled = true;
			requestDesktopChildStop(child, 'SIGINT');
			void cleanupDesktopProcesses(process.cwd());
			reject(new Error(`[test-desktop-interaction] timeout after ${STARTUP_TIMEOUT_MS}ms`));
		}, STARTUP_TIMEOUT_MS);

		const clear = () => {
			if (timeout) clearTimeout(timeout);
			timeout = null;
		};

		const onChunk = (raw: Buffer | string): void => {
			const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
			outputTail = appendTail(outputTail, text);
			const normalized = normalizeForMatch(outputTail);
			if (normalized.includes('[desktop] interaction smoke FAIL:')) {
				if (settled) return;
				settled = true;
				clear();
				requestDesktopChildStop(child, 'SIGINT');
				void cleanupDesktopProcesses(process.cwd());
				reject(
					new Error(
						`[test-desktop-interaction] interaction smoke reported FAIL\n--- output tail ---\n${outputTail}`,
					),
				);
				return;
			}
			if (normalized.includes('[desktop] interaction smoke PASS')) {
				requestDesktopChildStop(child, 'SIGINT');
			}
		};

		child.stdout?.on('data', onChunk);
		child.stderr?.on('data', onChunk);

		child.on('error', (error) => {
			if (settled) return;
			settled = true;
			clear();
			reject(new Error(`[test-desktop-interaction] spawn failed: ${error.message}`));
		});

		child.on('close', (code) => {
			if (settled) return;
			settled = true;
			clear();
			resolve({ outputTail, exitCode: code });
		});
	});
}

async function main(): Promise<void> {
	const fixture = setupFixtureWorkspace();
	try {
		const result = await runDesktopInteractionGate(fixture.workspaceRoot, fixture.homeDir);
		const cleanup = await cleanupDesktopProcesses(process.cwd());
		const normalized = normalizeForMatch(result.outputTail);

		for (const marker of REQUIRED_MARKERS) {
			if (!normalized.includes(marker)) {
				throw new Error(`[test-desktop-interaction] missing marker: ${marker}`);
			}
		}
		if (normalized.includes('[desktop] interaction smoke FAIL:')) {
			throw new Error('[test-desktop-interaction] FAIL marker detected');
		}
		if (result.exitCode !== 0 && result.exitCode !== null) {
			throw new Error(
				`[test-desktop-interaction] unexpected exit code: ${result.exitCode}\n--- output tail ---\n${result.outputTail}`,
			);
		}

		console.log('[test-desktop-interaction] markers=PASS');
		console.log(`[test-desktop-interaction] exitCode=${result.exitCode ?? -1}`);
		console.log(`[test-desktop-interaction] cleanup terminated=${cleanup.terminated} forceKilled=${cleanup.forceKilled}`);
		console.log('[test-desktop-interaction] PASS');
	} finally {
		fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? `${error.message}` : String(error));
	process.exit(1);
});
