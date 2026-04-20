import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { BrowserWindow, Utils } from 'electrobun';
import pty from '@lydell/node-pty';
import { PNG } from 'pngjs';
import {
	createZigPtyBridge,
	resolveZigPtyBinaryPath,
	type TerminalPtyLike,
} from './zigPtyBridge.js';
import { canResumeHistorySession, collectHistorySessions } from '../../../../src/historySessions.js';
import {
	CHAR_COUNT,
	CHAR_FRAME_H,
	CHAR_FRAME_W,
	CHAR_FRAMES_PER_ROW,
	CHARACTER_DIRECTIONS,
	FLOOR_PATTERN_COUNT,
	FLOOR_TILE_SIZE,
	HISTORY_SESSIONS_ENABLED_DEFAULT,
	HISTORY_SESSIONS_LOOKBACK_DAYS_DEFAULT,
	HISTORY_SESSIONS_MAX_VISIBLE_DEFAULT,
	LAYOUT_REVISION_KEY,
	PNG_ALPHA_THRESHOLD,
	WALL_BITMASK_COUNT,
	WALL_GRID_COLS,
	WALL_PIECE_HEIGHT,
	WALL_PIECE_WIDTH,
} from '../../../../src/constants.js';
import type {
	AgentSeatAssignment,
	AgentRuntimeStatus,
	CharacterDirectionSprites,
	ExistingAgentMeta,
	FurnitureCatalogAsset,
	ExtensionToWebviewMessage,
	HistorySessionSummary,
	WebviewToExtensionMessage,
} from '../../../../src/contracts/messages.js';
import type { LayoutWatcher } from '../../../../src/layoutPersistence.js';
import { readLayoutFromFile, watchLayoutFile, writeLayoutToFile } from '../../../../src/layoutPersistence.js';
import { applyPackDirectory, applyPackZip, exportPackZip, getInstalledPackRoot } from '../../../../src/packManager.js';

const LIVE_SESSION_LOOKBACK_HOURS = 12;
const LIVE_SESSION_MAX_VISIBLE = 8;
const REFRESH_INTERVAL_MS = 4000;
const ACTIVE_RECENT_THRESHOLD_MS = 30 * 1000;
const BASH_COMMAND_DISPLAY_MAX_LENGTH = 30;
const TASK_DESCRIPTION_DISPLAY_MAX_LENGTH = 40;
const DESKTOP_PTY_DEFAULT_COLS = 120;
const DESKTOP_PTY_DEFAULT_ROWS = 32;
const DEFAULT_CLAUDE_LAUNCH_COMMAND = 'claude';
const DEFAULT_CLAUDE_RESUME_COMMAND = 'claude --resume {sessionId}';
const TERMINAL_REPLAY_MAX_BYTES = 128 * 1024;
const TERMINAL_MIN_COLS = 40;
const TERMINAL_MIN_ROWS = 8;
const TRACE_SMOKE_ENV = 'PIXEL_AGENTS_TRACE_SMOKE';
const TRACE_CONTRACT_ENV = 'PIXEL_AGENTS_TRACE_CONTRACT';
const TRACE_SMOKE_MARKER_PREFIX = '__PA_TRACE_ACK__';
const INTERACTION_SMOKE_ENV = 'PIXEL_AGENTS_INTERACTION_SMOKE';
const DESKTOP_TERMINAL_EVENT = 'pixel-agents:terminal';
const DESKTOP_STATE_DIR = path.join(os.homedir(), '.pixel-agents');
const DESKTOP_STATE_FILE = path.join(DESKTOP_STATE_DIR, 'desktop-state.json');

type TerminalLifecycleState = 'stopped' | 'starting' | 'running' | 'closing';
type TerminalSessionSource = 'launch' | 'history' | null;

interface TerminalRuntimeState {
	instanceId: string;
	terminalPty: TerminalPtyLike | null;
	terminalBackend: 'zig' | 'node-pty' | null;
	terminalCols: number;
	terminalRows: number;
	terminalCwd: string;
	terminalReplay: string;
	terminalTraceId: string | null;
	terminalLifecycle: TerminalLifecycleState;
	terminalSessionSource: TerminalSessionSource;
	activeTerminalSessionId: string | null;
}

interface DesktopAgent {
	id: string;
	sessionId: string;
	jsonlPath: string;
	folderName: string;
	status: AgentRuntimeStatus;
	toolStatus: string | null;
	lastActivityAtMs: number;
	palette: number;
	hueShift: number;
	seatId: string | null;
}

interface DesktopSettingsState {
	soundEnabled: boolean;
	alwaysStatusBubblesEnabled: boolean;
	eventBubblesEnabled: boolean;
	historySessionsEnabled: boolean;
}

interface DesktopPersistedState {
	agentSeats: Record<string, AgentSeatAssignment>;
}

interface SessionRuntimeSnapshot {
	status: AgentRuntimeStatus;
	toolStatus: string | null;
	lastActivityAtMs: number;
}

interface DesktopHostState {
	workspaceRoot: string | null;
	projectDir: string | null;
	workspaceFolderName: string;
	settingsFilePath: string | null;
	persistedStateFilePath: string;
	agents: Map<string, DesktopAgent>;
	agentSeats: Record<string, AgentSeatAssignment>;
	historySessions: HistorySessionSummary[];
	settings: DesktopSettingsState;
	historyLookbackDays: number;
	historyMaxVisible: number;
	selectedAgentId: string | null;
	hiddenSessionIds: Set<string>;
	forcedLiveSessionIds: Set<string>;
	claudeLaunchCommand: string;
	claudeResumeCommand: string;
	terminalInstances: Map<string, TerminalRuntimeState>;
	activeTerminalInstanceId: string | null;
	traceSmokeMode: boolean;
	traceContractProbe: boolean;
	traceSmokeId: string | null;
	traceSmokeAck: boolean;
	traceSmokeStarted: boolean;
	interactionSmokeMode: boolean;
	interactionSmokeStarted: boolean;
	interactionSmokePassed: boolean;
	defaultLayout: Record<string, unknown> | null;
	layoutWatcher: LayoutWatcher | null;
	assetsBootstrapPromise: Promise<void> | null;
	refreshTimer: ReturnType<typeof setInterval> | null;
	didInitialize: boolean;
	isShuttingDown: boolean;
}

type TerminalHostToWebviewMessage = Extract<
	ExtensionToWebviewMessage,
	{ type: 'terminalReady' | 'terminalData' | 'terminalExit' }
>;

function isTerminalHostToWebviewMessage(
	message: ExtensionToWebviewMessage,
): message is TerminalHostToWebviewMessage {
	return message.type === 'terminalReady' || message.type === 'terminalData' || message.type === 'terminalExit';
}

function postToWebview(window: BrowserWindow, message: ExtensionToWebviewMessage): void {
	const webview = window.webview as unknown as {
		executeJavascript: (js: string) => void;
	};

	const payload = JSON.stringify(message);
	if (isTerminalHostToWebviewMessage(message)) {
		// Keep terminal traffic on a dedicated channel to avoid generic message-wrapper
		// payload transformations that can drop `type`/`data` semantics.
		webview.executeJavascript(
			`window.dispatchEvent(new CustomEvent('${DESKTOP_TERMINAL_EVENT}', { detail: ${payload} }));`,
		);
		return;
	}
	// Non-terminal messages continue through the generic message bus.
	webview.executeJavascript(`window.dispatchEvent(new MessageEvent('message', { data: ${payload} }));`);
}

function parseHostMessage(event: unknown): WebviewToExtensionMessage | null {
	const root = event as { data?: { detail?: unknown }; detail?: unknown } | null;
	const detail = root?.data?.detail ?? root?.detail;
	let candidate = detail;

	if (typeof candidate === 'string') {
		try {
			candidate = JSON.parse(candidate) as unknown;
		} catch {
			return null;
		}
	}

	if (!candidate || typeof candidate !== 'object') return null;
	if (typeof (candidate as { type?: unknown }).type !== 'string') return null;
	return candidate as WebviewToExtensionMessage;
}

function bundleAppRoot(): string | null {
	const candidates = [
		path.resolve(process.cwd(), '../Resources/app'),
		path.resolve(import.meta.dir, '../../build/dev-macos-arm64/Pixel Agents Desktop-dev.app/Contents/Resources/app'),
	];
	for (const candidate of candidates) {
		if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
			return candidate;
		}
	}
	return null;
}

function bundledVisualAssetsRoot(): string | null {
	const appRoot = bundleAppRoot();
	if (!appRoot) return null;
	const assetsRoot = path.join(appRoot, 'assets');
	return fs.existsSync(assetsRoot) ? appRoot : null;
}

function bundledDefaultPackRoot(): string | null {
	const appRoot = bundleAppRoot();
	if (!appRoot) return null;
	const packRoot = path.join(appRoot, 'assets', 'packs', 'default');
	return fs.existsSync(path.join(packRoot, 'manifest.json')) ? packRoot : null;
}

function rgbaToHex(r: number, g: number, b: number): string {
	return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase();
}

function readPngSprite(filePath: string): PNG {
	return PNG.sync.read(fs.readFileSync(filePath));
}

function loadDefaultLayoutFromAssets(assetsRoot: string): Record<string, unknown> | null {
	try {
		const candidates = [
			path.join(assetsRoot, 'assets', 'default-layout.json'),
			path.join(assetsRoot, 'assets', 'default-layout-1.json'),
		];
		for (const filePath of candidates) {
			if (!fs.existsSync(filePath)) continue;
			return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
		}
	} catch (error) {
		console.log(`[desktop] failed to load default layout: ${error}`);
	}
	return null;
}

