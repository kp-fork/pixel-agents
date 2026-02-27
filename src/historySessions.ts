import * as fs from 'fs';
import * as path from 'path';

export interface HistorySessionRecord {
	id: string;
	sessionId: string;
	jsonlPath: string;
	createdAtMs: number;
	lastActivityAtMs: number;
	preview: string;
}

interface HistorySessionOptions {
	enabled: boolean;
	lookbackDays: number;
	maxVisible: number;
}

interface JsonlHeaderRecord {
	type?: unknown;
	sessionId?: unknown;
	agentName?: unknown;
	teamName?: unknown;
	isSidechain?: unknown;
	message?: unknown;
}

interface SessionHeaderAnalysis {
	hasConversation: boolean;
	excludedForTeamOrSubagent: boolean;
}

interface JsonlRecord {
	type?: unknown;
	sessionId?: unknown;
	timestamp?: unknown;
	message?: unknown;
	isMeta?: unknown;
}

function clampInteger(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	const rounded = Math.round(value);
	return Math.max(min, Math.min(max, rounded));
}

function normalizePathForCompare(input: string): string {
	const normalized = path.normalize(input);
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function looksLikeSessionId(value: string): boolean {
	return /^[0-9a-fA-F-]{36}$/.test(value);
}

function sessionIdFromJsonlPath(jsonlPath: string): string {
	if (!jsonlPath) return '';
	const sessionId = path.basename(jsonlPath, '.jsonl');
	return looksLikeSessionId(sessionId) ? sessionId.toLowerCase() : '';
}

function readFilePrefix(filePath: string, maxBytes: number): string {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, 'r');
		const buffer = Buffer.alloc(maxBytes);
		const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
		return buffer.toString('utf-8', 0, bytesRead);
	} catch {
		return '';
	} finally {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch { /* noop */ }
		}
	}
}

function readFileTail(filePath: string, maxBytes: number): string {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, 'r');
		const stat = fs.fstatSync(fd);
		const size = stat.size;
		if (!Number.isFinite(size) || size <= 0) {
			return '';
		}
		const length = Math.min(maxBytes, size);
		const start = Math.max(0, size - length);
		const buffer = Buffer.alloc(length);
		const bytesRead = fs.readSync(fd, buffer, 0, length, start);
		return buffer.toString('utf-8', 0, bytesRead);
	} catch {
		return '';
	} finally {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch { /* noop */ }
		}
	}
}

function parseTimestampMs(value: unknown): number {
	if (typeof value !== 'string' || value.trim() === '') {
		return 0;
	}
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : 0;
}

function normalizePreviewText(input: string): string {
	return stripNonUserFacingCommandTags(input).replace(/\s+/g, ' ').trim();
}

function stripNonUserFacingCommandTags(input: string): string {
	return input
		.replace(/<\/?local-command-stdout\b[^>]*>/gi, ' ')
		.replace(/<\/?local-command-stderr\b[^>]*>/gi, ' ')
		.replace(/<\/>/g, ' ');
}

function truncatePreview(text: string, maxLen: number): string {
	if (text.length <= maxLen) {
		return text;
	}
	return `${text.slice(0, maxLen - 1)}\u2026`;
}

function extractTextFromContent(content: unknown): string {
	if (typeof content === 'string') {
		return normalizePreviewText(content);
	}
	if (!Array.isArray(content)) {
		return '';
	}
	const chunks: string[] = [];
	for (const block of content as Array<{ type?: unknown; text?: unknown }>) {
		if (block.type !== 'text' || typeof block.text !== 'string') {
			continue;
		}
		const trimmed = normalizePreviewText(block.text);
		if (trimmed) {
			chunks.push(trimmed);
		}
	}
	return normalizePreviewText(chunks.join(' '));
}

function extractPreviewFromRecord(record: JsonlRecord): string {
	const message = record.message as { content?: unknown } | undefined;
	const text = extractTextFromContent(message?.content);
	if (!text) {
		return '';
	}
	// Team envelope payload is not user-facing history preview content.
	if (text.includes('<teammate-message')) {
		return '';
	}
	return truncatePreview(text, 120);
}

