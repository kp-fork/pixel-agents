export { bindBridgeToRouter, createMessageRouter } from './messageRouter.js';
export {
  createDefaultHostBridge,
  createNoopBridge,
  createVsCodeBridge,
  resolveVsCodeApi,
} from './vscodeBridge.js';
export type { HostBridge, MessageLike, VsCodeApiLike } from './types.js';
