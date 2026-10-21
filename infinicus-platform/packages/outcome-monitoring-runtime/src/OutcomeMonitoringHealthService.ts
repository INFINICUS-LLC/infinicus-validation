/**
 * Read-only operator view of the health of Outcome Monitoring for ONE business (OM-OBS-1; Guardrail Section XXII.L, read with Section XI).
 *
 * It answers "is Outcome Monitoring receiving, verifying and holding what it should - and what is still unproven?" from facts that already exist:
 * OM's own execution verifications, its monitored actions and observation records, and the platform's records of the execution notification OM
 * consumes (outbox, delivery attempts, dead letters). It never writes, never verifies, never replays, emits nothing, informs no learning and holds no
 * authority; it is NOT a second source of truth - every number is a grouped read of a stored fact.
 *
 * OUTCOME-MONITORING health is deliberately separate from EXECUTION health. Whether an authorized action was claimed, executed or refused is
 * Business Operations' view (L-OBS-1, `execution-health`) and is not repeated here. This view starts where that one ends: was the executed action announced
 * to OM, did OM verify it, and what does OM say about its outcome - which, without a governed measurement model, is only ever PENDING or INCONCLUSIVE.
 *
 * Nothing here is a state of its own. Outcome states are reported as stored; a state the vocabulary does not allow is surfaced as an anomaly, never
 * relabelled. PENDING and INCONCLUSIVE are the normal resting states of a verified execution, so they are reported, not alarmed on.
 */
import { OutcomeMonitoringHealthRepository } from '@infinicus/database';
import type { AnnouncedExecutionClass, OutcomeMonitoringHealthSnapshot, TenantContext } from '@infinicus/database';
import { ACTION_EXECUTED_CONSUMER, ACTION_EXECUTED_EVENT_TYPE } from '@infinicus/event-contracts';
import { EXECUTION_STATES, INITIAL_OUTCOME_STATES } from '@infinicus/handoff-contracts';

/** The existing operator authority (the same as execution health, recovery and activation); no permission was invented. */
export const OUTCOME_MONITORING_HEALTH_PERMISSION = 'bo:admin';
export const OUTCOME_MONITORING_HEALTH_WINDOW_SECONDS = 24 * 60 * 60;
export const OUTCOME_MONITORING_HEALTH_LIST_LIMIT = 25;

export class OutcomeMonitoringHealthError extends Error {
  constructor(readonly code: 'PERMISSION_INVALID', message: string) {
    super(message);
    this.name = 'OutcomeMonitoringHealthError';
  }
}

/** Why the view asks for attention. An empty list means OK. */
export type OutcomeMonitoringAttention =
  | 'DEAD_LETTERS_PENDING'
  | 'DELIVERED_NOT_VERIFIED'
  | 'VERIFICATION_ATTEMPT_FAILURES_IN_WINDOW'
  | 'UNSUPPORTED_STATE_ROWS';

/** What this view cannot tell you, stated so that absence is never read as health. */
export const OUTCOME_MONITORING_LIMITATIONS = [
  'NO_OUTCOME_MEASUREMENT_MODEL: no governed measurement model exists, so no execution can reach a verified outcome; PENDING and INCONCLUSIVE are the only outcomes OM can hold',
  'EXECUTIONS_NEVER_ANNOUNCED_ARE_NOT_VISIBLE: an execution is seen here only through the notification Business Operations emitted for it; Business Operations tables are not read',
  'NO_AGE_THRESHOLD_RULED: no ruling defines how long delivery may take, so age is reported but never alarmed on',
  'DEAD_LETTER_REPLAY_NOT_PROVIDED: dead-lettered notifications are listed, not replayed',
] as const;

