import * as vscode from 'vscode';

import {
	COMMAND_EXPORT_DEFAULT_LAYOUT,
	COMMAND_OPEN_IN_EDITOR,
	COMMAND_SHOW_PANEL,
	COMMAND_SHOW_RUNTIME_INFO,
	VIEW_ID,
} from './constants.js';
import { PixelAgentsViewProvider } from './PixelAgentsViewProvider.js';

let providerInstance: PixelAgentsViewProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
	const output = vscode.window.createOutputChannel('Pixel Agents');
	const runtimeInfo = `id=${context.extension.id} version=${context.extension.packageJSON.version} path=${context.extensionPath}`;
	output.appendLine(`[activate] ${runtimeInfo}`);

	const provider = new PixelAgentsViewProvider(context);
	providerInstance = provider;

	context.subscriptions.push(output);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(VIEW_ID, provider)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(COMMAND_SHOW_PANEL, () => {
			vscode.commands.executeCommand(`${VIEW_ID}.focus`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(COMMAND_OPEN_IN_EDITOR, () => {
			provider.showInEditor();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(COMMAND_EXPORT_DEFAULT_LAYOUT, () => {
			provider.exportDefaultLayout();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(COMMAND_SHOW_RUNTIME_INFO, () => {
			const snapshot = provider.getRuntimeSnapshot();
			const activeAgents = snapshot.agents.filter((agent) => agent.status === 'active').length;
			const waitingAgents = snapshot.agents.length - activeAgents;
			output.appendLine('[runtime][begin]');
			output.appendLine(`[runtime][extension] ${runtimeInfo}`);
			output.appendLine(`[runtime][workspace] folders=${snapshot.workspaceFolders.length} projectDir=${snapshot.projectDir ?? '<none>'}`);
			output.appendLine(`[runtime][settings] sound=${snapshot.settings.soundEnabled} alwaysStatusBubbles=${snapshot.settings.alwaysStatusBubblesEnabled} eventBubbles=${snapshot.settings.eventBubblesEnabled} historyEnabled=${snapshot.settings.historySessionsEnabled} lookbackDays=${snapshot.settings.historyLookbackDays} maxVisible=${snapshot.settings.historyMaxVisible}`);
			output.appendLine(`[runtime][agents] total=${snapshot.agentCount} active=${activeAgents} waiting=${waitingAgents} selected=${snapshot.activeAgentId ?? '<none>'} knownJsonl=${snapshot.knownJsonlFileCount}`);
			for (const agent of snapshot.agents) {
				output.appendLine(
					`[runtime][agent] id=${agent.id} terminal="${agent.terminalName}" status=${agent.status} tools=${agent.activeToolCount} sessionId=${agent.sessionId ?? '<none>'} folder=${agent.folderName ?? '<none>'}`,
				);
			}
			output.appendLine(`[runtime][webview] attached=${snapshot.webviewAttached} layoutWatcher=${snapshot.layoutWatcherActive}`);
			output.appendLine(`[runtime][snapshot] ${JSON.stringify(snapshot)}`);
			output.appendLine('[runtime][end]');
			output.show(true);
			vscode.window.showInformationMessage(`Pixel Agents runtime logged: agents=${snapshot.agentCount}, project=${snapshot.projectDir ?? 'none'}`);
		})
	);
}

export function deactivate() {
	providerInstance?.dispose();
}
