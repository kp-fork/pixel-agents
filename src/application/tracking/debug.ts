import type { SessionRecord, TrackingEvent, TrackingEventType } from '../../contracts/session.js';
import type { CandidateSession } from './scanner.js';
import type { SessionBinding, SessionRegistrySnapshot } from './sessionRegistry.js';

export interface TrackingDebugSnapshot {
	at: number;
	seenJsonl: string[];
	boundJsonl: SessionBinding[];
	records: SessionRecord[];
	queuedCandidates: CandidateSession[];
	recentEvents: TrackingEvent[];
	eventCounts: Record<TrackingEventType, number>;
}

export interface TrackingDebugSnapshotInput {
	at?: number;
	registry: SessionRegistrySnapshot;
	queuedCandidates: readonly CandidateSession[];
	recentEvents: readonly TrackingEvent[];
}

export function buildTrackingDebugSnapshot(input: TrackingDebugSnapshotInput): TrackingDebugSnapshot {
	const seenJsonl = [...input.registry.seenJsonl].sort((a, b) => a.localeCompare(b));
	const boundJsonl = [...input.registry.boundJsonl]
		.map((binding) => ({ ...binding }))
		.sort((a, b) => a.jsonlPath.localeCompare(b.jsonlPath));
	const records = [...input.registry.records]
		.map((record) => ({ ...record }))
		.sort((a, b) => a.jsonlPath.localeCompare(b.jsonlPath));
	const queuedCandidates = [...input.queuedCandidates]
		.map((candidate) => ({ ...candidate }))
		.sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || b.mtimeMs - a.mtimeMs);
	const recentEvents = [...input.recentEvents]
		.map((event) => ({ ...event }))
		.sort((a, b) => a.at - b.at);

	return {
		at: input.at ?? Date.now(),
		seenJsonl,
		boundJsonl,
		records,
		queuedCandidates,
		recentEvents,
		eventCounts: countEvents(recentEvents),
	};
}

export function serializeTrackingDebugSnapshot(
	input: TrackingDebugSnapshotInput,
	space = 2,
): string {
	const snapshot = buildTrackingDebugSnapshot(input);
	return JSON.stringify(snapshot, null, space);
}

function countEvents(events: readonly TrackingEvent[]): Record<TrackingEventType, number> {
	const counts: Record<TrackingEventType, number> = {
		tracking_attempt: 0,
		tracking_success: 0,
		tracking_deferred: 0,
		tracking_failed: 0,
	};
	for (const event of events) {
		counts[event.type] += 1;
	}
	return counts;
}
