import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentId, AgentState } from './types.js';
import type { WebviewToExtensionMessage } from './contracts/messages.js';
import { postToWebview } from './contracts/postMessage.js';
import {
	launchNewTerminal,
	launchTerminalForSession,
	removeAgent,
	restoreAgents,
	persistAgents,
	sendExistingAgents,
	sendLayout,
	getProjectDirPath,
} from './agentManager.js';
import { ensureProjectScan } from './fileWatcher.js';
import { loadFurnitureAssets, sendAssetsToWebview, loadFloorTiles, sendFloorTilesToWebview, loadWallTiles, sendWallTilesToWebview, loadCharacterSprites, sendCharacterSpritesToWebview, loadDefaultLayout } from './assetLoader.js';
import {
	WORKSPACE_KEY_AGENT_SEATS,
	GLOBAL_KEY_SOUND_ENABLED,
	GLOBAL_KEY_SPEECH_BUBBLES_ENABLED,
	GLOBAL_KEY_ALWAYS_STATUS_BUBBLES_ENABLED,
	GLOBAL_KEY_EVENT_BUBBLES_ENABLED,
	HISTORY_SESSIONS_ENABLED_DEFAULT,
	HISTORY_SESSIONS_LOOKBACK_DAYS_DEFAULT,
	HISTORY_SESSIONS_MAX_VISIBLE_DEFAULT,
} from './constants.js';
import { writeLayoutToFile, readLayoutFromFile, watchLayoutFile } from './layoutPersistence.js';
import type { LayoutWatcher } from './layoutPersistence.js';
import { canResumeHistorySession, collectHistorySessions } from './historySessions.js';
import { applyPackDirectory, applyPackZip, exportPackZip, getInstalledPackRoot } from './packManager.js';

export class PixelAgentsViewProvider implements vscode.WebviewViewProvider {
	nextTerminalIndex = { current: 1 };
	agents = new Map<AgentId, AgentState>();
	webviewView: vscode.WebviewView | undefined;

	// Per-agent timers
	fileWatchers = new Map<AgentId, fs.FSWatcher>();
	pollingTimers = new Map<AgentId, ReturnType<typeof setInterval>>();
	waitingTimers = new Map<AgentId, ReturnType<typeof setTimeout>>();
	jsonlPollTimers = new Map<AgentId, ReturnType<typeof setInterval>>();
	permissionTimers = new Map<AgentId, ReturnType<typeof setTimeout>>();

	// /clear detection: project-level scan for new JSONL files
	activeAgentId = { current: null as AgentId | null };
	knownJsonlFiles = new Set<string>();
	projectScanTimer = { current: null as ReturnType<typeof setInterval> | null };

	// Bundled default layout (loaded from assets/default-layout.json)
	defaultLayout: Record<string, unknown> | null = null;

	// Cross-window layout sync
	layoutWatcher: LayoutWatcher | null = null;

	constructor(private readonly context: vscode.ExtensionContext) {}

	private get extensionUri(): vscode.Uri {
		return this.context.extensionUri;
	}

	private get webview(): vscode.Webview | undefined {
		return this.webviewView?.webview;
	}

	private persistAgents = (): void => {
		persistAgents(this.agents, this.context);
	};

	private pushSettings(): void {
		if (!this.webview) return;
		const soundEnabled = this.context.globalState.get<boolean>(GLOBAL_KEY_SOUND_ENABLED, true);
		const speechBubblesEnabled = this.context.globalState.get<boolean>(GLOBAL_KEY_SPEECH_BUBBLES_ENABLED, true);
		const alwaysStatusBubblesEnabled = this.context.globalState.get<boolean>(GLOBAL_KEY_ALWAYS_STATUS_BUBBLES_ENABLED, speechBubblesEnabled);
		const eventBubblesEnabled = this.context.globalState.get<boolean>(GLOBAL_KEY_EVENT_BUBBLES_ENABLED, true);
		const config = vscode.workspace.getConfiguration('pixel-agents');
		const historySessionsEnabled = config.get<boolean>('historySessions.enabled', HISTORY_SESSIONS_ENABLED_DEFAULT);
		postToWebview(this.webview, {
			type: 'settingsLoaded',
			soundEnabled,
			speechBubblesEnabled: alwaysStatusBubblesEnabled,
			alwaysStatusBubblesEnabled,
			eventBubblesEnabled,
			historySessionsEnabled,
		});
	}

