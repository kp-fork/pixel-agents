import type { SessionRecord, TrackingEvent } from '../contracts/session.js';
import type { ExtensionToWebviewMessage } from '../contracts/messages.js';

export interface TerminalRef {
	id: string;
	name: string;
	cwd?: string;
	lastActiveAt?: number;
}

export interface TerminalPort {
	listOpenTerminals(): TerminalRef[];
	focusTerminal(id: string): void;
}

export interface JsonlFileInfo {
	path: string;
	mtimeMs: number;
	size: number;
}

export interface SessionStorePort {
	listJsonl(projectDir: string): JsonlFileInfo[];
	readNewLines(path: string, offset: number): { lines: string[]; nextOffset: number };
}

export interface SessionRegistryPort {
	getByPath(path: string): SessionRecord | undefined;
	upsert(record: SessionRecord): void;
}

export interface TrackingEventPort {
	emit(event: TrackingEvent): void;
}

export interface WebviewMessagePort {
	post(message: ExtensionToWebviewMessage): void;
}

