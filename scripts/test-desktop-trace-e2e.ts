import { spawn } from 'node:child_process';
import { cleanupDesktopProcesses, requestDesktopChildStop } from './lib/desktopProcessCleanup.js';

interface TraceRuntimeCheckResult {
	sawServerStart: boolean;
	sawWebviewReady: boolean;
	sawTraceStart: boolean;
	sawTraceAck: boolean;
	sawStaleInputIgnored: boolean;
	sawStaleResizeIgnored: boolean;
	sawStaleCloseIgnored: boolean;
	traceStartId: string | null;
	traceAckId: string | null;
	outputTail: string;
	exitCode: number | null;
}

const STARTUP_TIMEOUT_MS = 180_000;
const OUTPUT_TAIL_MAX_CHARS = 120_000;
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const REQUIRE_CONTRACT_PROBE = process.env['PIXEL_AGENTS_TRACE_CONTRACT'] === '1';

function appendTail(current: string, chunk: string): string {
	const next = current + chunk;
	if (next.length <= OUTPUT_TAIL_MAX_CHARS) return next;
	return next.slice(next.length - OUTPUT_TAIL_MAX_CHARS);
}

function normalizeForMatch(text: string): string {
	return text.replace(ANSI_ESCAPE_PATTERN, '');
}

function extractTraceStartId(text: string): string | null {
	return text.match(/trace\s+smoke\s+start\s+([^\s\r\n)]+)/)?.[1] ?? null;
}

function extractTraceAckId(text: string): string | null {
	return text.match(/trace\s+ack\s+\(([^)\r\n]+)\)/)?.[1] ?? null;
}

async function runTraceRuntimeCheck(): Promise<TraceRuntimeCheckResult> {
	return new Promise<TraceRuntimeCheckResult>((resolve, reject) => {
		const child = spawn('npm', ['run', 'dev:desktop'], {
			cwd: process.cwd(),
			env: {
				...process.env,
				PIXEL_AGENTS_TRACE_SMOKE: '1',
			},
			stdio: ['ignore', 'pipe', 'pipe'],
			shell: process.platform === 'win32',
			detached: process.platform !== 'win32',
		});

		let outputTail = '';
		let sawServerStart = false;
		let sawWebviewReady = false;
		let sawTraceStart = false;
		let sawTraceAck = false;
		let sawStaleInputIgnored = false;
		let sawStaleResizeIgnored = false;
		let sawStaleCloseIgnored = false;
		let traceStartId: string | null = null;
		let traceAckId: string | null = null;
		let resolved = false;
		let startupTimer: ReturnType<typeof setTimeout> | null = null;

		const clearTimers = () => {
			if (startupTimer) clearTimeout(startupTimer);
			startupTimer = null;
		};

		const finish = (result: TraceRuntimeCheckResult): void => {
			if (resolved) return;
			resolved = true;
			clearTimers();
			resolve(result);
		};

		const fail = (message: string): void => {
			if (resolved) return;
			resolved = true;
			clearTimers();
			requestDesktopChildStop(child, 'SIGINT');
			void cleanupDesktopProcesses(process.cwd());
			reject(new Error(`[test-desktop-trace] ${message}\n--- output tail ---\n${outputTail}`));
		};

		const tryFinishFromProbe = (): void => {
			if (!sawTraceAck) return;
			if (REQUIRE_CONTRACT_PROBE && (!sawStaleInputIgnored || !sawStaleResizeIgnored || !sawStaleCloseIgnored)) {
				return;
			}
			requestDesktopChildStop(child, 'SIGINT');
			const normalizedTail = normalizeForMatch(outputTail);
			const finalStartId = traceStartId ?? extractTraceStartId(normalizedTail);
			const finalAckId = traceAckId ?? extractTraceAckId(normalizedTail);
			finish({
				sawServerStart: sawServerStart || normalizedTail.includes('Server started at http://localhost:'),
				sawWebviewReady: sawWebviewReady || normalizedTail.includes('[desktop] webviewReady'),
				sawTraceStart: sawTraceStart || Boolean(finalStartId),
				sawTraceAck: sawTraceAck || Boolean(finalAckId),
				sawStaleInputIgnored: sawStaleInputIgnored || normalizedTail.includes('[desktop] stale terminalInput ignored'),
				sawStaleResizeIgnored: sawStaleResizeIgnored || normalizedTail.includes('[desktop] stale terminalResize ignored'),
				sawStaleCloseIgnored: sawStaleCloseIgnored || normalizedTail.includes('[desktop] stale terminalClose ignored'),
				traceStartId: finalStartId,
				traceAckId: finalAckId,
				outputTail,
				exitCode: null,
			});
		};

		const onChunk = (raw: Buffer | string): void => {
			const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
			outputTail = appendTail(outputTail, text);
			const normalizedChunk = normalizeForMatch(text);
			const normalizedTail = normalizeForMatch(outputTail);

			if (normalizedTail.includes('Server started at http://localhost:') || normalizedChunk.includes('Server started at http://localhost:')) {
				sawServerStart = true;
			}
			if (normalizedTail.includes('[desktop] webviewReady') || normalizedChunk.includes('[desktop] webviewReady')) {
				sawWebviewReady = true;
			}
			if (normalizedTail.includes('[desktop] stale terminalInput ignored') || normalizedChunk.includes('[desktop] stale terminalInput ignored')) {
				sawStaleInputIgnored = true;
			}
			if (normalizedTail.includes('[desktop] stale terminalResize ignored') || normalizedChunk.includes('[desktop] stale terminalResize ignored')) {
				sawStaleResizeIgnored = true;
			}
			if (normalizedTail.includes('[desktop] stale terminalClose ignored') || normalizedChunk.includes('[desktop] stale terminalClose ignored')) {
				sawStaleCloseIgnored = true;
			}

			const chunkTraceStartId = extractTraceStartId(normalizedChunk) ?? extractTraceStartId(normalizedTail);
			if (chunkTraceStartId) {
				traceStartId = chunkTraceStartId;
				sawTraceStart = true;
			}

			const chunkTraceAckId = extractTraceAckId(normalizedChunk) ?? extractTraceAckId(normalizedTail);
			if (chunkTraceAckId) {
				traceAckId = chunkTraceAckId;
				sawTraceAck = true;
			}

			tryFinishFromProbe();
		};

		child.stdout?.on('data', onChunk);
		child.stderr?.on('data', onChunk);

		startupTimer = setTimeout(() => {
			fail(`timeout after ${STARTUP_TIMEOUT_MS}ms waiting for trace ack`);
		}, STARTUP_TIMEOUT_MS);

		child.on('error', (error) => {
			fail(`failed to spawn desktop runtime: ${error.message}`);
		});

		child.on('close', (code) => {
			const normalizedTail = normalizeForMatch(outputTail);
			const finalStartId = traceStartId ?? extractTraceStartId(normalizedTail);
			const finalAckId = traceAckId ?? extractTraceAckId(normalizedTail);
			finish({
				sawServerStart: sawServerStart || normalizedTail.includes('Server started at http://localhost:'),
				sawWebviewReady: sawWebviewReady || normalizedTail.includes('[desktop] webviewReady'),
				sawTraceStart: sawTraceStart || Boolean(finalStartId),
				sawTraceAck: sawTraceAck || Boolean(finalAckId),
				sawStaleInputIgnored: sawStaleInputIgnored || normalizedTail.includes('[desktop] stale terminalInput ignored'),
				sawStaleResizeIgnored: sawStaleResizeIgnored || normalizedTail.includes('[desktop] stale terminalResize ignored'),
				sawStaleCloseIgnored: sawStaleCloseIgnored || normalizedTail.includes('[desktop] stale terminalClose ignored'),
				traceStartId: finalStartId,
				traceAckId: finalAckId,
				outputTail,
				exitCode: code,
			});
		});
	});
}

