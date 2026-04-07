export {
	type CandidateQueue,
	type CandidateQueueDeferOptions,
	createCandidateQueue,
} from './candidateQueue.js';
export {
	buildTrackingDebugSnapshot,
	serializeTrackingDebugSnapshot,
	type TrackingDebugSnapshot,
	type TrackingDebugSnapshotInput,
} from './debug.js';
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
	matchTerminalForCandidate,
	scoreTerminalMatch,
	scoreTerminalMatchWithBreakdown,
	type TerminalMatcherOptions,
	type TerminalMatchResult,
	type TerminalMatchScoreBreakdown,
	type TerminalMatchScoreInput,
} from './matcher.js';
export {
	type BackfillScanOptions,
	buildBackfillCandidates,
	type CandidateSession,
	compareCandidatesByPriority,
	createCandidateSession,
	withRetry,
} from './scanner.js';
export {
	createSessionRegistry,
	type SessionBinding,
	type SessionRegistry,
	type SessionRegistrySnapshot,
} from './sessionRegistry.js';
