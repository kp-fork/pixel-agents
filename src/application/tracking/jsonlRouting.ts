export type JsonlRoutingDecision =
	| { action: 'reassign'; agentId: number }
	| { action: 'adopt' }
	| { action: 'ignore' };

export interface JsonlRoutingAgent {
	id: number;
	terminalRef: unknown;
}

export function decideJsonlRouting(
	activeAgentId: number | null,
	activeTerminal: unknown,
	agents: Iterable<JsonlRoutingAgent>,
): JsonlRoutingDecision {
	if (activeAgentId !== null) {
		return { action: 'reassign', agentId: activeAgentId };
	}

	if (!activeTerminal) {
		return { action: 'ignore' };
	}

	for (const agent of agents) {
		if (agent.terminalRef === activeTerminal) {
			return { action: 'reassign', agentId: agent.id };
		}
	}

	return { action: 'adopt' };
}
