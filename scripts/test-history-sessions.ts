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
  fs.writeFileSync(filePath, JSON.stringify({ type: 'assistant' }) + '\n', 'utf-8');
  const now = Date.now();
  const ts = new Date(now - (daysAgo * 24 * 60 * 60 * 1000));
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

    const recentLive = writeJsonl(tempRoot, s1, 0);
    writeJsonl(tempRoot, s2, 1);
    writeJsonl(tempRoot, s3, 2);
    writeJsonl(tempRoot, s4, 8);

    const recent = collectHistorySessions(
      tempRoot,
      [recentLive],
      { enabled: true, lookbackDays: 3, maxVisible: 10 },
    );

    assert(recent.length === 2, `expected 2 recent sessions, got ${recent.length}`);
    assert(recent.every((s) => s.jsonlPath !== recentLive), 'live session path must be excluded');
    assert(recent.every((s) => s.sessionId === s2 || s.sessionId === s3), 'unexpected session IDs in result');

    const capped = collectHistorySessions(
      tempRoot,
      [],
      { enabled: true, lookbackDays: 30, maxVisible: 1 },
    );
    assert(capped.length === 1, `expected maxVisible cap=1, got ${capped.length}`);

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
