import * as fs from 'fs';
import * as path from 'path';

export interface HistorySessionRecord {
	id: number;
	sessionId: string;
	jsonlPath: string;
	createdAtMs: number;
}

interface HistorySessionOptions {
	enabled: boolean;
	lookbackDays: number;
	maxVisible: number;
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

function stableHistoryId(sessionId: string): number {
	let hash = 0;
	for (let i = 0; i < sessionId.length; i++) {
		hash = ((hash << 5) - hash + sessionId.charCodeAt(i)) | 0;
	}
	const positive = Math.abs(hash);
	// Keep history IDs far from live IDs/subagent IDs.
	return 1_000_000 + (positive % 100_000_000);
}

export function collectHistorySessions(
	projectDir: string | null | undefined,
	liveJsonlPaths: Iterable<string>,
	options: HistorySessionOptions,
): HistorySessionRecord[] {
	if (!projectDir || !fs.existsSync(projectDir)) return [];
	if (!options.enabled) return [];

	const lookbackDays = clampInteger(options.lookbackDays, 1, 365);
	const maxVisible = clampInteger(options.maxVisible, 0, 100);
	if (maxVisible <= 0) return [];

	const livePaths = new Set<string>();
	for (const p of liveJsonlPaths) {
		livePaths.add(normalizePathForCompare(p));
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

		const jsonlPath = path.join(projectDir, name);
		if (livePaths.has(normalizePathForCompare(jsonlPath))) continue;

		let stat: fs.Stats;
		try {
			stat = fs.statSync(jsonlPath);
		} catch {
			continue;
		}

		const createdAtMs = stat.birthtimeMs > 0
			? Math.min(stat.birthtimeMs, stat.mtimeMs)
			: stat.mtimeMs;
		if (!Number.isFinite(createdAtMs) || createdAtMs < thresholdMs) continue;

		records.push({
			id: stableHistoryId(sessionId),
			sessionId,
			jsonlPath,
			createdAtMs,
		});
	}

	records.sort((a, b) => b.createdAtMs - a.createdAtMs);

	const deduped: HistorySessionRecord[] = [];
	const usedIds = new Set<number>();
	for (const record of records) {
		let nextId = record.id;
		while (usedIds.has(nextId)) {
			nextId += 1;
		}
		usedIds.add(nextId);
		deduped.push({ ...record, id: nextId });
		if (deduped.length >= maxVisible) break;
	}

	return deduped;
}
