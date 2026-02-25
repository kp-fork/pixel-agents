import type { PixelAgentsViewModel } from '../../../packages/view-model/src/types.js';

function formatCharacters(viewModel: PixelAgentsViewModel): string[] {
  if (viewModel.characters.length === 0) {
    return ['  (no agents)'];
  }

  return viewModel.characters.map((character) => {
    const tool = character.activeToolLabel ? ` tool=${character.activeToolLabel}` : '';
    return `  #${character.id} status=${character.status}${tool}`;
  });
}

function formatOverlays(viewModel: PixelAgentsViewModel): string[] {
  if (viewModel.overlays.length === 0) {
    return ['  (no overlays)'];
  }

  return viewModel.overlays.map((overlay) => {
    return `  ${overlay.kind} agent=${overlay.agentId} text=\"${overlay.text}\"`;
  });
}

function formatSessionSummary(viewModel: PixelAgentsViewModel): string[] {
  return viewModel.sessionSummary.map((summary) => {
    return `  ${summary.stage}: ${summary.count}`;
  });
}

export function renderViewModel(viewModel: PixelAgentsViewModel): string {
  const lines = [
    '=== Pixel Agents View Harness ===',
    `toolbar tracked=${viewModel.toolbar.trackedAgentCount} waiting=${viewModel.toolbar.waitingAgentCount}`,
    '',
    'characters:',
    ...formatCharacters(viewModel),
    '',
    'overlays:',
    ...formatOverlays(viewModel),
    '',
    'sessions:',
    ...formatSessionSummary(viewModel),
  ];

  return lines.join('\n');
}