function analyzeSessionTail(
	jsonlPath: string,
	expectedSessionId: string,
): { lastActivityAtMs: number; userPreview: string; assistantPreview: string } {
	const tail = readFileTail(jsonlPath, 96 * 1024);
	if (!tail) {
		return { lastActivityAtMs: 0, userPreview: '', assistantPreview: '' };
	}

	const lines = tail.split('\n');
	let lastActivityAtMs = 0;
	let latestUserPreview = '';
	let latestAssistantPreview = '';

	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line || line[0] !== '{') {
			continue;
		}

		let record: JsonlRecord;
		try {
			record = JSON.parse(line) as JsonlRecord;
		} catch {
			continue;
		}

		const recordSessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
		if (recordSessionId && recordSessionId !== expectedSessionId) {
			continue;
		}

		const recordType = typeof record.type === 'string' ? record.type : '';
		if (recordType === 'user' || recordType === 'assistant' || recordType === 'system' || recordType === 'progress') {
			const tsMs = parseTimestampMs(record.timestamp);
			if (tsMs > lastActivityAtMs) {
				lastActivityAtMs = tsMs;
			}
		}

		if (!latestUserPreview && recordType === 'user' && record.isMeta !== true) {
			latestUserPreview = extractPreviewFromRecord(record);
		}
		if (!latestAssistantPreview && recordType === 'assistant') {
			latestAssistantPreview = extractPreviewFromRecord(record);
		}

		if (lastActivityAtMs > 0 && latestUserPreview) {
			break;
		}
	}

	return {
		lastActivityAtMs,
		userPreview: latestUserPreview,
		assistantPreview: latestAssistantPreview,
	};
}

function findFirstUserPreview(jsonlPath: string, expectedSessionId: string): string {
	const head = readFilePrefix(jsonlPath, 96 * 1024);
	if (!head) {
		return '';
	}
	const lines = head.split('\n');
	for (const raw of lines) {
		const line = raw.trim();
		if (!line || line[0] !== '{') {
			continue;
		}
		let record: JsonlRecord;
		try {
			record = JSON.parse(line) as JsonlRecord;
		} catch {
			continue;
		}
		const recordSessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
		if (recordSessionId && recordSessionId !== expectedSessionId) {
			continue;
		}
		const recordType = typeof record.type === 'string' ? record.type : '';
		if (recordType !== 'user' || record.isMeta === true) {
			continue;
		}
		const preview = extractPreviewFromRecord(record);
		if (preview) {
			return preview;
		}
	}
	return '';
}

function shouldIncludeHistorySession(jsonlPath: string): boolean {
	const analysis = analyzeSessionHeader(jsonlPath);
	return analysis.hasConversation && !analysis.excludedForTeamOrSubagent;
}

function analyzeSessionHeader(jsonlPath: string): SessionHeaderAnalysis {
	const prefix = readFilePrefix(jsonlPath, 16 * 1024);
	if (!prefix) {
		return { hasConversation: false, excludedForTeamOrSubagent: false };
	}

	const lines = prefix.split('\n');
	for (const raw of lines) {
		const line = raw.trim();
		if (!line) continue;

		let record: JsonlHeaderRecord;
		try {
			record = JSON.parse(line) as JsonlHeaderRecord;
		} catch {
			continue;
		}

		// Ignore metadata snapshots and inspect first conversational header.
		if (record.type === 'file-history-snapshot') continue;

		const recordType = typeof record.type === 'string' ? record.type : '';
		const hasSessionId = typeof record.sessionId === 'string' && record.sessionId.length > 0;
		const isConversationalType = recordType === 'user' || recordType === 'assistant' || recordType === 'system' || recordType === 'progress';
		if (!(hasSessionId && isConversationalType)) {
			continue;
		}

		const isSidechain = record.isSidechain === true;
		const agentName = typeof record.agentName === 'string' ? record.agentName.trim() : '';
		const teamName = typeof record.teamName === 'string' ? record.teamName.trim() : '';
		const message = record.message as { content?: unknown } | undefined;
		const content = typeof message?.content === 'string' ? message.content : '';
		const isTeammateEnvelope = content.includes('<teammate-message');

		return {
			hasConversation: true,
			excludedForTeamOrSubagent: isSidechain || agentName !== '' || teamName !== '' || isTeammateEnvelope,
		};
	}

	return { hasConversation: false, excludedForTeamOrSubagent: false };
}

