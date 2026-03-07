import { execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

const CLEANUP_GRACE_MS = 250;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePid(value: string): number | null {
	const n = Number.parseInt(value.trim(), 10);
	return Number.isFinite(n) && n > 0 ? n : null;
}

function listRepoDesktopPids(repoRoot: string): number[] {
	if (process.platform === 'win32') return [];
	let output = '';
	try {
		output = execFileSync('ps', ['-axo', 'pid=,command='], {
			encoding: 'utf-8',
		});
	} catch {
		return [];
	}

	const pids: number[] = [];
	for (const line of output.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const firstSpace = trimmed.indexOf(' ');
		if (firstSpace <= 0) continue;
		const pid = parsePid(trimmed.slice(0, firstSpace));
		if (!pid || pid === process.pid) continue;
		const command = trimmed.slice(firstSpace + 1);
		if (!command.includes(repoRoot)) continue;

		const isDesktopRuntime =
			command.includes(`${repoRoot}/apps/desktop`) &&
			(command.includes('electrobun') || command.includes('/Resources/main.js') || command.includes('/bun/index.ts'));
		const isNodePtyHelper =
			command.includes('/@lydell/node-pty-') && command.includes('/spawn-helper');

		if (isDesktopRuntime || isNodePtyHelper) {
			pids.push(pid);
		}
	}
	return pids;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function requestDesktopChildStop(child: ChildProcess, signal: NodeJS.Signals = 'SIGINT'): void {
	if (child.exitCode !== null || child.killed) return;
	if (process.platform !== 'win32' && typeof child.pid === 'number') {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {
			// Fall through to direct child signal.
		}
	}
	try {
		child.kill(signal);
	} catch {
		// noop
	}
}

export async function cleanupDesktopProcesses(
	repoRoot: string,
): Promise<{ terminated: number; forceKilled: number }> {
	const pids = listRepoDesktopPids(repoRoot);
	if (pids.length === 0) {
		return { terminated: 0, forceKilled: 0 };
	}

	let terminated = 0;
	for (const pid of pids) {
		try {
			process.kill(pid, 'SIGTERM');
			terminated += 1;
		} catch {
			// noop
		}
	}

	await sleep(CLEANUP_GRACE_MS);

	let forceKilled = 0;
	for (const pid of pids) {
		if (!isAlive(pid)) continue;
		try {
			process.kill(pid, 'SIGKILL');
			forceKilled += 1;
		} catch {
			// noop
		}
	}

	return { terminated, forceKilled };
}

