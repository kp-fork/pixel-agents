import fs from 'node:fs';
import path from 'node:path';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface TerminalExitEvent {
	exitCode: number;
	signal?: number;
}

export interface TerminalDisposable {
	dispose(): void;
}

export interface TerminalPtyLike {
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(signal?: string): void;
	onData(listener: (data: string) => void): TerminalDisposable;
	onExit(listener: (event: TerminalExitEvent) => void): TerminalDisposable;
}

interface ZigPtyOptions {
	binaryPath: string;
	shell: string;
	shellArgs: string[];
	cwd: string;
	cols: number;
	rows: number;
	onLog?: (text: string) => void;
}

type InboundMessage =
	| { type: 'ready' }
	| { type: 'data'; dataBase64?: string }
	| { type: 'exit'; exitCode?: number; signal?: number }
	| { type: 'error'; message?: string };

function encodeChunk(input: string): string {
	return Buffer.from(input, 'utf8').toString('base64');
}

function decodeChunk(base64: string): string {
	return Buffer.from(base64, 'base64').toString('utf8');
}

function normalizeShellArgs(executable: string, args: string[]): string[] {
	const next = args.map((value) => value.trim()).filter((value) => value.length > 0);
	if (next.length === 0) {
		return ['-i'];
	}
	if (next[0] === executable) {
		return next.slice(1);
	}
	return next;
}

function safeJsonParse(line: string): InboundMessage | null {
	try {
		const parsed = JSON.parse(line) as InboundMessage;
		if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

class ZigPtyBridge implements TerminalPtyLike {
	private child: ChildProcessWithoutNullStreams;
	private stdoutBuffer = '';
	private dataListeners = new Set<(data: string) => void>();
	private exitListeners = new Set<(event: TerminalExitEvent) => void>();
	private exited = false;

	constructor(private readonly options: ZigPtyOptions) {
		this.child = spawn(options.binaryPath, [], {
			cwd: options.cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
			env: process.env,
		});

		this.child.stdout.setEncoding('utf8');
		this.child.stderr.setEncoding('utf8');
		this.child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
		this.child.stderr.on('data', (chunk: string) => {
			const text = chunk.trim();
			if (text) {
				this.options.onLog?.(`[zig-pty][stderr] ${text}`);
			}
		});

		this.child.on('close', (code, signal) => {
			if (this.exited) return;
			this.exited = true;
			const event: TerminalExitEvent = {
				exitCode: typeof code === 'number' ? code : 0,
				signal: typeof signal === 'string' ? 0 : undefined,
			};
			this.emitExit(event);
		});

		this.child.on('error', (error) => {
			this.options.onLog?.(`[zig-pty] process error: ${error.message}`);
			if (this.exited) return;
			this.exited = true;
			this.emitExit({ exitCode: 1, signal: 0 });
		});

		this.send({
			type: 'spawn',
			spawn: {
				shell: options.shell,
				args: normalizeShellArgs(options.shell, options.shellArgs),
				cwd: options.cwd,
				cols: options.cols,
				rows: options.rows,
			},
		});
	}

	onData(listener: (data: string) => void): TerminalDisposable {
		this.dataListeners.add(listener);
		return {
			dispose: () => {
				this.dataListeners.delete(listener);
			},
		};
	}

	onExit(listener: (event: TerminalExitEvent) => void): TerminalDisposable {
		this.exitListeners.add(listener);
		return {
			dispose: () => {
				this.exitListeners.delete(listener);
			},
		};
	}

	write(data: string): void {
		if (this.exited) return;
		if (!data) return;
		this.send({
			type: 'input',
			input: {
				dataBase64: encodeChunk(data),
			},
		});
	}

	resize(cols: number, rows: number): void {
		if (this.exited) return;
		this.send({
			type: 'resize',
			resize: {
				cols,
				rows,
			},
		});
	}

	kill(signal = 'SIGTERM'): void {
		if (this.exited) return;
		this.send({ type: 'shutdown' });
		setTimeout(() => {
			if (this.exited) return;
			try {
				this.child.kill(signal as NodeJS.Signals);
			} catch {
				// noop
			}
		}, 120);
	}

	private onStdout(chunk: string): void {
		this.stdoutBuffer += chunk;
		let newlineIndex = this.stdoutBuffer.indexOf('\n');
		while (newlineIndex >= 0) {
			const rawLine = this.stdoutBuffer.slice(0, newlineIndex);
			this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
			const line = rawLine.trim();
			if (line.length > 0) {
				this.handleMessageLine(line);
			}
			newlineIndex = this.stdoutBuffer.indexOf('\n');
		}
	}

	private handleMessageLine(line: string): void {
		const message = safeJsonParse(line);
		if (!message) {
			this.options.onLog?.(`[zig-pty] invalid message: ${line}`);
			return;
		}

		switch (message.type) {
			case 'ready':
				this.options.onLog?.('[zig-pty] ready');
				return;
			case 'data':
				if (!message.dataBase64) return;
				this.emitData(decodeChunk(message.dataBase64));
				return;
			case 'error':
				this.options.onLog?.(`[zig-pty] ${message.message ?? 'unknown error'}`);
				return;
			case 'exit': {
				if (this.exited) return;
				this.exited = true;
				this.emitExit({
					exitCode: typeof message.exitCode === 'number' ? message.exitCode : 0,
					signal: typeof message.signal === 'number' ? message.signal : 0,
				});
				return;
			}
			default:
				return;
		}
	}

	private emitData(data: string): void {
		for (const listener of this.dataListeners) {
			try {
				listener(data);
			} catch {
				// noop
			}
		}
	}

	private emitExit(event: TerminalExitEvent): void {
		for (const listener of this.exitListeners) {
			try {
				listener(event);
			} catch {
				// noop
			}
		}
	}

	private send(payload: unknown): void {
		if (this.exited) return;
		const body = JSON.stringify(payload);
		this.child.stdin.write(`${body}\n`);
	}
}

export function resolveZigPtyBinaryPath(): string | null {
	const envPath = process.env['PIXEL_AGENTS_PTY_BINARY'];
	if (envPath && envPath.trim().length > 0) {
		const abs = path.resolve(envPath.trim());
		if (fs.existsSync(abs)) return abs;
	}

	const moduleDir = path.dirname(fileURLToPath(import.meta.url));
	const workspaceEnv = process.env['PIXEL_AGENTS_WORKSPACE']?.trim();
	const initCwd = process.env['INIT_CWD']?.trim();

	const candidates = [
		workspaceEnv ? path.join(workspaceEnv, 'bin', 'pixel-agents-pty') : '',
		workspaceEnv ? path.join(workspaceEnv, 'apps', 'desktop', 'bin', 'pixel-agents-pty') : '',
		initCwd ? path.join(initCwd, 'bin', 'pixel-agents-pty') : '',
		initCwd ? path.join(initCwd, 'apps', 'desktop', 'bin', 'pixel-agents-pty') : '',
		path.resolve(moduleDir, '..', '..', 'bin', 'pixel-agents-pty'),
		path.resolve(moduleDir, '..', '..', '..', 'bin', 'pixel-agents-pty'),
		path.join(process.cwd(), 'apps', 'desktop', 'bin', 'pixel-agents-pty'),
		path.join(process.cwd(), 'bin', 'pixel-agents-pty'),
	].filter((value) => value.length > 0);
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return null;
}

export function createZigPtyBridge(options: ZigPtyOptions): TerminalPtyLike {
	if (!fs.existsSync(options.binaryPath)) {
		throw new Error(`zig PTY binary not found: ${options.binaryPath}`);
	}
	return new ZigPtyBridge(options);
}
