/**
 * P0-6c - live PostgreSQL proof of the BO authorized-action execution engine (migrations 0191, 0192).
 * Requires DATABASE_URL (app role, RLS) and ADMIN_DATABASE_URL (fixtures / inspection / simulated outside changes).
 * Providers are scripted here; the real ABA provider is joined to the engine in the event-worker end-to-end tests.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- tests read arbitrary rows */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { AuthorizedActionExecutionRepository, closePool, createPool } from '@infinicus/database';
import type { TenantContext } from '@infinicus/database';
import type { AuthorizedActionPackageV1 } from '@infinicus/handoff-contracts';
import { AuthorizedActionExecutionService, ClaimNotFoundError, evidenceDigestOf, explicitCapabilities, type ExecutionResult } from '../src/index.js';
import { iso, MIN, answerFor } from './helpers/intakeFixture.js';
import { ScriptedProvider, SUPPORTED, buildPackage, claimPackage, consumedAnswer, makeExecWorld, type ExecWorld, type PackageSpec } from './helpers/executionWorld.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';

const run = Boolean(process.env.DATABASE_URL && process.env.ADMIN_DATABASE_URL);
const S = 'business_operations';
const MAX_AGE = 5000;
const OPEN = { isEnabled: async () => true };

describe.runIf(run)('P0-6c: BO authorized-action execution engine', () => {
  let admin: Pool;
  const tenantIds: string[] = [];
  const repo = new AuthorizedActionExecutionRepository();

  beforeAll(() => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    createPool({ connectionString: process.env.DATABASE_URL as string });
  });
  afterAll(async () => { await deleteMovementsForTenants(admin, tenantIds).catch(() => undefined); await admin?.end(); await closePool(); });

  const engine = (provider: ScriptedProvider, over: Record<string, unknown> = {}) => new AuthorizedActionExecutionService({
    statusProvider: provider, executionStatusMaxAgeMs: MAX_AGE, gate: OPEN, capabilities: SUPPORTED, ...over,
  });
  const ctxOf = (ew: ExecWorld): TenantContext => ({ tenantId: ew.w.tenantId, workspaceId: ew.w.workspaceId, userId: randomUUID() });

  interface Case { ew: ExecWorld; pkg: AuthorizedActionPackageV1; claimId: string; receiptId: string; provider: ScriptedProvider; ctx: TenantContext }
  /** A claimed, executable MODIFIED approval (baseline 100/200 -> final 150/250) by default. */
  async function claimed(spec: Partial<PackageSpec> = {}, world: Parameters<typeof makeExecWorld>[2] = {}): Promise<Case> {
    const ew = await makeExecWorld(admin, tenantIds, world);
    const pkg = await buildPackage(ew, { reorderPoint: 150, reorderQuantity: 250, modified: { baseline: world.baseline ?? [100, 200] }, ...spec });
    const { claimId, receiptId } = await claimPackage(ew, pkg);
    const provider = new ScriptedProvider(() => consumedAnswer(pkg, receiptId));
    return { ew, pkg, claimId, receiptId, provider, ctx: ctxOf(ew) };
  }
  const balance = async (c: Case) => (await admin.query(`SELECT reorder_point::float AS rp, reorder_quantity::float AS rq, version, reorder_policy_state AS state, reorder_policy_configured_source AS source FROM ${S}.inventory_balances WHERE id=$1`, [c.ew.balanceId])).rows[0];
  const execRows = async (c: Case) => (await admin.query(`SELECT * FROM ${S}.authorized_action_executions WHERE claim_id=$1`, [c.claimId])).rows;
  const attemptRows = async (c: Case) => (await admin.query(`SELECT * FROM ${S}.authorized_action_execution_attempts WHERE claim_id=$1 ORDER BY attempt_number`, [c.claimId])).rows;
  const terminal = (r: ExecutionResult) => { if (r.state !== 'TERMINAL') throw new Error(`expected a terminal result, got ${JSON.stringify(r)}`); return r.execution; };

  describe('success', () => {
    it('applies the authorized values under lock, records CONFIGURED (source AUTHORIZED_ACTION_PACKAGE), the before/requested/after state and a sealed evidence document', async () => {
      const c = await claimed();
      const before = await balance(c);
      const e = terminal(await engine(c.provider).executeClaim(c.ctx, c.claimId));
      expect(e).toMatchObject({ outcome: 'SUCCEEDED', mutationResult: 'APPLIED', reasonCode: null, authorityVerdict: 'CURRENT', attemptCount: 1, packageId: c.pkg.identity.packageId, digest: c.pkg.integrity.digest });
      expect(e.beforeState).toEqual({ reorderPoint: '100', reorderQuantity: '200' });
      expect(e.requestedState).toEqual({ reorderPoint: '150', reorderQuantity: '250' });
      expect(e.afterState).toEqual({ reorderPoint: '150', reorderQuantity: '250' });
      const after = await balance(c);
      expect(after).toMatchObject({ rp: 150, rq: 250, state: 'CONFIGURED', source: 'AUTHORIZED_ACTION_PACKAGE', version: before.version + 1 });
      expect(e.balanceId).toBe(c.ew.balanceId);
      // times: DB clock, ordered, judged after the claim
      expect(Date.parse(e.executionStartedAt)).toBeGreaterThanOrEqual(Date.parse(e.claimedAt));
      expect(Date.parse(e.executionCompletedAt)).toBeGreaterThanOrEqual(Date.parse(e.executionStartedAt));
      expect(e.statusVerifiedAt).not.toBeNull();
      // evidence: sealed, tamper-evident, names the facts, carries no body beyond the one balance's values
      expect(evidenceDigestOf(e.evidence)).toBe(e.evidenceDigest);
      expect(e.evidence).toMatchObject({
        contractVersion: 'execution-evidence/1',
        identity: { claimId: c.claimId, receiptId: c.receiptId, packageId: c.pkg.identity.packageId, target: { kind: 'inventory_item', id: c.ew.itemId } },
        authority: { verdict: 'CURRENT', provider: 'aba.package-status-provider' }, mutation: { result: 'APPLIED', baselineSource: 'BO_EVALUATION_EVIDENCE', balanceVersionBefore: before.version, balanceVersionAfter: before.version + 1 },
        outcome: { outcome: 'SUCCEEDED', reasonCode: null }, lineage: { executor: { type: 'system', id: 'bo.authorized-action-execution' } },
      });
      expect((e.evidence as any).lineage.authorization.evaluationRefs).toHaveLength(4);
      expect(await attemptRows(c)).toHaveLength(0);
      const audit = (await admin.query(`SELECT metadata FROM audit.audit_events WHERE tenant_id=$1 AND action='bo.authorized_action.executed'`, [c.ew.w.tenantId])).rows;
      expect(audit).toHaveLength(1);
      expect(audit[0].metadata).toMatchObject({ executionId: e.id, outcome: 'SUCCEEDED', evidenceDigest: e.evidenceDigest });
    });

    it('is idempotent: a second call (and 8 concurrent calls) return the stored outcome and change nothing more', async () => {
      const c = await claimed();
      const svc = engine(c.provider);
      const first = terminal(await svc.executeClaim(c.ctx, c.claimId));
      const v1 = (await balance(c)).version;
      const asked = c.provider.calls;
      const again = await svc.executeClaim(c.ctx, c.claimId);
      expect(again).toMatchObject({ state: 'TERMINAL', replayed: true });
      expect(c.provider.calls).toBe(asked); // a replay asks nothing and locks nothing new
      expect(terminal(again).id).toBe(first.id);
      expect((await balance(c)).version).toBe(v1);

      const fresh = await claimed();
      const results = await Promise.all(Array.from({ length: 8 }, () => engine(fresh.provider).executeClaim(fresh.ctx, fresh.claimId)));
      expect(results.filter((r) => r.state === 'TERMINAL' && !r.replayed)).toHaveLength(1);
      expect(new Set(results.map((r) => terminal(r).id)).size).toBe(1);
      expect(await execRows(fresh)).toHaveLength(1);
      expect((await balance(fresh)).version).toBe(2);
      expect(fresh.provider.calls).toBe(1); // serialized by the per-claim lock: the losers saw the stored outcome and asked ABA nothing
    });

    it('a no-op (the balance already holds the requested values) is SUCCEEDED/NO_CHANGE: claim consumed, no UPDATE, no version bump, state untouched (O-12)', async () => {
      const c = await claimed({ reorderPoint: 100, reorderQuantity: 200 });
      const before = await balance(c);
      const e = terminal(await engine(c.provider).executeClaim(c.ctx, c.claimId));
      expect(e).toMatchObject({ outcome: 'SUCCEEDED', mutationResult: 'NO_CHANGE', afterState: null });
      expect(await balance(c)).toEqual(before);
      expect(before.state).toBe('UNSET');
    });

    it('accepts ISSUED while the ABA mirror lags, but only because BO itself holds the claim', async () => {
      const c = await claimed();
      c.provider.set(() => answerFor(c.pkg));
      expect(terminal(await engine(c.provider).executeClaim(c.ctx, c.claimId)).outcome).toBe('SUCCEEDED');
    });
  });

  describe('fresh authority is required, and it is requested only after the locks are held', () => {
    it('does not call the status provider until the target balance lock is acquired', async () => {
      const c = await claimed();
      const holder = await admin.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT id FROM ${S}.inventory_balances WHERE id=$1 FOR UPDATE`, [c.ew.balanceId]);
        const pending = engine(c.provider).executeClaim(c.ctx, c.claimId);
        await new Promise((r) => setTimeout(r, 700));
        expect(c.provider.calls).toBe(0); // blocked on the row lock: nothing was asked yet, so the answer cannot age in the queue
        await holder.query('COMMIT');
        expect(terminal(await pending).outcome).toBe('SUCCEEDED');
        expect(c.provider.calls).toBe(1);
      } finally { holder.release(); }
    });

    it('REVOKED authority is a terminal REFUSED(AUTHORITY_REVOKED): nothing mutated, the claim is spent', async () => {
      const c = await claimed();
      c.provider.set(() => consumedAnswer(c.pkg, c.receiptId, { authority: { state: 'REVOKED' } }));
      const before = await balance(c);
      const e = terminal(await engine(c.provider).executeClaim(c.ctx, c.claimId));
      expect(e).toMatchObject({ outcome: 'REFUSED', reasonCode: 'AUTHORITY_REVOKED', mutationResult: 'NOT_APPLIED', authorityVerdict: 'REVOKED', afterState: null });
      expect(await balance(c)).toEqual(before);
      // never re-driven: a later call returns the same refusal even if ABA would now say CURRENT
      c.provider.set(() => consumedAnswer(c.pkg, c.receiptId));
      expect(terminal(await engine(c.provider).executeClaim(c.ctx, c.claimId))).toMatchObject({ id: e.id, outcome: 'REFUSED' });
    });

    it.each([
      ['a package revoked after the claim', { status: { lifecycle: 'REVOKED' as const, consumptionReceiptId: null } }, 'PACKAGE_REVOKED'],
      ['a superseded package', { status: { lifecycle: 'SUPERSEDED' as const, consumptionReceiptId: null } }, 'PACKAGE_SUPERSEDED'],
      ['an expired package', { status: { lifecycle: 'EXPIRED' as const, consumptionReceiptId: null } }, 'PACKAGE_EXPIRED'],
      ['CONSUMED by a different receipt', { status: { lifecycle: 'CONSUMED' as const, consumptionReceiptId: randomUUID() } }, 'PACKAGE_ALREADY_CONSUMED'],
      ['CONSUMED with no receipt', { status: { lifecycle: 'CONSUMED' as const, consumptionReceiptId: null } }, 'PACKAGE_ALREADY_CONSUMED'],
      ['a newer package version existing', { status: { lifecycle: 'ISSUED' as const, consumptionReceiptId: null, latestPackageVersion: 2 } }, 'PACKAGE_NOT_CURRENT_VERSION'],
    ])('%s is a terminal refusal (%s)', async (_name, over, code) => {
      const c = await claimed();
      c.provider.set(() => answerFor(c.pkg, { status: { ...over.status } as any }));
      const e = terminal(await engine(c.provider).executeClaim(c.ctx, c.claimId));
      expect([e.outcome, e.reasonCode, e.mutationResult]).toEqual(['REFUSED', code, 'NOT_APPLIED']);
      expect((await balance(c)).version).toBe(1);
    });

    it('transient conditions (no answer, rejected promise, stale answer, future answer, wrong digest, unverifiable authority) are retried, not refused', async () => {
      const cases: [string, (c: Case) => any, string][] = [
        ['null answer', () => null, 'STATUS_UNAVAILABLE'],
        ['stale answer', (c) => consumedAnswer(c.pkg, c.receiptId, { status: { verifiedAt: iso(Date.now() - MAX_AGE - 3000) }, authority: { verifiedAt: iso(Date.now() - MAX_AGE - 3000) } }), 'STATUS_UNVERIFIED'],
        ['future answer', (c) => consumedAnswer(c.pkg, c.receiptId, { status: { verifiedAt: iso(Date.now() + 60_000) } }), 'STATUS_UNVERIFIED'],
        ['wrong digest', (c) => consumedAnswer(c.pkg, c.receiptId, { status: { digest: `sha256:${'0'.repeat(64)}` } }), 'STATUS_UNVERIFIED'],
        ['unverifiable authority', (c) => consumedAnswer(c.pkg, c.receiptId, { authority: { state: 'UNVERIFIABLE' } }), 'AUTHORITY_UNVERIFIABLE'],
        ['stale authority', (c) => consumedAnswer(c.pkg, c.receiptId, { authority: { verifiedAt: iso(Date.now() - MAX_AGE - 3000) } }), 'AUTHORITY_UNVERIFIABLE'],
        ['malformed authority', (c) => ({ ...consumedAnswer(c.pkg, c.receiptId), authority: { state: 'MAYBE', verifiedAt: iso(Date.now()) } }), 'AUTHORITY_UNVERIFIABLE'],
      ];
      for (const [name, answer, code] of cases) {
        const c = await claimed();
        c.provider.set(() => answer(c));
        const r = await engine(c.provider).executeClaim(c.ctx, c.claimId);
        expect(r, name).toMatchObject({ state: 'RETRY', reasonCode: code, attemptNumber: 1, retryAfterMs: 1000 });
        expect(await execRows(c), name).toHaveLength(0);
        expect((await balance(c)).version, name).toBe(1);
        expect(await attemptRows(c), name).toHaveLength(1);
      }
      const thrown = await claimed();
      thrown.provider.set(() => { throw new Error('aba down'); });
      expect(await engine(thrown.provider).executeClaim(thrown.ctx, thrown.claimId)).toMatchObject({ state: 'RETRY', reasonCode: 'STATUS_UNAVAILABLE' });
    });

    it('retries then succeeds when the answer becomes available; attempt_count reflects it; attempts after the terminal row are refused by the database', async () => {
      const c = await claimed();
      c.provider.set((n) => (n === 1 ? null : consumedAnswer(c.pkg, c.receiptId)));
      const svc = engine(c.provider);
      expect(await svc.executeClaim(c.ctx, c.claimId)).toMatchObject({ state: 'RETRY', attemptNumber: 1 });
      const e = terminal(await svc.executeClaim(c.ctx, c.claimId));
      expect([e.outcome, e.attemptCount]).toEqual(['SUCCEEDED', 2]);
      await expect(admin.query(`INSERT INTO ${S}.authorized_action_execution_attempts (tenant_id, workspace_id, business_id, claim_id, attempt_number, outcome, reason_code, correlation_id) VALUES ($1,$2,$3,$4,9,'RETRYABLE_REFUSAL','X',$5)`,
        [c.ew.w.tenantId, c.ew.w.workspaceId, c.ew.w.businessId, c.claimId, randomUUID()])).rejects.toThrow(/terminal execution/);
    });

    it('exhausts after 3 attempts (O-3): terminal REFUSED(RETRIES_EXHAUSTED) with the backoff 1s/5s/15s reported in between', async () => {
      const c = await claimed();
      c.provider.set(() => null);
      const svc = engine(c.provider);
      const r1 = await svc.executeClaim(c.ctx, c.claimId); const r2 = await svc.executeClaim(c.ctx, c.claimId);
      expect([r1, r2].map((r) => r.state === 'RETRY' && r.retryAfterMs)).toEqual([1000, 5000]);
      const e = terminal(await svc.executeClaim(c.ctx, c.claimId));
      expect(e).toMatchObject({ outcome: 'REFUSED', reasonCode: 'RETRIES_EXHAUSTED', attemptCount: 3, mutationResult: 'NOT_APPLIED' });
      expect(e.detail).toContain('STATUS_UNAVAILABLE');
      expect(await attemptRows(c)).toHaveLength(2);
    });
  });

  describe('deterministic refusals (nothing mutated, claim spent)', () => {
    it('a plain approval has no authoritative baseline in v1: REFUSED(NO_BASELINE_EVIDENCE) (O-4)', async () => {
      const c = await claimed({ modified: undefined });
      const e = terminal(await engine(c.provider).executeClaim(c.ctx, c.claimId));
      expect([e.outcome, e.reasonCode]).toEqual(['REFUSED', 'NO_BASELINE_EVIDENCE']);
      expect((await balance(c)).version).toBe(1);
    });

    it('a changed balance is never overwritten: REFUSED(BASELINE_CHANGED)', async () => {
      const c = await claimed();
      const w = await admin.connect();
      try {
        await w.query('BEGIN');
        await w.query(`SELECT set_config('app.bo_reorder_policy_writer','configure_inventory_reorder_policy', true)`);
        await w.query(`UPDATE ${S}.inventory_balances SET reorder_point = 120 WHERE id=$1`, [c.ew.balanceId]);
        await w.query('COMMIT');
      } finally { w.release(); }
      const e = terminal(await engine(c.provider).executeClaim(c.ctx, c.claimId));
      expect([e.outcome, e.reasonCode]).toEqual(['REFUSED', 'BASELINE_CHANGED']);
      expect((await balance(c)).rp).toBe(120);
    });

    it('evaluation evidence that is not bound to this target and these parameters yields no baseline', async () => {
      const wrongBalance = await claimed({ modified: { baseline: [100, 200], evalMutate: (i) => { i.facts.balances[0].id = randomUUID(); } } });
      expect(terminal(await engine(wrongBalance.provider).executeClaim(wrongBalance.ctx, wrongBalance.claimId)).reasonCode).toBe('BASELINE_CHANGED');
      const none = await claimed({ modified: { baseline: [100, 200], evalMutate: (i) => { i.facts.balances = []; } } });
      expect(terminal(await engine(none.provider).executeClaim(none.ctx, none.claimId)).reasonCode).toBe('NO_BASELINE_EVIDENCE');
      const two = await claimed({ modified: { baseline: [100, 200], evalMutate: (i) => { i.facts.balances.push({ ...i.facts.balances[0] }); } } });
      expect(terminal(await engine(two.provider).executeClaim(two.ctx, two.claimId)).reasonCode).toBe('NO_BASELINE_EVIDENCE');
      const schema = await claimed({ modified: { baseline: [100, 200], evalMutate: (i) => { i.schema = 'other/1'; } } });
      expect(terminal(await engine(schema.provider).executeClaim(schema.ctx, schema.claimId)).reasonCode).toBe('NO_BASELINE_EVIDENCE');
    });

    it('evaluation records bound to other parameters, or filed under another item, or disagreeing with each other, yield no baseline', async () => {
      const otherParams = await claimed({ modified: { baseline: [100, 200], evalFinal: { reorderPoint: 160, reorderQuantity: 260 } } });
      expect(terminal(await engine(otherParams.provider).executeClaim(otherParams.ctx, otherParams.claimId)).reasonCode).toBe('NO_BASELINE_EVIDENCE');
      const ew = await makeExecWorld(admin, tenantIds);
      const otherItem = randomUUID();
      await admin.query(`INSERT INTO platform.inventory_items (id, tenant_id, workspace_id, business_id, sku, name, status) VALUES ($1,$2,$3,$4,$5,'Other','active')`, [otherItem, ew.w.tenantId, ew.w.workspaceId, ew.w.businessId, `sku-${otherItem}`]);
      const filed = await buildPackage(ew, { reorderPoint: 150, reorderQuantity: 250, modified: { baseline: [100, 200], recordedItemId: otherItem } }).then(async (pkg) => {
        const { claimId, receiptId } = await claimPackage(ew, pkg);
        return { claimId, provider: new ScriptedProvider(() => consumedAnswer(pkg, receiptId)), ctx: ctxOf(ew) };
      }).catch((e) => e as Error);
      if (filed instanceof Error) {
        expect(filed.message).toMatch(/inventory_item|subject|check/i); // the database already refuses such a record
      } else {
        expect(terminal(await engine(filed.provider).executeClaim(filed.ctx, filed.claimId)).reasonCode).toBe('NO_BASELINE_EVIDENCE');
      }
      const disagree = await claimed({ modified: { baseline: [100, 200], perDimension: (i, d) => { if (d === 'COST') i.facts.balances[0].reorderPoint = 101; } } });
      expect(terminal(await engine(disagree.provider).executeClaim(disagree.ctx, disagree.claimId)).reasonCode).toBe('NO_BASELINE_EVIDENCE');
    });

    it('a stored receipt that no longer verifies (tampered after the fact) is refused, never executed', async () => {
      const c = await claimed();
      const t = await admin.connect();
      try {
        await t.query('BEGIN'); await t.query("SET LOCAL session_replication_role = 'replica'");
        await t.query(`UPDATE ${S}.authorized_action_receipts SET package = jsonb_set(package, '{action,parameters,reorderPoint}', '999') WHERE id=$1`, [c.receiptId]);
        await t.query('COMMIT');
      } finally { t.release(); }
      const e = terminal(await engine(c.provider).executeClaim(c.ctx, c.claimId));
      expect([e.outcome, e.reasonCode]).toEqual(['REFUSED', 'RECEIPT_INVALID']);
      expect(c.provider.calls).toBe(0);
      expect((await balance(c)).rp).toBe(100);
    });

    it('a closed or throwing activation gate refuses (CAPABILITY_DISABLED) before any lock or authority request', async () => {
      for (const gate of [{ isEnabled: async () => false }, { isEnabled: async () => { throw new Error('gate down'); } }]) {
        const c = await claimed();
        const e = terminal(await engine(c.provider, { gate }).executeClaim(c.ctx, c.claimId));
        expect([e.outcome, e.reasonCode]).toEqual(['REFUSED', 'CAPABILITY_DISABLED']);
        expect(c.provider.calls).toBe(0);
      }
    });

    it('an action type BO cannot execute (empty production registry) is REFUSED(ACTION_TYPE_UNSUPPORTED_BY_EXECUTOR)', async () => {
      const c = await claimed();
      const e = terminal(await engine(c.provider, { capabilities: explicitCapabilities([]) }).executeClaim(c.ctx, c.claimId));
      expect(e.reasonCode).toBe('ACTION_TYPE_UNSUPPORTED_BY_EXECUTOR');
      expect(c.provider.calls).toBe(0);
      const production = await claimed();
      const prod = new AuthorizedActionExecutionService({ statusProvider: production.provider, executionStatusMaxAgeMs: MAX_AGE, gate: OPEN });
      expect(terminal(await prod.executeClaim(production.ctx, production.claimId)).reasonCode).toBe('ACTION_TYPE_UNSUPPORTED_BY_EXECUTOR');
    });

    it('no balance and several balances for the target are refused; none is ever created', async () => {
      const none = await claimed({}, { noBalance: true });
      expect(terminal(await engine(none.provider).executeClaim(none.ctx, none.claimId)).reasonCode).toBe('NO_BALANCE');
      expect(Number((await admin.query(`SELECT count(*) n FROM ${S}.inventory_balances WHERE inventory_item_id=$1`, [none.ew.itemId])).rows[0].n)).toBe(0);
      const many = await claimed({}, { secondBalance: true });
      expect(terminal(await engine(many.provider).executeClaim(many.ctx, many.claimId)).reasonCode).toBe('TARGET_AMBIGUOUS');
    });

    it('preconditions: unmet -> PRECONDITION_FAILED; unknown code, unsupported operator or bad operand -> UNSUPPORTED_PRECONDITION; met -> executes and is recorded with the observed value', async () => {
      const unmet = await claimed({ preconditions: [{ code: 'stock_available', operator: 'gte', operand: 1000 }] });
      expect(terminal(await engine(unmet.provider).executeClaim(unmet.ctx, unmet.claimId)).reasonCode).toBe('PRECONDITION_FAILED');
      for (const pre of [[{ code: 'warehouse_is_open', operator: 'eq', operand: true }], [{ code: 'stock_available', operator: 'contains', operand: 1 }], [{ code: 'stock_available', operator: 'between', operand: [5, 1] }]]) {
        const c = await claimed({ preconditions: pre });
        expect(terminal(await engine(c.provider).executeClaim(c.ctx, c.claimId)).reasonCode, JSON.stringify(pre)).toBe('UNSUPPORTED_PRECONDITION');
        expect((await balance(c)).version).toBe(1);
      }
      const met = await claimed({ preconditions: [{ code: 'stock_available', operator: 'between', operand: [10, 100] }] });
      const e = terminal(await engine(met.provider).executeClaim(met.ctx, met.claimId));
      expect(e.outcome).toBe('SUCCEEDED');
      expect((e.evidence as any).preconditions).toEqual([{ code: 'stock_available', operator: 'between', operand: [10, 100], observed: '50', passed: true, problem: null }]);
    });

    it('values the database column cannot hold exactly are refused, never rounded (more than four decimals)', async () => {
      const frac = await claimed({ reorderPoint: 150.00001 });
      expect(terminal(await engine(frac.provider).executeClaim(frac.ctx, frac.claimId)).reasonCode).toBe('PARAMETERS_INVALID');
      expect((await balance(frac)).rp).toBe(100);
    });
  });

  describe('atomicity and failure', () => {
    it('the mutation, the execution row and the audit commit together: a failing execution-row insert rolls the balance back (then it is recorded as a retryable failure)', async () => {
      const c = await claimed();
      const broken = new (class extends AuthorizedActionExecutionRepository {
        override async insertExecution(): Promise<never> { throw new Error('disk full'); }
      })();
      const r = await engine(c.provider, { repository: broken }).executeClaim(c.ctx, c.claimId);
      expect(r).toMatchObject({ state: 'RETRY', reasonCode: 'OPERATIONAL_ERROR' });
      expect(await balance(c)).toMatchObject({ rp: 100, rq: 200, version: 1, state: 'UNSET' });
      expect(await execRows(c)).toHaveLength(0);
      const attempts = await attemptRows(c);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ outcome: 'RETRYABLE_FAILURE', reason_code: 'OPERATIONAL_ERROR' });
      // and the next healthy attempt succeeds exactly once
      expect(terminal(await engine(c.provider).executeClaim(c.ctx, c.claimId))).toMatchObject({ outcome: 'SUCCEEDED', attemptCount: 2 });
    });

    it('operational failures exhaust into a terminal FAILED(RETRIES_EXHAUSTED) with the balance untouched', async () => {
      const c = await claimed();
      const broken = new (class extends AuthorizedActionExecutionRepository {
        override async insertExecution(client: any, ctx: any, x: any): Promise<any> {
          if (x.reasonCode === 'RETRIES_EXHAUSTED') return super.insertExecution(client, ctx, x);
          throw new Error('disk full');
        }
      })();
      const svc = engine(c.provider, { repository: broken });
      await svc.executeClaim(c.ctx, c.claimId); await svc.executeClaim(c.ctx, c.claimId);
      const e = terminal(await svc.executeClaim(c.ctx, c.claimId));
      expect(e).toMatchObject({ outcome: 'FAILED', reasonCode: 'RETRIES_EXHAUSTED', mutationResult: 'NOT_APPLIED', attemptCount: 3 });
      expect((await balance(c)).version).toBe(1);
    });

    it('a deterministic database rejection of the mutation is a terminal FAILED(MUTATION_REJECTED) that leaves the transaction usable', async () => {
      const c = await claimed();
      const adapter = new (class extends (await import('../src/index.js')).InventoryReorderPolicyExecutionAdapter {
        override async apply(): Promise<never> { const e: any = new Error('check constraint'); e.code = '23514'; throw e; }
      })();
      const e = terminal(await engine(c.provider, { adapter }).executeClaim(c.ctx, c.claimId));
      expect([e.outcome, e.reasonCode, e.mutationResult]).toEqual(['FAILED', 'MUTATION_REJECTED', 'NOT_APPLIED']);
      expect(await balance(c)).toMatchObject({ rp: 100, version: 1 });
    });

    it('another tenant cannot execute, or even see, a claim', async () => {
      const c = await claimed();
      const other = await makeExecWorld(admin, tenantIds);
      await expect(engine(c.provider).executeClaim(ctxOf(other), c.claimId)).rejects.toBeInstanceOf(ClaimNotFoundError);
      await expect(engine(c.provider).executeClaim(c.ctx, randomUUID())).rejects.toBeInstanceOf(ClaimNotFoundError);
      expect(await repo.getByClaim(ctxOf(other), c.claimId)).toBeNull();
    });
  });

  describe('retry scheduling and claim recovery (O-3)', () => {
    it('a claim never attempted is recovered 60 s after it was claimed, not before; terminal claims are never re-driven', async () => {
      const c = await claimed();
      let now = Date.now();
      const svc = engine(c.provider, { clock: () => new Date(now) });
      expect(await svc.runDue(c.ctx, { limit: 50 })).toEqual([]); // just claimed
      now += 59_000;
      expect((await svc.runDue(c.ctx, { limit: 50 })).filter((r) => r.claimId === c.claimId)).toEqual([]);
      now += 2_000;
      const ran = (await svc.runDue(c.ctx, { limit: 50 })).filter((r) => r.claimId === c.claimId);
      expect(ran).toHaveLength(1);
      expect(terminal(ran[0].result).outcome).toBe('SUCCEEDED');
      expect((await svc.runDue(c.ctx, { limit: 50 })).filter((r) => r.claimId === c.claimId)).toEqual([]);
    });

    it('a claim with attempts waits the backoff of its attempt count (1 s, then 5 s)', async () => {
      const c = await claimed();
      c.provider.set(() => null);
      let now = Date.now();
      const svc = engine(c.provider, { clock: () => new Date(now) });
      const lastAttempt = async () => ((await admin.query(`SELECT max(attempted_at) AS t FROM ${S}.authorized_action_execution_attempts WHERE claim_id=$1`, [c.claimId])).rows[0].t as Date).getTime();
      const due = async () => (await svc.runDue(c.ctx, { limit: 50 })).filter((r) => r.claimId === c.claimId);
      await svc.executeClaim(c.ctx, c.claimId); // attempt 1
      const a1 = await lastAttempt();
      now = a1 + 500; expect(await due()).toHaveLength(0); // 1 s backoff not elapsed
      now = a1 + 1_100;
      const second = await due();
      expect(second).toHaveLength(1);
      expect(second[0].result).toMatchObject({ state: 'RETRY', attemptNumber: 2 });
      const a2 = await lastAttempt();
      now = a2 + 4_000; expect(await due()).toHaveLength(0); // 5 s backoff after attempt 2
      now = a2 + 5_100;
      expect(await due()).toHaveLength(1); // attempt 3 -> terminal exhaustion
      expect((await execRows(c))[0].reason_code).toBe('RETRIES_EXHAUSTED');
    });
  });

  describe('database guards (migrations 0191 and 0192)', () => {
    it('execution and attempt rows are append-only for every role; TRUNCATE is refused', async () => {
      const c = await claimed();
      const e = terminal(await engine(c.provider).executeClaim(c.ctx, c.claimId));
      for (const sql of [`UPDATE ${S}.authorized_action_executions SET detail='x' WHERE id='${e.id}'`, `DELETE FROM ${S}.authorized_action_executions WHERE id='${e.id}'`, `TRUNCATE ${S}.authorized_action_executions`,
        `TRUNCATE ${S}.authorized_action_execution_attempts`]) {
        await expect(admin.query(sql), sql).rejects.toThrow(/append-only/);
      }
    });

    it('at most one terminal row per claim and per package version', async () => {
      const c = await claimed();
      const e = terminal(await engine(c.provider).executeClaim(c.ctx, c.claimId));
      const row = (await admin.query(`SELECT * FROM ${S}.authorized_action_executions WHERE id=$1`, [e.id])).rows[0];
      const cols = Object.keys(row).filter((k) => k !== 'id');
      const insert = `INSERT INTO ${S}.authorized_action_executions (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`;
      await expect(admin.query(insert, cols.map((k) => (row[k] !== null && typeof row[k] === 'object' && !(row[k] instanceof Date) ? JSON.stringify(row[k]) : row[k])))).rejects.toThrow(/duplicate key|unique/);
    });

    it('the database refuses an execution that does not match its claim, and a SUCCEEDED row without proven authority', async () => {
      const c = await claimed();
      const base = async (over: Record<string, unknown>) => {
        const cl = (await admin.query(`SELECT * FROM ${S}.authorized_action_claims WHERE id=$1`, [c.claimId])).rows[0];
        const cols = { tenant_id: cl.tenant_id, workspace_id: cl.workspace_id, business_id: cl.business_id, claim_id: cl.id, receipt_id: cl.receipt_id, package_id: cl.package_id, package_version: cl.package_version,
          digest: cl.digest, action_type_code: 'inventory_reorder_policy_update', action_type_schema_version: '1', target_kind: 'inventory_item', target_id: c.ew.itemId, outcome: 'REFUSED', reason_code: 'X',
          mutation_result: 'NOT_APPLIED', authority_verdict: 'NOT_CHECKED', attempt_count: 1, claimed_at: cl.claimed_at, execution_started_at: new Date(), execution_completed_at: new Date(),
          evidence: JSON.stringify({}), evidence_digest: `sha256:${'a'.repeat(64)}`, correlation_id: randomUUID(), ...over };
        const keys = Object.keys(cols);
        return admin.query(`INSERT INTO ${S}.authorized_action_executions (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, keys.map((k) => (cols as any)[k]));
      };
      await expect(base({ digest: `sha256:${'b'.repeat(64)}` })).rejects.toThrow(/does not match its claim/);
      await expect(base({ target_id: randomUUID() })).rejects.toThrow(/action type or target/);
      await expect(base({ outcome: 'SUCCEEDED', reason_code: null, mutation_result: 'NO_CHANGE' })).rejects.toThrow(/success_needs_authority/);
      await expect(base({ outcome: 'SUCCEEDED', reason_code: null, mutation_result: 'APPLIED', authority_verdict: 'REVOKED' })).rejects.toThrow();
      await expect(base({ outcome: 'REFUSED', reason_code: null })).rejects.toThrow(/outcome_shape/);
      await expect(base({ outcome: 'REFUSED', mutation_result: 'APPLIED' })).rejects.toThrow();
      await expect(base({ execution_started_at: new Date(Date.parse(c.pkg.issuance.issuedAt) - 3_600_000) })).rejects.toThrow(/before its claim/);
    });

    it('row-level security isolates executions and attempts by tenant and workspace (forced)', async () => {
      const c = await claimed();
      c.provider.set(() => null);
      await engine(c.provider).executeClaim(c.ctx, c.claimId);
      const outsider = await makeExecWorld(admin, tenantIds);
      const { withTenantTransaction } = await import('@infinicus/database');
      const seen = await withTenantTransaction(ctxOf(outsider), async (client) => (await client.query(`SELECT (SELECT count(*) FROM ${S}.authorized_action_executions) AS e, (SELECT count(*) FROM ${S}.authorized_action_execution_attempts) AS a`)).rows[0]);
      expect([Number(seen.e), Number(seen.a)]).toEqual([0, 0]);
      const forced = (await admin.query(`SELECT relname, relforcerowsecurity FROM pg_class WHERE relname IN ('authorized_action_executions','authorized_action_execution_attempts')`)).rows;
      expect(forced.map((r: any) => r.relforcerowsecurity)).toEqual([true, true]);
    });

    it('M3: the reorder fields can be changed only by the BO configure command, even on an UNSET balance; negative values are refused', async () => {
      const ew = await makeExecWorld(admin, tenantIds);
      await expect(admin.query(`UPDATE ${S}.inventory_balances SET reorder_point = 1 WHERE id=$1`, [ew.balanceId])).rejects.toThrow(/configure_inventory_reorder_policy/);
      await expect(admin.query(`UPDATE ${S}.inventory_balances SET reorder_quantity = 1 WHERE id=$1`, [ew.balanceId])).rejects.toThrow(/configure_inventory_reorder_policy/);
      const c = await admin.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.bo_reorder_policy_writer','configure_inventory_reorder_policy', true)`);
        await expect(c.query(`UPDATE ${S}.inventory_balances SET reorder_point = -1 WHERE id=$1`, [ew.balanceId])).rejects.toThrow(/reorder_non_negative/);
      } finally { await c.query('ROLLBACK'); c.release(); }
      // quantity movements are unaffected by the guard
      await admin.query(`UPDATE ${S}.inventory_balances SET quantity_on_hand = 60, last_movement_at = now() WHERE id=$1`, [ew.balanceId]);
    });
  });
});
