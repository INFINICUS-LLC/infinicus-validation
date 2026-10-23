import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import {
  ATTENTION_TEXT, executionHealthPath, executionHealthSchema, formatDuration, outcomeHealthPath, outcomeHealthSchema, sortedCounts, statusText, utcDateTime,
  type ExecutionHealth, type OutcomeHealth,
} from '../lib/client/automationHealth';
import { AutomationView } from '../app/(client)/businesses/[businessId]/automation/automation-view';
import AutomationPage from '../app/(client)/businesses/[businessId]/automation/page';
import { AuthContext, type AuthContextValue } from '../app/(client)/auth-provider';

vi.mock('../app/(client)/use-scoped-resource', () => ({ useScopedResource: () => ({ resource: { kind: 'loading' }, reload: vi.fn() }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }), useParams: () => ({ businessId: '00000000-0000-4000-8000-000000000002' }) }));

const BUSINESS = '00000000-0000-4000-8000-000000000002';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const execution = (over: Record<string, unknown> = {}): ExecutionHealth => executionHealthSchema.parse({
  businessId: BUSINESS, status: 'OK', asOf: '2026-03-10T08:30:00.000Z', windowSeconds: 86400,
  claims: { open: 3, stranded: 1, retryDue: 1, inProgress: 1, truncated: false, oldestStrandedAgeSeconds: 7500, attention: [
    { claimId: id(1), state: 'STRANDED', actionType: { code: 'INVENTORY_REORDER_POLICY', schemaVersion: '1' }, claimedAt: '2026-03-10T05:00:00.000Z', attempts: 0, lastAttemptedAt: null, lastAttemptReasonCode: null, overdueSeconds: 3600, ageSeconds: 7500 },
    { claimId: id(2), state: 'RETRY_DUE', actionType: null, claimedAt: '2026-03-09T05:00:00.000Z', attempts: 2, lastAttemptedAt: '2026-03-10T07:00:00.000Z', lastAttemptReasonCode: 'PRECONDITION_FAILED', overdueSeconds: 90, ageSeconds: 100000 },
  ] },
  executions: { succeeded: 10, failed: 2, refused: 1, succeededInWindow: 4, failedInWindow: 1, refusedInWindow: 0, lastExecutionRecordedAt: '2026-03-10T08:00:00.000Z',
    reasons: [{ outcome: 'FAILED', reasonCode: 'TARGET_MISSING', total: 2, inWindow: 1, latestRecordedAt: '2026-03-10T07:30:00.000Z' }] },
  ...over,
});
const outcome = (over: Record<string, unknown> = {}): OutcomeHealth => outcomeHealthSchema.parse({
  businessId: BUSINESS, scope: 'OUTCOME_MONITORING', asOf: '2026-03-10T08:30:00.000Z', windowSeconds: 86400, status: 'ATTENTION', attention: ['DEAD_LETTERS_PENDING', 'DELIVERED_NOT_VERIFIED'],
  executionHealth: { included: false, see: 'Execution health is a separate read: execution-health.' },
  verification: { total: 5, executionVerified: 3, awaitingOutcome: 1, inconclusive: 1, byExecutionOutcome: { SUCCEEDED: 3, FAILED: 1 }, unsupportedStateRows: 0, verifiedOutcomes: { supported: false, rows: 0 }, lastVerifiedAt: '2026-03-10T06:00:00.000Z' },
  missingEvidence: { monitoredActionsWithoutVerification: 1, verificationsWithoutMonitoredAction: 0, announcedNotVerified: 2 },
  announcedExecutions: { total: 8, verified: 5, awaitingDelivery: 1, deadLettered: 1, deliveredNotVerified: 1, oldestAwaitingAgeSeconds: 600, truncated: false, pending: [
    { outboxEventId: id(10), executionId: 'exec-1', class: 'DEAD_LETTERED', attempts: 5, occurredAt: '2026-03-10T04:00:00.000Z', ageSeconds: 15000 },
  ] },
  failedVerificationAttempts: { total: 4, inWindow: 1, byCode: [{ failureCode: 'EVIDENCE_UNREADABLE', status: 'failed', total: 4, inWindow: 1, latestAt: '2026-03-10T07:00:00.000Z' }] },
  deadLetters: { pending: 1, replayed: 2, abandoned: 0, byCode: [{ code: 'DELIVERY_REFUSED', total: 3, pending: 1 }], truncated: false, items: [
    { id: id(20), originalEventId: id(21), executionId: null, code: 'DELIVERY_REFUSED', retryable: true, attempts: 5, firstFailedAt: '2026-03-10T03:00:00.000Z', lastFailedAt: '2026-03-10T04:00:00.000Z' },
  ] },
  observationRecords: { byStatus: { recorded: 6, withdrawn: 1 } },
  limitations: ['Verified business outcomes are not produced by this version.', 'Counts are as of the time shown.'],
  ...over,
});
const view = (e: Parameters<typeof AutomationView>[0]['execution'], o: Parameters<typeof AutomationView>[0]['outcome']) => renderToString(<AutomationView execution={e} outcome={o} />).replace(/<!-- -->/g, '');
const plain = (html: string): string => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

