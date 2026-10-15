import { describe, it, expect } from 'vitest';
import { AuthController } from '../lib/client/authController';
import { fetchScoped } from '../lib/client/resource';
import { businessListSchema, decisionHistorySchema, workflowViewSchema } from '../lib/client/schemas';
import { FakeBackend, FakeProvider, MemoryStorage, membership, settle } from './helpers/fakes';

const BASE = 'https://api.example.test';
const BIZ = '33333333-3333-4333-8333-333333333333';
const id = () => crypto.randomUUID();

const business = { id: BIZ, legalName: 'Acme Ltd', businessCode: 'ACME', status: 'active', industry: 'retail' };
const workflow = {
  business: { ...business, tradingName: null, legalStructure: 'llc', businessModel: null },
  biEvidence: [{ id: id(), packageCode: 'insight-1', status: 'published', latestVersion: 2 }],
  dtLatestSnapshot: { snapshotCode: 'snap-1', status: 'published', effectiveAt: '2026-10-15T12:00:00.000Z' },
  simulationLatestResult: null,
  simulationRuns: [{ id: id(), runCode: 'run-1', status: 'queued', sampleSize: 500 }],
  adiLatestRecommendation: { recommendationCode: 'rec-1', status: 'published' },
  abaLatestDecision: null,
  outcomes: [],
};
const history = {
  biEvidence: [{ id: id(), packageCode: 'insight-1', status: 'published' }],
  simulationRuns: [], adiCases: [{ id: id(), caseCode: 'case-1', status: 'open' }], abaReviews: [], outcomes: [],
};

async function signedIn() {
  const backend = new FakeBackend();
  backend.users.set('user-a', { id: crypto.randomUUID(), email: 'user-a@example.test' });
  backend.setMemberships('user-a', [membership('Acme')]);
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

describe('lifecycle reads go through the API in the selected workspace', () => {
  it('the business list, workflow view and history are validated and every request carries the bearer token and the workspace claim', async () => {
    const { backend, controller, scope } = await signedIn();
    backend.businessList = { items: [business], page: 1, pageSize: 20, total: 1 };
    backend.workflowView = workflow; backend.historyView = history;
    const list = await fetchScoped(controller.api, '/v1/businesses?page=1&pageSize=20', businessListSchema, scope);
    const view = await fetchScoped(controller.api, `/v1/businesses/${BIZ}/workflow`, workflowViewSchema, scope);
    const hist = await fetchScoped(controller.api, `/v1/businesses/${BIZ}/history`, decisionHistorySchema, scope);
    expect(list).toMatchObject({ kind: 'ok', data: { total: 1, items: [{ legalName: 'Acme Ltd' }] } });
    expect(view).toMatchObject({ kind: 'ok', data: { business: { legalStructure: 'llc', tradingName: null }, dtLatestSnapshot: { snapshotCode: 'snap-1' } } });
    expect(hist).toMatchObject({ kind: 'ok', data: { adiCases: [{ caseCode: 'case-1' }] } });
    expect(backend.requests.map((r) => r.path)).toEqual(['/v1/businesses', `/v1/businesses/${BIZ}/workflow`, `/v1/businesses/${BIZ}/history`]);
    for (const r of backend.requests) {
      expect(r.method).toBe('GET');
      expect(r.headers.authorization).toMatch(/^Bearer raw-/);
      expect(r.headers['x-tenant-id']).toBe(scope.tenantId);
      expect(r.headers['x-workspace-id']).toBe(scope.workspaceId);
    }
  });

  it('a refused read becomes a sentence (permission / not found / service problem) with the reference, never the server text', async () => {
    const { backend, controller, scope } = await signedIn();
    for (const [status, fragment] of [[403, 'do not have permission'], [404, 'Not found in this workspace'], [500, 'problem']] as const) {
      backend.readStatus = status;
      const r = await fetchScoped(controller.api, `/v1/businesses/${BIZ}/workflow`, workflowViewSchema, scope);
      expect(r.kind).toBe('error');
      if (r.kind === 'error') { expect(r.message).toContain(fragment); expect(r.message).toContain('corr-read'); expect(r.message).not.toContain('internal detail'); }
    }
  });

  it('a response that does not match the documented shape is an error, not a half-rendered page', async () => {
    const { backend, controller, scope } = await signedIn();
    backend.workflowView = { ...workflow, biEvidence: 'nope' };
    const r = await fetchScoped(controller.api, `/v1/businesses/${BIZ}/workflow`, workflowViewSchema, scope);
    expect(r).toMatchObject({ kind: 'error', message: expect.stringContaining('unexpected format') });
    backend.historyView = { biEvidence: [] };
    expect((await fetchScoped(controller.api, `/v1/businesses/${BIZ}/history`, decisionHistorySchema, scope)).kind).toBe('error');
  });

  it('when the server has dropped the session the read heals once by re-exchanging and then succeeds', async () => {
    const { backend, controller, scope } = await signedIn();
    backend.businessList = { items: [business], page: 1, pageSize: 20, total: 1 };
    backend.sessions.clear();
    const r = await fetchScoped(controller.api, '/v1/businesses', businessListSchema, scope);
    expect(r.kind).toBe('ok');
    expect(backend.exchangeCount).toBe(2);
  });
});