async function main(): Promise<void> {
	const result = await runTraceRuntimeCheck();
	const cleanup = await cleanupDesktopProcesses(process.cwd());

	console.log(`[test-desktop-trace] sawServerStart=${result.sawServerStart}`);
	console.log(`[test-desktop-trace] sawWebviewReady=${result.sawWebviewReady}`);
	console.log(`[test-desktop-trace] sawTraceStart=${result.sawTraceStart} id=${result.traceStartId ?? '-'}`);
	console.log(`[test-desktop-trace] sawTraceAck=${result.sawTraceAck} id=${result.traceAckId ?? '-'}`);
	if (REQUIRE_CONTRACT_PROBE) {
		console.log(`[test-desktop-trace] sawStaleInputIgnored=${result.sawStaleInputIgnored}`);
		console.log(`[test-desktop-trace] sawStaleResizeIgnored=${result.sawStaleResizeIgnored}`);
		console.log(`[test-desktop-trace] sawStaleCloseIgnored=${result.sawStaleCloseIgnored}`);
	}
	console.log(`[test-desktop-trace] exitCode=${result.exitCode ?? -1}`);
	console.log(`[test-desktop-trace] cleanup terminated=${cleanup.terminated} forceKilled=${cleanup.forceKilled}`);

	if (!result.sawServerStart) {
		throw new Error('[test-desktop-trace] FAIL: server start log not found');
	}
	if (!result.sawWebviewReady) {
		throw new Error('[test-desktop-trace] FAIL: webviewReady log not found');
	}
	if (!result.sawTraceStart || !result.traceStartId) {
		throw new Error('[test-desktop-trace] FAIL: trace smoke start log not found');
	}
	if (!result.sawTraceAck || !result.traceAckId) {
		throw new Error('[test-desktop-trace] FAIL: trace ack log not found');
	}
	if (result.traceStartId !== result.traceAckId) {
		throw new Error(`[test-desktop-trace] FAIL: trace id mismatch start=${result.traceStartId} ack=${result.traceAckId}`);
	}
	if (REQUIRE_CONTRACT_PROBE) {
		if (!result.sawStaleInputIgnored) {
			throw new Error('[test-desktop-trace] FAIL: stale terminalInput ignore log not found');
		}
		if (!result.sawStaleResizeIgnored) {
			throw new Error('[test-desktop-trace] FAIL: stale terminalResize ignore log not found');
		}
		if (!result.sawStaleCloseIgnored) {
			throw new Error('[test-desktop-trace] FAIL: stale terminalClose ignore log not found');
		}
	}
	if (result.exitCode !== 0 && result.exitCode !== null) {
		throw new Error(`[test-desktop-trace] FAIL: expected exit code 0|null, got ${result.exitCode}`);
	}

	console.log('[test-desktop-trace] PASS');
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
