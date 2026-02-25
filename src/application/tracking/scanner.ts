import type { JsonlFileInfo } from '../ports.js';

export interface CandidateSession {
	jsonlPath: string;
	mtimeMs: number;
	size: number;
	retryCount: number;
	firstSeenAt: number;
	queuedAt: number;
	nextAttemptAt: number;
	lastDeferReason?: string;
}

export interface BackfillScanOptions {
	now?: number;
	seenJsonl?: ReadonlySet<string>;
	includeSeen?: boolean;
	maxCandidates?: number;
}

export function createCandidateSession(file: JsonlFileInfo, now: number, retryCount = 0): CandidateSession {
	const jsonlPath = normalizeJsonlPath(file.path);
	return {
		jsonlPath,
		mtimeMs: file.mtimeMs,
		size: file.size,
		retryCount,
		firstSeenAt: now,
		queuedAt: now,
		nextAttemptAt: now,
	};
}

export function buildBackfillCandidates(
	files: readonly JsonlFileInfo[],
	options: BackfillScanOptions = {},
): CandidateSession[] {
	const now = options.now ?? Date.now();
	const seenJsonl = options.seenJsonl;
	const includeSeen = options.includeSeen ?? false;
	const maxCandidates = options.maxCandidates;

	const latestByPath = new Map<string, JsonlFileInfo>();
	for (const file of files) {
		const jsonlPath = normalizeJsonlPath(file.path);
		if (!jsonlPath) continue;
		if (!includeSeen && seenJsonl?.has(jsonlPath)) continue;

		const prev = latestByPath.get(jsonlPath);
		if (!prev || file.mtimeMs > prev.mtimeMs) {
			latestByPath.set(jsonlPath, file);
		}
	}

	const candidates = [...latestByPath.values()]
		.map((file) => createCandidateSession(file, now))
		.sort(compareCandidatesByPriority);

	if (typeof maxCandidates === 'number' && maxCandidates >= 0) {
		return candidates.slice(0, maxCandidates);
	}

	return candidates;
}

export function compareCandidatesByPriority(a: CandidateSession, b: CandidateSession): number {
	if (a.nextAttemptAt !== b.nextAttemptAt) {
		return a.nextAttemptAt - b.nextAttemptAt;
	}
	if (a.retryCount !== b.retryCount) {
		return a.retryCount - b.retryCount;
	}
	if (a.mtimeMs !== b.mtimeMs) {
		return b.mtimeMs - a.mtimeMs;
	}
	if (a.size !== b.size) {
		return b.size - a.size;
	}
	return a.jsonlPath.localeCompare(b.jsonlPath);
}

export function withRetry(
	candidate: CandidateSession,
	retryCount: number,
	now: number,
	nextAttemptAt: number,
	reason?: string,
): CandidateSession {
	return {
		...candidate,
		retryCount,
		queuedAt: now,
		nextAttemptAt,
		lastDeferReason: reason,
	};
}

function normalizeJsonlPath(path: string): string {
	return path.trim();
}
