import type { TrackingEvent, TrackingEventType } from '../../contracts/session.js';
import type { TrackingEventPort } from '../ports.js';

export interface TrackingEventInput {
	jsonlPath: string;
	terminalId?: string;
	reason?: string;
	at?: number;
}

export interface TrackingTelemetryBuffer {
	push(event: TrackingEvent): void;
	list(limit?: number): TrackingEvent[];
	clear(): void;
	counts(): Record<TrackingEventType, number>;
}

const TRACKING_EVENT_TYPES: TrackingEventType[] = [
	'tracking_attempt',
	'tracking_success',
	'tracking_deferred',
	'tracking_failed',
];

export function createTrackingEvent(type: TrackingEventType, input: TrackingEventInput): TrackingEvent {
	return {
		type,
		jsonlPath: input.jsonlPath.trim(),
		terminalId: input.terminalId,
		reason: input.reason,
		at: input.at ?? Date.now(),
	};
}

export function emitTrackingEvent(
	port: TrackingEventPort,
	type: TrackingEventType,
	input: TrackingEventInput,
): TrackingEvent {
	const event = createTrackingEvent(type, input);
	port.emit(event);
	return event;
}

export function emitTrackingAttempt(port: TrackingEventPort, input: TrackingEventInput): TrackingEvent {
	return emitTrackingEvent(port, 'tracking_attempt', input);
}

export function emitTrackingSuccess(port: TrackingEventPort, input: TrackingEventInput): TrackingEvent {
	return emitTrackingEvent(port, 'tracking_success', input);
}

export function emitTrackingDeferred(port: TrackingEventPort, input: TrackingEventInput): TrackingEvent {
	return emitTrackingEvent(port, 'tracking_deferred', input);
}

export function emitTrackingFailed(port: TrackingEventPort, input: TrackingEventInput): TrackingEvent {
	return emitTrackingEvent(port, 'tracking_failed', input);
}

export function createTrackingTelemetryBuffer(maxEvents = 200): TrackingTelemetryBuffer {
	return new RingTrackingTelemetryBuffer(maxEvents);
}

class RingTrackingTelemetryBuffer implements TrackingTelemetryBuffer {
	private readonly maxEvents: number;
	private readonly events: TrackingEvent[] = [];

	constructor(maxEvents: number) {
		this.maxEvents = Math.max(1, Math.floor(maxEvents));
	}

	push(event: TrackingEvent): void {
		this.events.push({ ...event });
		if (this.events.length <= this.maxEvents) return;

		this.events.splice(0, this.events.length - this.maxEvents);
	}

	list(limit?: number): TrackingEvent[] {
		const safeLimit = typeof limit === 'number' ? Math.max(0, Math.floor(limit)) : this.events.length;
		return this.events.slice(-safeLimit).map((event) => ({ ...event }));
	}

	clear(): void {
		this.events.length = 0;
	}

	counts(): Record<TrackingEventType, number> {
		const tally = createEventCounter();
		for (const event of this.events) {
			tally[event.type] += 1;
		}
		return tally;
	}
}

function createEventCounter(): Record<TrackingEventType, number> {
	return TRACKING_EVENT_TYPES.reduce<Record<TrackingEventType, number>>((acc, type) => {
		acc[type] = 0;
		return acc;
	}, {
		tracking_attempt: 0,
		tracking_success: 0,
		tracking_deferred: 0,
		tracking_failed: 0,
	});
}
