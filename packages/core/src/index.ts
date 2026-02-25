export { CoreStore, createInitialCoreState, reduceCoreState } from './officeState.js';
export {
  canTransitionSessionStage,
  createSessionCoreState,
  setSessionAgentBinding,
  transitionSessionStage,
} from './sessionState.js';
export type {
  AgentActivityStatus,
  AgentCoreState,
  CoreEvent,
  CoreState,
  OfficeLayoutState,
  SessionCoreState,
  SessionStage,
} from './types.js';
