import { spawn } from 'node:child_process';
import { cleanupDesktopProcesses, requestDesktopChildStop } from './lib/desktopProcessCleanup.js';

interface RuntimeCheckResult {
  sawWebviewReady: boolean;
  sawEbafd: boolean;
  sawServerStart: boolean;
  outputTail: string;
  exitCode: number | null;
}

const STARTUP_TIMEOUT_MS = 120_000;
const OBSERVE_AFTER_READY_MS = 15_000;
const OUTPUT_TAIL_MAX_CHARS = 18_000;
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function appendTail(current: string, chunk: string): string {
  const next = current + chunk;
  if (next.length <= OUTPUT_TAIL_MAX_CHARS) return next;
  return next.slice(next.length - OUTPUT_TAIL_MAX_CHARS);
}

function normalizeForMatch(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, '');
}

async function runDesktopRuntimeCheck(): Promise<RuntimeCheckResult> {
  return new Promise<RuntimeCheckResult>((resolve, reject) => {
    const child = spawn('npm', ['run', 'dev:desktop'], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      detached: process.platform !== 'win32',
    });

    let outputTail = '';
    let sawWebviewReady = false;
    let sawEbafd = false;
    let sawServerStart = false;
    let resolved = false;
    let startupTimer: ReturnType<typeof setTimeout> | null = null;
    let readyTimer: ReturnType<typeof setTimeout> | null = null;

    const clearTimers = () => {
      if (startupTimer) clearTimeout(startupTimer);
      if (readyTimer) clearTimeout(readyTimer);
      startupTimer = null;
      readyTimer = null;
    };

    const finish = (result: RuntimeCheckResult): void => {
      if (resolved) return;
      resolved = true;
      clearTimers();
      resolve(result);
    };

    const fail = (message: string): void => {
      if (resolved) return;
      resolved = true;
      clearTimers();
      requestDesktopChildStop(child, 'SIGINT');
      void cleanupDesktopProcesses(process.cwd());
      reject(new Error(`[test-desktop-runtime] ${message}\n--- output tail ---\n${outputTail}`));
    };

    const onChunk = (raw: Buffer | string): void => {
      const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
      outputTail = appendTail(outputTail, text);

      const normalizedTail = normalizeForMatch(outputTail);

      if (normalizedTail.includes('[desktop] webviewReady')) {
        sawWebviewReady = true;
      }
      if (normalizedTail.includes('Server started at http://localhost:')) {
        sawServerStart = true;
      }
      if (normalizedTail.includes('EBADF')) {
        sawEbafd = true;
      }

      if (sawWebviewReady && !readyTimer) {
        readyTimer = setTimeout(() => {
          requestDesktopChildStop(child, 'SIGINT');
        }, OBSERVE_AFTER_READY_MS);
      }
    };

    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    startupTimer = setTimeout(() => {
      fail(`timeout after ${STARTUP_TIMEOUT_MS}ms waiting for startup readiness`);
    }, STARTUP_TIMEOUT_MS);

    child.on('error', (error) => {
      fail(`failed to spawn desktop runtime: ${error.message}`);
    });

    child.on('close', (code) => {
      const normalizedTail = normalizeForMatch(outputTail);
      finish({
        sawWebviewReady: sawWebviewReady || normalizedTail.includes('[desktop] webviewReady'),
        sawEbafd: sawEbafd || normalizedTail.includes('EBADF'),
        sawServerStart: sawServerStart || normalizedTail.includes('Server started at http://localhost:'),
        outputTail,
        exitCode: code,
      });
    });
  });
}

async function main(): Promise<void> {
  const result = await runDesktopRuntimeCheck();
  const cleanup = await cleanupDesktopProcesses(process.cwd());

  console.log(`[test-desktop-runtime] sawServerStart=${result.sawServerStart}`);
  console.log(`[test-desktop-runtime] sawWebviewReady=${result.sawWebviewReady}`);
  console.log(`[test-desktop-runtime] sawEbafd=${result.sawEbafd}`);
  console.log(`[test-desktop-runtime] exitCode=${result.exitCode ?? -1}`);
  console.log(`[test-desktop-runtime] cleanup terminated=${cleanup.terminated} forceKilled=${cleanup.forceKilled}`);

  if (!result.sawServerStart) {
    throw new Error('[test-desktop-runtime] FAIL: server start log not found');
  }
  if (!result.sawWebviewReady) {
    throw new Error('[test-desktop-runtime] FAIL: webviewReady log not found');
  }
  if (result.sawEbafd) {
    throw new Error('[test-desktop-runtime] FAIL: EBADF detected in runtime logs');
  }
  if (result.exitCode !== 0 && result.exitCode !== null) {
    throw new Error(`[test-desktop-runtime] FAIL: expected exit code 0|null, got ${result.exitCode}`);
  }

  console.log('[test-desktop-runtime] PASS');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
