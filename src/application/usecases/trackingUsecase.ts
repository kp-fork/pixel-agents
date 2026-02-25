import type {
	SessionRegistryPort,
	SessionStorePort,
	TerminalPort,
	TrackingEventPort,
	WebviewMessagePort,
} from '../ports.js';

export interface TrackingUsecaseDeps {
	sessions: SessionRegistryPort;
	store: SessionStorePort;
	terminals: TerminalPort;
	events: TrackingEventPort;
	webview: WebviewMessagePort;
}

export interface TrackingUsecase {
	onTick(now: number): void;
	onTerminalFocus(terminalId: string): void;
}

export function createTrackingUsecase(_deps: TrackingUsecaseDeps): TrackingUsecase {
	return {
		onTick: (_now: number) => {
			// Intentionally a no-op for PR2.
			// PR4-PR7 will populate this with real tracking orchestration.
		},
		onTerminalFocus: (_terminalId: string) => {
			// Intentionally a no-op for PR2.
		},
	};
}

