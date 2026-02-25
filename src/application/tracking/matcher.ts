import path from 'node:path';

import type { TerminalRef } from '../ports.js';
import type { CandidateSession } from './scanner.js';

export interface TerminalMatchScoreInput {
	terminal: TerminalRef;
	candidate: CandidateSession;
	now: number;
}

export interface TerminalMatchScoreBreakdown {
	recencyScore: number;
	nameScore: number;
	cwdScore: number;
	candidateFreshnessScore: number;
	retryPenalty: number;
	total: number;
}

export interface TerminalMatchResult {
	terminal: TerminalRef;
	score: number;
	breakdown: TerminalMatchScoreBreakdown;
}

export interface TerminalMatcherOptions {
	minScore?: number;
}

export function scoreTerminalMatch(input: TerminalMatchScoreInput): number {
	return scoreTerminalMatchWithBreakdown(input).total;
}

export function scoreTerminalMatchWithBreakdown(
	input: TerminalMatchScoreInput,
): TerminalMatchScoreBreakdown {
	const recencyScore = computeRecencyScore(input.terminal.lastActiveAt, input.now);
	const nameScore = computeNameScore(input.terminal.name);
	const cwdScore = computeCwdScore(input.terminal.cwd, input.candidate.jsonlPath);
	const candidateFreshnessScore = computeCandidateFreshnessScore(input.candidate.mtimeMs, input.now);
	const retryPenalty = Math.min(input.candidate.retryCount * 8, 24);
	const total = recencyScore + nameScore + cwdScore + candidateFreshnessScore - retryPenalty;

	return {
		recencyScore,
		nameScore,
		cwdScore,
		candidateFreshnessScore,
		retryPenalty,
		total,
	};
}

export function matchTerminalForCandidate(
	terminals: readonly TerminalRef[],
	candidate: CandidateSession,
	now: number,
	options: TerminalMatcherOptions = {},
): TerminalMatchResult | undefined {
	const minScore = options.minScore ?? 1;

	let best: TerminalMatchResult | undefined;
	for (const terminal of terminals) {
		const breakdown = scoreTerminalMatchWithBreakdown({ terminal, candidate, now });
		if (breakdown.total < minScore) continue;

		if (!best || compareMatchResult({ terminal, score: breakdown.total, breakdown }, best) < 0) {
			best = { terminal, score: breakdown.total, breakdown };
		}
	}

	return best;
}

function compareMatchResult(a: TerminalMatchResult, b: TerminalMatchResult): number {
	if (a.score !== b.score) {
		return b.score - a.score;
	}

	const aLastActive = a.terminal.lastActiveAt ?? 0;
	const bLastActive = b.terminal.lastActiveAt ?? 0;
	if (aLastActive !== bLastActive) {
		return bLastActive - aLastActive;
	}

	return a.terminal.id.localeCompare(b.terminal.id);
}

function computeRecencyScore(lastActiveAt: number | undefined, now: number): number {
	if (typeof lastActiveAt !== 'number') return 0;
	const ageMs = Math.max(0, now - lastActiveAt);

	if (ageMs <= 15_000) return 40;
	if (ageMs <= 60_000) return 30;
	if (ageMs <= 5 * 60_000) return 20;
	if (ageMs <= 15 * 60_000) return 10;
	return 0;
}

function computeNameScore(name: string): number {
	const normalized = name.toLowerCase();
	let score = 0;
	if (normalized.includes('claude')) score += 24;
	if (normalized.includes('code')) score += 8;
	if (/claude\s*code(?:\s*#?\d+)?/.test(normalized)) score += 6;
	return score;
}

function computeCwdScore(cwd: string | undefined, jsonlPath: string): number {
	if (!cwd) return 0;
	const normalizedCwd = normalizePath(cwd);
	if (!normalizedCwd) return 0;

	const candidateDir = normalizePath(path.dirname(jsonlPath));
	if (!candidateDir) return 0;

	if (candidateDir === normalizedCwd) return 35;

	const cwdWithSep = `${normalizedCwd}${path.sep}`;
	if (candidateDir.startsWith(cwdWithSep)) return 26;

	const cwdBase = path.basename(normalizedCwd).toLowerCase();
	if (cwdBase && candidateDir.toLowerCase().includes(`${path.sep}${cwdBase}${path.sep}`)) return 12;
	return 0;
}

function computeCandidateFreshnessScore(mtimeMs: number, now: number): number {
	const ageMs = Math.max(0, now - mtimeMs);
	if (ageMs <= 60_000) return 14;
	if (ageMs <= 5 * 60_000) return 8;
	if (ageMs <= 30 * 60_000) return 3;
	return 0;
}

function normalizePath(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return '';
	const normalized = path.normalize(trimmed);
	return normalized.endsWith(path.sep) ? normalized.slice(0, -1) : normalized;
}
