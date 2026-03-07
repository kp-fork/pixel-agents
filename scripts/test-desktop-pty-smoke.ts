import * as path from 'node:path';
import { createRequire } from 'node:module';

type PtyLike = {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
};

type PtyModuleLike = {
  spawn(
    file: string,
    args: string[] | string,
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string | undefined>;
    }
  ): PtyLike;
};

function resolveShell(): { executable: string; args: string[] } {
  if (process.platform === 'win32') {
    return { executable: 'powershell.exe', args: ['-NoLogo'] };
  }
  const shell = (process.env.SHELL || '').trim();
  if (shell.length > 0) {
    const base = path.basename(shell).toLowerCase();
    if (base.includes('fish')) return { executable: shell, args: ['--interactive', '--login'] };
    if (base.includes('zsh') || base.includes('bash')) return { executable: shell, args: ['-il'] };
    return { executable: shell, args: ['-i'] };
  }
  return { executable: '/bin/zsh', args: ['-il'] };
}

function fail(message: string): never {
  throw new Error(`[test-desktop-pty] ${message}`);
}

async function main(): Promise<void> {
  const desktopPkgJson = path.join(process.cwd(), 'apps', 'desktop', 'package.json');
  const desktopRequire = createRequire(desktopPkgJson);
  const pty = desktopRequire('@lydell/node-pty') as PtyModuleLike;

  const shell = resolveShell();
  const cwd = path.join(process.cwd(), 'apps', 'desktop');
  const marker = '__PIXEL_PTY_MARKER__';

  const term = pty.spawn(shell.executable, shell.args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env: process.env,
  });

  let output = '';
  let exited = false;
  let resizeOk = false;
  let resizeError: string | null = null;

  const dataSub = term.onData((chunk) => {
    output += chunk;
    if (output.length > 64 * 1024) {
      output = output.slice(-64 * 1024);
    }
  });
  const exitSub = term.onExit((event) => {
    exited = true;
    // Keep this as info; immediate exit usually means shell launch issue.
    console.log(`[test-desktop-pty] onExit exitCode=${event.exitCode} signal=${event.signal ?? 0}`);
  });

  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const schedule = (ms: number, fn: () => void): void => {
    timers.push(setTimeout(fn, ms));
  };

  schedule(120, () => {
    try {
      term.resize(100, 30);
      resizeOk = true;
    } catch (error) {
      resizeError = error instanceof Error ? error.message : String(error);
    }
  });
  schedule(240, () => term.write(`echo ${marker}\r`));
  schedule(420, () => term.write('pwd\r'));
  if (process.platform !== 'win32') {
    schedule(620, () => term.write('echo "$-"\r'));
  }

  await new Promise<void>((resolve) => {
    schedule(1700, () => resolve());
  });

  for (const timer of timers) clearTimeout(timer);
  dataSub.dispose();
  exitSub.dispose();
  try { term.kill(); } catch { /* noop */ }

  if (exited && output.length === 0) {
    fail('PTY exited before producing any output');
  }
  if (!resizeOk) {
    fail(`resize failed${resizeError ? `: ${resizeError}` : ''}`);
  }
  if (!output.includes(marker)) {
    fail('marker output not found');
  }

  const sanitizedTail = output
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\r/g, '\\r')
    .split('\n')
    .slice(-16)
    .join('\n');

  console.log(`[test-desktop-pty] shell=${shell.executable} args=${JSON.stringify(shell.args)} cwd=${cwd}`);
  console.log(`[test-desktop-pty] outputBytes=${output.length} markerFound=yes resizeOk=yes`);
  console.log('[test-desktop-pty] tail-start');
  console.log(sanitizedTail);
  console.log('[test-desktop-pty] tail-end');
  console.log('[test-desktop-pty] PASS');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