describe('paths', () => {
  it('read exactly this business and encode the id', () => {
    expect(executionHealthPath(BUSINESS)).toBe(`/v1/businesses/${BUSINESS}/execution-health`);
    expect(outcomeHealthPath(BUSINESS)).toBe(`/v1/businesses/${BUSINESS}/outcome-monitoring-health`);
    expect(executionHealthPath('a/b?x=1')).toBe('/v1/businesses/a%2Fb%3Fx%3D1/execution-health');
    expect(outcomeHealthPath('a/b?x=1')).toBe('/v1/businesses/a%2Fb%3Fx%3D1/outcome-monitoring-health');
  });
});

describe('formatDuration, utcDateTime, statusText, sortedCounts', () => {
  it.each([[0, '0 s'], [59, '59 s'], [60, '1 min'], [3599, '59 min'], [3600, '1 h'], [3660, '1 h 1 min'], [86399, '23 h 59 min'], [86400, '1 d'], [90000, '1 d 1 h'], [172800, '2 d']])('%d seconds is %s', (n, text) => { expect(formatDuration(n)).toBe(text); });
  it('refuses a negative or non-integer duration', () => {
    expect(formatDuration(-1)).toBeNull();
    expect(formatDuration(1.5)).toBeNull();
    expect(formatDuration(Number.NaN)).toBeNull();
  });
  it('shows a UTC time, and unavailable when unreadable', () => {
    expect(utcDateTime('2026-03-10T08:30:00.000Z')).toBe('2026-03-10 08:30 UTC');
    expect(utcDateTime('nope')).toBe('unavailable');
  });
  it('shows the server status in words and every attention reason in words', () => {
    expect(statusText('OK')).toBe('No attention needed');
    expect(statusText('ATTENTION')).toBe('Needs attention');
    for (const k of Object.keys(ATTENTION_TEXT)) expect(ATTENTION_TEXT[k as keyof typeof ATTENTION_TEXT].length).toBeGreaterThan(10);
  });
  it('orders count maps by key so the same data reads the same way', () => {
    expect(sortedCounts({ b: 2, a: 1, c: 3 })).toEqual([['a', 1], ['b', 2], ['c', 3]]);
  });
});

describe('response contracts', () => {
  it('reject a wrong status, a string count, a negative-looking shape and a missing section', () => {
    const e = JSON.parse(JSON.stringify(execution()));
    expect(() => executionHealthSchema.parse({ ...e, status: 'HEALTHY' })).toThrow();
    expect(() => executionHealthSchema.parse({ ...e, claims: { ...e.claims, open: '3' } })).toThrow();
    expect(() => executionHealthSchema.parse({ ...e, executions: undefined })).toThrow();
    const o = JSON.parse(JSON.stringify(outcome()));
    expect(() => outcomeHealthSchema.parse({ ...o, scope: 'EXECUTION' })).toThrow();
    expect(() => outcomeHealthSchema.parse({ ...o, attention: ['MADE_UP'] })).toThrow();
    expect(() => outcomeHealthSchema.parse({ ...o, verification: { ...o.verification, verifiedOutcomes: { supported: true, rows: 1 } } })).toThrow();
  });
});