	private sendHistorySessions(projectDir: string | null): void {
		if (!this.webview) return;

		const config = vscode.workspace.getConfiguration('pixel-agents');
		const enabled = config.get<boolean>('historySessions.enabled', HISTORY_SESSIONS_ENABLED_DEFAULT);
		const lookbackDays = config.get<number>('historySessions.lookbackDays', HISTORY_SESSIONS_LOOKBACK_DAYS_DEFAULT);
		const maxVisible = config.get<number>('historySessions.maxVisible', HISTORY_SESSIONS_MAX_VISIBLE_DEFAULT);

		const liveSessionIds = Array.from(new Set(
			Array.from(this.agents.values()).flatMap((agent) => {
				const ids: string[] = [];
				const terminalMatch = agent.terminalRef.name.match(/\(([0-9a-fA-F-]{36})\)$/);
				if (terminalMatch?.[1]) {
					ids.push(terminalMatch[1].toLowerCase());
				}
				const fileSessionId = path.basename(agent.jsonlFile, '.jsonl');
				if (/^[0-9a-fA-F-]{36}$/.test(fileSessionId)) {
					ids.push(fileSessionId.toLowerCase());
				}
				return ids;
			}),
		));

		const sessions = collectHistorySessions(
			projectDir,
			Array.from(this.agents.values()).map((agent) => agent.jsonlFile),
			{ enabled, lookbackDays, maxVisible },
			liveSessionIds,
		).map((session) => ({
			id: session.id,
			sessionId: session.sessionId,
			jsonlPath: session.jsonlPath,
			createdAt: new Date(session.createdAtMs).toISOString(),
			lastActivityAt: new Date(session.lastActivityAtMs).toISOString(),
			preview: session.preview,
		}));

		postToWebview(this.webview, { type: 'historySessionsLoaded', sessions });
	}

	private resolvePackContentRoot(): string | null {
		const installedPackRoot = getInstalledPackRoot();
		if (installedPackRoot) {
			return installedPackRoot;
		}
		const extensionPath = this.extensionUri.fsPath;
		const bundledAssetsDir = path.join(extensionPath, 'dist', 'assets');
		if (fs.existsSync(bundledAssetsDir)) {
			return path.join(extensionPath, 'dist');
		}
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (workspaceRoot) {
			return workspaceRoot;
		}
		return null;
	}

	private makeDefaultPackExportName(): string {
		const now = new Date();
		const y = now.getFullYear();
		const m = String(now.getMonth() + 1).padStart(2, '0');
		const d = String(now.getDate()).padStart(2, '0');
		const hh = String(now.getHours()).padStart(2, '0');
		const mm = String(now.getMinutes()).padStart(2, '0');
		const ss = String(now.getSeconds()).padStart(2, '0');
		return `pixel-agents-pack-${y}${m}${d}-${hh}${mm}${ss}.pack.zip`;
	}

