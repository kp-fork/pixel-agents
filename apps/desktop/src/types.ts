export interface DesktopBridge {
	send(message: unknown): void;
	onMessage(handler: (message: unknown) => void): () => void;
	emitFromHost(message: unknown): void;
}

export interface DesktopInboundMessage {
	type: string;
	[key: string]: unknown;
}

