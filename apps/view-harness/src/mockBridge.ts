export interface HarnessBridge {
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): () => void;
  emitFromHost(message: unknown): void;
  drainSentMessages(): unknown[];
}

export function createMockBridge(): HarnessBridge {
  const listeners = new Set<(message: unknown) => void>();
  const sentMessages: unknown[] = [];

  return {
    send(message: unknown): void {
      sentMessages.push(message);
    },
    onMessage(handler: (message: unknown) => void): () => void {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
    emitFromHost(message: unknown): void {
      for (const listener of listeners) {
        listener(message);
      }
    },
    drainSentMessages(): unknown[] {
      const drained = [...sentMessages];
      sentMessages.length = 0;
      return drained;
    },
  };
}
