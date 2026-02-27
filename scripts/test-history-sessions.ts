import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { collectHistorySessions } from '../src/historySessions.js';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(`[test-history-sessions] ${message}`);
  }
}

function writeJsonl(dir: string, sessionId: string, daysAgo: number): string {
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, JSON.stringify({ type: 'user', isSidechain: false, sessionId }) + '\n', 'utf-8');
  const now = Date.now();
  const ts = new Date(now - (daysAgo * 24 * 60 * 60 * 1000));
  fs.utimesSync(filePath, ts, ts);
  return filePath;
}

function writeTeamJsonl(dir: string, sessionId: string, daysAgo: number): string {
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(
    filePath,
    JSON.stringify({ type: 'user', isSidechain: false, sessionId, teamName: 't', agentName: 'worker' }) + '\n',
    'utf-8',
  );
  const now = Date.now();
  const ts = new Date(now - (daysAgo * 24 * 60 * 60 * 1000));
  fs.utimesSync(filePath, ts, ts);
  return filePath;
}

function writeSnapshotOnlyJsonl(dir: string, sessionId: string, daysAgo: number): string {
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(
    filePath,
    JSON.stringify({ type: 'file-history-snapshot', messageId: 'x', snapshot: {}, isSnapshotUpdate: false }) + '\n',
    'utf-8',
  );
  const now = Date.now();
  const ts = new Date(now - (daysAgo * 24 * 60 * 60 * 1000));
  fs.utimesSync(filePath, ts, ts);
  return filePath;
}

function writeJsonlWithTaggedPreview(dir: string, sessionId: string, daysAgo: number): string {
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  const now = Date.now();
  const ts = new Date(now - (daysAgo * 24 * 60 * 60 * 1000));
  const iso = ts.toISOString();
  const line = JSON.stringify({
    type: 'user',
    isSidechain: false,
    isMeta: false,
    sessionId,
    timestamp: iso,
    message: {
      content: '<local-command-stdout>build passed</local-command-stdout>',
    },
  });
  fs.writeFileSync(filePath, `${line}\n`, 'utf-8');
  fs.utimesSync(filePath, ts, ts);
  return filePath;
}

function writeJsonlWithLongAssistantTail(
  dir: string,
  sessionId: string,
  daysAgo: number,
  userText: string,
): string {
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  const now = Date.now();
  const ts = new Date(now - (daysAgo * 24 * 60 * 60 * 1000));
  const iso = ts.toISOString();
  const lines: string[] = [];
  lines.push(JSON.stringify({
    type: 'user',
    isMeta: false,
    isSidechain: false,
    sessionId,
    timestamp: iso,
    message: { content: userText },
  }));
  const largeText = `${'A'.repeat(4096)} goodbye`;
  for (let i = 0; i < 80; i++) {
    lines.push(JSON.stringify({
      type: 'assistant',
      sessionId,
      timestamp: iso,
      message: { content: largeText },
    }));
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf-8');
  fs.utimesSync(filePath, ts, ts);
  return filePath;
}

function mkSessionId(seed: string): string {
  const clean = seed.replace(/[^0-9a-f]/gi, '').padEnd(32, '0').slice(0, 32).toLowerCase();
  return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`;
}

async function main(): Promise<void> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-history-'));
  try {
    const s1 = mkSessionId('11111111111111111111111111111111');
    const s2 = mkSessionId('22222222222222222222222222222222');
    const s3 = mkSessionId('33333333333333333333333333333333');
    const s4 = mkSessionId('44444444444444444444444444444444');
    const s5 = mkSessionId('55555555555555555555555555555555');
    const s6 = mkSessionId('66666666666666666666666666666666');
    const s7 = mkSessionId('77777777777777777777777777777777');
    const s8 = mkSessionId('88888888888888888888888888888888');

    const recentLive = writeJsonl(tempRoot, s1, 0);
    writeJsonl(tempRoot, s2, 1);
    writeJsonl(tempRoot, s3, 2);
    writeJsonl(tempRoot, s4, 8);
    writeTeamJsonl(tempRoot, s5, 1);
    writeSnapshotOnlyJsonl(tempRoot, s6, 1);
    writeJsonlWithTaggedPreview(tempRoot, s7, 1);
    writeJsonlWithLongAssistantTail(tempRoot, s8, 1, 'Build API gateway for tenant auth');

    const recent = collectHistorySessions(
      tempRoot,
      [recentLive],
      { enabled: true, lookbackDays: 3, maxVisible: 10 },
    );

    assert(recent.length === 4, `expected 4 recent sessions, got ${recent.length}`);
    assert(recent.every((s) => s.jsonlPath !== recentLive), 'live session path must be excluded');
    assert(
      recent.every((s) => s.sessionId === s2 || s.sessionId === s3 || s.sessionId === s7 || s.sessionId === s8),
      'unexpected session IDs in result',
    );
    assert(recent.every((s) => s.sessionId !== s5), 'team/subagent session must be excluded');
    assert(recent.every((s) => s.sessionId !== s6), 'snapshot-only session must be excluded');

    const withPreview = collectHistorySessions(
      tempRoot,
      [],
      { enabled: true, lookbackDays: 30, maxVisible: 10 },
    );
    const tagged = withPreview.find((s) => s.sessionId === s7);
    assert(!!tagged, 'expected tagged preview session to be present');
    assert(tagged!.preview === 'build passed', `expected stripped tagged preview, got "${tagged!.preview}"`);

    const longTail = withPreview.find((s) => s.sessionId === s8);
    assert(!!longTail, 'expected long-tail session to be present');
    assert(
      longTail!.preview === 'Build API gateway for tenant auth',
      `expected first user preview fallback, got "${longTail!.preview}"`,
    );

    const capped = collectHistorySessions(
      tempRoot,
      [],
      { enabled: true, lookbackDays: 30, maxVisible: 1 },
    );
    assert(capped.length === 1, `expected maxVisible cap=1, got ${capped.length}`);

    // Exclude by live session ID even when live path is from another project dir.
    const staleLivePath = path.join(tempRoot, 'stale', `${s2}.jsonl`);
    const bySessionFromPath = collectHistorySessions(
      tempRoot,
      [staleLivePath],
      { enabled: true, lookbackDays: 30, maxVisible: 10 },
    );
    assert(bySessionFromPath.every((s) => s.sessionId !== s2), 'live session inferred from jsonl basename must be excluded');

    // Explicit liveSessionIds should also exclude matching history entries.
    const byLiveSessionIds = collectHistorySessions(
      tempRoot,
      [],
      { enabled: true, lookbackDays: 30, maxVisible: 10 },
      [s3],
    );
    assert(byLiveSessionIds.every((s) => s.sessionId !== s3), 'liveSessionIds must be excluded');

    const disabled = collectHistorySessions(
      tempRoot,
      [],
      { enabled: false, lookbackDays: 30, maxVisible: 10 },
    );
    assert(disabled.length === 0, 'disabled mode must return empty list');

    console.log('[test-history-sessions] PASS');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('[test-history-sessions] FAIL:', error);
  process.exit(1);
});
