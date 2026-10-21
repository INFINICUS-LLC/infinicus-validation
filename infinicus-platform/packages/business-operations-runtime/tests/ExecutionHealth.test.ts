/**
 * L-OBS-1 - the execution-health classification (pure, no database) and the service guard.
 * The due rule is the engine's own (`runDue`): 60 s after the claim when unattempted, else the backoff for the attempt count after the last attempt.
 */
import { describe, it, expect } from 'vitest';
import type { ExecutionHealthSnapshot, OpenClaimHealthRow } from '@infinicus/database';
import { classifyExecutionHealth, ExecutionHealthService, ExecutionHealthError, EXECUTION_HEALTH_ATTENTION_LIMIT, DEFAULT_EXECUTION_HEALTH_POLICY } from '../src/index.js';

const BIZ = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const ACTION = { code: 'inventory_reorder_policy_update', schemaVersion: '1' };
let n = 0;
const claim = (over: Partial<OpenClaimHealthRow> = {}): OpenClaimHealthRow => ({
  claimId: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, claimedAt: ago(1000), attempts: 0, lastAttemptedAt: null, lastAttemptReasonCode: null, actionType: ACTION, ...over,
});
const snap = (over: Partial<ExecutionHealthSnapshot> = {}): ExecutionHealthSnapshot => ({ databaseNow: ago(0), openClaimTotal: 0, openClaims: [], terminal: [], ...over });
const view = (s: ExecutionHealthSnapshot) => classifyExecutionHealth(BIZ, s, 86_400);