	resolveWebviewView(webviewView: vscode.WebviewView) {
		this.webviewView = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = getWebviewContent(webviewView.webview, this.extensionUri);

		webviewView.webview.onDidReceiveMessage(async (message: WebviewToExtensionMessage) => {
			if (message.type === 'openClaude') {
				launchNewTerminal(
					this.nextTerminalIndex,
					this.agents, this.activeAgentId, this.knownJsonlFiles,
					this.fileWatchers, this.pollingTimers, this.waitingTimers, this.permissionTimers,
					this.jsonlPollTimers, this.projectScanTimer,
					this.webview, this.persistAgents,
				);
				this.sendHistorySessions(getProjectDirPath());
			} else if (message.type === 'focusAgent') {
				const agent = this.agents.get(message.id);
				if (agent) {
					this.activeAgentId.current = message.id;
					agent.terminalRef.show();
				}
			} else if (message.type === 'closeAgent') {
				const agent = this.agents.get(message.id);
				if (agent) {
					agent.terminalRef.dispose();
				}
			} else if (message.type === 'saveAgentSeats') {
				// Store seat assignments in a separate key (never touched by persistAgents)
				console.log(`[Pixel Agents] saveAgentSeats:`, JSON.stringify(message.seats));
				this.context.workspaceState.update(WORKSPACE_KEY_AGENT_SEATS, message.seats);
			} else if (message.type === 'saveLayout') {
				this.layoutWatcher?.markOwnWrite();
				writeLayoutToFile(message.layout as Record<string, unknown>);
			} else if (message.type === 'setSoundEnabled') {
				this.context.globalState.update(GLOBAL_KEY_SOUND_ENABLED, message.enabled);
			} else if (message.type === 'setSpeechBubblesEnabled') {
				this.context.globalState.update(GLOBAL_KEY_SPEECH_BUBBLES_ENABLED, message.enabled);
				this.context.globalState.update(GLOBAL_KEY_ALWAYS_STATUS_BUBBLES_ENABLED, message.enabled);
			} else if (message.type === 'setAlwaysStatusBubblesEnabled') {
				this.context.globalState.update(GLOBAL_KEY_ALWAYS_STATUS_BUBBLES_ENABLED, message.enabled);
				// Keep legacy key aligned for backward compatibility.
				this.context.globalState.update(GLOBAL_KEY_SPEECH_BUBBLES_ENABLED, message.enabled);
				} else if (message.type === 'setEventBubblesEnabled') {
					this.context.globalState.update(GLOBAL_KEY_EVENT_BUBBLES_ENABLED, message.enabled);
				} else if (message.type === 'setHistorySessionsEnabled') {
					const config = vscode.workspace.getConfiguration('pixel-agents');
					const hasWorkspace = !!(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0);
					await config.update(
						'historySessions.enabled',
						message.enabled,
						hasWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global,
					);
					this.pushSettings();
					this.sendHistorySessions(getProjectDirPath());
				} else if (message.type === 'webviewReady') {
					restoreAgents(
					this.context,
					this.nextTerminalIndex,
					this.agents, this.knownJsonlFiles,
					this.fileWatchers, this.pollingTimers, this.waitingTimers, this.permissionTimers,
					this.jsonlPollTimers, this.projectScanTimer, this.activeAgentId,
					this.webview, this.persistAgents,
				);
					// Send persisted settings to webview
					this.pushSettings();

				// Ensure project scan runs even with no restored agents (to adopt external terminals)
				const projectDir = getProjectDirPath();
				const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				console.log('[Extension] workspaceRoot:', workspaceRoot);
				console.log('[Extension] projectDir:', projectDir);
				if (projectDir) {
					ensureProjectScan(
						projectDir, this.knownJsonlFiles, this.projectScanTimer, this.activeAgentId,
						this.agents,
						this.fileWatchers, this.pollingTimers, this.waitingTimers, this.permissionTimers,
						this.webview, this.persistAgents,
					);

					// Load furniture assets BEFORE sending layout
						(async () => {
							try {
								console.log('[Extension] Loading furniture assets...');
								const extensionPath = this.extensionUri.fsPath;
								console.log('[Extension] extensionPath:', extensionPath);

								// Check bundled location first: extensionPath/dist/assets/
									const bundledAssetsDir = path.join(extensionPath, 'dist', 'assets');
									const bundledRoot = fs.existsSync(bundledAssetsDir) ? path.join(extensionPath, 'dist') : null;
									let installedPackRoot = getInstalledPackRoot();
									if (!installedPackRoot && bundledRoot) {
										const bundledDefaultPackRoot = path.join(bundledRoot, 'assets', 'packs', 'default');
										const bundledManifestPath = path.join(bundledDefaultPackRoot, 'manifest.json');
										if (fs.existsSync(bundledManifestPath)) {
											try {
												const applied = await applyPackDirectory(bundledDefaultPackRoot);
												installedPackRoot = applied.packRoot;
												this.defaultLayout = applied.layout;
												console.log('[Extension] Installed bundled default pack.');
											} catch (err) {
												console.error('[Extension] Failed to install bundled default pack:', err);
											}
										}
									}
									let visualAssetsRoot: string | null = null;
									let contentAssetsRoot: string | null = null;

								if (bundledRoot) {
									console.log('[Extension] Found bundled assets at dist/');
									visualAssetsRoot = bundledRoot;
								} else if (workspaceRoot) {
									// Fall back to workspace root (development or external assets)
									console.log('[Extension] Trying workspace for assets...');
									visualAssetsRoot = workspaceRoot;
								}

								if (installedPackRoot) {
									console.log('[Extension] Found installed pack:', installedPackRoot);
									contentAssetsRoot = installedPackRoot;
								} else {
									contentAssetsRoot = visualAssetsRoot;
								}
								if (!visualAssetsRoot && !contentAssetsRoot) {
									console.log('[Extension] ⚠️  No assets directory found');
									if (this.webview) {
										sendLayout(this.context, this.webview, this.defaultLayout);
										this.startLayoutWatcher();
									}
									return;
								}

								console.log('[Extension] Using visualAssetsRoot:', visualAssetsRoot);
								console.log('[Extension] Using contentAssetsRoot:', contentAssetsRoot);

								// Load default layout (installed pack has priority).
								if (contentAssetsRoot) {
									this.defaultLayout = loadDefaultLayout(contentAssetsRoot);
								}
								if (!this.defaultLayout && visualAssetsRoot && contentAssetsRoot !== visualAssetsRoot) {
									this.defaultLayout = loadDefaultLayout(visualAssetsRoot);
								}

								// Load character sprites from content root first (pack can override), then visual root fallback.
								{
									const charSprites = (contentAssetsRoot
										? await loadCharacterSprites(contentAssetsRoot)
										: null)
										|| ((visualAssetsRoot && visualAssetsRoot !== contentAssetsRoot)
											? await loadCharacterSprites(visualAssetsRoot)
											: null);
									if (charSprites && this.webview) {
										console.log('[Extension] Character sprites loaded, sending to webview');
										sendCharacterSpritesToWebview(this.webview, charSprites);
									}
								}

								// Load visual tiles (floor/wall) from bundled/workspace assets.
								if (visualAssetsRoot) {
									const floorTiles = await loadFloorTiles(visualAssetsRoot);
									if (floorTiles && this.webview) {
										console.log('[Extension] Floor tiles loaded, sending to webview');
										sendFloorTilesToWebview(this.webview, floorTiles);
									}

									const wallTiles = await loadWallTiles(visualAssetsRoot);
									if (wallTiles && this.webview) {
										console.log('[Extension] Wall tiles loaded, sending to webview');
										sendWallTilesToWebview(this.webview, wallTiles);
									}
								}

								// Load furniture assets from content root (installed pack preferred).
								if (contentAssetsRoot) {
									const assets = await loadFurnitureAssets(contentAssetsRoot);
									if (assets && this.webview) {
										console.log('[Extension] ✅ Assets loaded, sending to webview');
										sendAssetsToWebview(this.webview, assets);
									}
								}
							} catch (err) {
								console.error('[Extension] ❌ Error loading assets:', err);
						}
						// Always send saved layout (or null for default)
						if (this.webview) {
							console.log('[Extension] Sending saved layout');
							sendLayout(this.context, this.webview, this.defaultLayout);
							this.startLayoutWatcher();
						}
					})();
					} else {
						// No project dir — still try to load floor/wall tiles, then send saved layout
						(async () => {
							try {
								const ep = this.extensionUri.fsPath;
								const bundled = path.join(ep, 'dist', 'assets');
								if (fs.existsSync(bundled)) {
									const distRoot = path.join(ep, 'dist');
									let installedPackRoot = getInstalledPackRoot();
									if (!installedPackRoot) {
										const bundledDefaultPackRoot = path.join(distRoot, 'assets', 'packs', 'default');
										const bundledManifestPath = path.join(bundledDefaultPackRoot, 'manifest.json');
										if (fs.existsSync(bundledManifestPath)) {
											try {
												const applied = await applyPackDirectory(bundledDefaultPackRoot);
												installedPackRoot = applied.packRoot;
												this.defaultLayout = applied.layout;
											} catch (err) {
												console.error('[Extension] Failed to install bundled default pack:', err);
											}
										}
									}

									this.defaultLayout = loadDefaultLayout(installedPackRoot || distRoot);
									const cs = (installedPackRoot
										? await loadCharacterSprites(installedPackRoot)
										: null)
										|| await loadCharacterSprites(distRoot);
									if (cs && this.webview) {
										sendCharacterSpritesToWebview(this.webview, cs);
									}
									const ft = await loadFloorTiles(distRoot);
								if (ft && this.webview) {
									sendFloorTilesToWebview(this.webview, ft);
								}
									const wt = await loadWallTiles(distRoot);
									if (wt && this.webview) {
										sendWallTilesToWebview(this.webview, wt);
									}
									if (installedPackRoot) {
										const assets = await loadFurnitureAssets(installedPackRoot);
										if (assets && this.webview) {
											sendAssetsToWebview(this.webview, assets);
										}
									} else {
										const assets = await loadFurnitureAssets(distRoot);
										if (assets && this.webview) {
											sendAssetsToWebview(this.webview, assets);
										}
									}
								}
							} catch { /* ignore */ }
						if (this.webview) {
							sendLayout(this.context, this.webview, this.defaultLayout);
							this.startLayoutWatcher();
						}
					})();
				}
				sendExistingAgents(this.agents, this.context, this.webview);
				this.sendHistorySessions(projectDir);
			} else if (message.type === 'openSessionsFolder') {
				const liveAgentDir = Array.from(this.agents.values())
					.map((agent) => agent.projectDir)
					.find((dir) => !!dir && fs.existsSync(dir));
				const projectDir = liveAgentDir || getProjectDirPath();
				if (projectDir && fs.existsSync(projectDir)) {
					vscode.env.openExternal(vscode.Uri.file(projectDir));
				} else {
					const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
					if (fs.existsSync(projectsRoot)) {
						vscode.window.showWarningMessage('Pixel Agents: Could not resolve this workspace session folder. Opening ~/.claude/projects instead.');
						vscode.env.openExternal(vscode.Uri.file(projectsRoot));
					} else {
						vscode.window.showWarningMessage('Pixel Agents: Session folder not found.');
					}
				}
			} else if (message.type === 'openHistorySession') {
				const rawJsonlPath = (message.jsonlPath || '').trim();
				const rawSessionId = (message.sessionId || '').trim();
				const derivedSessionId = (!rawSessionId && rawJsonlPath.endsWith('.jsonl'))
					? path.basename(rawJsonlPath, '.jsonl')
					: '';
				const sessionId = rawSessionId || derivedSessionId;
				if (!sessionId) {
					vscode.window.showWarningMessage('Pixel Agents: Missing history session id.');
					return;
				}
				if (rawJsonlPath && !canResumeHistorySession(rawJsonlPath, sessionId)) {
					vscode.window.showWarningMessage('Pixel Agents: This history entry cannot be resumed.');
					this.sendHistorySessions(getProjectDirPath());
					return;
				}

				const projectDir = getProjectDirPath();
				const expectedJsonlPath = rawJsonlPath || (projectDir ? path.join(projectDir, `${sessionId}.jsonl`) : '');
				const sessionIdFromTerminalName = (name: string): string => {
					const match = name.match(/\(([0-9a-fA-F-]{36})\)$/);
					return match ? match[1] : '';
				};
				for (const [id, agent] of this.agents) {
					const terminalSessionId = sessionIdFromTerminalName(agent.terminalRef.name);
					const sameSession = path.basename(agent.jsonlFile) === `${sessionId}.jsonl`
						|| (expectedJsonlPath !== '' && agent.jsonlFile === expectedJsonlPath)
						|| terminalSessionId === sessionId;
					if (!sameSession) continue;
					this.activeAgentId.current = id;
					agent.terminalRef.show();
					postToWebview(this.webview, { type: 'agentSelected', id });
					this.sendHistorySessions(projectDir);
					return;
				}
				const existingTerminal = vscode.window.terminals.find((terminal) =>
					sessionIdFromTerminalName(terminal.name) === sessionId
				);
				launchTerminalForSession(
					sessionId,
					this.nextTerminalIndex,
					this.agents, this.activeAgentId, this.knownJsonlFiles,
					this.fileWatchers, this.pollingTimers, this.waitingTimers, this.permissionTimers,
					this.jsonlPollTimers, this.projectScanTimer,
					this.webview, this.persistAgents,
					{
						resumeSession: true,
						terminal: existingTerminal,
						sendCommand: existingTerminal ? false : true,
					},
				);
				if (existingTerminal) {
					existingTerminal.show();
				}
				this.sendHistorySessions(projectDir);
			} else if (message.type === 'openExternal') {
				const target = (message.target || '').trim();
				if (!target) return;
				if (/^https?:\/\//i.test(target)) {
					vscode.env.openExternal(vscode.Uri.parse(target));
					return;
				}
				const resolvedPath = path.isAbsolute(target)
					? target
					: path.resolve(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd(), target);
				vscode.env.openExternal(vscode.Uri.file(resolvedPath));
				} else if (message.type === 'exportLayout' || message.type === 'exportPack') {
					const layout = readLayoutFromFile();
					if (!layout) {
						vscode.window.showWarningMessage('Pixel Agents: No saved layout to export.');
						return;
					}
					const sourceAssetsRoot = this.resolvePackContentRoot();
					if (!sourceAssetsRoot) {
						vscode.window.showErrorMessage('Pixel Agents: Cannot resolve furniture assets root for pack export.');
						return;
					}
					const uri = await vscode.window.showSaveDialog({
						filters: { 'Pack ZIP': ['zip'] },
						defaultUri: vscode.Uri.file(path.join(os.homedir(), this.makeDefaultPackExportName())),
					});
					if (uri) {
						try {
							await exportPackZip({
								layout,
								sourceAssetsRoot,
								outputZipPath: uri.fsPath,
							});
							vscode.window.showInformationMessage('Pixel Agents: Pack exported successfully.');
						} catch (err) {
							const messageText = err instanceof Error ? err.message : String(err);
							vscode.window.showErrorMessage(`Pixel Agents: Failed to export pack. ${messageText}`);
						}
					}
				} else if (message.type === 'importPack') {
					const uris = await vscode.window.showOpenDialog({
						filters: { 'ZIP Files': ['zip'] },
						canSelectMany: false,
					});
					if (!uris || uris.length === 0) return;
					try {
						const applied = await applyPackZip(uris[0].fsPath);
						this.defaultLayout = applied.layout;

						const assets = await loadFurnitureAssets(applied.packRoot);
						if (assets && this.webview) {
							sendAssetsToWebview(this.webview, assets);
						}

						this.layoutWatcher?.markOwnWrite();
						writeLayoutToFile(applied.layout);
						postToWebview(this.webview, { type: 'layoutLoaded', layout: applied.layout });

						vscode.window.showInformationMessage(
							`Pixel Agents: Pack "${applied.manifest.name}" loaded successfully.`,
						);
					} catch (err) {
						const messageText = err instanceof Error ? err.message : String(err);
						vscode.window.showErrorMessage(`Pixel Agents: Failed to import pack. ${messageText}`);
					}
				} else if (message.type === 'importLayout') {
					const uris = await vscode.window.showOpenDialog({
						filters: { 'JSON Files': ['json'] },
						canSelectMany: false,
					});
				if (!uris || uris.length === 0) return;
				try {
					const raw = fs.readFileSync(uris[0].fsPath, 'utf-8');
					const imported = JSON.parse(raw) as Record<string, unknown>;
					if (imported.version !== 1 || !Array.isArray(imported.tiles)) {
						vscode.window.showErrorMessage('Pixel Agents: Invalid layout file.');
						return;
					}
					this.layoutWatcher?.markOwnWrite();
					writeLayoutToFile(imported);
					postToWebview(this.webview, { type: 'layoutLoaded', layout: imported });
					vscode.window.showInformationMessage('Pixel Agents: Layout imported successfully.');
				} catch {
					vscode.window.showErrorMessage('Pixel Agents: Failed to read or parse layout file.');
				}
			}
		});

		vscode.window.onDidChangeActiveTerminal((terminal) => {
			this.activeAgentId.current = null;
			if (!terminal) return;
			for (const [id, agent] of this.agents) {
				if (agent.terminalRef === terminal) {
					this.activeAgentId.current = id;
					postToWebview(webviewView.webview, { type: 'agentSelected', id });
					break;
				}
			}
		});

		vscode.window.onDidCloseTerminal((closed) => {
			for (const [id, agent] of this.agents) {
				if (agent.terminalRef === closed) {
					if (this.activeAgentId.current === id) {
						this.activeAgentId.current = null;
					}
					removeAgent(
						id, this.agents,
						this.fileWatchers, this.pollingTimers, this.waitingTimers, this.permissionTimers,
						this.jsonlPollTimers, this.persistAgents,
					);
					postToWebview(webviewView.webview, { type: 'agentClosed', id });
					this.sendHistorySessions(getProjectDirPath());
					break;
				}
			}
		});
	}

