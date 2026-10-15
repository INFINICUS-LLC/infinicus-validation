import { describe, it, expect } from 'vitest';
import { ApiError, ApiUnavailableError, ApiContractError, SessionExpiredError } from '../lib/client/apiClient';
import { AuthController } from '../lib/client/authController';
import { describeRequestError, newDecisionAttempt, newOutcomeAttempt, submitDecision, submitOutcome } from '../lib/client/lifecycle';
import { FakeBackend, FakeProvider, MemoryStorage, membership, settle } from './helpers/fakes';

const BASE = 'https://api.example.test';
const BIZ = '33333333-3333-4333-8333-333333333333';
const INTAKE = '44444444-4444-4444-8444-444444444444';
const ACTION = '55555555-5555-4555-8555-555555555555';

async function signedIn() {
  const backend = new FakeBackend();
  backend.users.set('user-a', { id: crypto.randomUUID(), email: 'user-a@example.test' });
  const m = membership('Acme');
  backend.setMemberships('user-a', [m]);
  const provider = new FakeProvider(backend, { 'a@example.test': { password: 'pw', providerUserId: 'user-a' } });
  const controller = new AuthController({ apiBaseUrl: BASE, provider, storage: new MemoryStorage(), fetchImpl: backend.fetch, logoutTimeoutMs: 30 });
  await controller.start();
  await controller.signIn('a@example.test', 'pw');
  for (let i = 0; i < 100 && controller.getState().status !== 'ready'; i++) await settle(5);
  const state = controller.getState();
  if (state.status !== 'ready' || !state.scope) throw new Error('not ready');
  backend.requests.length = 0;
  return { backend, controller, scope: state.scope };
}

