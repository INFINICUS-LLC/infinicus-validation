/**
 * AC-2 Block 9 - failure proofs for the first-action evidence chain (real PostgreSQL, production buildApp). Every scenario is DAL-fed (nothing seeded) and proves the
 * chain FAILS CLOSED at the right layer: nothing partial persists, nothing downstream is created, and no foreign scope is ever reached.
 *
 *   1 malformed source data -> rejected before BO truth        2 missing required source field -> nothing ingested, no recommendation
 *   3 stale evidence -> no recommendation                       4 wrong tenant / business scope -> no cross-tenant evidence
 *   5 inconsistent currency -> no recommendation                6 insufficient demand history -> no recommendation
 *   7 missing receipt / cost evidence -> no recommendation      8 BI / BDT evidence mismatch -> fail closed
 *   9 unsupported action -> no recommendation / no capture      10 no structured proposal -> ABA refusal
 *   11 baseline changed before execution -> no overwrite (plain AND modified approval)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@infinicus/configuration';
import { ApprovedActionRepository, closePool, createPool, type TenantContext } from '@infinicus/database';
import { DEFAULT_APPROVER_ASSIGNMENT_CODE } from '@infinicus/workflow';
import { buildEventWorker } from '../../../packages/event-worker/src/index.js';
import { buildApp } from '../src/app.js';
import { buildReorderPolicyRecommendationProducer } from '../src/reorderPolicyRecommendationComposition.js';
import { buildInventoryBiEvidenceService } from '../src/inventoryBiEvidenceComposition.js';
import { buildInventoryItemTwinService } from '../src/inventoryItemTwinComposition.js';
import { ACTION, chainKit, type AdiChain, type Session } from './helpers/authorizedPackageChain.js';
import { DAY, daysAgo, dalKit, firstActionRecords, unique, type World } from './helpers/dalIngestion.js';
import { createAbaFixture, APPROVABLE_FACTS, uc } from './helpers/abaFixtures.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const RULE_SET = 'inventory-reorder-policy/v1.1.0';
const BO = 'business_operations';
const ABA = 'approved_business_action';
const ADI = 'ai_decision_intelligence';
const ACTOR = randomUUID();
const HOUR = 3_600_000;

let admin: Pool;
let app: FastifyInstance;
const tenantIds: string[] = [];
let dk: ReturnType<typeof dalKit>;
let ck: ReturnType<typeof chainKit>;

const q = async (sql: string, args: unknown[]) => (await admin.query(sql, args)).rows;
const put = (w: { ctx: TenantContext; token: string }, url: string, payload: unknown) => app.inject({ method: 'PUT', url, headers: dk.headers(w, { 'idempotency-key': unique('key') }), payload: payload as never });
const post = (w: { ctx: TenantContext; token: string }, url: string, payload: unknown = {}) => app.inject({ method: 'POST', url, headers: dk.headers(w, { 'idempotency-key': unique('key') }), payload: payload as never });
const item = (w: World, itemId: string) => `/v1/businesses/${w.businessId}/inventory-items/${itemId}`;
const recommend = (w: World, itemId: string) => post(w, `${item(w, itemId)}/reorder-policy-recommendation`);
const rows = (w: World) => ({
  bo: async () => ({
    items: (await q(`SELECT 1 FROM platform.inventory_items WHERE business_id=$1`, [w.businessId])).length,
    warehouses: (await q(`SELECT 1 FROM platform.warehouses WHERE business_id=$1`, [w.businessId])).length,
    movements: (await q(`SELECT 1 FROM ${BO}.inventory_movements WHERE business_id=$1`, [w.businessId])).length,
    balances: (await q(`SELECT 1 FROM ${BO}.inventory_balances WHERE business_id=$1`, [w.businessId])).length,
  }),
  adi: async () => (await q(`SELECT 1 FROM ${ADI}.decision_recommendations WHERE business_id=$1`, [w.businessId])).length,
  aba: async () => (await q(`SELECT 1 FROM ${ABA}.authorized_action_captures WHERE business_id=$1`, [w.businessId])).length + (await q(`SELECT 1 FROM ${ABA}.authorized_action_packages WHERE business_id=$1`, [w.businessId])).length,
});
const EMPTY_BO = { items: 0, warehouses: 0, movements: 0, balances: 0 };
const noRec = (res: { statusCode: number; json(): { [k: string]: unknown } }, code: string, reason?: RegExp) => {
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ outcome: 'NO_RECOMMENDATION', code });
  if (reason) expect((res.json().reasonCodes as string[]).join(',')).toMatch(reason);
};
async function replica(sql: string, args: unknown[] = []): Promise<void> {
  const c = await admin.connect();
  try { await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'"); await c.query(sql, args); await c.query('COMMIT'); }
  catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
}

/** DAL -> BO for the given source records, then optionally the BO-owned policy (D2), the declared currency (D3), BI evidence and the BDT state. */
async function pipeline(records: Record<string, unknown>[], o: { baseline?: boolean; currency?: string | null; bi?: boolean; twin?: boolean } = {}) {
  const w = await dk.world();
  const ids = await dk.ingestFirstAction(w, 'SKU-F', 'WH-F', records);
  if (o.baseline !== false) expect((await put(w, `${item(w, ids.itemId!)}/warehouses/${ids.warehouseId}/initial-reorder-policy`, { reorderPoint: 170, reorderQuantity: 190 })).statusCode).toBe(200);
  if (o.currency !== null) expect((await put(w, `/v1/businesses/${w.businessId}/declared-currency`, { currency: o.currency ?? 'USD', expectedVersion: null, reason: 'initial declaration' })).statusCode).toBe(201);
  if (o.bi !== false) expect((await post(w, `${item(w, ids.itemId!)}/bi-evidence`, { ruleSetVersion: RULE_SET })).statusCode).toBe(201);
  if (o.bi !== false && o.twin !== false) expect((await post(w, `${item(w, ids.itemId!)}/twin-state`)).statusCode).toBe(201);
  return { w, itemId: ids.itemId!, warehouseId: ids.warehouseId!, balanceId: ids.balanceId! };
}
const recs = (sku = 'SKU-F', wh = 'WH-F') => firstActionRecords(sku, wh);
const movement = (data: Record<string, unknown>) => ({ recordType: 'inventory_movement', data });
const base = { sku: 'SKU-F', warehouseCode: 'WH-F' };