export interface OutcomeMonitoringHealthView {
  businessId: string;
  scope: 'OUTCOME_MONITORING';
  asOf: string;
  windowSeconds: number;
  status: 'OK' | 'ATTENTION';
  attention: OutcomeMonitoringAttention[];
  /** Execution health is a different view, owned by Business Operations. */
  executionHealth: { included: false; see: string };
  verification: {
    total: number;
    executionVerified: number;
    /** OM verified the execution and has not established its effect. The normal resting state. */
    awaitingOutcome: number;
    /** OM verified the execution and there was no applied change to measure. */
    inconclusive: number;
    byExecutionOutcome: Record<string, number>;
    /** Rows whose stored execution or outcome state the vocabulary does not allow (the database refuses them; shown so that none is assumed away). */
    unsupportedStateRows: number;
    verifiedOutcomes: { supported: false; rows: number };
    lastVerifiedAt: string | null;
  };
  missingEvidence: {
    /** Open monitored actions with no execution verification linked to them yet. */
    monitoredActionsWithoutVerification: number;
    /** Verifications not linked to any monitored action. */
    verificationsWithoutMonitoredAction: number;
    /** Executions announced to OM that OM holds no verification for. */
    announcedNotVerified: number;
  };
  announcedExecutions: {
    total: number;
    verified: number;
    awaitingDelivery: number;
    deadLettered: number;
    deliveredNotVerified: number;
    oldestAwaitingAgeSeconds: number | null;
    truncated: boolean;
    pending: { outboxEventId: string; executionId: string | null; class: AnnouncedExecutionClass; attempts: number; occurredAt: string; ageSeconds: number }[];
  };
  failedVerificationAttempts: {
    total: number;
    inWindow: number;
    byCode: { failureCode: string; status: string; total: number; inWindow: number; latestAt: string }[];
  };
  deadLetters: {
    pending: number;
    replayed: number;
    abandoned: number;
    byCode: { code: string; total: number; pending: number }[];
    truncated: boolean;
    items: OutcomeMonitoringHealthSnapshot['deadLetters']['pending'];
  };
  /** Observation records are the human-recorded workflow; their status is not execution evidence and never a verified outcome. */
  observationRecords: { byStatus: Record<string, number> };
  limitations: string[];
}

const sum = (xs: Iterable<number>): number => { let t = 0; for (const x of xs) t += x; return t; };
const count = (m: Record<string, number>, key: string): number => m[key] ?? 0;

