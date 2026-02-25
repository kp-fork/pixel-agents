import { CoreStore, createInitialCoreState } from '../../../packages/core/src/index.js';
import type { AgentActivityStatus, SessionStage } from '../../../packages/core/src/types.js';
import { mapToViewModel } from '../../../packages/view-model/src/index.js';
import type { ExtensionToWebviewMessage } from '../../../src/contracts/messages.js';
import { createMockBridge } from './mockBridge.js';
import { renderViewModel } from './renderViewModel.js';

type HarnessInboundMessage = Extract<
  ExtensionToWebviewMessage,
  | { type: 'layoutLoaded' }
  | { type: 'agentCreated' }
  | { type: 'agentStatus' }
  | { type: 'agentToolStart' }
  | { type: 'agentToolsClear' }
  | { type: 'agentToolPermission' }
  | { type: 'agentToolPermissionClear' }
  | { type: 'trackingEvent' }
>;

type TrackingEventType = Extract<HarnessInboundMessage, { type: 'trackingEvent' }>['event']['type'];

const HANDLED_MESSAGE_TYPES: ReadonlySet<HarnessInboundMessage['type']> = new Set([
  'layoutLoaded',
  'agentCreated',
  'agentStatus',
  'agentToolStart',
  'agentToolsClear',
  'agentToolPermission',
  'agentToolPermissionClear',
  'trackingEvent',
]);

const KNOWN_AGENT_STATUSES: ReadonlySet<AgentActivityStatus> = new Set([
  'active',
  'waiting',
  'idle',
  'closed',
]);

const SESSION_STAGE_ORDER: readonly SessionStage[] = [
  'discovered',
  'candidate',
  'bound',
  'tracking',
  'closed',
];

const TRACKING_STAGE_BY_EVENT_TYPE: Record<TrackingEventType, SessionStage> = {
  tracking_attempt: 'candidate',
  tracking_deferred: 'bound',
  tracking_success: 'tracking',
  tracking_failed: 'closed',
};

function isHarnessInboundMessage(message: unknown): message is HarnessInboundMessage {
  if (!message || typeof message !== 'object') {
    return false;
  }
  const type = (message as { type?: unknown }).type;
  return typeof type === 'string' && HANDLED_MESSAGE_TYPES.has(type as HarnessInboundMessage['type']);
}

const store = new CoreStore(createInitialCoreState());
const bridge = createMockBridge();

function toAgentStatus(status: string): AgentActivityStatus | null {
  return KNOWN_AGENT_STATUSES.has(status as AgentActivityStatus)
    ? (status as AgentActivityStatus)
    : null;
}

function ensureSessionExists(sessionId: string, at: number): void {
  const current = store.snapshot().sessions[sessionId];
  if (current) {
    return;
  }

  store.dispatch({
    type: 'sessionUpserted',
    session: {
      sessionId,
      jsonlPath: sessionId,
      stage: 'discovered',
      discoveredAt: at,
      updatedAt: at,
    },
    at,
  });
}

function advanceSessionToStage(sessionId: string, targetStage: SessionStage, at: number): void {
  const session = store.snapshot().sessions[sessionId];
  if (!session) {
    return;
  }

  const currentIndex = SESSION_STAGE_ORDER.indexOf(session.stage);
  const targetIndex = SESSION_STAGE_ORDER.indexOf(targetStage);
  if (currentIndex < 0 || targetIndex < 0 || targetIndex <= currentIndex) {
    return;
  }

  for (let index = currentIndex + 1; index <= targetIndex; index += 1) {
    store.dispatch({
      type: 'sessionStageChanged',
      sessionId,
      stage: SESSION_STAGE_ORDER[index],
      at,
    });
  }
}

function render(): void {
  const viewModel = mapToViewModel(store.snapshot());
  console.log(renderViewModel(viewModel));
  console.log('');
}

function applyMessage(message: HarnessInboundMessage): void {
  const at = Date.now();

  switch (message.type) {
    case 'layoutLoaded':
      store.dispatch({ type: 'layoutReplaced', layout: message.layout, at });
      break;
    case 'agentCreated':
      store.dispatch({ type: 'agentAdded', id: message.id, at });
      break;
    case 'agentStatus':
      {
        const status = toAgentStatus(message.status);
        if (!status) {
          break;
        }
        store.dispatch({ type: 'agentStatusSet', id: message.id, status, at });
      }
      break;
    case 'agentToolStart':
      store.dispatch({
        type: 'agentToolSet',
        id: message.id,
        toolId: message.toolId,
        label: message.status,
        at,
      });
      break;
    case 'agentToolsClear':
      store.dispatch({ type: 'agentToolSet', id: message.id, toolId: null, label: null, at });
      break;
    case 'agentToolPermission':
      store.dispatch({
        type: 'agentPermissionWaitingSet',
        id: message.id,
        waiting: true,
        at,
      });
      break;
    case 'agentToolPermissionClear':
      store.dispatch({
        type: 'agentPermissionWaitingSet',
        id: message.id,
        waiting: false,
        at,
      });
      break;
    case 'trackingEvent': {
      const sessionId = message.event.jsonlPath;
      const eventAt = message.event.at;
      ensureSessionExists(sessionId, eventAt);
      advanceSessionToStage(sessionId, TRACKING_STAGE_BY_EVENT_TYPE[message.event.type], eventAt);
      break;
    }
    default:
      break;
  }
}

bridge.onMessage((message) => {
  if (!isHarnessInboundMessage(message)) {
    return;
  }
  applyMessage(message);
  render();
});

const demoMessages: HarnessInboundMessage[] = [
  { type: 'layoutLoaded', layout: { version: 1, seats: [] } },
  { type: 'agentCreated', id: 1 },
  { type: 'agentStatus', id: 1, status: 'active' },
  { type: 'agentToolStart', id: 1, toolId: 'tool-1', status: 'Read files' },
  {
    type: 'trackingEvent',
    event: { type: 'tracking_attempt', jsonlPath: '/tmp/session-1.jsonl', at: Date.now() },
  },
  {
    type: 'trackingEvent',
    event: { type: 'tracking_deferred', jsonlPath: '/tmp/session-1.jsonl', at: Date.now() },
  },
  {
    type: 'trackingEvent',
    event: { type: 'tracking_success', jsonlPath: '/tmp/session-1.jsonl', at: Date.now() },
  },
  { type: 'agentStatus', id: 1, status: 'waiting' },
  { type: 'agentToolPermission', id: 1 },
  { type: 'agentToolPermissionClear', id: 1 },
  { type: 'agentToolsClear', id: 1 },
  {
    type: 'trackingEvent',
    event: {
      type: 'tracking_failed',
      jsonlPath: '/tmp/session-1.jsonl',
      reason: 'demo-complete',
      at: Date.now(),
    },
  },
];

for (const message of demoMessages) {
  bridge.emitFromHost(message);
}
