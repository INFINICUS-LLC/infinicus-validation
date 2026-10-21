/**
 * Read-only operator view of the health of authorized-action execution for ONE business (L-OBS-1; Guardrail Section XXII.L).
 *
 * It answers "is anything stuck or failing?" from facts Business Operations already owns (claims, attempts, terminal executions). It never
 * writes, never drives a claim, never calls ABA and holds no authority: the recovery control (P0-6h) and the worker remain the only things that
 * act. "Due" is the engine's OWN rule (`runDue`: an unattempted claim is due EXECUTION_CLAIM_RECOVERY_MS after it was claimed; an attempted one
 * is due after the backoff for its attempt count), so this view and the recovery path can never disagree about what is stranded. The thresholds
 * are the named constants of the engine; none is invented here.
 *
 *   STRANDED     no attempt and no outcome, and already due: nothing picked the claim up (worker absent or failing).
 *   RETRY_DUE    attempted but not terminal, and the backoff has elapsed: the next attempt is overdue.
 *   IN_PROGRESS  not yet due (within the normal window or backoff): healthy, nothing to do.
 */
import { AuthorizedActionExecutionRepository } from '@infinicus/database';
import type { ExecutionHealthSnapshot, ExecutionOutcome, OpenClaimHealthRow, TenantContext } from '@infinicus/database';
import { EXECUTION_BACKOFF_MS, EXECUTION_CLAIM_RECOVERY_MS } from './constants.js';

export const EXECUTION_HEALTH_PERMISSION = 'bo:admin';
export const EXECUTION_HEALTH_WINDOW_SECONDS = 24 * 60 * 60;
export const EXECUTION_HEALTH_ATTENTION_LIMIT = 25;
const OPEN_CLAIM_READ_LIMIT = 200;

export class ExecutionHealthError extends Error {
  constructor(readonly code: 'PERMISSION_INVALID', message: string) {
    super(message);
    this.name = 'ExecutionHealthError';
  }
}

export type OpenClaimState = 'STRANDED' | 'RETRY_DUE' | 'IN_PROGRESS';
/** OK: nothing due and no terminal failure or refusal in the window. ATTENTION: otherwise. */
export type ExecutionHealthStatus = 'OK' | 'ATTENTION';

export interface ExecutionHealthPolicy {
  claimRecoveryMs: number;
  backoffMs: readonly number[];
}
export const DEFAULT_EXECUTION_HEALTH_POLICY: ExecutionHealthPolicy = Object.freeze({ claimRecoveryMs: EXECUTION_CLAIM_RECOVERY_MS, backoffMs: EXECUTION_BACKOFF_MS });

export interface ClassifiedOpenClaim {
  claimId: string;
  state: OpenClaimState;
  actionType: { code: string; schemaVersion: string } | null;
  claimedAt: string;
  attempts: number;
  lastAttemptedAt: string | null;
  lastAttemptReasonCode: string | null;
  /** Seconds past the instant the claim became due; 0 while IN_PROGRESS. */
  overdueSeconds: number;
  /** Seconds since the claim was made. */
  ageSeconds: number;
}

export interface ExecutionHealthView {
  businessId: string;
  status: ExecutionHealthStatus;
  asOf: string;
  windowSeconds: number;
  claims: {
    open: number;
    stranded: number;
    retryDue: number;
    inProgress: number;
    /** True when more open claims exist than were examined (counts for stranded/retryDue/inProgress then cover the examined, oldest ones). */
    truncated: boolean;
    oldestStrandedAgeSeconds: number | null;
    /** The oldest due claims, bounded. */
    attention: ClassifiedOpenClaim[];
  };
  executions: {
    succeeded: number;
    failed: number;
    refused: number;
    succeededInWindow: number;
    failedInWindow: number;
    refusedInWindow: number;
    lastExecutionRecordedAt: string | null;
    /** Failed and refused outcomes by reason code, most frequent in the window first. */
    reasons: { outcome: Exclude<ExecutionOutcome, 'SUCCEEDED'>; reasonCode: string; total: number; inWindow: number; latestRecordedAt: string }[];
  };
}

function dueAtMs(c: OpenClaimHealthRow, policy: ExecutionHealthPolicy): number {
  if (c.attempts === 0 || c.lastAttemptedAt === null) return Date.parse(c.claimedAt) + policy.claimRecoveryMs;
  const idx = Math.min(Math.max(c.attempts, 1), policy.backoffMs.length) - 1;
  return Date.parse(c.lastAttemptedAt) + policy.backoffMs[idx];
}

