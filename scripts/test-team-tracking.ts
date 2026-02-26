import { processTranscriptLine } from '../src/transcriptParser.js';

interface AgentStateLike {
  id: number;
  terminalRef: unknown;
  projectDir: string;
  jsonlFile: string;
  fileOffset: number;
  lineBuffer: string;
  activeToolIds: Set<string>;
  activeToolStatuses: Map<string, string>;
  activeToolNames: Map<string, string>;
  activeSubagentToolIds: Map<string, Set<string>>;
  activeSubagentToolNames: Map<string, Map<string, string>>;
  isWaiting: boolean;
  permissionSent: boolean;
  hadToolsInTurn: boolean;
}

type Message = { type?: string; [key: string]: unknown };

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`[test-team-tracking] ${message}`);
}

function clearAllTimers(timers: Map<number, ReturnType<typeof setTimeout>>): void {
  for (const timer of timers.values()) {
    clearTimeout(timer);
  }
  timers.clear();
}

async function main(): Promise<void> {
  const agentId = 1;
  const parentToolId = 'parent-team-1';
  const subToolId = 'sub-read-1';

  const agents = new Map<number, AgentStateLike>();
  agents.set(agentId, {
    id: agentId,
    terminalRef: null,
    projectDir: '/tmp',
    jsonlFile: '/tmp/session.jsonl',
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
  });

  const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const emitted: Message[] = [];
  const webview = {
    postMessage(message: unknown): void {
      emitted.push((message || {}) as Message);
    },
  };

  const lines = [
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: parentToolId, name: 'TeamPlan', input: { description: 'Coordinate refactor' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'progress',
      parentToolUseID: parentToolId,
      data: {
        message: {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: subToolId, name: 'Read', input: { file_path: '/tmp/a.ts' } },
            ],
          },
        },
      },
    }),
    JSON.stringify({
      type: 'progress',
      parentToolUseID: parentToolId,
      data: {
        message: {
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: subToolId },
            ],
          },
        },
      },
    }),
    JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: parentToolId },
        ],
      },
    }),
  ];

  for (const line of lines) {
    processTranscriptLine(
      agentId,
      line,
      agents as unknown as Map<number, never>,
      waitingTimers,
      permissionTimers,
      webview as never,
    );
  }

  await new Promise((resolve) => setTimeout(resolve, 350));
  clearAllTimers(waitingTimers);
  clearAllTimers(permissionTimers);

  const parentStart = emitted.find((m) => m.type === 'agentToolStart' && m.toolId === parentToolId);
  assert(parentStart, 'expected parent agentToolStart');
  assert(typeof parentStart?.status === 'string' && String(parentStart.status).startsWith('Subtask:'), 'expected Team* parent status to be Subtask:*');

  const subStart = emitted.find((m) => m.type === 'subagentToolStart' && m.parentToolId === parentToolId && m.toolId === subToolId);
  assert(subStart, 'expected subagentToolStart for progress assistant tool_use');

  const subDone = emitted.find((m) => m.type === 'subagentToolDone' && m.parentToolId === parentToolId && m.toolId === subToolId);
  assert(subDone, 'expected subagentToolDone for progress user tool_result');

  const subClear = emitted.find((m) => m.type === 'subagentClear' && m.parentToolId === parentToolId);
  assert(subClear, 'expected subagentClear when parent Team* tool completes');

  const parentDone = emitted.find((m) => m.type === 'agentToolDone' && m.toolId === parentToolId);
  assert(parentDone, 'expected parent agentToolDone');

  const activeStatus = emitted.find((m) => m.type === 'agentStatus' && m.status === 'active');
  assert(activeStatus, 'expected agentStatus(active) when tools start');

  console.log('[test-team-tracking] PASS');
}

main().catch((error) => {
  console.error('[test-team-tracking] FAIL:', error);
  process.exit(1);
});
