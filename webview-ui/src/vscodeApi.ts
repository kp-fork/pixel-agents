import { createDefaultHostBridge } from './adapter/vscodeBridge.js'

export const hostBridge = createDefaultHostBridge()

export const vscode = {
  postMessage(message: unknown): void {
    hostBridge.send(message)
  },
}
