import { decideJsonlRouting } from '../src/application/tracking/jsonlRouting.js';

interface Agent {
  id: number;
  terminalRef: unknown;
}

function assertEqual(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`[test-jsonl-routing] ${name} failed\nexpected=${e}\nactual=${a}`);
  }
}

function run(name: string, input: { activeAgentId: number | null; activeTerminal: unknown; agents: Agent[] }, expected: unknown): void {
  const result = decideJsonlRouting(input.activeAgentId, input.activeTerminal, input.agents);
  assertEqual(name, result, expected);
  console.log(`[test-jsonl-routing] PASS: ${name}`);
}

const termA = { name: 'A' };
const termB = { name: 'B' };

run(
  'uses active agent when selected',
  {
    activeAgentId: 7,
    activeTerminal: null,
    agents: [{ id: 7, terminalRef: termA }],
  },
  { action: 'reassign', agentId: 7 },
);

run(
  'reassigns owned active terminal when no selected agent',
  {
    activeAgentId: null,
    activeTerminal: termB,
    agents: [
      { id: 1, terminalRef: termA },
      { id: 2, terminalRef: termB },
    ],
  },
  { action: 'reassign', agentId: 2 },
);

run(
  'adopts active terminal when terminal is unowned',
  {
    activeAgentId: null,
    activeTerminal: termA,
    agents: [{ id: 2, terminalRef: termB }],
  },
  { action: 'adopt' },
);

run(
  'ignores when no active terminal and no selected agent',
  {
    activeAgentId: null,
    activeTerminal: null,
    agents: [{ id: 3, terminalRef: termA }],
  },
  { action: 'ignore' },
);

console.log('[test-jsonl-routing] ALL PASS');
