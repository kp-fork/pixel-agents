import type { HostBridge, MessageLike } from './types.js';

export type MessageHandler<TMessage extends MessageLike = MessageLike> = (message: TMessage) => void;

export interface MessageRouter {
  register<TMessage extends MessageLike>(
    type: TMessage['type'],
    handler: MessageHandler<TMessage>,
  ): () => void;
  route(message: unknown): boolean;
  clear(): void;
}

function isMessageLike(message: unknown): message is MessageLike {
  if (!message || typeof message !== 'object') {
    return false;
  }
  return typeof (message as { type?: unknown }).type === 'string';
}

export function createMessageRouter(
  onUnhandled?: (message: unknown) => void,
): MessageRouter {
  const handlers = new Map<string, Set<MessageHandler>>();

  return {
    register<TMessage extends MessageLike>(
      type: TMessage['type'],
      handler: MessageHandler<TMessage>,
    ): () => void {
      const list = handlers.get(type) ?? new Set<MessageHandler>();
      list.add(handler as MessageHandler);
      handlers.set(type, list);

      return () => {
        const current = handlers.get(type);
        if (!current) {
          return;
        }
        current.delete(handler as MessageHandler);
        if (current.size === 0) {
          handlers.delete(type);
        }
      };
    },

    route(message: unknown): boolean {
      if (!isMessageLike(message)) {
        onUnhandled?.(message);
        return false;
      }

      const list = handlers.get(message.type);
      if (!list || list.size === 0) {
        onUnhandled?.(message);
        return false;
      }

      for (const handler of list) {
        handler(message);
      }
      return true;
    },

    clear(): void {
      handlers.clear();
    },
  };
}

export function bindBridgeToRouter(
  bridge: HostBridge,
  router: Pick<MessageRouter, 'route'>,
): () => void {
  return bridge.onMessage((message) => {
    router.route(message);
  });
}
