export interface HostBridge {
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): () => void;
  openExternal?(urlOrPath: string): Promise<void>;
}

export interface VsCodeApiLike {
  postMessage(message: unknown): void;
}

export interface MessageLike {
  type: string;
}
