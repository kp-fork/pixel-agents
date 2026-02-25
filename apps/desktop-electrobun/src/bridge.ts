import type { DesktopBridge } from './types.js';

export function createElectrobunBridge(): DesktopBridge {
	const listeners = new Set<(message: unknown) => void>();

	return {
		send(message: unknown): void {
			// Prototype path: log outbound payloads for visibility.
			console.log('[desktop-electrobun][send]', JSON.stringify(message));
		},
		onMessage(handler: (message: unknown) => void): () => void {
			listeners.add(handler);
			return () => {
				listeners.delete(handler);
			};
		},
		emitFromHost(message: unknown): void {
			for (const handler of listeners) {
				handler(message);
			}
		},
	};
}