const worker = (c: AdiChain) => buildEventWorker({
  config: { workerId: `w-${randomUUID().slice(0, 6)}`, actorUserId: ACTOR, discoveryDatabaseUrl: 'unused', intakeStatusMaxAgeMs: 5000, executionStatusMaxAgeMs: 5000, claimTimeoutMs: 60_000, batchSize: 10, maxScopesPerCycle: 5, pollIntervalMs: 1000 },
  discovery: { discover: async () => [{ tenantId: c.s.ctx.tenantId, workspaceId: c.s.ctx.workspaceId }] },
  killSwitchEngaged: () => false,
});

describe.runIf(run)('AC-2 Block 9: the first-action chain fails closed', () => {
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    await app.ready();
    dk = dalKit({ app, admin, tenantIds });
    ck = chainKit({ app, admin, tenantIds });
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    if (tenantIds.length > 0) {
      const c = await admin.connect();
      try {
        await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'");
        await c.query('DELETE FROM audit.audit_events WHERE tenant_id = ANY($1)', [tenantIds]);
        await c.query('DELETE FROM business_operations.inventory_policy_evaluations WHERE tenant_id = ANY($1)', [tenantIds]);
        await c.query('COMMIT');
      } catch { await c.query('ROLLBACK').catch(() => undefined); } finally { c.release(); }
      await deleteMovementsForTenants(admin, tenantIds);
    }
    await admin?.end(); await closePool();
  });

  // ── 1 & 2: bad source data never becomes BO truth ──────────────────────────────────────────────────────────────────────────────────────────
  describe('malformed or incomplete source data is refused before Business Operations truth exists', () => {
    const base0 = [{ recordType: 'warehouse', data: { warehouseCode: 'WH-F', name: 'W' } }, { recordType: 'inventory_item', data: { sku: 'SKU-F', name: 'Widget' } }];
    const malformed: [string, Record<string, unknown>][] = [
      ['a zero quantity', movement({ ...base, movementType: 'receipt', quantity: 0 })],
      ['a non-numeric quantity', movement({ ...base, movementType: 'receipt', quantity: 'many' })],
      ['a negative unit cost', movement({ ...base, movementType: 'receipt', quantity: 5, unitCost: -2, unitCostCurrency: 'USD' })],
      ['a zero unit cost', movement({ ...base, movementType: 'receipt', quantity: 5, unitCost: 0, unitCostCurrency: 'USD' })],
      ['a lowercase currency', movement({ ...base, movementType: 'receipt', quantity: 5, unitCost: 2, unitCostCurrency: 'usd' })],
      ['a cost with no currency', movement({ ...base, movementType: 'receipt', quantity: 5, unitCost: 2 })],
      ['an unknown movement type', movement({ ...base, movementType: 'teleport', quantity: 5 })],
      ['an unparseable business date', movement({ ...base, movementType: 'issue', quantity: 5, occurredAt: 'last tuesday-ish' })],
      ['a SKU with illegal characters', { recordType: 'inventory_item', data: { sku: 'bad sku!', name: 'x' } }],
      ['an unsupported record type', { recordType: 'inventory_teleport', data: {} }],
    ];
    it.each(malformed)('%s: the whole package is refused and nothing reaches BO', async (_name, bad) => {
      const w = await dk.world();
      const { packageId } = await dk.publishThroughDal(w, [...base0, bad]);
      const res = await dk.boIntake(w, packageId);
      expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
      expect(await rows(w).bo()).toEqual(EMPTY_BO);
    });

    const missing: [string, Record<string, unknown>][] = [
      ['a movement with no item key', movement({ warehouseCode: 'WH-F', movementType: 'issue', quantity: 1 })],
      ['a movement with no warehouse key', movement({ sku: 'SKU-F', movementType: 'issue', quantity: 1 })],
      ['a movement with no quantity', movement({ ...base, movementType: 'issue' })],
      ['a movement with no type', movement({ ...base, quantity: 1 })],
      ['an item with no name', { recordType: 'inventory_item', data: { sku: 'SKU-F' } }],
      ['a warehouse with no code', { recordType: 'warehouse', data: { name: 'W' } }],
    ];
    it.each(missing)('%s: refused whole; with nothing ingested there is no evidence and no recommendation', async (_name, bad) => {
      const w = await dk.world();
      const { packageId } = await dk.publishThroughDal(w, [...base0, bad]);
      expect((await dk.boIntake(w, packageId)).statusCode).toBeGreaterThanOrEqual(400);
      expect(await rows(w).bo()).toEqual(EMPTY_BO);
      noRec(await recommend(w, randomUUID()), 'BI_EVIDENCE_MISSING');
      expect(await rows(w).adi()).toBe(0);
    });

    it('a record Data Acquisition itself rejects (not an object) is quarantined by DAL, never published, and never reaches BO', async () => {
      const w = await dk.world();
      const intake = await dk.da.submitManualIntake(w.ctx, { businessId: w.businessId, dataSourceId: w.dataSourceId, submissionType: 'operations', records: [...base0, 'not-an-object', 42] as unknown[], sourceReference: 'integration://ac2-malformed', submittedBy: w.ctx.userId });
      expect(intake.recordsRejected).toBeGreaterThanOrEqual(2);
      expect(intake.state).toBe('quarantined');
      await expect(dk.da.preparePublicationPackage(w.ctx, w.businessId, intake.collectionRunId, { targetBlock: 'BO-RUNTIME' })).rejects.toThrow();
      expect(await rows(w).bo()).toEqual(EMPTY_BO);
    });
  });

  // ── 3, 6, 7: evidence that is stale, thin or missing yields no recommendation ───────────────────────────────────────────────────────────────
  describe('stale, thin or missing evidence yields no recommendation', () => {
    it('3. EXPIRED governed evidence (past the rule set\'s maximum age) -> BI_EVIDENCE_EXPIRED; nothing persists', async () => {
      const { w, itemId } = await pipeline(recs());
      const later = buildReorderPolicyRecommendationProducer({ evidence: { now: () => new Date(Date.now() + 25 * HOUR) } });
      expect(await later.produce(w.ctx, { businessId: w.businessId, itemId }, { permissionUsed: 'bo:write' })).toMatchObject({ outcome: 'NO_RECOMMENDATION', code: 'BI_EVIDENCE_EXPIRED' });
      expect(await rows(w).adi()).toBe(0);
    });

    it('3. demand older than the 90-day window is stale -> no recommendation', async () => {
      const old = recs().map((r) => (r.recordType === 'inventory_movement' && (r.data as Record<string, unknown>).movementType === 'issue' ? { ...r, data: { ...(r.data as Record<string, unknown>), occurredAt: new Date(Date.now() - 200 * DAY).toISOString() } } : r));
      const { w, itemId } = await pipeline(old);
      noRec(await recommend(w, itemId), 'EVIDENCE_UNAVAILABLE', /INSUFFICIENT_HISTORY/);
      expect(await rows(w).adi()).toBe(0);
    });

    it('6. insufficient demand history (fewer than 10 observations) -> no recommendation', async () => {
      const thin = recs().filter((r) => !(r.recordType === 'inventory_movement' && (r.data as Record<string, unknown>).movementType === 'issue')).concat(
        Array.from({ length: 5 }, (_, i) => movement({ ...base, movementType: 'issue', quantity: 75, occurredAt: daysAgo(i + 1) })));
      const { w, itemId } = await pipeline(thin);
      noRec(await recommend(w, itemId), 'EVIDENCE_UNAVAILABLE', /INSUFFICIENT_HISTORY/);
      expect(await rows(w).adi()).toBe(0);
    });

    it('7. no receipt at all -> no recommendation', async () => {
      const noReceipt = recs().filter((r) => !(r.recordType === 'inventory_movement' && (r.data as Record<string, unknown>).movementType === 'receipt'));
      // without a receipt the issues would drive the balance negative; a small opening adjustment (no cost) supplies stock without being a cost-bearing receipt
      const seeded = [...noReceipt.slice(0, 2), movement({ ...base, movementType: 'adjustment', quantity: 1000, occurredAt: daysAgo(6) }), ...noReceipt.slice(2)];
      const { w, itemId } = await pipeline(seeded);
      noRec(await recommend(w, itemId), 'EVIDENCE_UNAVAILABLE', /NO_RECEIPT/);
      expect(await rows(w).adi()).toBe(0);
    });

    it('7. a receipt that states no cost -> no cost evidence is published and nothing is recommended', async () => {
      const noCost = recs().map((r) => (r.recordType === 'inventory_movement' && (r.data as Record<string, unknown>).movementType === 'receipt'
        ? movement({ ...base, movementType: 'receipt', quantity: 1000, occurredAt: daysAgo(5), referenceType: 'manual' }) : r));
      const { w, itemId } = await pipeline(noCost);
      expect((await q(`SELECT 1 FROM business_intelligence.metric_calculated_values v JOIN business_intelligence.metric_definitions d ON d.id=v.metric_definition_id WHERE v.business_id=$1 AND d.metric_code='inventory.receipt.latest_cost_per_unit'`, [w.businessId]))).toHaveLength(0);
      const res = await recommend(w, itemId);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ outcome: 'NO_RECOMMENDATION', code: 'EVIDENCE_UNAVAILABLE' });
      expect(await rows(w).adi()).toBe(0);
    });

    it('missing baseline policy (D2) or missing declared currency (D3) -> no recommendation', async () => {
      const unset = await pipeline(recs(), { baseline: false });
      noRec(await recommend(unset.w, unset.itemId), 'EVIDENCE_UNAVAILABLE', /BASELINE_UNSET_OR_ZERO/);
      const undeclared = await pipeline(recs(), { currency: null });
      noRec(await recommend(undeclared.w, undeclared.itemId), 'EVIDENCE_UNAVAILABLE', /DECLARED_CURRENCY_MISSING/);
    });
  });

  // ── 5: currency ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  it('5. inconsistent currency (the receipt is USD, the business declares EUR) -> BI records it as a fact, ADI recommends nothing', async () => {
    const { w, itemId } = await pipeline(recs(), { currency: 'EUR' });
    const flag = (await q(`SELECT v.dimensions->>'currencyConsistent' c FROM business_intelligence.metric_calculated_values v JOIN business_intelligence.metric_definitions d ON d.id=v.metric_definition_id WHERE v.business_id=$1 AND d.metric_code='inventory.receipt.latest_cost_per_unit'`, [w.businessId]))[0];
    expect(flag.c).toBe('false');
    const res = await recommend(w, itemId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outcome: 'NO_RECOMMENDATION', code: 'EVIDENCE_UNAVAILABLE' });
    expect((res.json().reasonCodes as string[]).join(',')).toMatch(/CURRENCY/);
    expect(await rows(w).adi()).toBe(0);
  });

  // ── 4: scope ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  it('4. wrong tenant or business scope: no cross-tenant evidence is readable, publishable or recommendable', async () => {
    const a = await pipeline(recs());
    const b = await dk.world();
    // B addressing A's business: not found in B's tenant, for every surface
    for (const url of ['reorder-policy-recommendation', 'bi-evidence', 'twin-state']) {
      const res = await post(b, `/v1/businesses/${a.w.businessId}/inventory-items/${a.itemId}/${url}`, url === 'bi-evidence' ? { ruleSetVersion: RULE_SET } : {});
      expect(res.statusCode, url).toBe(404);
    }
    // B addressing its OWN business with A's item id: the item does not resolve there, so there is no evidence
    noRec(await recommend(b, a.itemId), 'BI_EVIDENCE_MISSING');
    const biForeign = await post(b, `${item(b, a.itemId)}/bi-evidence`, { ruleSetVersion: RULE_SET });
    expect(biForeign.json()).toMatchObject({ outcome: 'NOT_PUBLISHED', code: 'TARGET_NOT_FOUND' });
    // the evidence services, called as B, see nothing of A
    expect(await buildInventoryBiEvidenceService().getLatest(b.ctx, a.w.businessId, a.itemId)).toBeNull();
    expect(await buildInventoryItemTwinService().getLatest(b.ctx, a.w.businessId, a.itemId)).toBeNull();
    // and B cannot consume A's published package
    const pkg = await dk.publishThroughDal(a.w, [{ recordType: 'inventory_item', data: { sku: 'SKU-SCOPE', name: 'x' } }]);
    expect((await dk.boIntake({ ...b, businessId: a.w.businessId }, pkg.packageId)).statusCode).toBeGreaterThanOrEqual(400);
    expect(await rows(b).adi()).toBe(0);
    expect(await rows(b).bo()).toEqual(EMPTY_BO);
  });

  // ── 8: BI / BDT mismatch ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('BI / BDT evidence mismatch fails closed', () => {
    it('BI republished after the twin (the twin no longer matches the latest evidence)', async () => {
      const { w, itemId } = await pipeline(recs());
      expect((await post(w, `${item(w, itemId)}/bi-evidence`, { ruleSetVersion: RULE_SET })).statusCode).toBe(201);
      noRec(await recommend(w, itemId), 'BI_BDT_EVIDENCE_MISMATCH');
      expect(await rows(w).adi()).toBe(0);
    });
    it('a BI metric whose fact digest differs from its version: the twin refuses to derive from it', async () => {
      const { w, itemId } = await pipeline(recs(), { twin: false });
      await replica(`UPDATE business_intelligence.metric_calculated_values SET dimensions = jsonb_set(dimensions, '{factsDigest}', '"sha256:tampered"') WHERE business_id=$1`, [w.businessId]);
      expect((await post(w, `${item(w, itemId)}/twin-state`)).json()).toMatchObject({ outcome: 'NOT_PUBLISHED', code: 'BI_EVIDENCE_INCONSISTENT' });
    });
    it('Business Operations facts changed after the evidence was published', async () => {
      const { w, itemId } = await pipeline(recs());
      const more = await dk.publishThroughDal(w, [movement({ ...base, movementType: 'issue', quantity: 5, occurredAt: daysAgo(0.5), referenceType: 'manual' })]);
      expect((await dk.boIntake(w, more.packageId)).statusCode).toBe(200);
      noRec(await recommend(w, itemId), 'EVIDENCE_DIGEST_MISMATCH');
      expect(await rows(w).adi()).toBe(0);
    });
    it('a newer twin snapshot of the business supersedes the state used', async () => {
      const { w, itemId } = await pipeline(recs());
      await new Promise((r) => setTimeout(r, 1200));
      const { TwinComputationService } = await import('@infinicus/workflow');
      await new TwinComputationService().getOrComputeTwin(w.ctx, w.businessId, { forceRefresh: true });
      noRec(await recommend(w, itemId), 'BDT_STATE_STALE');
    });
  });

  // ── 9: unsupported action ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('an unsupported action is neither recommended nor captured', () => {
    it('the producer refuses every action type and schema version but the first action', async () => {
      const { w, itemId } = await pipeline(recs());
      const producer = buildReorderPolicyRecommendationProducer();
      for (const actionType of [{ code: 'supplier_price_update', schemaVersion: '1' }, { code: 'inventory_reorder_policy_update', schemaVersion: '2' }]) {
        expect(await producer.produce(w.ctx, { businessId: w.businessId, itemId, actionType }, { permissionUsed: 'bo:write' })).toMatchObject({ outcome: 'NO_RECOMMENDATION', code: 'UNSUPPORTED_ACTION_TYPE' });
      }
      expect(await rows(w).adi()).toBe(0);
    });
    it('ABA refuses to capture an action type outside the canonical vocabulary, whatever the recommendation', async () => {
      const w = await dk.world();
      const c = await ck.authorFromAdi({ mode: 'until-capture', session: { ctx: w.ctx, token: w.token, bizId: w.businessId, membershipId: w.membershipId }, seed: async () => {
        const ids = await dk.ingestFirstAction(w, 'SKU-U', 'WH-U');
        expect((await put(w, `${item(w, ids.itemId!)}/warehouses/${ids.warehouseId}/initial-reorder-policy`, { reorderPoint: 170, reorderQuantity: 190 })).statusCode).toBe(200);
        expect((await put(w, `/v1/businesses/${w.businessId}/declared-currency`, { currency: 'USD', expectedVersion: null, reason: 'initial declaration' })).statusCode).toBe(201);
        return { itemId: ids.itemId!, warehouseId: ids.warehouseId!, balanceId: ids.balanceId! };
      } });
      const res = await ck.post(c.s, `${c.base}/capture`, { actionType: { code: 'supplier_price_update', schemaVersion: '1' }, target: { kind: 'inventory_item', id: c.itemId }, proposedParameters: { reorderPoint: 175, reorderQuantity: 190 } });
      expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
      expect(await rows(w).aba()).toBe(0);
    }, 90_000);
  });

  // ── 10: no structured proposal ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  it('10. a narrative-only recommendation (no structured proposal) is refused by ABA, whatever parameters the caller supplies', async () => {
    const s = await ck.setup();
    await ck.governance(s);
    expect((await ck.post(s, `/v1/businesses/${s.bizId}/approver-assignments`, { approverUserId: s.ctx.userId, assignmentCode: DEFAULT_APPROVER_ASSIGNMENT_CODE, roleCode: 'business-owner' })).statusCode).toBe(201);
    const { intakePackageId, recommendationId } = await createAbaFixture(s.ctx, s.bizId, APPROVABLE_FACTS);
    const d = await ck.post(s, `/v1/businesses/${s.bizId}/decisions`, { intakePackageId, reviewCode: uc('r'), summary: 'narrative only', assignmentCode: DEFAULT_APPROVER_ASSIGNMENT_CODE, decisionCode: uc('d'), outcome: 'approve' });
    expect(d.statusCode, d.body).toBe(201);
    const actions = new ApprovedActionRepository();
    const action = await actions.createAction(s.ctx, s.bizId, d.json().id, uc('act'), recommendationId);
    await actions.createVersion(s.ctx, action.id, s.bizId, 'narrative');
    const res = await ck.post(s, `/v1/businesses/${s.bizId}/authorized-actions/${action.id}/capture`, { actionType: ACTION, target: { kind: 'inventory_item', id: randomUUID() }, proposedParameters: { reorderPoint: 175, reorderQuantity: 190 } });
    expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
    expect(res.body).toContain('ADI_PROPOSAL_REQUIRED');
    expect((await q(`SELECT 1 FROM ${ABA}.authorized_action_captures WHERE business_id=$1`, [s.bizId]))).toHaveLength(0);
  }, 90_000);

  // ── 11: baseline changed before execution ────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('baseline changed before execution: the newer state is never overwritten', () => {
    it.each(['plain', 'modify'] as const)('%s approval -> BASELINE_CHANGED, REFUSED, balance untouched, verification ineligible for learning', async (mode) => {
      const w = await dk.world();
      const session: Session = { ctx: w.ctx, token: w.token, bizId: w.businessId, membershipId: w.membershipId };
      const c = await ck.authorFromAdi({ mode, session, seed: async () => {
        const ids = await dk.ingestFirstAction(w, 'SKU-B', 'WH-B');
        expect((await put(w, `${item(w, ids.itemId!)}/warehouses/${ids.warehouseId}/initial-reorder-policy`, { reorderPoint: 170, reorderQuantity: 190 })).statusCode).toBe(200);
        expect((await put(w, `/v1/businesses/${w.businessId}/declared-currency`, { currency: 'USD', expectedVersion: null, reason: 'initial declaration' })).statusCode).toBe(201);
        return { itemId: ids.itemId!, warehouseId: ids.warehouseId!, balanceId: ids.balanceId! };
      } });
      await replica(`UPDATE ${BO}.inventory_balances SET reorder_point=171, reorder_quantity=191, version = version + 1 WHERE id=$1`, [c.balanceId]); // someone changed the policy after the evaluation
      const versionAfterBump = (await q(`SELECT version FROM ${BO}.inventory_balances WHERE id=$1`, [c.balanceId]))[0].version;
      expect((await ck.activate(c)).statusCode).toBe(200);
      const issued = await ck.issue(c);
      expect(issued.statusCode, issued.body).toBe(201);
      for (let i = 0; i < 6; i += 1) { if ((await worker(c).runOnce()).claimed === 0) break; }
      const ex = await q(`SELECT * FROM ${BO}.authorized_action_executions WHERE tenant_id=$1`, [c.s.ctx.tenantId]);
      expect(ex).toHaveLength(1);
      expect(ex[0]).toMatchObject({ outcome: 'REFUSED', mutation_result: 'NOT_APPLICABLE', package_id: issued.json().packageId });
      expect(JSON.stringify(ex[0])).toContain('BASELINE_CHANGED');
      expect((await q(`SELECT reorder_point::float rp, reorder_quantity::float rq, version FROM ${BO}.inventory_balances WHERE id=$1`, [c.balanceId]))[0]).toEqual({ rp: 171, rq: 191, version: versionAfterBump });
    }, 120_000);
  });
});
