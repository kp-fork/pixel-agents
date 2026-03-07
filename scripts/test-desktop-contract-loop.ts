import { spawn } from 'node:child_process';
import { cleanupDesktopProcesses, requestDesktopChildStop } from './lib/desktopProcessCleanup.js';

const RUN_COUNT = Number.parseInt(process.env['PIXEL_AGENTS_CONTRACT_RUNS'] ?? '10', 10);
const TIMEOUT_MS = 240_000;

function runSingle(iteration: number): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const startedAt = Date.now();
		const child = spawn('npm', ['run', '-s', 'test:desktop-trace'], {
			cwd: process.cwd(),
			env: {
				...process.env,
				PIXEL_AGENTS_TRACE_CONTRACT: '1',
			},
			stdio: ['ignore', 'pipe', 'pipe'],
			shell: process.platform === 'win32',
			detached: process.platform !== 'win32',
		});

		let output = '';
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
			if (settled) return;
			settled = true;
			requestDesktopChildStop(child, 'SIGINT');
			void cleanupDesktopProcesses(process.cwd());
			reject(new Error(`[test-desktop-contract-loop] run ${iteration} timeout after ${TIMEOUT_MS}ms\n${output}`));
		}, TIMEOUT_MS);

		const clear = () => {
			if (timeout) clearTimeout(timeout);
			timeout = null;
		};

		const onChunk = (raw: Buffer | string) => {
			const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
			output += text;
			if (output.length > 24_000) {
				output = output.slice(output.length - 24_000);
			}
		};

		child.stdout?.on('data', onChunk);
		child.stderr?.on('data', onChunk);

		child.on('error', (error) => {
			if (settled) return;
			settled = true;
			clear();
			reject(new Error(`[test-desktop-contract-loop] run ${iteration} spawn failed: ${error.message}`));
		});

		child.on('close', (code) => {
			if (settled) return;
			settled = true;
			clear();
			const elapsedMs = Date.now() - startedAt;
			cleanupDesktopProcesses(process.cwd())
				.then((cleanup) => {
					if (code === 0) {
						console.log(
							`[test-desktop-contract-loop] run ${iteration}/${RUN_COUNT} PASS (${elapsedMs}ms, cleanup term=${cleanup.terminated}, kill=${cleanup.forceKilled})`,
						);
						resolve();
						return;
					}
					reject(new Error(`[test-desktop-contract-loop] run ${iteration} failed (code ${code ?? -1})\n${output}`));
				})
				.catch((error) => {
					reject(new Error(`[test-desktop-contract-loop] run ${iteration} cleanup failed: ${String(error)}`));
				});
		});
	});
}

async function main(): Promise<void> {
	if (!Number.isFinite(RUN_COUNT) || RUN_COUNT <= 0) {
		throw new Error(`[test-desktop-contract-loop] invalid run count: ${String(RUN_COUNT)}`);
	}
	console.log(`[test-desktop-contract-loop] start runs=${RUN_COUNT}`);
	for (let i = 1; i <= RUN_COUNT; i += 1) {
		await runSingle(i);
	}
	const cleanup = await cleanupDesktopProcesses(process.cwd());
	console.log(`[test-desktop-contract-loop] final cleanup term=${cleanup.terminated} kill=${cleanup.forceKilled}`);
	console.log('[test-desktop-contract-loop] PASS');
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
