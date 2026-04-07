import type * as vscode from 'vscode';

import type { ExtensionToWebviewMessage } from './messages.js';

export function postToWebview(
	webview: vscode.Webview | undefined,
	message: ExtensionToWebviewMessage,
): void {
	webview?.postMessage(message);
}
