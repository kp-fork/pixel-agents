export type JsonlRoutingDecision =
	| { action: 'reassign'; agentId: string }
	| { action: 'adopt' }
	| { action: 'ignore' };

export interface JsonlRoutingAgent {
	id: string;
	terminalRef: unknown;
}

export function decideJsonlRouting(
	activeAgentId: string | null,
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