describe('AutomationView', () => {
  it('names itself for administrators and says it changes nothing', () => {
    const out = view({ kind: 'loading' }, { kind: 'loading' });
    expect(out).toContain('This view is for administrators');
    expect(out).toContain('does not retry, replay, recover or change anything');
    expect(out).toContain('aria-busy="true"');
  });
  it('shows an error for each panel on its own, with the right role', () => {
    const out = view({ kind: 'error', message: 'You do not have permission to do this in this workspace.' }, { kind: 'ok', data: outcome() });
    expect(out).toMatch(/role="alert"[^>]*>You do not have permission/);
    expect(out).toContain('Outcome monitoring');
    expect(out).toContain('Verification');
  });
  it('shows the execution health exactly as the service reported it', () => {
    const out = plain(view({ kind: 'ok', data: execution() }, { kind: 'loading' }));
    expect(out).toContain('No attention needed');
    expect(out).toContain('As of 2026-03-10 08:30 UTC');
    expect(out).toContain('the last 1 d');
    expect(out).toContain('Oldest stranded 2 h 5 min');
    expect(out).toContain('Stranded (due and never attempted)');
    expect(out).toContain('Retry overdue');
    expect(out).toContain('INVENTORY_REORDER_POLICY (1)');
    expect(out).toContain('PRECONDITION_FAILED');
    expect(out).toContain('TARGET_MISSING');
    expect(out).toContain('Succeeded 10 (4 in window)');
    expect(out).toContain('never');                      // a claim never attempted
    expect(out).toContain('unknown');                    // an action type the service could not name
  });
  it('shows the server status as sent and never decides its own (ATTENTION with nothing listed stays ATTENTION)', () => {
    const out = plain(view({ kind: 'ok', data: execution({ status: 'ATTENTION', claims: { open: 0, stranded: 0, retryDue: 0, inProgress: 0, truncated: false, oldestStrandedAgeSeconds: null, attention: [] } }) }, { kind: 'loading' }));
    expect(out).toContain('Needs attention');
    expect(out).toContain('No claims need attention.');
    expect(out).toContain('Oldest stranded none');
  });
  it('shows the outcome monitoring health: reasons in words, counts, pending items and the contract limitations', () => {
    const out = plain(view({ kind: 'loading' }, { kind: 'ok', data: outcome() }));
    expect(out).toContain('Needs attention');
    expect(out).toContain('Notifications are waiting in the dead-letter list.');
    expect(out).toContain('Some delivered notifications have not been verified yet.');
    expect(out).toContain('Awaiting outcome 1');
    expect(out).toContain('Verified business outcomes are not supported yet (0 rows).');
    expect(out).toContain('By execution outcome: FAILED 1, SUCCEEDED 3.');
    expect(out).toContain('Dead-lettered');
    expect(out).toContain('EVIDENCE_UNREADABLE');
    expect(out).toContain('DELIVERY_REFUSED');
    expect(out).toContain('Observation records by status: recorded 6, withdrawn 1.');
    expect(out).toContain('Execution health is a separate read: execution-health.');
    expect(out).toContain('Verified business outcomes are not produced by this version.');
    expect(out).toContain('Counts are as of the time shown.');
  });
  it('warns when a list was cut short, and not otherwise', () => {
    const cut = view({ kind: 'ok', data: execution({ claims: { ...execution().claims, truncated: true } }) }, { kind: 'ok', data: outcome({ deadLetters: { ...outcome().deadLetters, truncated: true }, announcedExecutions: { ...outcome().announcedExecutions, truncated: true } }) });
    expect(cut).toContain('Only some claims are listed.');
    expect(cut).toContain('Only some dead letters are listed.');
    expect(cut).toContain('Only some announced executions are listed.');
    expect(view({ kind: 'ok', data: execution() }, { kind: 'ok', data: outcome() })).not.toContain('Only some');
  });
  it('shows a duration it cannot display as unavailable rather than a guess', () => {
    const bad = execution();
    (bad.claims.attention[0] as { overdueSeconds: number }).overdueSeconds = -5;
    expect(view({ kind: 'ok', data: bad }, { kind: 'loading' })).toContain('unavailable');
  });
  it('is read-only: no button, form, input or select exists, and nothing offers to retry, replay, recover or abandon', () => {
    const out = view({ kind: 'ok', data: execution() }, { kind: 'ok', data: outcome() });
    expect(out).not.toMatch(/<(button|form|input|select|textarea)\b/);
    expect(out).not.toMatch(/\b(Retry now|Replay|Recover now|Abandon|Resolve|Acknowledge|Delete)\b/);
  });
});

describe('AutomationPage', () => {
  const scope = { tenantId: id(3), workspaceId: id(4) };
  const value: AuthContextValue = { state: { status: 'ready', email: 'staff@example.test', scope, memberships: [] }, api: null, signIn: async () => ({ ok: true }), signOut: async () => undefined, selectWorkspace: () => true, retry: () => undefined };
  it('shows nothing before the business address is known (server render), and nothing at all when signed out', () => {
    const ready = renderToString(<AuthContext.Provider value={value}><AutomationPage /></AuthContext.Provider>);
    expect(ready).toContain('business address is not valid');
    const out = renderToString(<AuthContext.Provider value={{ ...value, state: { status: 'signed-out' } }}><AutomationPage /></AuthContext.Provider>);
    expect(out).not.toContain('Automation health');
  });
});
