import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { cleanupDesktopProcesses } from './desktopProcessCleanup.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));

export const repoRoot = resolve(scriptDir, '..', '..');
export const desktopAppBundlePath = resolve(
	repoRoot,
	'apps/desktop/build/dev-macos-arm64/Pixel Agents Desktop-dev.app',
);

const WINDOW_POLL_INTERVAL_MS = 500;
const WINDOW_WAIT_TIMEOUT_MS = 30_000;
const DESKTOP_WINDOW_NAME = 'Pixel Agents Desktop';

function sleep(ms: number): Promise<void> {
	return new Promise((resolvePromise) => {
		setTimeout(resolvePromise, ms);
	});
}

function run(command: string, args: string[], options: { cwd?: string } = {}): Promise<number> {
	return new Promise((resolveExit, rejectExit) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			stdio: 'inherit',
			shell: process.platform === 'win32',
		});
		child.on('error', rejectExit);
		child.on('close', (code, signal) => {
			if (signal) {
				rejectExit(new Error(`${command} terminated by signal: ${signal}`));
				return;
			}
			resolveExit(code ?? 0);
		});
	});
}

function execFileText(command: string, args: string[]): Promise<string> {
	return new Promise((resolveText, rejectText) => {
		execFile(command, args, { encoding: 'utf-8' }, (error, stdout) => {
			if (error) {
				rejectText(error);
				return;
			}
			resolveText(stdout.trim());
		});
	});
}

async function canAccess(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

async function desktopWindowIsOpen(): Promise<boolean> {
	if (process.platform !== 'darwin') {
		return true;
	}
	try {
		const output = await execFileText('osascript', [
			'-e',
			`tell application "System Events" to tell process "bun" to get name of every window`,
		]);
		return output.split(',').map((value) => value.trim()).includes(DESKTOP_WINDOW_NAME);
	} catch {
		return false;
	}
}

export async function waitForDesktopWindow(timeoutMs = WINDOW_WAIT_TIMEOUT_MS): Promise<void> {
	const startedAt = Date.now();
	for (;;) {
		if (await desktopWindowIsOpen()) {
			return;
		}
		if (Date.now() - startedAt >= timeoutMs) {
			throw new Error(`desktop window did not appear within ${timeoutMs}ms`);
		}
		await sleep(WINDOW_POLL_INTERVAL_MS);
	}
}

export async function launchDesktopApp(): Promise<void> {
	if (process.platform === 'darwin' && await canAccess(desktopAppBundlePath)) {
		const exitCode = await run('open', [desktopAppBundlePath], { cwd: repoRoot });
		if (exitCode !== 0) {
			throw new Error(`open failed with code ${exitCode}`);
		}
		await waitForDesktopWindow();
		return;
	}

	const child = spawn('npm', ['run', 'dev:desktop'], {
		cwd: repoRoot,
		detached: process.platform !== 'win32',
		stdio: 'ignore',
		shell: process.platform === 'win32',
	});
	child.unref();
	await waitForDesktopWindow();
}

export async function stopDesktopApp(): Promise<{ terminated: number; forceKilled: number }> {
	return cleanupDesktopProcesses(repoRoot);
}
