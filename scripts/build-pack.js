#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function usage() {
	console.error('Usage: npm run build:pack -- <src-dir> <output-dir>');
}

function fail(message) {
	console.error(`Error: ${message}`);
	process.exit(1);
}

function resolveInside(rootDir, relativePath) {
	const absoluteRoot = path.resolve(rootDir);
	const normalized = String(relativePath || '').replace(/\\/g, '/');
	const target = path.resolve(absoluteRoot, normalized);
	const rootWithSep = absoluteRoot.endsWith(path.sep) ? absoluteRoot : `${absoluteRoot}${path.sep}`;
	if (target !== absoluteRoot && !target.startsWith(rootWithSep)) {
		throw new Error(`Path escapes pack root: ${relativePath}`);
	}
	return target;
}

function validatePackSource(srcDir) {
	const manifestPath = path.join(srcDir, 'manifest.json');
	if (!fs.existsSync(manifestPath)) {
		fail(`manifest.json not found in ${srcDir}`);
	}

	let manifest;
	try {
		manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
	} catch (err) {
		fail(`manifest.json parse failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	if (!manifest || typeof manifest !== 'object') {
		fail('manifest.json must be a JSON object');
	}
	if (manifest.packVersion !== 1) {
		fail('manifest.packVersion must be 1');
	}
	if (typeof manifest.entryLayout !== 'string' || !manifest.entryLayout.trim()) {
		fail('manifest.entryLayout is required');
	}
	if (typeof manifest.furnitureCatalog !== 'string' || !manifest.furnitureCatalog.trim()) {
		fail('manifest.furnitureCatalog is required');
	}

	const entryLayout = resolveInside(srcDir, manifest.entryLayout);
	const furnitureCatalog = resolveInside(srcDir, manifest.furnitureCatalog);
	if (!fs.existsSync(entryLayout)) {
		fail(`entryLayout file not found: ${manifest.entryLayout}`);
	}
	if (!fs.existsSync(furnitureCatalog)) {
		fail(`furnitureCatalog file not found: ${manifest.furnitureCatalog}`);
	}
}

function buildZip(srcDir, outputDir, outFileName) {
	const outPath = path.join(outputDir, outFileName);
	if (fs.existsSync(outPath)) {
		fs.rmSync(outPath, { force: true });
	}

	if (process.platform === 'win32') {
		const srcGlob = path.join(srcDir, '*');
		const script = [
			`$src = '${srcGlob.replace(/'/g, "''")}'`,
			`$dst = '${outPath.replace(/'/g, "''")}'`,
			'Compress-Archive -Path $src -DestinationPath $dst -Force',
		].join('; ');
		execFileSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'inherit' });
		return outPath;
	}

	execFileSync('zip', ['-rq', outPath, '.'], { cwd: srcDir, stdio: 'inherit' });
	return outPath;
}

function main() {
	const [srcArg, outputArg] = process.argv.slice(2);
	if (!srcArg || !outputArg) {
		usage();
		process.exit(1);
	}

	const srcDir = path.resolve(srcArg);
	const outputDir = path.resolve(outputArg);
	if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
		fail(`src-dir is not a directory: ${srcDir}`);
	}
	fs.mkdirSync(outputDir, { recursive: true });

	validatePackSource(srcDir);
	const outFileName = `${path.basename(srcDir)}.pack.zip`;
	const outPath = buildZip(srcDir, outputDir, outFileName);
	console.log(`Built pack: ${outPath}`);
}

main();
