/**
 * OM-OBS-1 - classification of the Outcome Monitoring health view (no database). The rule is pure: a snapshot of stored facts in, a view out.
 * Nothing is relabelled and no state is invented; PENDING and INCONCLUSIVE are resting states, not alarms.
 */
import { describe, expect, it } from 'vitest';
import type { OutcomeMonitoringHealthSnapshot } from '@infinicus/database';
import {
  classifyOutcomeMonitoringHealth, OutcomeMonitoringHealthError, OutcomeMonitoringHealthService, OUTCOME_MONITORING_HEALTH_PERMISSION, OUTCOME_MONITORING_LIMITATIONS,
} from '../src/OutcomeMonitoringHealthService.js';

const BIZ = '33333333-3333-4333-8333-333333333333';
const NOW = '2026-10-21T12:00:00.000Z';
const snap = (over: Partial<OutcomeMonitoringHealthSnapshot> = {}): OutcomeMonitoringHealthSnapshot => ({
  databaseNow: NOW,
  verifications: { total: 0, byExecutionState: {}, byOutcomeState: {}, byExecutionOutcome: {}, verifiedOutcomeRows: 0, unlinkedToMonitoredAction: 0, lastVerifiedAt: null },
  monitoredActions: { open: 0, openWithoutVerification: 0 },
  observationsByStatus: {},
  announced: { total: 0, verified: 0, awaitingDelivery: 0, deadLettered: 0, deliveredNotVerified: 0, oldestAwaitingAgeSeconds: null, pending: [] },
  deliveryFailures: [],
  deadLetters: { byStatus: {}, byCode: [], pending: [] },
  ...over,
});
const view = (s: OutcomeMonitoringHealthSnapshot) => classifyOutcomeMonitoringHealth(BIZ, s, 86400, 25);

describe('classification of the states OM actually holds', () => {
  it('an empty business is OK, scoped to Outcome Monitoring, and says execution health is a different view', () => {
    const v = view(snap());
    expect(v).toMatchObject({ businessId: BIZ, scope: 'OUTCOME_MONITORING', status: 'OK', attention: [], asOf: NOW });
    expect(v.executionHealth).toEqual({ included: false, see: `/v1/businesses/${BIZ}/execution-health` });
    expect(v.limitations).toEqual([...OUTCOME_MONITORING_LIMITATIONS]);
  });

  it('executions awaiting an outcome (PENDING) and inconclusive ones are reported separately and are NOT an alarm', () => {
    const v = view(snap({ verifications: {
      total: 5, byExecutionState: { EXECUTION_VERIFIED: 5 }, byOutcomeState: { OUTCOME_PENDING: 3, OUTCOME_INCONCLUSIVE: 2 }, byExecutionOutcome: { SUCCEEDED: 3, REFUSED: 2 },
      verifiedOutcomeRows: 0, unlinkedToMonitoredAction: 0, lastVerifiedAt: NOW,
    } }));
    expect(v.status).toBe('OK');
    expect(v.verification).toMatchObject({ total: 5, executionVerified: 5, awaitingOutcome: 3, inconclusive: 2, unsupportedStateRows: 0, byExecutionOutcome: { SUCCEEDED: 3, REFUSED: 2 } });
  });

  it('verified outcomes are never "supported": the view reports the stored rows and says no measurement model exists', () => {
    const v = view(snap());
    expect(v.verification.verifiedOutcomes).toEqual({ supported: false, rows: 0 });
    expect(v.limitations.some((l) => l.startsWith('NO_OUTCOME_MEASUREMENT_MODEL'))).toBe(true);
  });

  it('a state the vocabulary does not allow is surfaced as an anomaly (ATTENTION), never relabelled as pending or inconclusive', () => {
    const v = view(snap({ verifications: {
      total: 3, byExecutionState: { EXECUTION_VERIFIED: 2, EXECUTION_DONE: 1 }, byOutcomeState: { OUTCOME_PENDING: 1, OUTCOME_VERIFIED: 1, OUTCOME_EFFECTIVE: 1 }, byExecutionOutcome: {},
      verifiedOutcomeRows: 1, unlinkedToMonitoredAction: 0, lastVerifiedAt: NOW,
    } }));
    expect(v.status).toBe('ATTENTION');
    expect(v.attention).toContain('UNSUPPORTED_STATE_ROWS');
    expect(v.verification).toMatchObject({ unsupportedStateRows: 3, awaitingOutcome: 1, inconclusive: 0, verifiedOutcomes: { supported: false, rows: 1 } });
  });

  it('missing or incomplete evidence is counted, and announced-but-unverified executions are broken down by what became of them', () => {
    const v = view(snap({
      verifications: { total: 1, byExecutionState: { EXECUTION_VERIFIED: 1 }, byOutcomeState: { OUTCOME_PENDING: 1 }, byExecutionOutcome: {}, verifiedOutcomeRows: 0, unlinkedToMonitoredAction: 1, lastVerifiedAt: null },
      monitoredActions: { open: 4, openWithoutVerification: 3 },
      announced: { total: 6, verified: 1, awaitingDelivery: 2, deadLettered: 1, deliveredNotVerified: 2, oldestAwaitingAgeSeconds: 90, pending: [] },
    }));
    expect(v.missingEvidence).toEqual({ monitoredActionsWithoutVerification: 3, verificationsWithoutMonitoredAction: 1, announcedNotVerified: 5 });
    expect(v.announcedExecutions).toMatchObject({ total: 6, verified: 1, awaitingDelivery: 2, deadLettered: 1, deliveredNotVerified: 2, oldestAwaitingAgeSeconds: 90, truncated: true });
  });

  it('open monitored actions without a verification, and a slow delivery, are reported but are not alarms (no ruling defines "late")', () => {
    const v = view(snap({
      monitoredActions: { open: 2, openWithoutVerification: 2 },
      announced: { total: 1, verified: 0, awaitingDelivery: 1, deadLettered: 0, deliveredNotVerified: 0, oldestAwaitingAgeSeconds: 999999, pending: [] },
    }));
    expect(v.status).toBe('OK');
  });

  it('observation records are reported by their stored workflow status as records, not as verified outcomes', () => {
    const v = view(snap({ observationsByStatus: { draft: 2, recorded: 1, verified: 1 } }));
    expect(v.observationRecords.byStatus).toEqual({ draft: 2, recorded: 1, verified: 1 });
    expect(v.verification.verifiedOutcomes.rows).toBe(0);
    expect(v.status).toBe('OK');
  });
});

