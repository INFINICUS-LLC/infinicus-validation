/**
 * AC-2 Block 5 - Business Intelligence evidence for the first action (real PostgreSQL, production buildApp).
 *
 * DAL-ingested BO truth -> BI evidence (metric calculations + an insight package version referencing them). BI is descriptive and never fabricates; every metric
 * carries the BO fact digest (the same digest the BO derivation computes), the BO capture time and the evidence expiry; BI writes only BI tables; BO is untouched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { loadConfig } from '@infinicus/configuration';
import { closePool, createPool, MembershipRepository, RoleRepository, UserRepository, type TenantContext } from '@infinicus/database';
import { ReorderPolicyDerivationService } from '@infinicus/business-operations-runtime';
import { buildApp } from '../src/app.js';
import { buildInventoryBiEvidenceService } from '../src/inventoryBiEvidenceComposition.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';
import { STRONG_PASSWORD, daysAgo, dalKit, firstActionRecords, unique, type World } from './helpers/dalIngestion.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const RULE_SET = 'inventory-reorder-policy/v1.1.0';

let app: FastifyInstance;
let admin: Pool;
const tenantIds: string[] = [];
let kit: ReturnType<typeof dalKit>;

const put = (w: { ctx: TenantContext; token: string }, url: string, payload: unknown) =>
  app.inject({ method: 'PUT', url, headers: kit.headers(w, { 'idempotency-key': unique('key') }), payload: payload as never });
const evidenceUrl = (w: World, itemId: string) => `/v1/businesses/${w.businessId}/inventory-items/${itemId}/bi-evidence`;
const publish = (w: { ctx: TenantContext; token: string; businessId: string }, itemId: string, body: unknown = { ruleSetVersion: RULE_SET }, key = unique('key')) =>
  app.inject({ method: 'POST', url: `/v1/businesses/${w.businessId}/inventory-items/${itemId}/bi-evidence`, headers: kit.headers(w, { 'idempotency-key': key }), payload: body as never });

/** DAL -> BO, then the BO-owned baseline and the declared currency. */
async function ready(over: { records?: Record<string, unknown>[]; currency?: string; baseline?: boolean } = {}) {
  const w = await kit.world();
  const ids = await kit.ingestFirstAction(w, 'SKU-A', 'WH-A', over.records);
  if (over.baseline !== false) expect((await put(w, `/v1/businesses/${w.businessId}/inventory-items/${ids.itemId}/warehouses/${ids.warehouseId}/initial-reorder-policy`, { reorderPoint: 170, reorderQuantity: 190 })).statusCode).toBe(200);
  expect((await put(w, `/v1/businesses/${w.businessId}/declared-currency`, { currency: over.currency ?? 'USD', expectedVersion: null, reason: 'initial declaration' })).statusCode).toBe(201);
  return { w, ...ids };
}
const biCounts = async (w: World) => ({
  metricValues: Number((await admin.query(`SELECT count(*) n FROM business_intelligence.metric_calculated_values WHERE business_id=$1`, [w.businessId])).rows[0].n),
  versions: Number((await admin.query(`SELECT count(*) n FROM business_intelligence.insight_package_versions WHERE business_id=$1`, [w.businessId])).rows[0].n),
  definitions: Number((await admin.query(`SELECT count(*) n FROM business_intelligence.metric_definitions WHERE business_id=$1`, [w.businessId])).rows[0].n),
});
const boSnapshot = async (w: World) => JSON.stringify(await Promise.all([
  'business_operations.inventory_balances', 'business_operations.inventory_movements', 'platform.inventory_items', 'platform.warehouses',
].map(async (t) => (await admin.query(`SELECT * FROM ${t} WHERE business_id = $1 ORDER BY id`, [w.businessId])).rows)));

