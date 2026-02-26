import { deriveOverlayState } from '../webview-ui/src/office/components/toolOverlayState.js';
import type { ToolActivity } from '../webview-ui/src/office/types.js';

function assertEqual(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`[test-tool-overlay-state] ${name} failed\nexpected=${e}\nactual=${a}`);
  }
}

const running: ToolActivity = { toolId: 't1', status: 'Running: npm test', done: false };
const permission: ToolActivity = { toolId: 't2', status: 'Reading file.ts', done: false, permissionWait: true };
const subDone: ToolActivity = { toolId: 's1', status: 'Reading a.ts', done: true };
const subRun: ToolActivity = { toolId: 's2', status: 'Editing b.ts', done: false };

assertEqual(
  'active-without-tools-shows-working',
  deriveOverlayState({ isSubagent: false, isActive: true, bubbleType: null, tools: [] }).activityText,
  'Working',
);

assertEqual(
  'permission-priority',
  deriveOverlayState({ isSubagent: false, isActive: true, bubbleType: null, tools: [running, permission] }).activityText,
  'Needs approval',
);

assertEqual(
  'coordinating-progress',
  deriveOverlayState({
    isSubagent: false,
    isActive: true,
    bubbleType: null,
    tools: [running],
    subToolGroups: { parentA: [subDone, subRun] },
  }).activityText,
  'Coordinating 1/2',
);

assertEqual(
  'inactive-no-tools-idle',
  deriveOverlayState({ isSubagent: false, isActive: false, bubbleType: null, tools: [] }).activityText,
  'Idle',
);

const subPerm = deriveOverlayState({ isSubagent: true, isActive: true, bubbleType: 'permission', subLabel: 'My Subtask' });
assertEqual('subagent-permission-text', subPerm.activityText, 'Needs approval');
assertEqual('subagent-permission-flag', subPerm.hasPermission, true);

const subNormal = deriveOverlayState({ isSubagent: true, isActive: true, bubbleType: null, subLabel: 'My Subtask' });
assertEqual('subagent-label', subNormal.activityText, 'My Subtask');

console.log('[test-tool-overlay-state] PASS');
