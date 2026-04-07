import type { SessionRecord, SessionStage } from '../../contracts/session.js';
import type { SessionRegistryPort } from '../ports.js';

export interface SessionBinding {
	jsonlPath: string;
	agentId: number;
}

export interface SessionRegistrySnapshot {
	seenJsonl: string[];
	boundJsonl: SessionBinding[];
	records: SessionRecord[];
}

export interface SessionRegistry extends SessionRegistryPort {
	readonly seenJsonl: ReadonlySet<string>;
	readonly boundJsonl: ReadonlyMap<string, number>;
	markSeen(path: string): void;
	isSeen(path: string): boolean;
	bind(path: string, agentId: number): void;
	unbind(path: string): void;
	isBound(path: string): boolean;
	getBoundAgentId(path: string): number | undefined;
	listRecords(): SessionRecord[];
	snapshot(): SessionRegistrySnapshot;
}

export function createSessionRegistry(seedRecords: readonly SessionRecord[] = []): SessionRegistry {
	return new InMemorySessionRegistry(seedRecords);
}

function normalizeJsonlPath(path: string): string {
	return path.trim();
}

function isBoundStage(stage: SessionStage): boolean {
	return stage === 'bound' || stage === 'tracking';
}

function cloneRecord(record: SessionRecord): SessionRecord {
	return { ...record };
}

class InMemorySessionRegistry implements SessionRegistry {
	readonly seenJsonl = new Set<string>();
	readonly boundJsonl = new Map<string, number>();

	private readonly recordsByPath = new Map<string, SessionRecord>();

	constructor(seedRecords: readonly SessionRecord[]) {
		for (const record of seedRecords) {
			this.upsert(record);
		}
	}

	markSeen(path: string): void {
		const jsonlPath = normalizeJsonlPath(path);
		if (!jsonlPath) return;
		this.seenJsonl.add(jsonlPath);
	}

	isSeen(path: string): boolean {
		const jsonlPath = normalizeJsonlPath(path);
		if (!jsonlPath) return false;
		return this.seenJsonl.has(jsonlPath);
	}

	bind(path: string, agentId: number): void {
		const jsonlPath = normalizeJsonlPath(path);
		if (!jsonlPath) return;
		this.seenJsonl.add(jsonlPath);
		this.boundJsonl.set(jsonlPath, agentId);
	}

	unbind(path: string): void {
		const jsonlPath = normalizeJsonlPath(path);
		if (!jsonlPath) return;
		this.boundJsonl.delete(jsonlPath);
	}

	isBound(path: string): boolean {
		const jsonlPath = normalizeJsonlPath(path);
		if (!jsonlPath) return false;
		return this.boundJsonl.has(jsonlPath);
	}

	getBoundAgentId(path: string): number | undefined {
		const jsonlPath = normalizeJsonlPath(path);
		if (!jsonlPath) return undefined;
		return this.boundJsonl.get(jsonlPath);
	}

	getByPath(path: string): SessionRecord | undefined {
		const jsonlPath = normalizeJsonlPath(path);
		if (!jsonlPath) return undefined;
		const record = this.recordsByPath.get(jsonlPath);
		return record ? cloneRecord(record) : undefined;
	}

	upsert(record: SessionRecord): void {
		const jsonlPath = normalizeJsonlPath(record.jsonlPath);
		if (!jsonlPath) return;

		const nextRecord: SessionRecord = { ...record, jsonlPath };
		this.recordsByPath.set(jsonlPath, nextRecord);
		this.seenJsonl.add(jsonlPath);

		if (isBoundStage(nextRecord.stage) && typeof nextRecord.agentId === 'number') {
			this.boundJsonl.set(jsonlPath, nextRecord.agentId);
			return;
		}

		if (!isBoundStage(nextRecord.stage)) {
			this.boundJsonl.delete(jsonlPath);
		}
	}

	listRecords(): SessionRecord[] {
		return [...this.recordsByPath.values()]
			.map(cloneRecord)
			.sort((a, b) => a.jsonlPath.localeCompare(b.jsonlPath));
	}

	snapshot(): SessionRegistrySnapshot {
		return {
			seenJsonl: [...this.seenJsonl].sort((a, b) => a.localeCompare(b)),
			boundJsonl: [...this.boundJsonl.entries()]
				.map(([jsonlPath, agentId]) => ({ jsonlPath, agentId }))
				.sort((a, b) => a.jsonlPath.localeCompare(b.jsonlPath)),
			records: this.listRecords(),
		};
	}
}