/** Pure: classifies a snapshot. Exported so the rule can be tested without a database. */
export function classifyOutcomeMonitoringHealth(businessId: string, s: OutcomeMonitoringHealthSnapshot, windowSeconds: number, listLimit: number): OutcomeMonitoringHealthView {
  const allowedExecution: readonly string[] = EXECUTION_STATES;
  const allowedOutcome: readonly string[] = INITIAL_OUTCOME_STATES;
  const [pendingState, inconclusiveState] = INITIAL_OUTCOME_STATES;
  const unsupportedStateRows = sum(Object.entries(s.verifications.byExecutionState).filter(([k]) => !allowedExecution.includes(k)).map(([, n]) => n))
    + sum(Object.entries(s.verifications.byOutcomeState).filter(([k]) => !allowedOutcome.includes(k)).map(([, n]) => n));
  const failuresTotal = sum(s.deliveryFailures.map((f) => f.total));
  const failuresInWindow = sum(s.deliveryFailures.map((f) => f.inWindow));
  const dlPending = count(s.deadLetters.byStatus, 'pending');
  const announcedNotVerified = s.announced.awaitingDelivery + s.announced.deadLettered + s.announced.deliveredNotVerified;

  const attention: OutcomeMonitoringAttention[] = [];
  if (dlPending > 0) attention.push('DEAD_LETTERS_PENDING');
  if (s.announced.deliveredNotVerified > 0) attention.push('DELIVERED_NOT_VERIFIED');
  if (failuresInWindow > 0) attention.push('VERIFICATION_ATTEMPT_FAILURES_IN_WINDOW');
  if (unsupportedStateRows > 0) attention.push('UNSUPPORTED_STATE_ROWS');

  return {
    businessId,
    scope: 'OUTCOME_MONITORING',
    asOf: s.databaseNow,
    windowSeconds,
    status: attention.length > 0 ? 'ATTENTION' : 'OK',
    attention,
    executionHealth: { included: false, see: `/v1/businesses/${businessId}/execution-health` },
    verification: {
      total: s.verifications.total,
      executionVerified: sum(Object.entries(s.verifications.byExecutionState).filter(([k]) => allowedExecution.includes(k)).map(([, n]) => n)),
      awaitingOutcome: count(s.verifications.byOutcomeState, pendingState),
      inconclusive: count(s.verifications.byOutcomeState, inconclusiveState),
      byExecutionOutcome: s.verifications.byExecutionOutcome,
      unsupportedStateRows,
      verifiedOutcomes: { supported: false, rows: s.verifications.verifiedOutcomeRows },
      lastVerifiedAt: s.verifications.lastVerifiedAt,
    },
    missingEvidence: {
      monitoredActionsWithoutVerification: s.monitoredActions.openWithoutVerification,
      verificationsWithoutMonitoredAction: s.verifications.unlinkedToMonitoredAction,
      announcedNotVerified,
    },
    announcedExecutions: {
      total: s.announced.total, verified: s.announced.verified, awaitingDelivery: s.announced.awaitingDelivery, deadLettered: s.announced.deadLettered,
      deliveredNotVerified: s.announced.deliveredNotVerified, oldestAwaitingAgeSeconds: s.announced.oldestAwaitingAgeSeconds,
      truncated: announcedNotVerified > s.announced.pending.length,
      pending: s.announced.pending.slice(0, listLimit).map((p) => ({ outboxEventId: p.outboxEventId, executionId: p.executionId, class: p.class, attempts: p.attempts, occurredAt: p.occurredAt, ageSeconds: p.ageSeconds })),
    },
    failedVerificationAttempts: { total: failuresTotal, inWindow: failuresInWindow, byCode: s.deliveryFailures },
    deadLetters: {
      pending: dlPending, replayed: count(s.deadLetters.byStatus, 'replayed'), abandoned: count(s.deadLetters.byStatus, 'abandoned'), byCode: s.deadLetters.byCode,
      truncated: dlPending > s.deadLetters.pending.length, items: s.deadLetters.pending.slice(0, listLimit),
    },
    observationRecords: { byStatus: s.observationsByStatus },
    limitations: [...OUTCOME_MONITORING_LIMITATIONS],
  };
}

export interface OutcomeMonitoringHealthDependencies {
  repository?: Pick<OutcomeMonitoringHealthRepository, 'healthSnapshot'>;
}

export class OutcomeMonitoringHealthService {
  private readonly repository: Pick<OutcomeMonitoringHealthRepository, 'healthSnapshot'>;

  constructor(deps: OutcomeMonitoringHealthDependencies = {}) {
    this.repository = deps.repository ?? new OutcomeMonitoringHealthRepository();
  }

  /** Read-only. `permissionCode` is checked as the sibling controls check theirs; the caller (route) enforces it first as well. */
  async getHealth(ctx: TenantContext, permissionCode: string, businessId: string): Promise<OutcomeMonitoringHealthView> {
    if (permissionCode !== OUTCOME_MONITORING_HEALTH_PERMISSION) throw new OutcomeMonitoringHealthError('PERMISSION_INVALID', `outcome monitoring health is governed by ${OUTCOME_MONITORING_HEALTH_PERMISSION}`);
    const snapshot = await this.repository.healthSnapshot(ctx, businessId, {
      announcedEventType: ACTION_EXECUTED_EVENT_TYPE, consumerName: ACTION_EXECUTED_CONSUMER,
      windowSeconds: OUTCOME_MONITORING_HEALTH_WINDOW_SECONDS, listLimit: OUTCOME_MONITORING_HEALTH_LIST_LIMIT,
    });
    return classifyOutcomeMonitoringHealth(businessId, snapshot, OUTCOME_MONITORING_HEALTH_WINDOW_SECONDS, OUTCOME_MONITORING_HEALTH_LIST_LIMIT);
  }
}
