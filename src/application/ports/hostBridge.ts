export interface HostBridge {
	send(message: unknown): void;
	onMessage(handler: (message: unknown) => void): () => void;
	openExternal?(urlOrPath: string): Promise<void>;
}

