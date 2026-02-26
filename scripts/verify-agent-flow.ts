import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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

function normalizeWorkspacePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 1) return trimmed;
  return trimmed.replace(/[\\/]+$/, '');
}

function currentDirNameForWorkspace(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '-');
}

function legacyDirNameForWorkspace(value: string): string {
  return value.replace(/[:\\/]/g, '-');
}

function resolveProjectDir(cwd: string): string | null {
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  const normalizedPath = normalizeWorkspacePath(cwd);

  const candidates = new Set<string>([
    path.join(projectsRoot, currentDirNameForWorkspace(normalizedPath)),
    path.join(projectsRoot, legacyDirNameForWorkspace(normalizedPath)),
  ]);

  try {
    const real = fs.realpathSync(normalizedPath);
    const normalizedReal = normalizeWorkspacePath(real);
    candidates.add(path.join(projectsRoot, currentDirNameForWorkspace(normalizedReal)));
    candidates.add(path.join(projectsRoot, legacyDirNameForWorkspace(normalizedReal)));
  } catch {
    // ignore
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function pickLatestJsonl(projectDir: string): string | null {
  const files = fs
    .readdirSync(projectDir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => path.join(projectDir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  return files[0] || null;
}

function countByType(messages: Message[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const type = typeof message.type === 'string' ? message.type : 'unknown';
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  return counts;
}

function clearAllTimers(timers: Map<number, ReturnType<typeof setTimeout>>): void {
  for (const timer of timers.values()) {
    clearTimeout(timer);
  }
  timers.clear();
}

async function main(): Promise<void> {
  const explicitJsonl = process.argv[2];
  const cwd = process.cwd();

  const projectDir = explicitJsonl ? path.dirname(explicitJsonl) : resolveProjectDir(cwd);
  if (!projectDir) {
    console.error('[verify-agent-flow] FAIL: project dir not found');
    process.exit(1);
  }

  const jsonlFile = explicitJsonl || pickLatestJsonl(projectDir);
  if (!jsonlFile || !fs.existsSync(jsonlFile)) {
    console.error(`[verify-agent-flow] FAIL: jsonl not found in ${projectDir}`);
    process.exit(1);
  }

  const content = fs.readFileSync(jsonlFile, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim().length > 0);
  const rawToolUseCount = lines.filter((line) => line.includes('"type":"tool_use"')).length;

  const agents = new Map<number, AgentStateLike>();
  agents.set(1, {
    id: 1,
    terminalRef: null,
    projectDir,
    jsonlFile,
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

  for (const line of lines) {
    processTranscriptLine(
      1,
      line,
      agents as unknown as Map<number, never>,
      waitingTimers,
      permissionTimers,
      webview as never,
    );
  }

  // process delayed agentToolDone events
  await new Promise((resolve) => setTimeout(resolve, 350));

  clearAllTimers(waitingTimers);
  clearAllTimers(permissionTimers);

  const counts = countByType(emitted);
  const activeStatusCount = emitted.filter((m) => m.type === 'agentStatus' && m.status === 'active').length;
  const waitingStatusCount = emitted.filter((m) => m.type === 'agentStatus' && m.status === 'waiting').length;
  const toolStartCount = counts.get('agentToolStart') || 0;

  console.log(`[verify-agent-flow] projectDir=${projectDir}`);
  console.log(`[verify-agent-flow] jsonl=${jsonlFile}`);
  console.log(`[verify-agent-flow] lines=${lines.length} rawToolUseLines=${rawToolUseCount}`);
  console.log(`[verify-agent-flow] emitted=${JSON.stringify(Object.fromEntries(counts))}`);
  console.log(`[verify-agent-flow] activeStatus=${activeStatusCount} waitingStatus=${waitingStatusCount} toolStart=${toolStartCount}`);

  if (rawToolUseCount > 0 && toolStartCount === 0) {
    console.error('[verify-agent-flow] FAIL: tool_use exists but no agentToolStart emitted');
    process.exit(1);
  }

  if (toolStartCount > 0 && activeStatusCount === 0) {
    console.error('[verify-agent-flow] FAIL: toolStart exists but no agentStatus(active) emitted');
    process.exit(1);
  }

  console.log('[verify-agent-flow] PASS');
}

main().catch((error) => {
  console.error('[verify-agent-flow] FAIL:', error);
  process.exit(1);
});
