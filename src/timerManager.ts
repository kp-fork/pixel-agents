import type * as vscode from 'vscode';

import { PERMISSION_TIMER_DELAY_MS } from './constants.js';
import { postToWebview } from './contracts/postMessage.js';
import type { AgentId, AgentState } from './types.js';

function isPermissionExempt(
	permissionExemptTools: Set<string>,
	toolName: string | undefined,
): boolean {
	if (!toolName) return false;
	return permissionExemptTools.has(toolName) || toolName.startsWith('Team');
}

export function clearAgentActivity(
	agent: AgentState | undefined,
	agentId: AgentId,
	permissionTimers: Map<AgentId, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	if (!agent) return;

	if (agent.backgroundAgentToolIds.size > 0) {
		for (const toolId of Array.from(agent.activeToolIds)) {
			if (agent.backgroundAgentToolIds.has(toolId)) continue;
			agent.activeToolIds.delete(toolId);
			agent.activeToolStatuses.delete(toolId);
			const toolName = agent.activeToolNames.get(toolId);
			agent.activeToolNames.delete(toolId);
			if (toolName === 'Task' || toolName === 'Agent') {
				agent.activeSubagentToolIds.delete(toolId);
				agent.activeSubagentToolNames.delete(toolId);
			}
		}
	} else {
		agent.activeToolIds.clear();
		agent.activeToolStatuses.clear();
		agent.activeToolNames.clear();
		agent.activeSubagentToolIds.clear();
		agent.activeSubagentToolNames.clear();
	}

	agent.isWaiting = false;
	agent.permissionSent = false;
	cancelPermissionTimer(agentId, permissionTimers);
	postToWebview(webview, { type: 'agentToolsClear', id: agentId });
	for (const toolId of agent.backgroundAgentToolIds) {
		const status = agent.activeToolStatuses.get(toolId);
		if (status) {
			postToWebview(webview, {
				type: 'agentToolStart',
				id: agentId,
				toolId,
				status,
			});
		}
	}
	postToWebview(webview, { type: 'agentStatus', id: agentId, status: 'active' });
}

export function cancelWaitingTimer(
	agentId: AgentId,
	waitingTimers: Map<AgentId, ReturnType<typeof setTimeout>>,
): void {
	const timer = waitingTimers.get(agentId);
	if (timer) {
		clearTimeout(timer);
		waitingTimers.delete(agentId);
	}
}

export function startWaitingTimer(
	agentId: AgentId,
	delayMs: number,
	agents: Map<AgentId, AgentState>,
	waitingTimers: Map<AgentId, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	cancelWaitingTimer(agentId, waitingTimers);
	const timer = setTimeout(() => {
		waitingTimers.delete(agentId);
		const agent = agents.get(agentId);
		if (agent) {
			agent.isWaiting = true;
		}
		postToWebview(webview, {
			type: 'agentStatus',
			id: agentId,
			status: 'waiting',
		});
	}, delayMs);
	waitingTimers.set(agentId, timer);
}

export function cancelPermissionTimer(
	agentId: AgentId,
	permissionTimers: Map<AgentId, ReturnType<typeof setTimeout>>,
): void {
	const timer = permissionTimers.get(agentId);
	if (timer) {
		clearTimeout(timer);
		permissionTimers.delete(agentId);
	}
}

export function startPermissionTimer(
	agentId: AgentId,
	agents: Map<AgentId, AgentState>,
	permissionTimers: Map<AgentId, ReturnType<typeof setTimeout>>,
	permissionExemptTools: Set<string>,
	webview: vscode.Webview | undefined,
): void {
	cancelPermissionTimer(agentId, permissionTimers);
	const timer = setTimeout(() => {
		permissionTimers.delete(agentId);
		const agent = agents.get(agentId);
		if (!agent) return;

		let hasNonExempt = false;
		for (const toolId of agent.activeToolIds) {
			const toolName = agent.activeToolNames.get(toolId);
			if (!isPermissionExempt(permissionExemptTools, toolName)) {
				hasNonExempt = true;
				break;
			}
		}

		const stuckSubagentParentToolIds: string[] = [];
		for (const [parentToolId, subToolNames] of agent.activeSubagentToolNames) {
			for (const [, toolName] of subToolNames) {
				if (!isPermissionExempt(permissionExemptTools, toolName)) {
					stuckSubagentParentToolIds.push(parentToolId);
					hasNonExempt = true;
					break;
				}
			}
		}

		if (hasNonExempt) {
			agent.permissionSent = true;
			console.log(`[Pixel Agents] Agent ${agentId}: possible permission wait detected`);
			postToWebview(webview, {
				type: 'agentToolPermission',
				id: agentId,
			});
			for (const parentToolId of stuckSubagentParentToolIds) {
				postToWebview(webview, {
					type: 'subagentToolPermission',
					id: agentId,
					parentToolId,
				});
			}
		}
	}, PERMISSION_TIMER_DELAY_MS);
	permissionTimers.set(agentId, timer);
}
