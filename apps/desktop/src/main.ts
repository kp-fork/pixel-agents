import { CoreStore, createInitialCoreState } from '../../../packages/core/src/index.js';
import { mapToViewModel } from '../../../packages/view-model/src/index.js';
import { createElectrobunBridge } from './bridge.js';
import type { DesktopInboundMessage } from './types.js';

function isDesktopMessage(message: unknown): message is DesktopInboundMessage {
	if (!message || typeof message !== 'object') return false;
	return typeof (message as { type?: unknown }).type === 'string';
}

function renderSnapshot(label: string, store: CoreStore): void {
	const vm = mapToViewModel(store.snapshot());
	console.log(`[desktop][render:${label}] agents=${vm.toolbar.trackedAgentCount} waiting=${vm.toolbar.waitingAgentCount}`);
}

function run(): void {
	const bridge = createElectrobunBridge();
	const store = new CoreStore(createInitialCoreState());

	bridge.onMessage((message) => {
		if (!isDesktopMessage(message)) return;
		const at = Date.now();
		switch (message.type) {
			case 'agentCreated': {
				const id = Number(message.id);
				if (!Number.isFinite(id)) return;
				store.dispatch({ type: 'agentAdded', id, at });
				renderSnapshot('agentCreated', store);
				return;
			}
			case 'agentStatus': {
				const id = Number(message.id);
				const status = message.status;
				if (!Number.isFinite(id)) return;
				if (status !== 'active' && status !== 'waiting' && status !== 'idle') return;
				store.dispatch({ type: 'agentStatusSet', id, status, at });
				renderSnapshot('agentStatus', store);
				return;
			}
			default:
				return;
		}
	});

	bridge.emitFromHost({ type: 'agentCreated', id: 1 });
	bridge.emitFromHost({ type: 'agentStatus', id: 1, status: 'active' });
	bridge.emitFromHost({ type: 'agentStatus', id: 1, status: 'waiting' });
}

run();

