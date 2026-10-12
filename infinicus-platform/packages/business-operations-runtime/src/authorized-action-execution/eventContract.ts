// The shared event contract, as Business Operations uses it (re-exported from the shared event-contracts package: one definition).
export { ACTION_EXECUTED_CONSUMER, buildActionExecutedEvent } from '@infinicus/event-contracts';
export type { ActionExecutedPayload } from '@infinicus/event-contracts';
export const EVIDENCE_CONTRACT_REFERENCE = 'execution-evidence/1';