describe('lifecycle writes go through the API with no identity of their own', () => {
  it('a decision sends the bearer token, the workspace claim, an idempotency key and ONLY target + words in the body (no approver, no assignment, no tenant)', async () => {
    const { backend, controller, scope } = await signedIn();
    const attempt = newDecisionAttempt();
    const r = await submitDecision(controller.api, scope, BIZ, { intakePackageId: INTAKE, summary: ' approve it ', outcome: 'approve' }, attempt);
    expect(r.ok).toBe(true);
    const req = backend.requests[0];
    expect(req).toMatchObject({ method: 'POST', path: `/v1/businesses/${BIZ}/decisions` });
    expect(req.headers).toMatchObject({ 'idempotency-key': attempt.idempotencyKey, 'x-tenant-id': scope.tenantId, 'x-workspace-id': scope.workspaceId, 'content-type': 'application/json' });
    expect(req.headers.authorization).toMatch(/^Bearer raw-/);
    expect(req.body).toEqual({ intakePackageId: INTAKE, reviewCode: attempt.reviewCode, summary: 'approve it', decisionCode: attempt.decisionCode, outcome: 'approve' });
    expect(Object.keys(req.body as object)).not.toEqual(expect.arrayContaining(['approverUserId']));
    expect(JSON.stringify(req.body)).not.toMatch(/assignmentCode|tenantId|workspaceId|userId/);
  });

  it('an outcome sends the target, the summary, a fixed effective time and an idempotency key', async () => {
    const { backend, controller, scope } = await signedIn();
    const attempt = newOutcomeAttempt(() => new Date('2026-10-15T12:00:00.000Z'));
    const r = await submitOutcome(controller.api, scope, BIZ, { monitoredActionId: ACTION, summary: 'sold 12 units' }, attempt);
    expect(r.ok).toBe(true);
    expect(backend.requests[0].body).toEqual({ monitoredActionId: ACTION, observationCode: attempt.observationCode, summary: 'sold 12 units', effectiveAt: '2026-10-15T12:00:00.000Z' });
    expect(backend.requests[0].headers['idempotency-key']).toBe(attempt.idempotencyKey);
  });

  it('input is validated before anything is sent: bad ids and empty summaries produce field errors and no request', async () => {
    const { backend, controller, scope } = await signedIn();
    const d = await submitDecision(controller.api, scope, BIZ, { intakePackageId: 'not-a-uuid', summary: '   ', outcome: 'approve' }, newDecisionAttempt());
    expect(d).toMatchObject({ ok: false, fieldErrors: { intakePackageId: expect.any(String), summary: expect.any(String) } });
    const wrongOutcome = await submitDecision(controller.api, scope, BIZ, { intakePackageId: INTAKE, summary: 's', outcome: 'maybe' }, newDecisionAttempt());
    expect(wrongOutcome.ok).toBe(false);
    const o = await submitOutcome(controller.api, scope, BIZ, { monitoredActionId: '1', summary: '' }, newOutcomeAttempt());
    expect(o).toMatchObject({ ok: false, fieldErrors: { monitoredActionId: expect.any(String), summary: expect.any(String) } });
    expect(backend.requests).toHaveLength(0);
  });

  it('retrying the SAME attempt is a replay (same record, one decision stored); a NEW attempt is a new submission', async () => {
    const { backend, controller, scope } = await signedIn();
    const attempt = newDecisionAttempt();
    const input = { intakePackageId: INTAKE, summary: 's', outcome: 'reject' };
    const a = await submitDecision(controller.api, scope, BIZ, input, attempt);
    const b = await submitDecision(controller.api, scope, BIZ, input, attempt);
    expect(a.ok && b.ok && a.value.id === b.value.id).toBe(true);
    expect(backend.requests.map((r) => r.headers['idempotency-key'])).toEqual([attempt.idempotencyKey, attempt.idempotencyKey]);
    expect(backend.requests[0].body).toEqual(backend.requests[1].body);
    const c = await submitDecision(controller.api, scope, BIZ, input, newDecisionAttempt());
    expect(c.ok && a.ok && c.value.id !== a.value.id).toBe(true);
  });

  it('attempts are unique per call', () => {
    const a = newDecisionAttempt(); const b = newDecisionAttempt();
    expect(new Set([a.idempotencyKey, a.reviewCode, a.decisionCode, b.idempotencyKey, b.reviewCode, b.decisionCode]).size).toBe(6);
    expect(newOutcomeAttempt().observationCode).not.toBe(newOutcomeAttempt().observationCode);
  });

  it('the business id in the path is URL-encoded as a single segment', async () => {
    const { backend, controller, scope } = await signedIn();
    await submitDecision(controller.api, scope, 'x/../../auth/logout', { intakePackageId: INTAKE, summary: 's', outcome: 'approve' }, newDecisionAttempt()).catch(() => undefined);
    expect(backend.requests[0].path).toBe('/v1/businesses/x%2F..%2F..%2Fauth%2Flogout/decisions');
  });

  it('a refused write is an ApiError the UI turns into a sentence with a reference, never the server text', async () => {
    const { backend, controller, scope } = await signedIn();
    backend.writeStatus = 403;
    const error = await submitDecision(controller.api, scope, BIZ, { intakePackageId: INTAKE, summary: 's', outcome: 'approve' }, newDecisionAttempt()).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    const text = describeRequestError(error);
    expect(text).toContain('do not have permission');
    expect(text).toContain('corr-write');
    expect(text).not.toContain('internal detail');
  });
});

describe('describeRequestError', () => {
  const api = (status: number) => new ApiError(status, 'X', 'server text', 'ref-1');
  it.each([[403, 'permission'], [404, 'Not found'], [409, 'conflicts'], [400, 'not accepted'], [422, 'not accepted'], [429, 'Too many'], [500, 'problem'], [503, 'problem']])('maps %i', (status, fragment) => {
    const text = describeRequestError(api(status));
    expect(text).toContain(fragment);
    expect(text).toContain('ref-1');
    expect(text).not.toContain('server text');
  });
  it('handles the non-HTTP failures and unknown errors', () => {
    expect(describeRequestError(new SessionExpiredError())).toMatch(/sign in again/);
    expect(describeRequestError(new ApiUnavailableError())).toMatch(/could not be reached/);
    expect(describeRequestError(new ApiContractError())).toMatch(/unexpected format/);
    expect(describeRequestError(new Error('secret stack detail'))).toBe('Something went wrong. Please try again.');
    expect(describeRequestError('weird')).toBe('Something went wrong. Please try again.');
  });
});