function loadCharacterSpritesFromAssets(assetsRoot: string): CharacterDirectionSprites[] | null {
	try {
		const charDir = path.join(assetsRoot, 'assets', 'characters');
		const characters: CharacterDirectionSprites[] = [];
		for (let ci = 0; ci < CHAR_COUNT; ci += 1) {
			const png = readPngSprite(path.join(charDir, `char_${ci}.png`));
			const charData: CharacterDirectionSprites = { down: [], up: [], right: [] };
			for (let dirIdx = 0; dirIdx < CHARACTER_DIRECTIONS.length; dirIdx += 1) {
				const dir = CHARACTER_DIRECTIONS[dirIdx]!;
				const rowOffsetY = dirIdx * CHAR_FRAME_H;
				const frames: string[][][] = [];
				for (let frame = 0; frame < CHAR_FRAMES_PER_ROW; frame += 1) {
					const sprite: string[][] = [];
					const frameOffsetX = frame * CHAR_FRAME_W;
					for (let y = 0; y < CHAR_FRAME_H; y += 1) {
						const row: string[] = [];
						for (let x = 0; x < CHAR_FRAME_W; x += 1) {
							const idx = (((rowOffsetY + y) * png.width) + (frameOffsetX + x)) * 4;
							const alpha = png.data[idx + 3]!;
							row.push(alpha < PNG_ALPHA_THRESHOLD ? '' : rgbaToHex(png.data[idx]!, png.data[idx + 1]!, png.data[idx + 2]!));
						}
						sprite.push(row);
					}
					frames.push(sprite);
				}
				charData[dir] = frames;
			}
			characters.push(charData);
		}
		return characters;
	} catch {
		return null;
	}
}

function loadFloorTilesFromAssets(assetsRoot: string): string[][][] | null {
	try {
		const sprites: string[][][] = [];
		const floorDir = path.join(assetsRoot, 'assets', 'floors');
		const fileNames = fs.readdirSync(floorDir)
			.filter((name) => /^floor_\d+\.png$/i.test(name))
			.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
		for (const fileName of fileNames.slice(0, FLOOR_PATTERN_COUNT)) {
			const png = readPngSprite(path.join(floorDir, fileName));
			const sprite: string[][] = [];
			for (let y = 0; y < FLOOR_TILE_SIZE; y += 1) {
				const row: string[] = [];
				for (let x = 0; x < FLOOR_TILE_SIZE; x += 1) {
					const idx = (y * png.width + x) * 4;
					const alpha = png.data[idx + 3]!;
					row.push(alpha < PNG_ALPHA_THRESHOLD ? '' : rgbaToHex(png.data[idx]!, png.data[idx + 1]!, png.data[idx + 2]!));
				}
				sprite.push(row);
			}
			sprites.push(sprite);
		}
		return sprites;
	} catch {
		return null;
	}
}

function loadWallTilesFromAssets(assetsRoot: string): string[][][] | null {
	try {
		const png = readPngSprite(path.join(assetsRoot, 'assets', 'walls', 'wall_0.png'));
		const sprites: string[][][] = [];
		for (let mask = 0; mask < WALL_BITMASK_COUNT; mask += 1) {
			const offsetX = (mask % WALL_GRID_COLS) * WALL_PIECE_WIDTH;
			const offsetY = Math.floor(mask / WALL_GRID_COLS) * WALL_PIECE_HEIGHT;
			const sprite: string[][] = [];
			for (let y = 0; y < WALL_PIECE_HEIGHT; y += 1) {
				const row: string[] = [];
				for (let x = 0; x < WALL_PIECE_WIDTH; x += 1) {
					const idx = (((offsetY + y) * png.width) + (offsetX + x)) * 4;
					const alpha = png.data[idx + 3]!;
					row.push(alpha < PNG_ALPHA_THRESHOLD ? '' : rgbaToHex(png.data[idx]!, png.data[idx + 1]!, png.data[idx + 2]!));
				}
				sprite.push(row);
			}
			sprites.push(sprite);
		}
		return sprites;
	} catch {
		return null;
	}
}

function loadFurnitureAssetsFromRoot(assetsRoot: string): { catalog: FurnitureCatalogAsset[]; sprites: Record<string, string[][]> } | null {
	try {
		const catalogCandidates = [
			path.join(assetsRoot, 'assets', 'furniture', 'furniture-catalog.json'),
			path.join(assetsRoot, 'assets', 'furniture-catalog.json'),
		];
		const catalogPath = catalogCandidates.find((candidate) => fs.existsSync(candidate));
		if (!catalogPath) return null;
		const raw = JSON.parse(fs.readFileSync(catalogPath, 'utf-8')) as { assets?: FurnitureCatalogAsset[] };
		const catalog = Array.isArray(raw.assets) ? raw.assets : [];
		const sprites: Record<string, string[][]> = {};
		for (const asset of catalog) {
			const normalized = asset.file.startsWith('assets/') ? asset.file : `assets/${asset.file}`;
			const assetPath = path.join(assetsRoot, normalized);
			if (!fs.existsSync(assetPath)) continue;
			const png = readPngSprite(assetPath);
			const sprite: string[][] = [];
			for (let y = 0; y < asset.height; y += 1) {
				const row: string[] = [];
				for (let x = 0; x < asset.width; x += 1) {
					const idx = (y * png.width + x) * 4;
					const alpha = png.data[idx + 3]!;
					row.push(alpha < PNG_ALPHA_THRESHOLD ? '' : rgbaToHex(png.data[idx]!, png.data[idx + 1]!, png.data[idx + 2]!));
				}
				sprite.push(row);
			}
			sprites[asset.id] = sprite;
		}
		return { catalog, sprites };
	} catch (error) {
		console.log(`[desktop] failed to load furniture assets: ${error}`);
		return null;
	}
}

function sendLayout(window: BrowserWindow, state: DesktopHostState): void {
	const savedLayout = readLayoutFromFile();
	const layout = savedLayout ?? state.defaultLayout;
	postToWebview(window, { type: 'layoutLoaded', layout });
}

function startLayoutWatcher(window: BrowserWindow, state: DesktopHostState): void {
	if (state.layoutWatcher) return;
	state.layoutWatcher = watchLayoutFile((layout) => {
		postToWebview(window, { type: 'layoutLoaded', layout });
	});
}

async function bootstrapDesktopAssets(window: BrowserWindow, state: DesktopHostState): Promise<void> {
	let installedPackRoot = getInstalledPackRoot();
	if (!installedPackRoot) {
		const defaultPackRoot = bundledDefaultPackRoot();
		if (defaultPackRoot) {
			try {
				const applied = await applyPackDirectory(defaultPackRoot);
				installedPackRoot = applied.packRoot;
				state.defaultLayout = applied.layout;
				console.log('[desktop] installed bundled default pack');
			} catch (error) {
				console.log(`[desktop] failed to install bundled default pack: ${error}`);
			}
		}
	}

	const visualAssetsRoot = bundledVisualAssetsRoot();
	const contentAssetsRoot = installedPackRoot ?? visualAssetsRoot;
	if (!state.defaultLayout && contentAssetsRoot) {
		state.defaultLayout = loadDefaultLayoutFromAssets(contentAssetsRoot);
	}
	if (!state.defaultLayout && visualAssetsRoot && visualAssetsRoot !== contentAssetsRoot) {
		state.defaultLayout = loadDefaultLayoutFromAssets(visualAssetsRoot);
	}

	publishPackAssets(window, contentAssetsRoot, visualAssetsRoot);

	const currentLayout = readLayoutFromFile();
	const currentRevision = typeof currentLayout?.[LAYOUT_REVISION_KEY] === 'number' ? currentLayout[LAYOUT_REVISION_KEY] as number : 0;
	const defaultRevision = typeof state.defaultLayout?.[LAYOUT_REVISION_KEY] === 'number' ? state.defaultLayout[LAYOUT_REVISION_KEY] as number : 0;
	if (!currentLayout || (state.defaultLayout && defaultRevision > currentRevision)) {
		if (state.defaultLayout) {
			writeLayoutToFile(state.defaultLayout);
		}
	}
	sendLayout(window, state);
	startLayoutWatcher(window, state);
}

function ensureDesktopAssets(window: BrowserWindow, state: DesktopHostState): void {
	if (state.assetsBootstrapPromise) return;
	state.assetsBootstrapPromise = bootstrapDesktopAssets(window, state)
		.catch((error) => {
			console.log(`[desktop] asset bootstrap failed: ${error}`);
		})
		.finally(() => {
			state.assetsBootstrapPromise = null;
		});
}

function execFileText(command: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(command, args, (error, stdout, stderr) => {
			if (error) {
				const detail = stderr?.trim() || stdout?.trim() || error.message;
				reject(new Error(detail));
				return;
			}
			resolve(stdout.trim());
		});
	});
}

function makeDefaultPackExportName(): string {
	const now = new Date();
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, '0');
	const d = String(now.getDate()).padStart(2, '0');
	const hh = String(now.getHours()).padStart(2, '0');
	const mm = String(now.getMinutes()).padStart(2, '0');
	const ss = String(now.getSeconds()).padStart(2, '0');
	return `pixel-agents-pack-${y}${m}${d}-${hh}${mm}${ss}.pack.zip`;
}

function resolvePackContentRootForExport(): string | null {
	const installedPackRoot = getInstalledPackRoot();
	if (installedPackRoot) {
		return installedPackRoot;
	}
	return bundleAppRoot();
}

