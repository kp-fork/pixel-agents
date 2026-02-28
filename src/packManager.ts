import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';

export interface PackManifest {
	packVersion: number;
	id: string;
	name: string;
	description?: string;
	author?: string;
	createdAt?: string;
	entryLayout: string;
	furnitureCatalog: string;
}

export interface AppliedPack {
	packRoot: string;
	manifest: PackManifest;
	layout: Record<string, unknown>;
}

const PACK_HOME_DIR = path.join(os.homedir(), '.pixel-agents');
const ACTIVE_PACK_DIR = path.join(PACK_HOME_DIR, 'pack-current');

function execFileAsync(command: string, args: string[], options?: { cwd?: string }): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile(command, args, { cwd: options?.cwd }, (err) => {
			if (err) {
				reject(err);
				return;
			}
			resolve();
		});
	});
}

function escapePsSingleQuoted(value: string): string {
	return value.replace(/'/g, "''");
}

async function extractZip(zipPath: string, destDir: string): Promise<void> {
	try {
		await execFileAsync('unzip', ['-oq', zipPath, '-d', destDir]);
		return;
	} catch (err) {
		if (process.platform !== 'win32') {
			throw new Error(`Failed to extract zip with unzip: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	const zipEscaped = escapePsSingleQuoted(zipPath);
	const destEscaped = escapePsSingleQuoted(destDir);
	const script = `Expand-Archive -LiteralPath '${zipEscaped}' -DestinationPath '${destEscaped}' -Force`;
	try {
		await execFileAsync('powershell', ['-NoProfile', '-Command', script]);
	} catch (err) {
		throw new Error(`Failed to extract zip with PowerShell: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function createZip(sourceDir: string, outZipPath: string): Promise<void> {
	if (fs.existsSync(outZipPath)) {
		fs.rmSync(outZipPath, { force: true });
	}
	fs.mkdirSync(path.dirname(outZipPath), { recursive: true });
	try {
		await execFileAsync('zip', ['-rq', outZipPath, '.'], { cwd: sourceDir });
		return;
	} catch (err) {
		if (process.platform !== 'win32') {
			throw new Error(`Failed to create zip with zip: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	const sourceGlob = path.join(sourceDir, '*');
	const srcEscaped = escapePsSingleQuoted(sourceGlob);
	const outEscaped = escapePsSingleQuoted(outZipPath);
	const script = `Compress-Archive -Path '${srcEscaped}' -DestinationPath '${outEscaped}' -Force`;
	try {
		await execFileAsync('powershell', ['-NoProfile', '-Command', script]);
	} catch (err) {
		throw new Error(`Failed to create zip with PowerShell: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function resolveInside(rootDir: string, relativePath: string): string {
	const absoluteRoot = path.resolve(rootDir);
	const normalized = (relativePath || '').replace(/\\/g, '/');
	const target = path.resolve(absoluteRoot, normalized);
	const rootWithSep = absoluteRoot.endsWith(path.sep) ? absoluteRoot : `${absoluteRoot}${path.sep}`;
	if (target !== absoluteRoot && !target.startsWith(rootWithSep)) {
		throw new Error(`Path escapes pack root: ${relativePath}`);
	}
	return target;
}

function readJsonFile<T>(filePath: string): T {
	return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function validateManifest(raw: unknown): PackManifest {
	if (!raw || typeof raw !== 'object') {
		throw new Error('Invalid manifest.json: expected object');
	}
	const obj = raw as Record<string, unknown>;
	if (obj.packVersion !== 1) {
		throw new Error('Unsupported packVersion (expected 1)');
	}
	const id = typeof obj.id === 'string' ? obj.id.trim() : '';
	const name = typeof obj.name === 'string' ? obj.name.trim() : '';
	const entryLayout = typeof obj.entryLayout === 'string' ? obj.entryLayout.trim() : '';
	const furnitureCatalog = typeof obj.furnitureCatalog === 'string' ? obj.furnitureCatalog.trim() : '';
	if (!id || !name || !entryLayout || !furnitureCatalog) {
		throw new Error('Manifest missing required keys: id/name/entryLayout/furnitureCatalog');
	}
	return {
		packVersion: 1,
		id,
		name,
		description: typeof obj.description === 'string' ? obj.description : undefined,
		author: typeof obj.author === 'string' ? obj.author : undefined,
		createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : undefined,
		entryLayout,
		furnitureCatalog,
	};
}

function resolveAssetSourcePath(packRoot: string, fileField: string): string {
	const raw = (fileField || '').trim().replace(/\\/g, '/');
	if (!raw) throw new Error('Catalog asset has empty file path');
	const candidateDirect = resolveInside(packRoot, raw);
	if (fs.existsSync(candidateDirect)) return candidateDirect;
	const prefixed = raw.startsWith('assets/') ? raw : `assets/${raw}`;
	const candidateAssets = resolveInside(packRoot, prefixed);
	if (fs.existsSync(candidateAssets)) return candidateAssets;
	throw new Error(`Missing asset file in pack: ${fileField}`);
}

function installPackFromExtracted(
	packRoot: string,
	manifest: PackManifest,
	layoutPath: string,
	catalogPath: string,
	layout: Record<string, unknown>,
	catalog: { assets?: Array<{ file?: string }> },
): string {
	fs.mkdirSync(PACK_HOME_DIR, { recursive: true });
	const stageDir = path.join(PACK_HOME_DIR, `pack-stage-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
	fs.mkdirSync(path.join(stageDir, 'assets', 'furniture', 'custom'), { recursive: true });

	// Canonical runtime paths used by current loader.
	const canonicalManifestPath = path.join(stageDir, 'manifest.json');
	const canonicalLayoutPath = path.join(stageDir, 'assets', 'default-layout.json');
	const canonicalCatalogPath = path.join(stageDir, 'assets', 'furniture', 'furniture-catalog.json');

	fs.writeFileSync(canonicalManifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
	fs.copyFileSync(layoutPath, canonicalLayoutPath);
	fs.copyFileSync(catalogPath, canonicalCatalogPath);

	const assets = Array.isArray(catalog.assets) ? catalog.assets : [];
	for (const entry of assets) {
		const fileField = typeof entry.file === 'string' ? entry.file : '';
		if (!fileField) continue;
		const sourceFile = resolveAssetSourcePath(packRoot, fileField);
		const normalized = fileField.startsWith('assets/')
			? fileField
			: `assets/${fileField}`;
		const destination = path.join(stageDir, normalized.replace(/\\/g, '/'));
		fs.mkdirSync(path.dirname(destination), { recursive: true });
		fs.copyFileSync(sourceFile, destination);
	}

	const backupDir = `${ACTIVE_PACK_DIR}.bak`;
	try {
		if (fs.existsSync(backupDir)) {
			fs.rmSync(backupDir, { recursive: true, force: true });
		}
		if (fs.existsSync(ACTIVE_PACK_DIR)) {
			fs.renameSync(ACTIVE_PACK_DIR, backupDir);
		}
		fs.renameSync(stageDir, ACTIVE_PACK_DIR);
		if (fs.existsSync(backupDir)) {
			fs.rmSync(backupDir, { recursive: true, force: true });
		}
	} catch (err) {
		if (fs.existsSync(backupDir) && !fs.existsSync(ACTIVE_PACK_DIR)) {
			try {
				fs.renameSync(backupDir, ACTIVE_PACK_DIR);
			} catch {
				// ignore rollback failure
			}
		}
		if (fs.existsSync(stageDir)) {
			fs.rmSync(stageDir, { recursive: true, force: true });
		}
		throw err;
	}

	return ACTIVE_PACK_DIR;
}

function applyPackRoot(packRoot: string): AppliedPack {
	const manifestPath = path.join(packRoot, 'manifest.json');
	if (!fs.existsSync(manifestPath)) {
		throw new Error('manifest.json not found at pack root');
	}

	const manifest = validateManifest(readJsonFile<unknown>(manifestPath));
	const layoutPath = resolveInside(packRoot, manifest.entryLayout);
	const catalogPath = resolveInside(packRoot, manifest.furnitureCatalog);
	if (!fs.existsSync(layoutPath)) {
		throw new Error(`Entry layout not found: ${manifest.entryLayout}`);
	}
	if (!fs.existsSync(catalogPath)) {
		throw new Error(`Furniture catalog not found: ${manifest.furnitureCatalog}`);
	}

	const layout = readJsonFile<Record<string, unknown>>(layoutPath);
	if (layout.version !== 1 || !Array.isArray(layout.tiles) || !Array.isArray(layout.furniture)) {
		throw new Error('Invalid entry layout format');
	}

	const catalog = readJsonFile<{ assets?: Array<{ file?: string }> }>(catalogPath);
	if (!catalog || !Array.isArray(catalog.assets)) {
		throw new Error('Invalid furniture catalog format');
	}

	// Validate referenced asset files up front.
	for (const entry of catalog.assets) {
		const fileField = typeof entry.file === 'string' ? entry.file : '';
		if (!fileField) continue;
		resolveAssetSourcePath(packRoot, fileField);
	}

	const installedRoot = installPackFromExtracted(
		packRoot,
		manifest,
		layoutPath,
		catalogPath,
		layout,
		catalog,
	);

	return {
		packRoot: installedRoot,
		manifest,
		layout,
	};
}

export async function applyPackDirectory(packRoot: string): Promise<AppliedPack> {
	if (!fs.existsSync(packRoot)) {
		throw new Error('Pack directory not found');
	}
	return applyPackRoot(packRoot);
}

export async function applyPackZip(zipPath: string): Promise<AppliedPack> {
	if (!fs.existsSync(zipPath)) {
		throw new Error('Pack zip file not found');
	}

	const extractRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-pack-'));
	try {
		await extractZip(zipPath, extractRoot);
		return applyPackRoot(extractRoot);
	} finally {
		if (fs.existsSync(extractRoot)) {
			fs.rmSync(extractRoot, { recursive: true, force: true });
		}
	}
}

export interface ExportPackOptions {
	layout: Record<string, unknown>;
	sourceAssetsRoot: string;
	outputZipPath: string;
	packId?: string;
	packName?: string;
	description?: string;
	author?: string;
}

function sanitizePackId(raw: string): string {
	const normalized = raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
	return normalized || `pixel-agents.export.${Date.now()}`;
}

export async function exportPackZip(options: ExportPackOptions): Promise<void> {
	const { layout, sourceAssetsRoot, outputZipPath } = options;
	if (!layout || typeof layout !== 'object') {
		throw new Error('Invalid layout object');
	}
	const version = (layout as { version?: unknown }).version;
	const tiles = (layout as { tiles?: unknown }).tiles;
	const furniture = (layout as { furniture?: unknown }).furniture;
	if (version !== 1 || !Array.isArray(tiles) || !Array.isArray(furniture)) {
		throw new Error('Layout must be version 1 with tiles[] and furniture[]');
	}

	const catalogPath = path.join(sourceAssetsRoot, 'assets', 'furniture', 'furniture-catalog.json');
	if (!fs.existsSync(catalogPath)) {
		throw new Error(`Furniture catalog not found: ${catalogPath}`);
	}
	const catalog = readJsonFile<{ assets?: Array<{ file?: string }> }>(catalogPath);
	if (!catalog || !Array.isArray(catalog.assets)) {
		throw new Error('Invalid furniture catalog format');
	}

	const packId = sanitizePackId(options.packId || path.basename(outputZipPath, path.extname(outputZipPath)));
	const packName = (options.packName || path.basename(outputZipPath, path.extname(outputZipPath)) || 'Pixel Agents Export').trim();
	const description = options.description || 'Exported from Pixel Agents Layout menu';
	const author = options.author || 'pixel-agents';
	const createdAt = new Date().toISOString();

	const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-export-pack-'));
	try {
		const layoutsDir = path.join(stageRoot, 'layouts');
		const catalogDir = path.join(stageRoot, 'assets', 'furniture');
		const customDir = path.join(catalogDir, 'custom');
		fs.mkdirSync(layoutsDir, { recursive: true });
		fs.mkdirSync(customDir, { recursive: true });

		fs.writeFileSync(path.join(layoutsDir, 'default-layout.json'), JSON.stringify(layout, null, 2), 'utf-8');
		fs.copyFileSync(catalogPath, path.join(catalogDir, 'furniture-catalog.json'));

		for (const entry of catalog.assets) {
			const fileField = typeof entry.file === 'string' ? entry.file : '';
			if (!fileField) continue;
			const sourceFile = resolveAssetSourcePath(sourceAssetsRoot, fileField);
			const normalized = fileField.startsWith('assets/')
				? fileField
				: `assets/${fileField}`;
			const destination = path.join(stageRoot, normalized.replace(/\\/g, '/'));
			fs.mkdirSync(path.dirname(destination), { recursive: true });
			fs.copyFileSync(sourceFile, destination);
		}

		const manifest: PackManifest = {
			packVersion: 1,
			id: packId,
			name: packName,
			description,
			author,
			createdAt,
			entryLayout: 'layouts/default-layout.json',
			furnitureCatalog: 'assets/furniture/furniture-catalog.json',
		};
		fs.writeFileSync(path.join(stageRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

		await createZip(stageRoot, outputZipPath);
	} finally {
		if (fs.existsSync(stageRoot)) {
			fs.rmSync(stageRoot, { recursive: true, force: true });
		}
	}
}

export function getInstalledPackRoot(): string | null {
	const manifestPath = path.join(ACTIVE_PACK_DIR, 'manifest.json');
	const layoutPath = path.join(ACTIVE_PACK_DIR, 'assets', 'default-layout.json');
	const catalogPath = path.join(ACTIVE_PACK_DIR, 'assets', 'furniture', 'furniture-catalog.json');
	if (!fs.existsSync(manifestPath) || !fs.existsSync(layoutPath) || !fs.existsSync(catalogPath)) {
		return null;
	}
	return ACTIVE_PACK_DIR;
}
