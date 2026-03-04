import type { HostBridge, VsCodeApiLike } from './types.js';

type BrowserBridgeTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>;

type HostGlobal = typeof globalThis & {
  acquireVsCodeApi?: () => VsCodeApiLike;
  __electrobunSendToHost?: (message: unknown) => void;
};

function hasBrowserMessageTarget(value: unknown): value is BrowserBridgeTarget {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<BrowserBridgeTarget>;
  return typeof candidate.addEventListener === 'function' && typeof candidate.removeEventListener === 'function';
}

export function createVsCodeBridge(
  vscodeApi: VsCodeApiLike,
  messageTarget: BrowserBridgeTarget,
): HostBridge {
  return {
    send(message: unknown): void {
      vscodeApi.postMessage(message);
    },
    onMessage(handler: (message: unknown) => void): () => void {
      const listener: EventListener = (event) => {
        const messageEvent = event as MessageEvent<unknown>;
        handler(messageEvent.data);
      };
      messageTarget.addEventListener('message', listener);
      return () => {
        messageTarget.removeEventListener('message', listener);
      };
    },
    async openExternal(urlOrPath: string): Promise<void> {
      vscodeApi.postMessage({ type: 'openExternal', target: urlOrPath });
    },
  };
}

export function createElectrobunBridge(
  sendToHost: (message: unknown) => void,
  messageTarget: BrowserBridgeTarget,
): HostBridge {
  return {
    send(message: unknown): void {
      sendToHost(message);
    },
    onMessage(handler: (message: unknown) => void): () => void {
      const listener: EventListener = (event) => {
        const messageEvent = event as MessageEvent<unknown>;
        handler(messageEvent.data);
      };
      messageTarget.addEventListener('message', listener);
      return () => {
        messageTarget.removeEventListener('message', listener);
      };
    },
    async openExternal(urlOrPath: string): Promise<void> {
      sendToHost({ type: 'openExternal', target: urlOrPath });
    },
  };
}

export function createNoopBridge(): HostBridge {
  return {
    send(_message: unknown): void {
      // No-op host bridge for standalone contexts.
    },
    onMessage(_handler: (message: unknown) => void): () => void {
      return () => {
        // No-op cleanup.
      };
    },
    async openExternal(urlOrPath: string): Promise<void> {
      if (typeof window !== 'undefined' && typeof window.open === 'function') {
        window.open(urlOrPath, '_blank', 'noopener,noreferrer');
      }
    },
  };
}

export function resolveVsCodeApi(target: HostGlobal = globalThis): VsCodeApiLike | null {
  if (typeof target.acquireVsCodeApi !== 'function') {
    return null;
  }

  try {
    return target.acquireVsCodeApi();
  } catch {
    return null;
  }
}

export function resolveElectrobunSendToHost(target: HostGlobal = globalThis): ((message: unknown) => void) | null {
  if (typeof target.__electrobunSendToHost !== 'function') {
    return null;
  }

  return target.__electrobunSendToHost;
}

export function createDefaultHostBridge(target: HostGlobal = globalThis): HostBridge {
  if (!hasBrowserMessageTarget(target)) {
    return createNoopBridge();
  }

  const vscodeApi = resolveVsCodeApi(target);
  if (vscodeApi) {
    return createVsCodeBridge(vscodeApi, target);
  }

  const sendToHost = resolveElectrobunSendToHost(target);
  if (sendToHost) {
    return createElectrobunBridge(sendToHost, target);
  }

  return createNoopBridge();
}
