import * as vscode from 'vscode';
import { PixelAgentsViewProvider } from './PixelAgentsViewProvider.js';
import {
	VIEW_ID,
	COMMAND_SHOW_PANEL,
	COMMAND_OPEN_IN_EDITOR,
	COMMAND_EXPORT_DEFAULT_LAYOUT,
	COMMAND_SHOW_RUNTIME_INFO,
} from './constants.js';

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
			output.appendLine(`[runtime] ${runtimeInfo}`);
			output.show(true);
			vscode.window.showInformationMessage(`Pixel Agents runtime: ${runtimeInfo}`);
		})
	);
}

export function deactivate() {
	providerInstance?.dispose();
}
