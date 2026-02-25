import {
	compareCandidatesByPriority,
	type CandidateSession,
	withRetry,
} from './scanner.js';

export interface CandidateQueueDeferOptions {
	reason?: string;
	baseDelayMs?: number;
	maxDelayMs?: number;
	maxRetries?: number;
}

export interface CandidateQueue {
	size(): number;
	has(jsonlPath: string): boolean;
	enqueue(candidate: CandidateSession): boolean;
	enqueueMany(candidates: readonly CandidateSession[]): number;
	dequeueReady(now: number): CandidateSession | undefined;
	defer(candidate: CandidateSession, now: number, options?: CandidateQueueDeferOptions): CandidateSession | undefined;
	remove(jsonlPath: string): CandidateSession | undefined;
	snapshot(): CandidateSession[];
	clear(): void;
}

const DEFAULT_BASE_DELAY_MS = 1_500;
const DEFAULT_MAX_DELAY_MS = 60_000;

export function createCandidateQueue(seed: readonly CandidateSession[] = []): CandidateQueue {
	const queue = new InMemoryCandidateQueue();
	queue.enqueueMany(seed);
	return queue;
}

function normalizeJsonlPath(path: string): string {
	return path.trim();
}

function cloneCandidate(candidate: CandidateSession): CandidateSession {
	return { ...candidate };
}

class InMemoryCandidateQueue implements CandidateQueue {
	private readonly byPath = new Map<string, CandidateSession>();

	size(): number {
		return this.byPath.size;
	}

	has(path: string): boolean {
		const jsonlPath = normalizeJsonlPath(path);
		if (!jsonlPath) return false;
		return this.byPath.has(jsonlPath);
	}

	enqueue(candidate: CandidateSession): boolean {
		const jsonlPath = normalizeJsonlPath(candidate.jsonlPath);
		if (!jsonlPath) return false;

		const next = { ...candidate, jsonlPath };
		const prev = this.byPath.get(jsonlPath);
		if (prev) {
			this.byPath.set(jsonlPath, mergeCandidate(prev, next));
			return false;
		}

		this.byPath.set(jsonlPath, next);
		return true;
	}

	enqueueMany(candidates: readonly CandidateSession[]): number {
		let added = 0;
		for (const candidate of candidates) {
			if (this.enqueue(candidate)) {
				added += 1;
			}
		}
		return added;
	}

	dequeueReady(now: number): CandidateSession | undefined {
		for (const candidate of this.sortedCandidates()) {
			if (candidate.nextAttemptAt > now) break;
			this.byPath.delete(candidate.jsonlPath);
			return cloneCandidate(candidate);
		}
		return undefined;
	}

	defer(
		candidate: CandidateSession,
		now: number,
		options: CandidateQueueDeferOptions = {},
	): CandidateSession | undefined {
		const nextRetryCount = candidate.retryCount + 1;
		const maxRetries = options.maxRetries;
		if (typeof maxRetries === 'number' && maxRetries >= 0 && nextRetryCount > maxRetries) {
			return undefined;
		}

		const delayMs = backoffDelayMs(nextRetryCount, options.baseDelayMs, options.maxDelayMs);
		const deferred = withRetry(candidate, nextRetryCount, now, now + delayMs, options.reason);
		this.enqueue(deferred);
		return cloneCandidate(deferred);
	}

	remove(path: string): CandidateSession | undefined {
		const jsonlPath = normalizeJsonlPath(path);
		if (!jsonlPath) return undefined;
		const removed = this.byPath.get(jsonlPath);
		if (!removed) return undefined;
		this.byPath.delete(jsonlPath);
		return cloneCandidate(removed);
	}

	snapshot(): CandidateSession[] {
		return this.sortedCandidates().map(cloneCandidate);
	}

	clear(): void {
		this.byPath.clear();
	}

	private sortedCandidates(): CandidateSession[] {
		return [...this.byPath.values()].sort(compareCandidatesByPriority);
	}
}

function backoffDelayMs(retryCount: number, baseDelayMs?: number, maxDelayMs?: number): number {
	const base = baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
	const max = maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
	const exponential = Math.max(base, base * (2 ** (retryCount - 1)));
	return Math.min(exponential, max);
}

function mergeCandidate(existing: CandidateSession, incoming: CandidateSession): CandidateSession {
	const newest = incoming.mtimeMs >= existing.mtimeMs ? incoming : existing;
	return {
		...newest,
		retryCount: Math.min(existing.retryCount, incoming.retryCount),
		firstSeenAt: Math.min(existing.firstSeenAt, incoming.firstSeenAt),
		nextAttemptAt: Math.min(existing.nextAttemptAt, incoming.nextAttemptAt),
		queuedAt: Math.max(existing.queuedAt, incoming.queuedAt),
		lastDeferReason: incoming.lastDeferReason ?? existing.lastDeferReason,
	};
}
