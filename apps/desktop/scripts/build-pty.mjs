import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'pty', 'main.zig');
const outDir = path.join(root, 'bin');
const outBin = path.join(outDir, 'pixel-agents-pty');
const outBinNext = `${outBin}.next`;

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

function resolveDarwinTarget() {
  if (process.platform !== 'darwin') return null;
  if (process.arch === 'arm64') return 'aarch64-macos';
  if (process.arch === 'x64') return 'x86_64-macos';
  return null;
}

function resolveSdkRoot() {
  if (process.platform !== 'darwin') return null;
  const sdk = spawnSync('xcrun', ['--show-sdk-path'], { encoding: 'utf-8' });
  if (sdk.status !== 0) return null;
  const value = sdk.stdout.trim();
  return value.length > 0 ? value : null;
}

const args = [
  'build-exe',
  source,
  '-O',
  'ReleaseFast',
];

const darwinTarget = resolveDarwinTarget();
if (darwinTarget) {
  args.push('-target', darwinTarget);
}

args.push(
  '-lc',
  `-femit-bin=${outBinNext}`,
);

const buildEnv = {
  ...process.env,
};
const sdkRoot = resolveSdkRoot();
if (sdkRoot) {
  args.push(`-I${path.join(sdkRoot, 'usr', 'include')}`);
  buildEnv.SDKROOT = sdkRoot;
  if (!buildEnv.MACOSX_DEPLOYMENT_TARGET) {
    buildEnv.MACOSX_DEPLOYMENT_TARGET = '14.0';
  }
}

if (fs.existsSync(outBinNext)) {
  fs.rmSync(outBinNext, { force: true });
}
if (fs.existsSync(outBin)) {
  fs.rmSync(outBin, { force: true });
}

console.log(`[build-pty] zig ${args.join(' ')}`);
if (darwinTarget) {
  console.log(`[build-pty] target=${darwinTarget}`);
}
if (sdkRoot) {
  console.log(`[build-pty] SDKROOT=${sdkRoot}`);
}
const build = spawnSync('zig', args, {
  stdio: 'inherit',
  cwd: root,
  env: buildEnv,
});

if (build.status !== 0) {
  console.warn('[build-pty] Zig PTY build failed; continuing without native PTY binary (runtime fallback will be used)');
  process.exit(0);
}

try {
  fs.renameSync(outBinNext, outBin);
} catch (error) {
  console.warn(`[build-pty] Failed to finalize PTY binary: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(0);
}

try {
  fs.chmodSync(outBin, 0o755);
} catch {
  // noop
}

console.log(`[build-pty] built ${outBin}`);