function escapeAppleScriptString(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function pickSingleFile(options: {
	allowedFileTypes: string;
	startingFolder?: string;
}): Promise<string | null> {
	const results = await Utils.openFileDialog({
		startingFolder: options.startingFolder || os.homedir(),
		allowedFileTypes: options.allowedFileTypes,
		canChooseFiles: true,
		canChooseDirectory: false,
		allowsMultipleSelection: false,
	});
	const first = results.find((value) => value && value.trim().length > 0);
	return first?.trim() || null;
}

async function pickSaveFilePath(defaultFileName: string): Promise<string | null> {
	if (process.platform === 'darwin') {
		const escaped = escapeAppleScriptString(defaultFileName);
		const output = await execFileText('osascript', [
			'-e',
			`POSIX path of (choose file name with prompt "Export Pixel Agents Pack" default name "${escaped}")`,
		]);
		return output.trim() || null;
	}

	const selectedDir = await Utils.openFileDialog({
		startingFolder: os.homedir(),
		allowedFileTypes: '*',
		canChooseFiles: false,
		canChooseDirectory: true,
		allowsMultipleSelection: false,
	});
	const baseDir = selectedDir.find((value) => value && value.trim().length > 0)?.trim();
	return baseDir ? path.join(baseDir, defaultFileName) : null;
}

function showDesktopMessage(kind: 'info' | 'warning' | 'error', message: string): void {
	void Utils.showMessageBox({
		type: kind,
		title: 'Pixel Agents Desktop',
		message,
		buttons: ['OK'],
		defaultId: 0,
		cancelId: 0,
	}).catch((error) => {
		console.log(`[desktop] failed to show message box: ${error}`);
	});
}

function publishPackAssets(window: BrowserWindow, contentAssetsRoot: string | null, visualAssetsRoot: string | null): void {
	const charSprites = (contentAssetsRoot ? loadCharacterSpritesFromAssets(contentAssetsRoot) : null)
		?? (visualAssetsRoot && visualAssetsRoot !== contentAssetsRoot ? loadCharacterSpritesFromAssets(visualAssetsRoot) : null);
	if (charSprites) {
		postToWebview(window, { type: 'characterSpritesLoaded', characters: charSprites });
	}

	if (visualAssetsRoot) {
		const floorTiles = loadFloorTilesFromAssets(visualAssetsRoot);
		if (floorTiles) {
			postToWebview(window, { type: 'floorTilesLoaded', sprites: floorTiles });
		}
		const wallTiles = loadWallTilesFromAssets(visualAssetsRoot);
		if (wallTiles) {
			postToWebview(window, { type: 'wallTilesLoaded', sprites: wallTiles });
		}
	}

	if (contentAssetsRoot) {
		const assets = loadFurnitureAssetsFromRoot(contentAssetsRoot);
		if (assets) {
			postToWebview(window, {
				type: 'furnitureAssetsLoaded',
				catalog: assets.catalog,
				sprites: assets.sprites,
			});
		}
	}
}

function parseTimestampMs(value: unknown): number {
	if (typeof value !== 'string' || value.trim() === '') return 0;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : 0;
}

function readFileTail(filePath: string, maxBytes: number): string {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, 'r');
		const stat = fs.fstatSync(fd);
		const size = stat.size;
		if (!Number.isFinite(size) || size <= 0) return '';
		const length = Math.min(maxBytes, size);
		const start = Math.max(0, size - length);
		const buffer = Buffer.alloc(length);
		const bytesRead = fs.readSync(fd, buffer, 0, length, start);
		return buffer.toString('utf-8', 0, bytesRead);
	} catch {
		return '';
	} finally {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch { /* noop */ }
		}
	}
}

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

function nativePath(value: string): string {
	return process.platform === 'win32' ? value.replace(/\//g, '\\') : value;
}

function getProjectDirPath(workspaceRoot: string | null): string | null {
	if (!workspaceRoot) return null;
	const normalizedPath = normalizeWorkspacePath(workspaceRoot);
	const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
	const candidates = new Set<string>([
		path.join(projectsRoot, currentDirNameForWorkspace(normalizedPath)),
		path.join(projectsRoot, legacyDirNameForWorkspace(normalizedPath)),
	]);
	try {
		const real = fs.realpathSync(nativePath(normalizedPath));
		const normalizedReal = normalizeWorkspacePath(real);
		candidates.add(path.join(projectsRoot, currentDirNameForWorkspace(normalizedReal)));
		candidates.add(path.join(projectsRoot, legacyDirNameForWorkspace(normalizedReal)));
	} catch {
		// noop
	}
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return path.join(projectsRoot, currentDirNameForWorkspace(normalizedPath));
}

function resolveWorkspaceRoot(): string | null {
	const candidates = [
		process.env['PIXEL_AGENTS_WORKSPACE'],
		process.env['INIT_CWD'],
		process.env['PWD'],
	].filter((value): value is string => !!value && value.trim().length > 0);
	for (const candidate of candidates) {
		const resolved = path.resolve(candidate);
		if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
			return resolved;
		}
	}
	return null;
}

function parseJsonObject(input: string): Record<string, unknown> | null {
	try {
		return JSON.parse(input) as Record<string, unknown>;
	} catch {
		// Tolerate simple JSONC-style comments/trailing commas from VS Code settings files.
		try {
			const withoutBlockComments = input.replace(/\/\*[\s\S]*?\*\//g, '');
			const withoutLineComments = withoutBlockComments.replace(/^\s*\/\/.*$/gm, '');
			const withoutTrailingCommas = withoutLineComments.replace(/,\s*([}\]])/g, '$1');
			return JSON.parse(withoutTrailingCommas) as Record<string, unknown>;
		} catch {
			return null;
		}
	}
}

function toBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

function toNumber(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function writeJsonFileAtomic(filePath: string, value: unknown): void {
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });
	const tmpPath = `${filePath}.tmp`;
	fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf-8');
	fs.renameSync(tmpPath, filePath);
}

function loadDesktopPersistedState(): DesktopPersistedState {
	if (!fs.existsSync(DESKTOP_STATE_FILE)) {
		return { agentSeats: {} };
	}
	try {
		const parsed = parseJsonObject(fs.readFileSync(DESKTOP_STATE_FILE, 'utf8'));
		const rawSeats = parsed?.['agentSeats'];
		const agentSeats: Record<string, AgentSeatAssignment> = {};
		if (rawSeats && typeof rawSeats === 'object') {
			for (const [agentId, rawSeat] of Object.entries(rawSeats as Record<string, unknown>)) {
				if (!rawSeat || typeof rawSeat !== 'object') continue;
				const seat = rawSeat as Record<string, unknown>;
				const fallbackAppearance = appearanceForSession(agentId);
				agentSeats[agentId] = {
					palette: toNumber(seat['palette'], fallbackAppearance.palette),
					hueShift: toNumber(seat['hueShift'], fallbackAppearance.hueShift),
					seatId: typeof seat['seatId'] === 'string' ? seat['seatId'] : null,
				};
			}
		}
		return { agentSeats };
	} catch (error) {
		console.log(`[desktop] failed to load persisted state: ${error}`);
		return { agentSeats: {} };
	}
}

function persistDesktopState(state: DesktopHostState): void {
	try {
		writeJsonFileAtomic(state.persistedStateFilePath, {
			agentSeats: state.agentSeats,
		});
	} catch (error) {
		console.log(`[desktop] failed to persist desktop state: ${error}`);
	}
}

function loadWorkspaceDesktopSettings(workspaceRoot: string | null): {
	settingsFilePath: string | null;
	enabled: boolean;
	lookbackDays: number;
	maxVisible: number;
	claudeLaunchCommand: string;
	claudeResumeCommand: string;
} {
	const defaults = {
		enabled: HISTORY_SESSIONS_ENABLED_DEFAULT,
		lookbackDays: HISTORY_SESSIONS_LOOKBACK_DAYS_DEFAULT,
		maxVisible: HISTORY_SESSIONS_MAX_VISIBLE_DEFAULT,
		claudeLaunchCommand: DEFAULT_CLAUDE_LAUNCH_COMMAND,
		claudeResumeCommand: DEFAULT_CLAUDE_RESUME_COMMAND,
	};
	if (!workspaceRoot) {
		return { settingsFilePath: null, ...defaults };
	}

	const settingsFilePath = path.join(workspaceRoot, 'settings.json');
	if (!fs.existsSync(settingsFilePath)) {
		return { settingsFilePath, ...defaults };
	}

	let raw = '';
	try {
		raw = fs.readFileSync(settingsFilePath, 'utf8');
	} catch {
		return { settingsFilePath, ...defaults };
	}
	const parsed = parseJsonObject(raw);
	if (!parsed) {
		return { settingsFilePath, ...defaults };
	}

	return {
		settingsFilePath,
		enabled: toBoolean(parsed['pixel-agents.historySessions.enabled'], defaults.enabled),
		lookbackDays: toNumber(parsed['pixel-agents.historySessions.lookbackDays'], defaults.lookbackDays),
		maxVisible: toNumber(parsed['pixel-agents.historySessions.maxVisible'], defaults.maxVisible),
		claudeLaunchCommand: typeof parsed['pixel-agents.claudeLaunchCommand'] === 'string'
			? ((parsed['pixel-agents.claudeLaunchCommand'] as string).trim() || defaults.claudeLaunchCommand)
			: defaults.claudeLaunchCommand,
		claudeResumeCommand: typeof parsed['pixel-agents.claudeResumeCommand'] === 'string'
			? ((parsed['pixel-agents.claudeResumeCommand'] as string).trim() || defaults.claudeResumeCommand)
			: defaults.claudeResumeCommand,
	};
}

function looksLikeSessionId(value: string): boolean {
	return /^[0-9a-fA-F-]{36}$/.test(value);
}

