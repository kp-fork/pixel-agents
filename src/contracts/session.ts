export type SessionStage = 'discovered' | 'candidate' | 'bound' | 'tracking' | 'closed';

export interface SessionRecord {
	sessionId: string;
	jsonlPath: string;
	stage: SessionStage;
	terminalId?: string;
	agentId?: number;
	discoveredAt: number;
	updatedAt: number;
}

export type TrackingEventType =
	| 'tracking_attempt'
	| 'tracking_success'
	| 'tracking_deferred'
	| 'tracking_failed';

export interface TrackingEvent {
	type: TrackingEventType;
	jsonlPath: string;
	terminalId?: string;
	reason?: string;
	at: number;
}
