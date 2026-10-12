/**
 * Owner-ruled execution policy values (P0-6 planning record, rulings O-2 and O-3). They are named, documented constants - not
 * magic numbers - and every one is overridable ONLY through the engine's constructor, never silently.
 *
 *  O-3  retries: at most 3 attempts per claim, with backoff 1 s / 5 s / 15 s between them; a claim that has no outcome and no attempt is
 *       recovered 60 s after it was claimed. A terminal FAILED or deterministic REFUSED outcome is never re-driven (a new authorization is
 *       needed).
 *  O-2  `executionStatusMaxAgeMs` (5000 ms) is deliberately NOT here: the engine takes it as a required constructor argument with no
 *       default, and the composition root supplies 5000.
 */
export const EXECUTION_MAX_ATTEMPTS = 3;
export const EXECUTION_BACKOFF_MS: readonly number[] = Object.freeze([1_000, 5_000, 15_000]);
export const EXECUTION_CLAIM_RECOVERY_MS = 60_000;

/** The ABA component whose answer the engine judged; recorded in the evidence so the provider reference is explicit. */
export const STATUS_PROVIDER_COMPONENT = 'aba.package-status-provider';
/** The executor identity recorded in the evidence: Business Operations acting as the system, never a person. */
export const EXECUTOR_COMPONENT = 'bo.authorized-action-execution';

export const EXECUTION_AUDIT_ACTIONS = Object.freeze({
  executed: 'bo.authorized_action.executed',
  refused: 'bo.authorized_action.execution_refused',
  failed: 'bo.authorized_action.execution_failed',
  attemptDeferred: 'bo.authorized_action.execution_deferred',
});

/** Stable reason codes of an execution that did not succeed. */
export type ExecutionReasonCode =
  | 'RECEIPT_INVALID' | 'TARGET_INVALID' | 'PARAMETERS_INVALID' | 'CAPABILITY_DISABLED' | 'NO_BALANCE' | 'TARGET_AMBIGUOUS'
  | 'AUTHORITY_REVOKED' | 'UNSUPPORTED_PRECONDITION' | 'PRECONDITION_FAILED' | 'NO_BASELINE_EVIDENCE' | 'BASELINE_CHANGED'
  | 'MUTATION_REJECTED' | 'RETRIES_EXHAUSTED'
  | 'STATUS_UNAVAILABLE' | 'STATUS_UNVERIFIED' | 'AUTHORITY_UNVERIFIABLE' | 'OPERATIONAL_ERROR'
  // contract validation codes surfaced as terminal refusals (PACKAGE_REVOKED, PACKAGE_EXPIRED, SCOPE_MISMATCH, ...)
  | (string & {});