function hashString(input: string): number {
	let h = 2166136261;
	for (let i = 0; i < input.length; i += 1) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

function appearanceForSession(sessionId: string): { palette: number; hueShift: number } {
	const hash = hashString(sessionId);
	const palette = hash % 6;
	const cycle = Math.floor(hash / 6) % 4;
	const hueShift = cycle === 0 ? 0 : 55 + cycle * 30;
	return { palette, hueShift };
}

function formatToolStatus(toolName: string, input: Record<string, unknown>): string {
	const base = (p: unknown) => typeof p === 'string' ? path.basename(p) : '';
	if (toolName === 'Task' || toolName.startsWith('Team')) {
		const desc = typeof input.description === 'string' ? input.description : '';
		return desc
			? `Subtask: ${desc.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH ? `${desc.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH)}…` : desc}`
			: 'Running subtask';
	}
	switch (toolName) {
		case 'Read': return `Reading ${base(input.file_path)}`;
		case 'Edit': return `Editing ${base(input.file_path)}`;
		case 'Write': return `Writing ${base(input.file_path)}`;
		case 'Bash': {
			const cmd = (input.command as string) || '';
			return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? `${cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH)}…` : cmd}`;
		}
		case 'Glob': return 'Searching files';
		case 'Grep': return 'Searching code';
		case 'WebFetch': return 'Fetching web content';
		case 'WebSearch': return 'Searching the web';
		case 'AskUserQuestion': return 'Waiting for your answer';
		case 'EnterPlanMode': return 'Planning';
		case 'NotebookEdit': return 'Editing notebook';
		default: return `Using ${toolName}`;
	}
}

function parseSessionRuntime(jsonlPath: string, sessionId: string): SessionRuntimeSnapshot {
	const tail = readFileTail(jsonlPath, 256 * 1024);
	const activeToolStatuses = new Map<string, string>();
	let lastActivityAtMs = 0;
	let lastSawTurnDuration = false;

	if (tail) {
		const lines = tail.split('\n');
		for (const raw of lines) {
			const line = raw.trim();
			if (!line || line[0] !== '{') continue;
			let record: Record<string, unknown>;
			try {
				record = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			const recordSessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
			if (recordSessionId && recordSessionId !== sessionId) continue;

			const tsMs = parseTimestampMs(record.timestamp);
			if (tsMs > lastActivityAtMs) lastActivityAtMs = tsMs;

			const type = typeof record.type === 'string' ? record.type : '';
			if (type === 'assistant') {
				const message = record.message as { content?: unknown } | undefined;
				const content = message?.content;
				if (!Array.isArray(content)) continue;
				let hasToolUse = false;
				for (const block of content as Array<{ type?: unknown; id?: unknown; name?: unknown; input?: unknown }>) {
					if (block.type !== 'tool_use' || typeof block.id !== 'string') continue;
					const toolName = typeof block.name === 'string' ? block.name : '';
					const toolInput = (typeof block.input === 'object' && block.input !== null)
						? (block.input as Record<string, unknown>)
						: {};
					if (activeToolStatuses.has(block.id)) {
						activeToolStatuses.delete(block.id);
					}
					activeToolStatuses.set(block.id, formatToolStatus(toolName, toolInput));
					hasToolUse = true;
				}
				if (hasToolUse) {
					lastSawTurnDuration = false;
				}
				continue;
			}

			if (type === 'user') {
				const message = record.message as { content?: unknown } | undefined;
				const content = message?.content;
				if (!Array.isArray(content)) continue;
				for (const block of content as Array<{ type?: unknown; tool_use_id?: unknown }>) {
					if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
					activeToolStatuses.delete(block.tool_use_id);
				}
				continue;
			}

			if (type === 'system' && record.subtype === 'turn_duration') {
				activeToolStatuses.clear();
				lastSawTurnDuration = true;
			}
		}
	}

	try {
		const stat = fs.statSync(jsonlPath);
		if (Number.isFinite(stat.mtimeMs)) {
			lastActivityAtMs = Math.max(lastActivityAtMs, stat.mtimeMs);
		}
	} catch {
		// noop
	}

	const latestToolStatus = activeToolStatuses.size > 0
		? Array.from(activeToolStatuses.values())[activeToolStatuses.size - 1]!
		: null;
	const isActiveByRecentWrite = !lastSawTurnDuration && (Date.now() - lastActivityAtMs) <= ACTIVE_RECENT_THRESHOLD_MS;
	const status: AgentRuntimeStatus = (latestToolStatus || isActiveByRecentWrite) ? 'active' : 'waiting';

	return {
		status,
		toolStatus: latestToolStatus,
		lastActivityAtMs,
	};
}

function collectLiveAgents(
	projectDir: string,
	folderName: string,
	hiddenSessionIds: ReadonlySet<string>,
	forcedLiveSessionIds: ReadonlySet<string>,
	agentSeats: Readonly<Record<string, AgentSeatAssignment>>,
): DesktopAgent[] {
	let names: string[] = [];
	try {
		names = fs.readdirSync(projectDir);
	} catch {
		return [];
	}

	const thresholdMs = Date.now() - LIVE_SESSION_LOOKBACK_HOURS * 60 * 60 * 1000;
	const agents: DesktopAgent[] = [];

	for (const name of names) {
		if (!name.endsWith('.jsonl')) continue;
		const sessionId = name.slice(0, -'.jsonl'.length);
		if (!looksLikeSessionId(sessionId)) continue;
		if (hiddenSessionIds.has(sessionId)) continue;

		const jsonlPath = path.join(projectDir, name);
		if (!canResumeHistorySession(jsonlPath, sessionId)) continue;

		const runtime = parseSessionRuntime(jsonlPath, sessionId);
		const appearance = appearanceForSession(sessionId);
		const persistedSeat = agentSeats[sessionId];
		if (runtime.lastActivityAtMs < thresholdMs && !forcedLiveSessionIds.has(sessionId)) {
			continue;
		}

		agents.push({
			id: sessionId,
			sessionId,
			jsonlPath,
			folderName,
			status: runtime.status,
			toolStatus: runtime.toolStatus,
			lastActivityAtMs: runtime.lastActivityAtMs,
			palette: persistedSeat?.palette ?? appearance.palette,
			hueShift: persistedSeat?.hueShift ?? appearance.hueShift,
			seatId: persistedSeat?.seatId ?? null,
		});
	}

	agents.sort((a, b) => b.lastActivityAtMs - a.lastActivityAtMs);
	return agents.slice(0, LIVE_SESSION_MAX_VISIBLE);
}

function toHistorySummary(records: ReturnType<typeof collectHistorySessions>): HistorySessionSummary[] {
	return records.map((session) => ({
		id: session.id,
		sessionId: session.sessionId,
		jsonlPath: session.jsonlPath,
		createdAt: new Date(session.createdAtMs).toISOString(),
		lastActivityAt: new Date(session.lastActivityAtMs).toISOString(),
		title: session.title,
		summary: session.summary,
	}));
}

function createInitialState(): DesktopHostState {
	const workspaceRoot = resolveWorkspaceRoot();
	const workspaceFolderName = workspaceRoot ? path.basename(workspaceRoot) || 'workspace' : 'workspace';
	const projectDir = getProjectDirPath(workspaceRoot);
	const config = loadWorkspaceDesktopSettings(workspaceRoot);
	const traceSmokeMode = process.env[TRACE_SMOKE_ENV] === '1';
	const traceContractProbe = process.env[TRACE_CONTRACT_ENV] === '1';
	const interactionSmokeMode = process.env[INTERACTION_SMOKE_ENV] === '1';
	const persisted = loadDesktopPersistedState();
	return {
		workspaceRoot,
		projectDir,
		workspaceFolderName,
		settingsFilePath: config.settingsFilePath,
		persistedStateFilePath: DESKTOP_STATE_FILE,
		agents: new Map(),
		agentSeats: persisted.agentSeats,
		historySessions: [],
		settings: {
			soundEnabled: true,
			alwaysStatusBubblesEnabled: true,
			eventBubblesEnabled: true,
			historySessionsEnabled: config.enabled,
		},
		historyLookbackDays: config.lookbackDays,
		historyMaxVisible: config.maxVisible,
		selectedAgentId: null,
		hiddenSessionIds: new Set(),
		forcedLiveSessionIds: new Set(),
		claudeLaunchCommand: config.claudeLaunchCommand,
		claudeResumeCommand: config.claudeResumeCommand,
		terminalInstances: new Map(),
		activeTerminalInstanceId: null,
		traceSmokeMode,
		traceContractProbe,
		traceSmokeId: null,
		traceSmokeAck: false,
		traceSmokeStarted: false,
		interactionSmokeMode,
		interactionSmokeStarted: false,
		interactionSmokePassed: false,
		defaultLayout: null,
		layoutWatcher: null,
		assetsBootstrapPromise: null,
		refreshTimer: null,
		didInitialize: false,
		isShuttingDown: false,
	};
}

function sendSettings(window: BrowserWindow, state: DesktopHostState): void {
	postToWebview(window, {
		type: 'settingsLoaded',
		soundEnabled: state.settings.soundEnabled,
		speechBubblesEnabled: state.settings.alwaysStatusBubblesEnabled,
		alwaysStatusBubblesEnabled: state.settings.alwaysStatusBubblesEnabled,
		eventBubblesEnabled: state.settings.eventBubblesEnabled,
		historySessionsEnabled: state.settings.historySessionsEnabled,
	});
}

function sendWorkspace(window: BrowserWindow, state: DesktopHostState): void {
	const root = state.workspaceRoot ?? 'desktop://workspace';
	postToWebview(window, {
		type: 'workspaceFolders',
		folders: [{ name: state.workspaceFolderName, path: root }],
	});
}

function sendExistingAgents(window: BrowserWindow, agents: DesktopAgent[]): void {
	const agentIds = agents.map((agent) => agent.id);
	const agentMeta: Record<string, ExistingAgentMeta> = {};
	const folderNames: Record<string, string> = {};
	for (const agent of agents) {
		agentMeta[agent.id] = {
			palette: agent.palette,
			hueShift: agent.hueShift,
			seatId: agent.seatId,
		};
		folderNames[agent.id] = agent.folderName;
	}
	postToWebview(window, {
		type: 'existingAgents',
		agents: agentIds,
		agentMeta,
		folderNames,
	});
}

function sendHistorySessions(window: BrowserWindow, state: DesktopHostState): void {
	postToWebview(window, {
		type: 'historySessionsLoaded',
		sessions: state.settings.historySessionsEnabled ? state.historySessions : [],
	});
}

function applyAgentRuntime(window: BrowserWindow, agent: DesktopAgent): void {
	postToWebview(window, { type: 'agentToolsClear', id: agent.id });
	if (agent.status === 'active' && agent.toolStatus) {
		postToWebview(window, {
			type: 'agentToolStart',
			id: agent.id,
			toolId: `tool:${agent.id}:live`,
			status: agent.toolStatus,
		});
	}
	postToWebview(window, {
		type: 'agentStatus',
		id: agent.id,
		status: agent.status,
	});
}

function refreshAndPublish(window: BrowserWindow, state: DesktopHostState, initial = false): void {
	if (!state.projectDir || !fs.existsSync(state.projectDir)) {
		if (initial && !state.didInitialize) {
			sendWorkspace(window, state);
			sendSettings(window, state);
			postToWebview(window, { type: 'layoutLoaded', layout: null });
			postToWebview(window, { type: 'historySessionsLoaded', sessions: [] });
			state.didInitialize = true;
		}
		return;
	}

	const liveAgents = collectLiveAgents(
		state.projectDir,
		state.workspaceFolderName,
		state.hiddenSessionIds,
		state.forcedLiveSessionIds,
		state.agentSeats,
	);
	const liveSessionIds = liveAgents.map((agent) => agent.sessionId.toLowerCase());
	const liveJsonlPaths = liveAgents.map((agent) => agent.jsonlPath);
	const historyRecords = collectHistorySessions(
		state.projectDir,
		liveJsonlPaths,
		{
			enabled: true,
			lookbackDays: state.historyLookbackDays,
			maxVisible: state.historyMaxVisible,
		},
		liveSessionIds,
	);
	state.historySessions = toHistorySummary(historyRecords);

	const prevAgents = state.agents;
	const nextAgents = new Map(liveAgents.map((agent) => [agent.id, agent]));
	state.agents = nextAgents;

	if (initial && !state.didInitialize) {
		console.log(`[desktop] publish initial snapshot: live=${liveAgents.length}, history=${state.historySessions.length}`);
		sendWorkspace(window, state);
		sendSettings(window, state);
		sendExistingAgents(window, liveAgents);
		postToWebview(window, { type: 'layoutLoaded', layout: null });
		sendHistorySessions(window, state);
		for (const agent of liveAgents) {
			applyAgentRuntime(window, agent);
		}
		state.didInitialize = true;
	} else {
		for (const id of prevAgents.keys()) {
			if (!nextAgents.has(id)) {
				postToWebview(window, { type: 'agentClosed', id });
			}
		}
		for (const agent of liveAgents) {
			if (!prevAgents.has(agent.id)) {
				postToWebview(window, { type: 'agentCreated', id: agent.id, folderName: agent.folderName });
			}
			applyAgentRuntime(window, agent);
		}
		sendHistorySessions(window, state);
	}

	if (state.selectedAgentId && !nextAgents.has(state.selectedAgentId)) {
		state.selectedAgentId = null;
	}
	if (!state.selectedAgentId && liveAgents[0]) {
		state.selectedAgentId = liveAgents[0].id;
	}
	if (state.selectedAgentId) {
		postToWebview(window, { type: 'agentSelected', id: state.selectedAgentId });
	}
}

function openExternalTarget(target: string): void {
	try {
		if (process.platform === 'darwin') {
			spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
			return;
		}
		if (process.platform === 'win32') {
			spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore' }).unref();
			return;
		}
		spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
	} catch (error) {
		console.log(`[desktop] failed to open target: ${target} (${error})`);
	}
}

function resolveShell(): { executable: string; args: string[] } {
	if (process.platform === 'win32') {
		return { executable: 'powershell.exe', args: ['-NoLogo'] };
	}
	const shell = (process.env['SHELL'] || '').trim();
	if (shell.length > 0) {
		const base = path.basename(shell).toLowerCase();
		if (base.includes('fish')) {
			return { executable: shell, args: ['--interactive', '--no-config'] };
		}
		if (base.includes('zsh')) {
			return { executable: shell, args: ['-if'] };
		}
		if (base.includes('bash')) {
			return { executable: shell, args: ['--noprofile', '--norc', '-i'] };
		}
		return { executable: shell, args: ['-i'] };
	}
	return { executable: '/bin/zsh', args: ['-if'] };
}

function buildClaudeCommand(template: string, sessionId?: string): string {
	const safeTemplate = template.trim() || (sessionId ? DEFAULT_CLAUDE_RESUME_COMMAND : DEFAULT_CLAUDE_LAUNCH_COMMAND);
	const resolved = safeTemplate
		.replace(/\{sessionId\}/g, sessionId || '')
		.replace(/\$\{sessionId\}/g, sessionId || '')
		.replace(/\$SESSION_ID/g, sessionId || '')
		.replace(/%SESSION_ID%/g, sessionId || '');
	if (resolved !== safeTemplate) {
		return resolved.trim().replace(/\s+/g, ' ');
	}
	if (sessionId) {
		return `${safeTemplate} --resume ${sessionId}`;
	}
	return safeTemplate;
}

function buildClaudeLaunchCommand(template: string): string {
	const base = buildClaudeCommand(template);
	return `${base}; exit`;
}

function normalizeTerminalSize(value: unknown, fallback: number, min: number): number {
	const safeFallback = Number.isFinite(fallback) ? fallback : min;
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return Math.max(min, Math.floor(safeFallback));
	}
	return Math.max(min, Math.floor(value));
}

function normalizeTraceId(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function normalizeInstanceId(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function shortInstanceId(value: string | null): string {
	if (!value) return '-';
	if (value.length <= 12) return value;
	return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function traceLabel(traceId: string | null): string {
	return traceId ? `trace:${traceId}` : 'trace:none';
}

function createTerminalRuntime(state: DesktopHostState, instanceId: string): TerminalRuntimeState {
	return {
		instanceId,
		terminalPty: null,
		terminalBackend: null,
		terminalCols: DESKTOP_PTY_DEFAULT_COLS,
		terminalRows: DESKTOP_PTY_DEFAULT_ROWS,
		terminalCwd: state.workspaceRoot || process.cwd(),
		terminalReplay: '',
		terminalTraceId: null,
		terminalLifecycle: 'stopped',
		terminalSessionSource: null,
		activeTerminalSessionId: null,
	};
}

function resolveTerminalInstanceId(state: DesktopHostState, value: unknown): string | null {
	const direct = normalizeInstanceId(value);
	if (direct) return direct;
	if (state.activeTerminalInstanceId) return state.activeTerminalInstanceId;
	const first = state.terminalInstances.keys().next().value;
	return typeof first === 'string' ? first : null;
}

function setActiveTerminalInstance(state: DesktopHostState, instanceId: string | null): void {
	const next = normalizeInstanceId(instanceId);
	const prev = state.activeTerminalInstanceId;
	state.activeTerminalInstanceId = next;
	if (prev && next && prev !== next) {
		console.log(`[desktop] terminal attachment switched: ${shortInstanceId(prev)} -> ${shortInstanceId(next)}`);
	}
}

function getTerminalRuntime(
	state: DesktopHostState,
	instanceId: string,
	createIfMissing = true,
): TerminalRuntimeState | null {
	const normalized = normalizeInstanceId(instanceId);
	if (!normalized) return null;
	let runtime = state.terminalInstances.get(normalized) || null;
	if (!runtime && createIfMissing) {
		runtime = createTerminalRuntime(state, normalized);
		state.terminalInstances.set(normalized, runtime);
	}
	return runtime;
}

function postTerminalReady(
	window: BrowserWindow,
	runtime: TerminalRuntimeState,
	cols: number,
	rows: number,
	cwd: string,
	shell: string,
): void {
	postToWebview(window, {
		type: 'terminalReady',
		cols,
		rows,
		cwd,
		shell,
		instanceId: runtime.instanceId,
		traceId: runtime.terminalTraceId ?? undefined,
	});
}

function postTerminalData(window: BrowserWindow, runtime: TerminalRuntimeState, data: string): void {
	postToWebview(window, {
		type: 'terminalData',
		data,
		instanceId: runtime.instanceId,
		traceId: runtime.terminalTraceId ?? undefined,
	});
}

function postTerminalExit(
	window: BrowserWindow,
	runtime: TerminalRuntimeState,
	exitCode: number,
	signal?: number,
): void {
	postToWebview(window, {
		type: 'terminalExit',
		exitCode,
		signal,
		instanceId: runtime.instanceId,
		traceId: runtime.terminalTraceId ?? undefined,
	});
}

function writeTerminalCommand(runtime: TerminalRuntimeState, command: string): boolean {
	if (!runtime.terminalPty) return false;
	const trimmed = command.trim();
	if (!trimmed) return true;
	try {
		runtime.terminalPty.write(`${trimmed}\r`);
		return true;
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error);
		console.log(`[desktop] terminal write failed: ${text}`);
		runtime.terminalPty = null;
		runtime.terminalBackend = null;
		runtime.terminalLifecycle = 'stopped';
		runtime.terminalSessionSource = null;
		runtime.activeTerminalSessionId = null;
		return false;
	}
}

function runTerminalCommand(
	window: BrowserWindow,
	state: DesktopHostState,
	runtime: TerminalRuntimeState,
	command: string,
): void {
	console.log(`[desktop] runTerminalCommand (${traceLabel(runtime.terminalTraceId)}): ${command}`);
	ensureTerminalPty(window, state, { instanceId: runtime.instanceId, traceId: runtime.terminalTraceId ?? undefined });
	if (writeTerminalCommand(runtime, command)) return;
	// Retry once with a fresh PTY when write failed on a stale handle.
	ensureTerminalPty(window, state, { instanceId: runtime.instanceId, traceId: runtime.terminalTraceId ?? undefined });
	writeTerminalCommand(runtime, command);
}

function resetTerminalSession(runtime: TerminalRuntimeState, reason: string): void {
	if (!runtime.terminalPty) {
		runtime.terminalLifecycle = 'stopped';
		runtime.terminalSessionSource = null;
		runtime.activeTerminalSessionId = null;
		return;
	}

	const current = runtime.terminalPty;
	runtime.terminalLifecycle = 'closing';
	runtime.terminalPty = null;
	runtime.terminalBackend = null;
	runtime.terminalSessionSource = null;
	runtime.activeTerminalSessionId = null;
	runtime.terminalReplay = '';

	try {
		current.kill();
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error);
		console.log(`[desktop] terminal reset kill failed during ${reason}: ${text}`);
	}

	runtime.terminalLifecycle = 'stopped';
	console.log(`[desktop] terminal reset (${reason}) instance=${shortInstanceId(runtime.instanceId)}`);
}

function appendTerminalReplay(runtime: TerminalRuntimeState, chunk: string): void {
	if (!chunk) return;
	const next = runtime.terminalReplay + chunk;
	if (next.length <= TERMINAL_REPLAY_MAX_BYTES) {
		runtime.terminalReplay = next;
		return;
	}
	runtime.terminalReplay = next.slice(next.length - TERMINAL_REPLAY_MAX_BYTES);
}

function attachTerminalListeners(
	window: BrowserWindow,
	state: DesktopHostState,
	runtime: TerminalRuntimeState,
	terminal: TerminalPtyLike,
): void {
	terminal.onData((data) => {
		if (runtime.terminalPty !== terminal) {
			return;
		}
		appendTerminalReplay(runtime, data);
		postTerminalData(window, runtime, data);
	});

	terminal.onExit((event) => {
		if (runtime.terminalPty !== terminal) {
			console.log(`[desktop] stale PTY exit ignored (${traceLabel(runtime.terminalTraceId)})`);
			return;
		}
		const wasClosing = runtime.terminalLifecycle === 'closing';
		postTerminalExit(window, runtime, event.exitCode, event.signal);
		runtime.terminalPty = null;
		runtime.terminalBackend = null;
		runtime.terminalLifecycle = 'stopped';
		runtime.activeTerminalSessionId = null;
		console.log(
			`[desktop] PTY exited (${traceLabel(runtime.terminalTraceId)}) instance=${shortInstanceId(runtime.instanceId)} code=${event.exitCode} signal=${event.signal ?? 0}`,
		);
		if (!wasClosing) {
			postTerminalData(window, runtime, '\r\n[desktop] terminal exited; restarting shell...\r\n');
			ensureTerminalPty(window, state, {
				instanceId: runtime.instanceId,
				traceId: runtime.terminalTraceId ?? undefined,
			});
		}
	});
}

function createTerminalBackend(
	window: BrowserWindow,
	state: DesktopHostState,
	runtime: TerminalRuntimeState,
	cwd: string,
	cols: number,
	rows: number,
	shell: { executable: string; args: string[] },
): TerminalPtyLike {
	const zigBinaryPath = resolveZigPtyBinaryPath();
	if (zigBinaryPath) {
		try {
			const zig = createZigPtyBridge({
				binaryPath: zigBinaryPath,
				shell: shell.executable,
				shellArgs: shell.args,
				cwd,
				cols,
				rows,
				onLog: (text) => console.log(`[desktop] ${text}`),
			});
			runtime.terminalBackend = 'zig';
			console.log(`[desktop] terminal backend=zig (${zigBinaryPath}) instance=${shortInstanceId(runtime.instanceId)}`);
			attachTerminalListeners(window, state, runtime, zig);
			return zig;
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			console.log(`[desktop] zig PTY unavailable (${text}); falling back to node-pty`);
		}
	} else {
		console.log(`[desktop] zig PTY binary not found (cwd=${process.cwd()}); falling back to node-pty`);
	}

	const fallback = pty.spawn(shell.executable, shell.args, {
		name: 'xterm-256color',
		cols,
		rows,
		cwd,
		env: {
			...process.env,
			TERM: 'xterm-256color',
			TERM_PROGRAM: 'pixel-agents',
			TERM_PROGRAM_VERSION: 'desktop-node-pty',
		},
	});
	runtime.terminalBackend = 'node-pty';
	console.log(`[desktop] terminal backend=node-pty instance=${shortInstanceId(runtime.instanceId)}`);
	attachTerminalListeners(window, state, runtime, fallback as unknown as TerminalPtyLike);
	return fallback as unknown as TerminalPtyLike;
}

function ensureTerminalPty(
	window: BrowserWindow,
	state: DesktopHostState,
	opts?: { cols?: number; rows?: number; cwd?: string; instanceId?: string; traceId?: string },
): TerminalRuntimeState | null {
	const resolved = resolveTerminalInstanceId(state, opts?.instanceId) ?? `term-${Date.now().toString(36)}`;
	const runtime = getTerminalRuntime(state, resolved, true);
	if (!runtime) return null;
	setActiveTerminalInstance(state, runtime.instanceId);
	const traceId = normalizeTraceId(opts?.traceId);
	if (traceId) {
		runtime.terminalTraceId = traceId;
	}

	if (runtime.terminalPty) {
		const cols = normalizeTerminalSize(opts?.cols, runtime.terminalCols, TERMINAL_MIN_COLS);
		const rows = normalizeTerminalSize(opts?.rows, runtime.terminalRows, TERMINAL_MIN_ROWS);
		if (cols !== runtime.terminalCols || rows !== runtime.terminalRows) {
			try {
				runtime.terminalPty.resize(cols, rows);
			} catch (error) {
				const text = error instanceof Error ? error.message : String(error);
				if (process.env['PIXEL_AGENTS_DEBUG_TERMINAL'] === '1') {
					console.log(`[desktop] terminal resize failed on existing PTY: ${text}`);
				} else {
					console.log('[desktop] terminal resize failed on existing PTY; keeping current size');
				}
				// Keep PTY alive even when a resize event fails.
				runtime.terminalLifecycle = 'running';
				postTerminalReady(
					window,
					runtime,
					runtime.terminalCols,
					runtime.terminalRows,
					runtime.terminalCwd,
					resolveShell().executable,
				);
				return runtime;
			}
			runtime.terminalCols = cols;
			runtime.terminalRows = rows;
		}
		runtime.terminalLifecycle = 'running';
		postTerminalReady(
			window,
			runtime,
			runtime.terminalCols,
			runtime.terminalRows,
			runtime.terminalCwd,
			resolveShell().executable,
		);
		if (runtime.terminalReplay) {
			postTerminalData(window, runtime, runtime.terminalReplay);
		}
		return runtime;
	}

	const cwd = opts?.cwd || state.workspaceRoot || process.cwd();
	const cols = normalizeTerminalSize(opts?.cols, runtime.terminalCols, TERMINAL_MIN_COLS);
	const rows = normalizeTerminalSize(opts?.rows, runtime.terminalRows, TERMINAL_MIN_ROWS);
	const shell = resolveShell();

	try {
		runtime.terminalLifecycle = 'starting';
		runtime.terminalPty = createTerminalBackend(window, state, runtime, cwd, cols, rows, shell);
		runtime.terminalCols = cols;
		runtime.terminalRows = rows;
		runtime.terminalCwd = cwd;
		runtime.terminalLifecycle = 'running';

		postTerminalReady(window, runtime, cols, rows, cwd, shell.executable);
		if (runtime.terminalReplay) {
			postTerminalData(window, runtime, runtime.terminalReplay);
		}
		return runtime;
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error);
		runtime.terminalLifecycle = 'stopped';
		postTerminalData(window, runtime, `\r\n[desktop] failed to start terminal: ${text}\r\n`);
		return runtime;
	}
}

function closeTerminalInstance(
	state: DesktopHostState,
	instanceId: string,
	reason: string,
	removeFromMap: boolean,
): void {
	const runtime = getTerminalRuntime(state, instanceId, false);
	if (!runtime) return;
	runtime.terminalLifecycle = 'closing';
	if (runtime.terminalPty) {
		try {
			runtime.terminalPty.kill();
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			console.log(`[desktop] terminal PTY kill failed during ${reason}: ${text}`);
		}
		runtime.terminalPty = null;
		runtime.terminalBackend = null;
	}
	runtime.terminalLifecycle = 'stopped';
	runtime.activeTerminalSessionId = null;
	if (removeFromMap) {
		state.terminalInstances.delete(instanceId);
		if (state.activeTerminalInstanceId === instanceId) {
			const next = state.terminalInstances.keys().next().value;
			setActiveTerminalInstance(state, typeof next === 'string' ? next : null);
		}
	}
}

function startRefreshLoop(window: BrowserWindow, state: DesktopHostState): void {
	if (state.refreshTimer) return;
	state.refreshTimer = setInterval(() => {
		refreshAndPublish(window, state, false);
	}, REFRESH_INTERVAL_MS);
}

function stopRefreshLoop(state: DesktopHostState): void {
	if (!state.refreshTimer) return;
	clearInterval(state.refreshTimer);
	state.refreshTimer = null;
}

function cleanupHostResources(state: DesktopHostState, reason: string): void {
	if (state.isShuttingDown) return;
	state.isShuttingDown = true;
	stopRefreshLoop(state);
	state.layoutWatcher?.dispose();
	state.layoutWatcher = null;
	for (const instanceId of Array.from(state.terminalInstances.keys())) {
		closeTerminalInstance(state, instanceId, reason, true);
	}
	state.terminalInstances.clear();
	state.activeTerminalInstanceId = null;
	state.traceSmokeId = null;
	state.traceSmokeAck = false;
	state.traceSmokeStarted = false;
	console.log(`[desktop] cleanup complete (${reason})`);
}

function runInteractionSmokeScenario(window: BrowserWindow, state: DesktopHostState): void {
	if (!state.interactionSmokeMode) return;
	if (state.interactionSmokeStarted) return;
	state.interactionSmokeStarted = true;

	const traceId = `interaction-smoke-${Date.now().toString(36)}`;
	const instanceA = `smoke-${Date.now().toString(36)}-a`;
	const instanceB = `smoke-${Date.now().toString(36)}-b`;
	const history = state.historySessions[0];

	const fail = (reason: string): void => {
		state.interactionSmokePassed = false;
		console.log(`[desktop] interaction smoke FAIL: ${reason}`);
	};

	const send = (message: WebviewToExtensionMessage): void => {
		handleWebviewMessage(window, state, message);
	};

	console.log(`[desktop] interaction smoke start trace=${traceId}`);
	send({ type: 'terminalCreate', cols: DESKTOP_PTY_DEFAULT_COLS, rows: DESKTOP_PTY_DEFAULT_ROWS, instanceId: instanceA, traceId });
	console.log('[desktop] interaction smoke step=terminalCreateA');

	setTimeout(() => {
		send({ type: 'openClaude', traceId, instanceId: instanceA });
		console.log('[desktop] interaction smoke step=openClaude');
		send({ type: 'terminalInput', data: 'echo __PA_INTERACTION_AGENT__\r', instanceId: instanceA, traceId });
	}, 220);

	setTimeout(() => {
		send({ type: 'terminalClose', instanceId: instanceA, traceId });
		console.log('[desktop] interaction smoke step=terminalToggleOff');
	}, 540);

	setTimeout(() => {
		send({ type: 'terminalCreate', cols: DESKTOP_PTY_DEFAULT_COLS, rows: DESKTOP_PTY_DEFAULT_ROWS, instanceId: instanceB, traceId });
		console.log('[desktop] interaction smoke step=terminalToggleOn');
	}, 820);

	setTimeout(() => {
		if (!history) {
			fail('history session is missing');
			return;
		}
		send({
			type: 'openHistorySession',
			historyId: history.id,
			sessionId: history.sessionId,
			jsonlPath: history.jsonlPath,
			instanceId: instanceB,
		});
		console.log(`[desktop] interaction smoke step=openHistorySession session=${history.sessionId}`);
	}, 1150);

	setTimeout(() => {
		if (!history) {
			fail('history session step did not run');
			return;
		}
		send({ type: 'terminalInput', data: 'echo __PA_INTERACTION_DONE__\r', instanceId: instanceB, traceId });
		state.interactionSmokePassed = true;
		console.log('[desktop] interaction smoke PASS');
	}, 1550);
}

function handleWebviewMessage(window: BrowserWindow, state: DesktopHostState, message: WebviewToExtensionMessage): void {
	switch (message.type) {
		case 'webviewReady':
			console.log('[desktop] webviewReady');
			ensureDesktopAssets(window, state);
			refreshAndPublish(window, state, true);
			if (state.traceSmokeMode && !state.traceSmokeStarted) {
				const traceId = `trace-smoke-${Date.now().toString(36)}`;
				state.traceSmokeId = traceId;
				state.traceSmokeStarted = true;
				state.traceSmokeAck = false;
				console.log(`[desktop] trace smoke start ${traceId} marker=${TRACE_SMOKE_MARKER_PREFIX}:${traceId}`);
				postToWebview(window, { type: 'traceSmokeStart', traceId, contractProbe: state.traceContractProbe });
				let announceCount = 1;
				const announceTimer = setInterval(() => {
					if (!state.traceSmokeMode || state.traceSmokeAck || !state.traceSmokeId || announceCount >= 10) {
						clearInterval(announceTimer);
						return;
					}
					announceCount += 1;
					postToWebview(window, {
						type: 'traceSmokeStart',
						traceId: state.traceSmokeId,
						contractProbe: state.traceContractProbe,
					});
				}, 500);
				setTimeout(() => {
					if (!state.traceSmokeMode) return;
					if (state.traceSmokeAck) return;
					if (!state.traceSmokeId) return;
					const marker = `${TRACE_SMOKE_MARKER_PREFIX}:${state.traceSmokeId}`;
					console.log(`[desktop] trace smoke probe command ${marker}`);
					const instanceId = state.activeTerminalInstanceId ?? `trace-${Date.now().toString(36)}`;
					const runtime = ensureTerminalPty(window, state, {
						instanceId,
						traceId: state.traceSmokeId,
					});
					if (runtime) {
						runTerminalCommand(window, state, runtime, `echo ${marker}`);
					}
				}, 1200);
			}
			startRefreshLoop(window, state);
			runInteractionSmokeScenario(window, state);
			return;
		case 'saveLayout':
			writeLayoutToFile(message.layout);
			state.layoutWatcher?.markOwnWrite();
			return;
		case 'exportPack':
			void (async () => {
				const layout = readLayoutFromFile();
				if (!layout) {
					showDesktopMessage('warning', 'No saved layout to export.');
					return;
				}
				const sourceAssetsRoot = resolvePackContentRootForExport();
				if (!sourceAssetsRoot) {
					showDesktopMessage('error', 'Cannot resolve furniture assets root for pack export.');
					return;
				}
				const outputZipPath = await pickSaveFilePath(makeDefaultPackExportName());
				if (!outputZipPath) return;
				try {
					await exportPackZip({
						layout,
						sourceAssetsRoot,
						outputZipPath,
					});
					showDesktopMessage('info', 'Pack exported successfully.');
				} catch (error) {
					const text = error instanceof Error ? error.message : String(error);
					showDesktopMessage('error', `Failed to export pack. ${text}`);
				}
			})().catch((error) => {
				console.log(`[desktop] exportPack failed: ${error}`);
			});
			return;
		case 'importPack':
			void (async () => {
				const zipPath = await pickSingleFile({ allowedFileTypes: 'zip' });
				if (!zipPath) return;
				try {
					const applied = await applyPackZip(zipPath);
					state.defaultLayout = applied.layout;
					publishPackAssets(window, applied.packRoot, bundledVisualAssetsRoot());
					state.layoutWatcher?.markOwnWrite();
					writeLayoutToFile(applied.layout);
					sendLayout(window, state);
					showDesktopMessage('info', `Pack "${applied.manifest.name}" loaded successfully.`);
				} catch (error) {
					const text = error instanceof Error ? error.message : String(error);
					showDesktopMessage('error', `Failed to import pack. ${text}`);
				}
			})().catch((error) => {
				console.log(`[desktop] importPack failed: ${error}`);
			});
			return;
		case 'importLayout':
			void (async () => {
				const jsonPath = await pickSingleFile({ allowedFileTypes: 'json' });
				if (!jsonPath) return;
				try {
					const imported = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as Record<string, unknown>;
					if (imported.version !== 1 || !Array.isArray(imported.tiles)) {
						showDesktopMessage('error', 'Invalid layout file.');
						return;
					}
					state.layoutWatcher?.markOwnWrite();
					writeLayoutToFile(imported);
					postToWebview(window, { type: 'layoutLoaded', layout: imported });
					showDesktopMessage('info', 'Layout imported successfully.');
				} catch {
					showDesktopMessage('error', 'Failed to read or parse layout file.');
				}
			})().catch((error) => {
				console.log(`[desktop] importLayout failed: ${error}`);
			});
			return;
		case 'focusAgent':
			if (!state.agents.has(message.id)) return;
			state.selectedAgentId = message.id;
			postToWebview(window, { type: 'agentSelected', id: message.id });
			{
				const requestedInstanceId = resolveTerminalInstanceId(state, message.instanceId) ?? `term-${Date.now().toString(36)}`;
				const runtime = getTerminalRuntime(state, requestedInstanceId, true);
				if (!runtime) return;
				setActiveTerminalInstance(state, runtime.instanceId);
				if (runtime.activeTerminalSessionId !== message.id) {
					resetTerminalSession(runtime, `focusAgent:${runtime.activeTerminalSessionId ?? 'none'}->${message.id}`);
					ensureTerminalPty(window, state, { instanceId: runtime.instanceId, traceId: runtime.terminalTraceId ?? undefined });
					runtime.terminalSessionSource = 'history';
					runtime.activeTerminalSessionId = message.id;
					runTerminalCommand(window, state, runtime, buildClaudeCommand(state.claudeResumeCommand, message.id));
				}
			}
			return;
		case 'closeAgent':
			state.hiddenSessionIds.add(message.id);
			state.forcedLiveSessionIds.delete(message.id);
			if (state.agents.has(message.id)) {
				postToWebview(window, { type: 'agentClosed', id: message.id });
			}
			state.agents.delete(message.id);
			refreshAndPublish(window, state, false);
			return;
		case 'saveAgentSeats':
			state.agentSeats = { ...state.agentSeats, ...message.seats };
			for (const [agentId, seat] of Object.entries(message.seats)) {
				const existing = state.agents.get(agentId);
				if (existing) {
					existing.palette = seat.palette;
					existing.hueShift = seat.hueShift;
					existing.seatId = seat.seatId;
				}
			}
			persistDesktopState(state);
			return;
		case 'openHistorySession':
			state.hiddenSessionIds.delete(message.sessionId);
			state.forcedLiveSessionIds.add(message.sessionId);
			state.selectedAgentId = message.sessionId;
			{
				const requestedInstanceId = resolveTerminalInstanceId(state, message.instanceId) ?? `term-${Date.now().toString(36)}`;
				const runtime = getTerminalRuntime(state, requestedInstanceId, true);
				if (runtime) {
					setActiveTerminalInstance(state, runtime.instanceId);
					if (runtime.activeTerminalSessionId !== message.sessionId) {
						resetTerminalSession(runtime, 'openHistorySession');
						ensureTerminalPty(window, state, { instanceId: runtime.instanceId, traceId: runtime.terminalTraceId ?? undefined });
						runtime.terminalSessionSource = 'history';
						runtime.activeTerminalSessionId = message.sessionId;
						runTerminalCommand(window, state, runtime, buildClaudeCommand(state.claudeResumeCommand, message.sessionId));
					}
				}
			}
			refreshAndPublish(window, state, false);
			return;
			case 'terminalCreate':
			{
				const requestedInstanceId = normalizeInstanceId(message.instanceId) ?? `term-${Date.now().toString(36)}`;
				const traceId = normalizeTraceId(message.traceId);
				console.log(`[desktop] terminalCreate (${traceLabel(traceId)}) instance=${shortInstanceId(requestedInstanceId)}`);
				const runtime = ensureTerminalPty(window, state, {
					cols: normalizeTerminalSize(message.cols, DESKTOP_PTY_DEFAULT_COLS, TERMINAL_MIN_COLS),
					rows: normalizeTerminalSize(message.rows, DESKTOP_PTY_DEFAULT_ROWS, TERMINAL_MIN_ROWS),
					cwd: message.cwd,
					instanceId: requestedInstanceId,
					traceId: traceId ?? undefined,
				});
				if (runtime && state.traceSmokeMode && state.traceSmokeId && runtime.terminalTraceId === state.traceSmokeId) {
					const marker = `${TRACE_SMOKE_MARKER_PREFIX}:${state.traceSmokeId}`;
					postTerminalData(window, runtime, `${marker}\r\n`);
				}
			}
			return;
			case 'terminalInput':
			{
				const targetInstanceId = resolveTerminalInstanceId(state, message.instanceId);
				if (!targetInstanceId) return;
				const runtime = getTerminalRuntime(state, targetInstanceId, false);
				if (!runtime) return;
				const traceId = normalizeTraceId(message.traceId);
				if (traceId) runtime.terminalTraceId = traceId;
				if (!runtime.terminalPty) return;
				if (runtime.terminalLifecycle !== 'running') return;
				try {
					runtime.terminalPty.write(message.data);
				} catch (error) {
					const text = error instanceof Error ? error.message : String(error);
					console.log(`[desktop] terminalInput write failed: ${text}`);
					runtime.terminalPty = null;
					runtime.terminalBackend = null;
					runtime.terminalLifecycle = 'stopped';
					runtime.activeTerminalSessionId = null;
				}
			}
			return;
			case 'terminalResize':
			{
				const targetInstanceId = resolveTerminalInstanceId(state, message.instanceId);
				if (!targetInstanceId) return;
				const runtime = getTerminalRuntime(state, targetInstanceId, false);
				if (!runtime) return;
				const traceId = normalizeTraceId(message.traceId);
				if (traceId) runtime.terminalTraceId = traceId;
				if (!runtime.terminalPty) return;
				if (runtime.terminalLifecycle !== 'running') return;
				const nextCols = normalizeTerminalSize(message.cols, runtime.terminalCols, TERMINAL_MIN_COLS);
				const nextRows = normalizeTerminalSize(message.rows, runtime.terminalRows, TERMINAL_MIN_ROWS);
				if (nextCols === runtime.terminalCols && nextRows === runtime.terminalRows) {
					return;
				}
				try {
					runtime.terminalPty.resize(nextCols, nextRows);
					runtime.terminalCols = nextCols;
					runtime.terminalRows = nextRows;
				} catch (error) {
					const text = error instanceof Error ? error.message : String(error);
					if (process.env['PIXEL_AGENTS_DEBUG_TERMINAL'] === '1') {
						console.log(`[desktop] terminalResize message failed: ${text}`);
					} else {
						console.log('[desktop] terminalResize failed; keeping previous PTY size');
					}
				}
			}
			return;
			case 'terminalClose':
			{
				const targetInstanceId = resolveTerminalInstanceId(state, message.instanceId);
				if (!targetInstanceId) return;
				const runtime = getTerminalRuntime(state, targetInstanceId, false);
				if (!runtime) return;
				const traceId = normalizeTraceId(message.traceId);
				if (traceId) runtime.terminalTraceId = traceId;
				closeTerminalInstance(state, targetInstanceId, 'terminalClose', true);
			}
			return;
			case 'terminalTraceAck':
				{
					const traceId = normalizeTraceId(message.traceId);
					if (!traceId) return;
					if (state.traceSmokeMode && state.traceSmokeId === traceId && message.markerSeen) {
						state.traceSmokeAck = true;
					}
					console.log(`[desktop] trace ack (${traceId}) markerSeen=${message.markerSeen ? 'yes' : 'no'}`);
				}
				return;
		case 'setSoundEnabled':
			state.settings.soundEnabled = message.enabled;
			sendSettings(window, state);
			return;
		case 'setSpeechBubblesEnabled':
		case 'setAlwaysStatusBubblesEnabled':
			state.settings.alwaysStatusBubblesEnabled = message.enabled;
			sendSettings(window, state);
			return;
		case 'setEventBubblesEnabled':
			state.settings.eventBubblesEnabled = message.enabled;
			sendSettings(window, state);
			return;
		case 'setHistorySessionsEnabled':
			state.settings.historySessionsEnabled = message.enabled;
			sendSettings(window, state);
			sendHistorySessions(window, state);
			return;
		case 'openSessionsFolder':
			if (state.projectDir) {
				openExternalTarget(state.projectDir);
			}
			return;
		case 'openExternal':
			openExternalTarget(message.target);
			return;
		case 'openClaude':
			{
				const requestedInstanceId = resolveTerminalInstanceId(state, message.instanceId) ?? `term-${Date.now().toString(36)}`;
				const traceId = normalizeTraceId(message.traceId) ?? `trace-${Date.now().toString(36)}`;
				const runtime = getTerminalRuntime(state, requestedInstanceId, true);
				if (!runtime) return;
				setActiveTerminalInstance(state, runtime.instanceId);
				runtime.terminalTraceId = traceId;
				resetTerminalSession(runtime, 'openClaude');
				ensureTerminalPty(window, state, {
					cwd: message.folderPath || state.workspaceRoot || process.cwd(),
					instanceId: runtime.instanceId,
					traceId,
				});
				runtime.terminalSessionSource = 'launch';
				runtime.activeTerminalSessionId = null;
				runTerminalCommand(window, state, runtime, buildClaudeLaunchCommand(state.claudeLaunchCommand));
			}
			refreshAndPublish(window, state, false);
			return;
		default:
			console.log(`[desktop] webview message ignored: ${message.type}`);
			return;
	}
}

function run(): void {
	const state = createInitialState();
	console.log(`[desktop] workspace=${state.workspaceRoot ?? '<unset>'}`);
	console.log(`[desktop] projectDir=${state.projectDir ?? '<missing>'}`);
	console.log(
		`[desktop] history options: enabled=${state.settings.historySessionsEnabled}, lookbackDays=${state.historyLookbackDays}, maxVisible=${state.historyMaxVisible}, settingsFile=${state.settingsFilePath ?? '<none>'}`,
	);
	console.log(
		`[desktop] claude commands: launch="${state.claudeLaunchCommand}" resume="${state.claudeResumeCommand}"`,
	);

	const window = new BrowserWindow({
		title: 'Pixel Agents Desktop',
		frame: { x: 120, y: 80, width: 1280, height: 840 },
		url: 'views://pixel/index.html',
		renderer: 'native',
		titleBarStyle: 'default',
		transparent: false,
	});

	window.on('host-message', (event) => {
		const message = parseHostMessage(event);
		if (!message) {
			console.log('[desktop] ignored unknown host-message payload');
			return;
		}
		handleWebviewMessage(window, state, message);
	});

	window.on('dom-ready', () => {
		console.log('[desktop] webview DOM ready');
	});

	window.on('close', () => {
		cleanupHostResources(state, 'window-close');
	});

	process.once('SIGINT', () => cleanupHostResources(state, 'SIGINT'));
	process.once('SIGTERM', () => cleanupHostResources(state, 'SIGTERM'));
	process.once('beforeExit', () => cleanupHostResources(state, 'beforeExit'));
	process.once('exit', () => cleanupHostResources(state, 'exit'));

	console.log('[desktop] loading views://pixel/index.html');
}

run();