/** Pure: classifies a snapshot. Exported so the rule can be tested without a database. */
export function classifyExecutionHealth(businessId: string, snapshot: ExecutionHealthSnapshot, windowSeconds: number, policy: ExecutionHealthPolicy = DEFAULT_EXECUTION_HEALTH_POLICY): ExecutionHealthView {
  const now = Date.parse(snapshot.databaseNow);
  const classified: ClassifiedOpenClaim[] = snapshot.openClaims.map((c) => {
    const due = dueAtMs(c, policy);
    const isDue = due <= now;
    const state: OpenClaimState = !isDue ? 'IN_PROGRESS' : c.attempts === 0 ? 'STRANDED' : 'RETRY_DUE';
    return {
      claimId: c.claimId, state, actionType: c.actionType, claimedAt: c.claimedAt, attempts: c.attempts, lastAttemptedAt: c.lastAttemptedAt,
      lastAttemptReasonCode: c.lastAttemptReasonCode,
      overdueSeconds: isDue ? Math.floor((now - due) / 1000) : 0, ageSeconds: Math.max(0, Math.floor((now - Date.parse(c.claimedAt)) / 1000)),
    };
  });
  const stranded = classified.filter((c) => c.state === 'STRANDED');
  const retryDue = classified.filter((c) => c.state === 'RETRY_DUE');
  const sum = (outcome: ExecutionOutcome, key: 'total' | 'inWindow'): number => snapshot.terminal.filter((t) => t.outcome === outcome).reduce((a, t) => a + t[key], 0);
  const failedInWindow = sum('FAILED', 'inWindow');
  const refusedInWindow = sum('REFUSED', 'inWindow');
  const latest = snapshot.terminal.map((t) => t.latestRecordedAt).sort().at(-1) ?? null;
  const reasons = snapshot.terminal
    .filter((t): t is typeof t & { outcome: 'FAILED' | 'REFUSED' } => t.outcome !== 'SUCCEEDED')
    .map((t) => ({ outcome: t.outcome, reasonCode: t.reasonCode ?? 'UNSPECIFIED', total: t.total, inWindow: t.inWindow, latestRecordedAt: t.latestRecordedAt }))
    .sort((a, b) => b.inWindow - a.inWindow || b.total - a.total || a.reasonCode.localeCompare(b.reasonCode));
  return {
    businessId,
    status: stranded.length + retryDue.length + failedInWindow + refusedInWindow > 0 ? 'ATTENTION' : 'OK',
    asOf: snapshot.databaseNow,
    windowSeconds,
    claims: {
      open: snapshot.openClaimTotal, stranded: stranded.length, retryDue: retryDue.length, inProgress: classified.length - stranded.length - retryDue.length,
      truncated: snapshot.openClaimTotal > snapshot.openClaims.length,
      oldestStrandedAgeSeconds: stranded.length > 0 ? Math.max(...stranded.map((c) => c.ageSeconds)) : null,
      attention: classified.filter((c) => c.state !== 'IN_PROGRESS').sort((a, b) => b.overdueSeconds - a.overdueSeconds).slice(0, EXECUTION_HEALTH_ATTENTION_LIMIT),
    },
    executions: {
      succeeded: sum('SUCCEEDED', 'total'), failed: sum('FAILED', 'total'), refused: sum('REFUSED', 'total'),
      succeededInWindow: sum('SUCCEEDED', 'inWindow'), failedInWindow, refusedInWindow, lastExecutionRecordedAt: latest, reasons,
    },
  };
}

export interface ExecutionHealthDependencies {
  repository?: Pick<AuthorizedActionExecutionRepository, 'executionHealthSnapshot'>;
  policy?: ExecutionHealthPolicy;
}

export class ExecutionHealthService {
  private readonly repository: Pick<AuthorizedActionExecutionRepository, 'executionHealthSnapshot'>;
  private readonly policy: ExecutionHealthPolicy;

  constructor(deps: ExecutionHealthDependencies = {}) {
    this.repository = deps.repository ?? new AuthorizedActionExecutionRepository();
    this.policy = deps.policy ?? DEFAULT_EXECUTION_HEALTH_POLICY;
  }

  /** Read-only. `permissionCode` is checked as the recovery and activation controls check theirs; the caller (route) enforces it first as well. */
  async getHealth(ctx: TenantContext, permissionCode: string, businessId: string): Promise<ExecutionHealthView> {
    if (permissionCode !== EXECUTION_HEALTH_PERMISSION) throw new ExecutionHealthError('PERMISSION_INVALID', `execution health is governed by ${EXECUTION_HEALTH_PERMISSION}`);
    const snapshot = await this.repository.executionHealthSnapshot(ctx, businessId, { openLimit: OPEN_CLAIM_READ_LIMIT, windowSeconds: EXECUTION_HEALTH_WINDOW_SECONDS });
    return classifyExecutionHealth(businessId, snapshot, EXECUTION_HEALTH_WINDOW_SECONDS, this.policy);
  }
}