export function canResumeHistorySession(jsonlPath: string, expectedSessionId?: string): boolean {
	if (!fs.existsSync(jsonlPath)) return false;
	const analysis = analyzeSessionHeader(jsonlPath);
	if (!analysis.hasConversation || analysis.excludedForTeamOrSubagent) {
		return false;
	}
	if (!expectedSessionId) return true;
	const fileSessionId = path.basename(jsonlPath, '.jsonl');
	return fileSessionId === expectedSessionId;
}

export function collectHistorySessions(
	projectDir: string | null | undefined,
	liveJsonlPaths: Iterable<string>,
	options: HistorySessionOptions,
	liveSessionIds?: Iterable<string>,
): HistorySessionRecord[] {
	if (!projectDir || !fs.existsSync(projectDir)) return [];
	if (!options.enabled) return [];

	const lookbackDays = clampInteger(options.lookbackDays, 1, 365);
	const maxVisible = clampInteger(options.maxVisible, 0, 100);
	if (maxVisible <= 0) return [];

	const livePaths = new Set<string>();
	const liveSessions = new Set<string>();
	for (const p of liveJsonlPaths) {
		livePaths.add(normalizePathForCompare(p));
		const fromPath = sessionIdFromJsonlPath(p);
		if (fromPath) {
			liveSessions.add(fromPath);
		}
	}
	for (const s of liveSessionIds || []) {
		if (looksLikeSessionId(s)) {
			liveSessions.add(s.toLowerCase());
		}
	}

	const nowMs = Date.now();
	const thresholdMs = nowMs - (lookbackDays * 24 * 60 * 60 * 1000);
	const records: HistorySessionRecord[] = [];

	let names: string[] = [];
	try {
		names = fs.readdirSync(projectDir);
	} catch {
		return [];
	}

	for (const name of names) {
		if (!name.endsWith('.jsonl')) continue;
		const sessionId = name.slice(0, -'.jsonl'.length);
		if (!looksLikeSessionId(sessionId)) continue;
		if (liveSessions.has(sessionId.toLowerCase())) continue;

		const jsonlPath = path.join(projectDir, name);
		if (livePaths.has(normalizePathForCompare(jsonlPath))) continue;
		if (!shouldIncludeHistorySession(jsonlPath)) continue;

		let stat: fs.Stats;
		try {
			stat = fs.statSync(jsonlPath);
		} catch {
			continue;
		}

		const createdAtMs = stat.birthtimeMs > 0
			? Math.min(stat.birthtimeMs, stat.mtimeMs)
			: stat.mtimeMs;
		if (!Number.isFinite(createdAtMs)) continue;

		const tail = analyzeSessionTail(jsonlPath, sessionId);
		const firstUserPreview = tail.userPreview ? '' : findFirstUserPreview(jsonlPath, sessionId);
		const preview = tail.userPreview || firstUserPreview || tail.assistantPreview;
		const lastActivityAtMs = tail.lastActivityAtMs > 0
			? tail.lastActivityAtMs
			: (Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : createdAtMs);
		if (!Number.isFinite(lastActivityAtMs) || lastActivityAtMs < thresholdMs) continue;

		records.push({
			id: sessionId,
			sessionId,
			jsonlPath,
			createdAtMs,
			lastActivityAtMs,
			preview,
		});
	}

	records.sort((a, b) => b.lastActivityAtMs - a.lastActivityAtMs);

	return records.slice(0, maxVisible);
}
