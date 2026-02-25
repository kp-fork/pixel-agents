export {
	buildBackfillCandidates,
	compareCandidatesByPriority,
	createCandidateSession,
	withRetry,
	type BackfillScanOptions,
	type CandidateSession,
} from './scanner.js';

export {
	createCandidateQueue,
	type CandidateQueue,
	type CandidateQueueDeferOptions,
} from './candidateQueue.js';

export {
	createSessionRegistry,
	type SessionBinding,
	type SessionRegistry,
	type SessionRegistrySnapshot,
} from './sessionRegistry.js';

export {
	matchTerminalForCandidate,
	scoreTerminalMatch,
	scoreTerminalMatchWithBreakdown,
	type TerminalMatcherOptions,
	type TerminalMatchResult,
	type TerminalMatchScoreBreakdown,
	type TerminalMatchScoreInput,
} from './matcher.js';

export {
	createTrackingEvent,
	createTrackingTelemetryBuffer,
	emitTrackingAttempt,
	emitTrackingDeferred,
	emitTrackingEvent,
	emitTrackingFailed,
	emitTrackingSuccess,
	type TrackingEventInput,
	type TrackingTelemetryBuffer,
} from './events.js';

export {
	buildTrackingDebugSnapshot,
	serializeTrackingDebugSnapshot,
	type TrackingDebugSnapshot,
	type TrackingDebugSnapshotInput,
} from './debug.js';