describe('what asks for attention', () => {
  it('a pending dead letter, a delivered-but-unverified execution, and a failed verification attempt in the window each do, and are named', () => {
    const v = view(snap({
      announced: { total: 2, verified: 0, awaitingDelivery: 0, deadLettered: 1, deliveredNotVerified: 1, oldestAwaitingAgeSeconds: null, pending: [] },
      deliveryFailures: [{ failureCode: 'EVIDENCE_INVALID', status: 'failed', total: 4, inWindow: 1, latestAt: NOW }],
      deadLetters: { byStatus: { pending: 1, replayed: 2, abandoned: 1 }, byCode: [{ code: 'EVIDENCE_INVALID', total: 4, pending: 1 }], pending: [] },
    }));
    expect(v.status).toBe('ATTENTION');
    expect(v.attention).toEqual(['DEAD_LETTERS_PENDING', 'DELIVERED_NOT_VERIFIED', 'VERIFICATION_ATTEMPT_FAILURES_IN_WINDOW']);
    expect(v.failedVerificationAttempts).toMatchObject({ total: 4, inWindow: 1 });
    expect(v.deadLetters).toMatchObject({ pending: 1, replayed: 2, abandoned: 1 });
  });

  it('failures older than the window and dead letters already replayed or abandoned are history, not attention', () => {
    const v = view(snap({
      deliveryFailures: [{ failureCode: 'EVIDENCE_UNAVAILABLE', status: 'failed', total: 7, inWindow: 0, latestAt: '2026-10-01T00:00:00.000Z' }],
      deadLetters: { byStatus: { replayed: 3, abandoned: 1 }, byCode: [], pending: [] },
    }));
    expect(v.status).toBe('OK');
    expect(v.failedVerificationAttempts).toMatchObject({ total: 7, inWindow: 0 });
  });

  it('lists are bounded and marked truncated', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ id: `d${i}`, originalEventId: null, executionId: null, code: 'X', retryable: false, attempts: 1, firstFailedAt: NOW, lastFailedAt: NOW }));
    const v = classifyOutcomeMonitoringHealth(BIZ, snap({ deadLetters: { byStatus: { pending: 40 }, byCode: [], pending: items } }), 86400, 25);
    expect(v.deadLetters.items).toHaveLength(25);
    expect(v.deadLetters.truncated).toBe(true);
  });
});

describe('the service is permission-checked and only reads', () => {
  const ctx = { tenantId: 't', workspaceId: 'w', userId: 'u' };
  it('refuses any permission other than bo:admin, before touching the repository', async () => {
    let calls = 0;
    const service = new OutcomeMonitoringHealthService({ repository: { async healthSnapshot() { calls += 1; return snap(); } } });
    await expect(service.getHealth(ctx, 'om:read', BIZ)).rejects.toBeInstanceOf(OutcomeMonitoringHealthError);
    expect(calls).toBe(0);
    expect(OUTCOME_MONITORING_HEALTH_PERMISSION).toBe('bo:admin');
  });

  it('asks the repository once, for the event OM consumes and the consumer OM is registered as, and returns the classified view', async () => {
    const seen: unknown[][] = [];
    const service = new OutcomeMonitoringHealthService({ repository: { async healthSnapshot(...a) { seen.push(a); return snap(); } } });
    const v = await service.getHealth(ctx, 'bo:admin', BIZ);
    expect(v.status).toBe('OK');
    expect(seen).toHaveLength(1);
    expect(seen[0][2]).toMatchObject({ announcedEventType: 'operations.action.executed', consumerName: 'om.execution_verification', windowSeconds: 86400, listLimit: 25 });
  });
});