	/** Export current saved layout to webview-ui/public/assets/default-layout.json (dev utility) */
	exportDefaultLayout(): void {
		const layout = readLayoutFromFile();
		if (!layout) {
			vscode.window.showWarningMessage('Pixel Agents: No saved layout found.');
			return;
		}
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			vscode.window.showErrorMessage('Pixel Agents: No workspace folder found.');
			return;
		}
		const targetPath = path.join(workspaceRoot, 'webview-ui', 'public', 'assets', 'default-layout.json');
		const json = JSON.stringify(layout, null, 2);
		fs.writeFileSync(targetPath, json, 'utf-8');
		vscode.window.showInformationMessage(`Pixel Agents: Default layout exported to ${targetPath}`);
	}

	private startLayoutWatcher(): void {
		if (this.layoutWatcher) return;
		this.layoutWatcher = watchLayoutFile((layout) => {
			console.log('[Pixel Agents] External layout change — pushing to webview');
			postToWebview(this.webview, { type: 'layoutLoaded', layout });
		});
	}

	dispose() {
		this.layoutWatcher?.dispose();
		this.layoutWatcher = null;
		for (const id of [...this.agents.keys()]) {
			removeAgent(
				id, this.agents,
				this.fileWatchers, this.pollingTimers, this.waitingTimers, this.permissionTimers,
				this.jsonlPollTimers, this.persistAgents,
			);
		}
		if (this.projectScanTimer.current) {
			clearInterval(this.projectScanTimer.current);
			this.projectScanTimer.current = null;
		}
	}
}

export function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const distPath = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
	const indexPath = vscode.Uri.joinPath(distPath, 'index.html').fsPath;

	let html = fs.readFileSync(indexPath, 'utf-8');

	html = html.replace(/(href|src)="\.\/([^"]+)"/g, (_match, attr, filePath) => {
		const fileUri = vscode.Uri.joinPath(distPath, filePath);
		const webviewUri = webview.asWebviewUri(fileUri);
		return `${attr}="${webviewUri}"`;
	});

	return html;
}