describe.runIf(run)('AC-2 Block 5: BI evidence of the first action', () => {
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    await app.ready();
    kit = dalKit({ app, admin, tenantIds });
  });
  afterAll(async () => {
    await app?.close();
    if (tenantIds.length > 0) {
      const c = await admin.connect();
      try { await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'"); await c.query('DELETE FROM audit.audit_events WHERE tenant_id = ANY($1)', [tenantIds]); await c.query('COMMIT'); }
      catch { await c.query('ROLLBACK').catch(() => undefined); } finally { c.release(); }
      await deleteMovementsForTenants(admin, tenantIds);
    }
    await admin?.end(); await closePool();
  });

  it('publishes the descriptive evidence: demand, stock and receipt cost, each with the BO fact digest, capture time and expiry - and BI writes nothing in BO', async () => {
    const { w, itemId, balanceId } = await ready();
    const before = await boSnapshot(w);
    const res = await publish(w, itemId);
    expect(res.statusCode, res.body).toBe(201);
    const out = res.json();
    expect(out).toMatchObject({ outcome: 'PUBLISHED', versionNumber: 1 });
    expect(Object.keys(out.metricValueIds).sort()).toEqual(['inventory.demand.issued_units', 'inventory.receipt.latest_cost_per_unit', 'inventory.stock.on_hand_units']);
    expect(Date.parse(out.validUntil) - Date.parse(out.capturedAt)).toBe(24 * 3_600_000); // the approved rule set's evidence maximum age

    const rows = (await admin.query(
      `SELECT d.metric_code, v.value::text value, v.unit, v.currency_code, v.dimensions, v.evidence_reference, v.calculation_status, v.confidence
         FROM business_intelligence.metric_calculated_values v JOIN business_intelligence.metric_definitions d ON d.id = v.metric_definition_id
        WHERE v.business_id = $1 ORDER BY d.metric_code`, [w.businessId])).rows;
    expect(rows.map((r: any) => r.metric_code)).toEqual(['inventory.demand.issued_units', 'inventory.receipt.latest_cost_per_unit', 'inventory.stock.on_hand_units']);
    const by = Object.fromEntries(rows.map((r: any) => [r.metric_code, r]));
    expect(Number(by['inventory.demand.issued_units'].value)).toBe(900);
    expect(by['inventory.demand.issued_units'].dimensions).toMatchObject({ inventoryItemId: itemId, observations: 12, windowDays: 90, demandMovementTypes: ['issue'] });
    expect(Number(by['inventory.stock.on_hand_units'].value)).toBe(100);
    expect(by['inventory.stock.on_hand_units'].dimensions).toMatchObject({ balanceId, reorderPoint: '170.0000', reorderQuantity: '190.0000' });
    expect(Number(by['inventory.receipt.latest_cost_per_unit'].value)).toBe(10);
    expect(by['inventory.receipt.latest_cost_per_unit']).toMatchObject({ currency_code: 'USD' });
    expect(by['inventory.receipt.latest_cost_per_unit'].dimensions).toMatchObject({ currencyConsistent: true });
    for (const r of rows) {
      expect(r).toMatchObject({ calculation_status: 'completed', confidence: null }); // descriptive: no invented confidence
      expect(r.evidence_reference).toMatchObject({ source: 'BO', kind: 'bo_inventory_policy_facts', factsDigest: out.factsDigest, ruleSetVersion: RULE_SET, validUntil: out.validUntil });
      expect(r.dimensions).toMatchObject({ factsDigest: out.factsDigest, boCapturedAt: out.capturedAt });
    }
    // the digest is the SAME one the BO derivation computes from BO truth: BI evidence and BO facts provably describe the same state
    const derived = await new ReorderPolicyDerivationService().derive(w.ctx, { businessId: w.businessId, itemId, ruleSetVersion: RULE_SET });
    expect(derived.evidence!.snapshotDigest).toBe(out.factsDigest);
    // one insight package version referencing the three calculations by id; nothing in BO changed
    const version = (await admin.query(`SELECT metric_value_ids, summary FROM business_intelligence.insight_package_versions WHERE id=$1`, [out.insightPackageVersionId])).rows[0];
    expect([...version.metric_value_ids].sort()).toEqual(Object.values(out.metricValueIds).sort());
    expect(version.summary).toContain(out.factsDigest);
    expect(await boSnapshot(w)).toBe(before);
  });

  it('the stored evidence reads back through the BI service (the read side the Digital Twin and ADI will use)', async () => {
    const { w, itemId } = await ready();
    const out = (await publish(w, itemId)).json();
    const latest = await buildInventoryBiEvidenceService().getLatest(w.ctx, w.businessId, itemId);
    expect(latest).toMatchObject({ insightPackageVersionId: out.insightPackageVersionId, versionNumber: 1, factsDigest: out.factsDigest, validUntil: out.validUntil, ruleSetVersion: RULE_SET });
    expect(latest!.metrics['inventory.demand.issued_units']).toMatchObject({ value: 900, exact: '900.0000', unit: 'unit' });
    expect(latest!.metrics['inventory.receipt.latest_cost_per_unit']).toMatchObject({ exact: '10.0000', currencyCode: 'USD' });
    expect(await buildInventoryBiEvidenceService().getLatest(w.ctx, w.businessId, '11111111-1111-4111-8111-111111111111')).toBeNull();
  });

  it('is append-only: a new request appends a new version and new calculations, reusing the metric definitions', async () => {
    const { w, itemId } = await ready();
    const first = (await publish(w, itemId)).json();
    const defsAfterFirst = (await biCounts(w)).definitions;
    const second = (await publish(w, itemId)).json();
    expect(second.versionNumber).toBe(2);
    expect(second.insightPackageId).toBe(first.insightPackageId);
    expect(second.insightPackageVersionId).not.toBe(first.insightPackageVersionId);
    expect(await biCounts(w)).toEqual({ metricValues: 6, versions: 2, definitions: defsAfterFirst });
    expect(first.factsDigest).toBe(second.factsDigest); // unchanged BO facts -> the same digest
    expect((await buildInventoryBiEvidenceService().getLatest(w.ctx, w.businessId, itemId))!.versionNumber).toBe(2);
  });

  it('never fabricates: a receipt without a cost publishes demand and stock only, and says so', async () => {
    const records = firstActionRecords('SKU-A', 'WH-A').map((r) => (r.recordType === 'inventory_movement' && (r.data as any).movementType === 'receipt'
      ? { ...r, data: { sku: 'SKU-A', warehouseCode: 'WH-A', movementType: 'receipt', quantity: 1000, occurredAt: daysAgo(5), referenceType: 'manual' } } : r));
    const { w, itemId } = await ready({ records });
    const out = (await publish(w, itemId)).json();
    expect(Object.keys(out.metricValueIds).sort()).toEqual(['inventory.demand.issued_units', 'inventory.stock.on_hand_units']);
    const summary = (await admin.query(`SELECT summary FROM business_intelligence.insight_package_versions WHERE id=$1`, [out.insightPackageVersionId])).rows[0].summary as string;
    expect(summary).toContain('no receipt cost recorded');
  });

  it('records an inconsistent currency as a fact (the receipt is USD, the business declares EUR); the sufficiency decision is downstream', async () => {
    const { w, itemId } = await ready({ currency: 'EUR' });
    const out = (await publish(w, itemId)).json();
    const cost = (await admin.query(`SELECT v.currency_code, v.dimensions FROM business_intelligence.metric_calculated_values v WHERE v.id=$1`, [out.metricValueIds['inventory.receipt.latest_cost_per_unit']])).rows[0];
    expect(cost.currency_code).toBe('USD');
    expect(cost.dimensions).toMatchObject({ currencyConsistent: false });
  });

  it('publishes nothing - and persists nothing - when the item is unknown, has no balance, or the rule set is not approved', async () => {
    const { w, itemId } = await ready();
    const unknown = await publish(w, '11111111-1111-4111-8111-111111111111');
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json()).toMatchObject({ outcome: 'NOT_PUBLISHED', code: 'TARGET_NOT_FOUND' });
    const badRuleSet = await publish(w, itemId, { ruleSetVersion: 'inventory-reorder-policy/v0.1.0-DRAFT' });
    expect(badRuleSet.json()).toMatchObject({ outcome: 'NOT_PUBLISHED', code: 'INVALID_REQUEST' });
    // an item that exists but has no balance (no movement ever created one)
    const lone = await kit.publishThroughDal(w, [{ recordType: 'inventory_item', data: { sku: 'SKU-LONE', name: 'Lonely' } }]);
    expect((await kit.boIntake(w, lone.packageId)).statusCode).toBe(200);
    const loneId = (await admin.query(`SELECT id FROM platform.inventory_items WHERE business_id=$1 AND sku='SKU-LONE'`, [w.businessId])).rows[0].id as string;
    expect((await publish(w, loneId)).json()).toMatchObject({ outcome: 'NOT_PUBLISHED', code: 'BALANCE_UNAVAILABLE' });
    expect(await biCounts(w)).toEqual({ metricValues: 0, versions: 0, definitions: 0 });
  });

  it('is atomic: a failure while publishing the version leaves NO metric calculation behind', async () => {
    const { w, itemId } = await ready();
    const failing = buildInventoryBiEvidenceService({ packages: { findByCode: async () => null, create: async () => ({ id: '00000000-0000-4000-8000-000000000001' } as never), publishVersion: async () => { throw new Error('boom'); }, findLatestVersion: async () => null, findVersionById: async () => { throw new Error('unused'); } } });
    await expect(failing.publish(w.ctx, { businessId: w.businessId, itemId, ruleSetVersion: RULE_SET })).rejects.toThrow('boom');
    expect(await biCounts(w)).toEqual({ metricValues: 0, versions: 0, definitions: 0 });
  });

  it('enforces the boundary: authentication, bi:write, tenant scope, strict body and Idempotency-Key; a request replay returns the stored response', async () => {
    const { w, itemId } = await ready();
    const url = evidenceUrl(w, itemId);
    expect((await app.inject({ method: 'POST', url, headers: { 'idempotency-key': unique('k'), 'x-tenant-id': w.ctx.tenantId, 'x-workspace-id': w.ctx.workspaceId }, payload: { ruleSetVersion: RULE_SET } })).statusCode).toBe(401);
    // a viewer holds bi:read only
    const email = `${unique('viewer')}@ac2.example`;
    const reg = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: STRONG_PASSWORD } });
    const viewerId = reg.json().id as string;
    await new UserRepository().activate(viewerId);
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: STRONG_PASSWORD } });
    const vctx: TenantContext = { ...w.ctx, userId: viewerId };
    const memberships = new MembershipRepository();
    const m = await memberships.create(vctx, viewerId); await memberships.activate(vctx, m.id);
    await memberships.assignRole(vctx, m.id, (await new RoleRepository().getByCode(vctx, 'viewer')).id);
    expect((await publish({ ctx: vctx, token: login.json().rawSessionToken, businessId: w.businessId }, itemId)).statusCode).toBe(403);
    // another tenant cannot reach this business
    const other = await kit.world();
    expect((await publish({ ...other, businessId: w.businessId }, itemId)).statusCode).toBe(404);
    // strict body, no default rule set, and the Idempotency-Key is required
    expect((await publish(w, itemId, {})).statusCode).toBe(400);
    expect((await publish(w, itemId, { ruleSetVersion: RULE_SET, extra: 1 })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url, headers: kit.headers(w), payload: { ruleSetVersion: RULE_SET } })).statusCode).toBe(400);
    expect(await biCounts(w)).toEqual({ metricValues: 0, versions: 0, definitions: 0 }); // no refusal persisted anything
    // same Idempotency-Key + same body replays the first response and writes nothing more
    const key = unique('replay');
    const a = await publish(w, itemId, { ruleSetVersion: RULE_SET }, key);
    const b = await publish(w, itemId, { ruleSetVersion: RULE_SET }, key);
    expect(a.statusCode).toBe(201);
    expect(b.json()).toEqual(a.json());
    expect((await biCounts(w)).versions).toBe(1);
  });

  it('tenant isolation: another tenant\'s service cannot read this tenant\'s evidence', async () => {
    const { w, itemId } = await ready();
    expect((await publish(w, itemId)).statusCode).toBe(201);
    const other = await kit.world();
    expect(await buildInventoryBiEvidenceService().getLatest(other.ctx, w.businessId, itemId)).toBeNull();
  });
});
