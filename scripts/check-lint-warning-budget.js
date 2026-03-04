const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const budgetPath = path.join(repoRoot, 'docs', 'quality', 'lint-warning-budget.json');

function loadBudget() {
  const raw = fs.readFileSync(budgetPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed.maxWarnings !== 'number' || !Number.isFinite(parsed.maxWarnings)) {
    throw new Error(`Invalid lint warning budget file: ${budgetPath}`);
  }
  return parsed;
}

function runLintJson() {
  const eslintBin = path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'eslint.cmd' : 'eslint');
  try {
    return execFileSync(eslintBin, ['src', '-f', 'json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stdout = error && typeof error === 'object' && 'stdout' in error ? String(error.stdout || '') : '';
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr || '') : '';
    if (!stdout.trim()) {
      throw new Error(stderr || `eslint failed with code ${error && typeof error === 'object' && 'status' in error ? error.status : 'unknown'}`);
    }
    return stdout;
  }
}

function countWarningsAndErrors(eslintJsonText) {
  const reports = JSON.parse(eslintJsonText);
  let warnings = 0;
  let errors = 0;
  for (const report of reports) {
    warnings += Number(report.warningCount || 0);
    errors += Number(report.errorCount || 0);
  }
  return { warnings, errors };
}

function main() {
  const budget = loadBudget();
  const lintJson = runLintJson();
  const { warnings, errors } = countWarningsAndErrors(lintJson);

  console.log(`[quality] lint errors=${errors} warnings=${warnings} budget=${budget.maxWarnings}`);

  if (errors > 0) {
    console.error('[quality] FAILED: lint errors detected.');
    process.exit(1);
  }
  if (warnings > budget.maxWarnings) {
    console.error(`[quality] FAILED: lint warnings exceeded budget (${warnings} > ${budget.maxWarnings}).`);
    process.exit(1);
  }

  console.log('[quality] PASS: lint warnings are within budget.');
}

main();
