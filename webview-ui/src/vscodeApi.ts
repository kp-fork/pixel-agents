import { createDefaultHostBridge } from './adapter/vscodeBridge.js'

export function getHostBridge() {
  return createDefaultHostBridge()
}

export const vscode = {
  postMessage(message: unknown): void {
    getHostBridge().send(message)
  },
}