describe('classifyExecutionHealth - the engine\'s due rule', () => {
  it('no claims and no executions is OK with zero counts', () => {
    const v = view(snap());
    expect(v).toMatchObject({ businessId: BIZ, status: 'OK', claims: { open: 0, stranded: 0, retryDue: 0, inProgress: 0, truncated: false, oldestStrandedAgeSeconds: null, attention: [] } });
    expect(v.executions).toMatchObject({ succeeded: 0, failed: 0, refused: 0, lastExecutionRecordedAt: null, reasons: [] });
  });

  it('an unattempted claim younger than 60 s is IN_PROGRESS; at exactly 60 s it is STRANDED (the boundary the worker uses)', () => {
    const young = claim({ claimedAt: ago(59_999) });
    const edge = claim({ claimedAt: ago(60_000) });
    const v = view(snap({ openClaimTotal: 2, openClaims: [young, edge] }));
    expect(v.claims).toMatchObject({ open: 2, stranded: 1, inProgress: 1, retryDue: 0 });
    expect(v.claims.attention.map((c) => c.claimId)).toEqual([edge.claimId]);
    expect(v.claims.attention[0]).toMatchObject({ state: 'STRANDED', overdueSeconds: 0, ageSeconds: 60 });
    expect(v.status).toBe('ATTENTION');
  });

  it('an attempted claim is RETRY_DUE only after the backoff for its attempt count (1 s, 5 s, 15 s; capped at the last)', () => {
    const waiting1 = claim({ attempts: 1, lastAttemptedAt: ago(999), claimedAt: ago(200_000) });
    const due1 = claim({ attempts: 1, lastAttemptedAt: ago(1000), claimedAt: ago(200_000) });
    const waiting2 = claim({ attempts: 2, lastAttemptedAt: ago(4999), claimedAt: ago(200_000) });
    const due2 = claim({ attempts: 2, lastAttemptedAt: ago(5000), claimedAt: ago(200_000) });
    const due9 = claim({ attempts: 9, lastAttemptedAt: ago(15_000), claimedAt: ago(200_000) });
    const v = view(snap({ openClaimTotal: 5, openClaims: [waiting1, due1, waiting2, due2, due9] }));
    expect(v.claims).toMatchObject({ stranded: 0, retryDue: 3, inProgress: 2 });
    expect(new Set(v.claims.attention.map((c) => c.claimId))).toEqual(new Set([due1.claimId, due2.claimId, due9.claimId]));
    expect(v.claims.attention.every((c) => c.state === 'RETRY_DUE')).toBe(true);
  });

  it('an attempted claim is never reported STRANDED, even when it is old (it was picked up)', () => {
    const v = view(snap({ openClaimTotal: 1, openClaims: [claim({ claimedAt: ago(9_999_999), attempts: 1, lastAttemptedAt: ago(500) })] }));
    expect(v.claims).toMatchObject({ stranded: 0, retryDue: 0, inProgress: 1 });
    expect(v.status).toBe('OK');
  });

  it('oldestStrandedAgeSeconds is the age of the oldest STRANDED claim; attention is ordered most overdue first and bounded', () => {
    const many = Array.from({ length: EXECUTION_HEALTH_ATTENTION_LIMIT + 5 }, (_, i) => claim({ claimedAt: ago(61_000 + i * 1000) }));
    const v = view(snap({ openClaimTotal: many.length, openClaims: many }));
    expect(v.claims.stranded).toBe(many.length);
    expect(v.claims.attention).toHaveLength(EXECUTION_HEALTH_ATTENTION_LIMIT);
    const overdue = v.claims.attention.map((c) => c.overdueSeconds);
    expect([...overdue].sort((a, b) => b - a)).toEqual(overdue);
    expect(v.claims.oldestStrandedAgeSeconds).toBe(61 + EXECUTION_HEALTH_ATTENTION_LIMIT + 4);
  });

  it('truncated is true when more open claims exist than were examined', () => {
    expect(view(snap({ openClaimTotal: 500, openClaims: [claim()] })).claims.truncated).toBe(true);
    expect(view(snap({ openClaimTotal: 1, openClaims: [claim()] })).claims.truncated).toBe(false);
  });

  it('terminal rows: totals, window counts, reasons ordered by window frequency; a window failure or refusal is ATTENTION, old ones alone are OK', () => {
    const terminal = [
      { outcome: 'SUCCEEDED' as const, reasonCode: null, total: 7, inWindow: 2, latestRecordedAt: ago(10_000) },
      { outcome: 'FAILED' as const, reasonCode: 'MUTATION_REJECTED', total: 3, inWindow: 0, latestRecordedAt: ago(90_000_000) },
      { outcome: 'REFUSED' as const, reasonCode: 'AUTHORITY_REVOKED', total: 4, inWindow: 2, latestRecordedAt: ago(5000) },
      { outcome: 'REFUSED' as const, reasonCode: 'BASELINE_CHANGED', total: 1, inWindow: 1, latestRecordedAt: ago(7000) },
    ];
    const v = view(snap({ terminal }));
    expect(v.executions).toMatchObject({ succeeded: 7, failed: 3, refused: 5, succeededInWindow: 2, failedInWindow: 0, refusedInWindow: 3 });
    expect(v.executions.lastExecutionRecordedAt).toBe(ago(5000));
    expect(v.executions.reasons.map((r) => r.reasonCode)).toEqual(['AUTHORITY_REVOKED', 'BASELINE_CHANGED', 'MUTATION_REJECTED']);
    expect(v.status).toBe('ATTENTION');
    expect(view(snap({ terminal: [terminal[0], terminal[1]] })).status).toBe('OK');
  });

  it('a custom policy changes the thresholds (the constants stay the default)', () => {
    const c = claim({ claimedAt: ago(5000) });
    expect(classifyExecutionHealth(BIZ, snap({ openClaimTotal: 1, openClaims: [c] }), 1, { claimRecoveryMs: 0, backoffMs: [0] }).claims.stranded).toBe(1);
    expect(classifyExecutionHealth(BIZ, snap({ openClaimTotal: 1, openClaims: [c] }), 1, DEFAULT_EXECUTION_HEALTH_POLICY).claims.stranded).toBe(0);
  });
});

describe('ExecutionHealthService', () => {
  const ctx = { tenantId: 't', workspaceId: 'w', userId: 'u' };
  it('refuses any permission other than bo:admin and reads nothing', async () => {
    let reads = 0;
    const svc = new ExecutionHealthService({ repository: { executionHealthSnapshot: async () => { reads++; return snap(); } } });
    await expect(svc.getHealth(ctx, 'bo:read', BIZ)).rejects.toBeInstanceOf(ExecutionHealthError);
    expect(reads).toBe(0);
    expect((await svc.getHealth(ctx, 'bo:admin', BIZ)).status).toBe('OK');
    expect(reads).toBe(1);
  });
});
