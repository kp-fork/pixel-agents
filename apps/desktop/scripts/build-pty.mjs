import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'pty', 'main.zig');
const outDir = path.join(root, 'bin');
const outBin = path.join(outDir, 'pixel-agents-pty');

if (!fs.existsSync(source)) {
  console.error(`[build-pty] source not found: ${source}`);
  process.exit(1);
}

const zigVersion = spawnSync('zig', ['version'], { encoding: 'utf-8' });
if (zigVersion.status !== 0) {
  console.warn('[build-pty] zig not found; skipping Zig PTY build (runtime fallback will be used)');
  process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });

const args = [
  'build-exe',
  source,
  '-lc',
  '-O',
  'ReleaseFast',
  `-femit-bin=${outBin}`,
];

console.log(`[build-pty] zig ${args.join(' ')}`);
const build = spawnSync('zig', args, {
  stdio: 'inherit',
  cwd: root,
});

if (build.status !== 0) {
  console.warn('[build-pty] Zig PTY build failed; continuing without native PTY binary (runtime fallback will be used)');
  process.exit(0);
}

try {
  fs.chmodSync(outBin, 0o755);
} catch {
  // noop
}

console.log(`[build-pty] built ${outBin}`);
