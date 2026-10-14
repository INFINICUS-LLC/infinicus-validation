/**
 * AC-2 Block 6 - Business Digital Twin current state of the first action's item (real PostgreSQL, production buildApp).
 *
 * BO truth (DAL-ingested) -> BI evidence -> BDT modeled state. The twin consumes BI evidence only, is derived (days of cover, average daily demand, policy
 * position) with references - not copies of operational facts - uses the existing snapshot lifecycle, is atomic, fails closed on missing / expired /
 * inconsistent evidence, and mutates nothing operational.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { loadConfig } from '@infinicus/configuration';
import { closePool, createPool, DigitalTwinSnapshotRepository, MembershipRepository, RoleRepository, UserRepository, type TenantContext } from '@infinicus/database';
import { buildApp } from '../src/app.js';
import { buildInventoryBiEvidenceService } from '../src/inventoryBiEvidenceComposition.js';
import { buildInventoryItemTwinService } from '../src/inventoryItemTwinComposition.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';
import { STRONG_PASSWORD, dalKit, unique, type World } from './helpers/dalIngestion.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const RULE_SET = 'inventory-reorder-policy/v1.1.0';
const HOUR = 3_600_000;

let app: FastifyInstance;
let admin: Pool;
const tenantIds: string[] = [];
let kit: ReturnType<typeof dalKit>;

const put = (w: { ctx: TenantContext; token: string }, url: string, payload: unknown) =>
  app.inject({ method: 'PUT', url, headers: kit.headers(w, { 'idempotency-key': unique('key') }), payload: payload as never });
const post = (w: { ctx: TenantContext; token: string }, url: string, payload: unknown = {}, key = unique('key')) =>
  app.inject({ method: 'POST', url, headers: kit.headers(w, { 'idempotency-key': key }), payload: payload as never });
const twinUrl = (w: { businessId: string }, itemId: string) => `/v1/businesses/${w.businessId}/inventory-items/${itemId}/twin-state`;

/** DAL -> BO, baseline, currency; optionally the BI evidence. */
async function ready(o: { evidence?: boolean } = {}) {
  const w = await kit.world();
  const ids = await kit.ingestFirstAction(w, 'SKU-A', 'WH-A');
  expect((await put(w, `/v1/businesses/${w.businessId}/inventory-items/${ids.itemId}/warehouses/${ids.warehouseId}/initial-reorder-policy`, { reorderPoint: 170, reorderQuantity: 190 })).statusCode).toBe(200);
  expect((await put(w, `/v1/businesses/${w.businessId}/declared-currency`, { currency: 'USD', expectedVersion: null, reason: 'initial declaration' })).statusCode).toBe(201);
  let bi: any = null;
  if (o.evidence !== false) {
    const res = await post(w, `/v1/businesses/${w.businessId}/inventory-items/${ids.itemId}/bi-evidence`, { ruleSetVersion: RULE_SET });
    expect(res.statusCode, res.body).toBe(201);
    bi = res.json();
  }
  return { w, ...ids, bi };
}
const dtCounts = async (w: World) => ({
  definitions: Number((await admin.query(`SELECT count(*) n FROM business_digital_twin.digital_twin_definitions WHERE business_id=$1`, [w.businessId])).rows[0].n),
  instances: Number((await admin.query(`SELECT count(*) n FROM business_digital_twin.digital_twin_instances WHERE business_id=$1`, [w.businessId])).rows[0].n),
  snapshots: Number((await admin.query(`SELECT count(*) n FROM business_digital_twin.digital_twin_snapshots WHERE business_id=$1`, [w.businessId])).rows[0].n),
});
const boSnapshot = async (w: World) => JSON.stringify(await Promise.all([
  'business_operations.inventory_balances', 'business_operations.inventory_movements', 'platform.inventory_items', 'platform.warehouses',
].map(async (t) => (await admin.query(`SELECT * FROM ${t} WHERE business_id = $1 ORDER BY id`, [w.businessId])).rows)));

describe.runIf(run)('AC-2 Block 6: BDT current state of the first action\'s item', () => {
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

  it('publishes the modeled state through the existing lifecycle: derived values, references to the BI evidence, evidence rows, effective at the BO capture time - and BO is untouched', async () => {
    const { w, itemId, balanceId, bi } = await ready();
    const before = await boSnapshot(w);
    const res = await post(w, twinUrl(w, itemId));
    expect(res.statusCode, res.body).toBe(201);
    const out = res.json();
    expect(out).toMatchObject({ outcome: 'PUBLISHED', factsDigest: bi.factsDigest, effectiveAt: bi.capturedAt, validUntil: bi.validUntil });
    // 900 units / 90 days = 10 per day; 100 on hand = 10 days of cover; 100 <= the configured point 170
    expect(out.state).toMatchObject({
      schema: 'inventory-item-twin-state/1', model: { name: 'inventory-item-state', version: '1', method: 'DETERMINISTIC_RATIO' }, inventoryItemId: itemId, observedAt: bi.capturedAt,
      derived: { avgDailyDemand: 10, daysOfCover: 10, policyPosition: 'AT_OR_BELOW_REORDER_POINT', demandObservations: 12, windowDays: 90 },
      references: { biInsightPackageId: bi.insightPackageId, biInsightPackageVersionId: bi.insightPackageVersionId, biVersionNumber: 1, boBalanceId: balanceId, ruleSetVersion: RULE_SET },
    });
    expect(Object.keys(out.state.references.biMetricValueIds).sort()).toEqual(Object.keys(bi.metricValueIds).sort());

    const snap = (await admin.query(`SELECT s.status, s.effective_at, sv.status vstatus, sv.version_number FROM business_digital_twin.digital_twin_snapshots s JOIN business_digital_twin.digital_twin_snapshot_versions sv ON sv.snapshot_id = s.id WHERE s.id=$1`, [out.snapshotId])).rows[0];
    expect(snap).toMatchObject({ status: 'published', vstatus: 'published', version_number: 1 });
    expect(new Date(snap.effective_at).toISOString()).toBe(bi.capturedAt);
    const evidence = (await admin.query(`SELECT evidence_type, evidence_reference FROM business_digital_twin.digital_twin_snapshot_evidence WHERE snapshot_version_id=$1 ORDER BY evidence_type`, [out.snapshotVersionId])).rows;
    expect(evidence.map((e: any) => e.evidence_type)).toEqual(['bi_insight_package_version', 'bo_inventory_policy_facts']);
    expect(evidence[0].evidence_reference).toMatchObject({ insightPackageVersionId: bi.insightPackageVersionId, factsDigest: bi.factsDigest });
    expect(evidence[1].evidence_reference).toMatchObject({ digest: bi.factsDigest, balanceId });
    // the twin is NOT a second operational source of truth: no raw BO fact (stock count, cost, currency) is restated in it, and BO did not change
    const storedState = (await admin.query(`SELECT value_json FROM business_digital_twin.digital_twin_snapshot_values WHERE snapshot_version_id=$1`, [out.snapshotVersionId])).rows[0].value_json;
    delete storedState.references.biMetricValueIds; // metric CODES are the keys of this id map; every other part of the state is checked
    expect(JSON.stringify(storedState)).not.toMatch(/quantityOnHand|onHand|unitCost|cost|currency|USD|reorderPoint|reorderQuantity/i);
    expect(await boSnapshot(w)).toBe(before);
  });

  it('reads back through the twin service and satisfies the existing freshness assessment (usable until a newer snapshot is published)', async () => {
    const { w, itemId } = await ready();
    const out = (await post(w, twinUrl(w, itemId))).json();
    const latest = await buildInventoryItemTwinService().getLatest(w.ctx, w.businessId, itemId);
    expect(latest).toMatchObject({ snapshotId: out.snapshotId, state: { inventoryItemId: itemId, derived: { daysOfCover: 10 } } });
    expect(await new DigitalTwinSnapshotRepository().assessFreshness(w.ctx, w.businessId, out.snapshotId)).toEqual({ usable: true, newerPublishedExists: false });
    // BI publishes newer evidence, the twin is re-derived: the earlier snapshot is superseded under the P0-3 rule (fail closed), the instance and definition are reused
    await new Promise((r) => setTimeout(r, 1200)); // the BO capture time has one-second resolution
    expect((await post(w, `/v1/businesses/${w.businessId}/inventory-items/${itemId}/bi-evidence`, { ruleSetVersion: RULE_SET })).statusCode).toBe(201);
    const second = (await post(w, twinUrl(w, itemId))).json();
    expect(second.snapshotId).not.toBe(out.snapshotId);
    expect(second.instanceId).toBe(out.instanceId);
    expect(await dtCounts(w)).toEqual({ definitions: 1, instances: 1, snapshots: 2 });
    expect(await new DigitalTwinSnapshotRepository().assessFreshness(w.ctx, w.businessId, out.snapshotId)).toEqual({ usable: true, newerPublishedExists: true });
    expect((await buildInventoryItemTwinService().getLatest(w.ctx, w.businessId, itemId))!.snapshotId).toBe(second.snapshotId);
  });

  it('fails closed on missing BI evidence: nothing is published and no twin structure is created', async () => {
    const { w, itemId } = await ready({ evidence: false });
    const res = await post(w, twinUrl(w, itemId));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outcome: 'NOT_PUBLISHED', code: 'BI_EVIDENCE_MISSING' });
    expect(await dtCounts(w)).toEqual({ definitions: 0, instances: 0, snapshots: 0 });
  });

  it('fails closed on EXPIRED evidence (past the rule set\'s maximum age)', async () => {
    const { w, itemId } = await ready();
    const later = buildInventoryItemTwinService({ now: () => new Date(Date.now() + 25 * HOUR) });
    expect(await later.publish(w.ctx, { businessId: w.businessId, itemId })).toMatchObject({ outcome: 'NOT_PUBLISHED', code: 'BI_EVIDENCE_EXPIRED' });
    expect(await dtCounts(w)).toEqual({ definitions: 0, instances: 0, snapshots: 0 });
  });

  it('fails closed on an inconsistent evidence set (a metric whose fact digest differs from its version) and on an incomplete one', async () => {
    const { w, itemId, bi } = await ready();
    // fixture surgery: the BI rows are append-only, so a superuser suspends the guard triggers in ONE transaction to corrupt the demand metric's digest
    const c = await admin.connect();
    try {
      await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'");
      await c.query(`UPDATE business_intelligence.metric_calculated_values SET dimensions = jsonb_set(dimensions, '{factsDigest}', '"sha256:tampered"') WHERE id = $1`, [bi.metricValueIds['inventory.demand.issued_units']]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
    expect((await post(w, twinUrl(w, itemId))).json()).toMatchObject({ outcome: 'NOT_PUBLISHED', code: 'BI_EVIDENCE_INCONSISTENT' });
    // an evidence view without the stock metric (no database needed to reach this refusal)
    const incomplete = buildInventoryItemTwinService({ bi: { getLatest: async () => ({ ...(await buildInventoryBiEvidenceService().getLatest(w.ctx, w.businessId, itemId))!, metrics: {} }) } });
    expect(await incomplete.publish(w.ctx, { businessId: w.businessId, itemId })).toMatchObject({ outcome: 'NOT_PUBLISHED', code: 'BI_EVIDENCE_INCOMPLETE' });
    expect(await dtCounts(w)).toEqual({ definitions: 0, instances: 0, snapshots: 0 });
  });

  it('is atomic: a failure while publishing leaves no definition, instance, snapshot, value or evidence behind', async () => {
    const { w, itemId } = await ready();
    const real = new DigitalTwinSnapshotRepository();
    const failing = buildInventoryItemTwinService({ snapshots: { createSnapshot: real.createSnapshot.bind(real), addValue: real.addValue.bind(real), addEvidence: real.addEvidence.bind(real), validateSnapshot: real.validateSnapshot.bind(real), publishSnapshot: async () => { throw new Error('boom'); }, getPublishedForInstance: real.getPublishedForInstance.bind(real), getValuesForPublishedSnapshot: real.getValuesForPublishedSnapshot.bind(real) } });
    await expect(failing.publish(w.ctx, { businessId: w.businessId, itemId })).rejects.toThrow('boom');
    expect(await dtCounts(w)).toEqual({ definitions: 0, instances: 0, snapshots: 0 });
    expect(Number((await admin.query(`SELECT count(*) n FROM business_digital_twin.digital_twin_snapshot_values WHERE business_id=$1`, [w.businessId])).rows[0].n)).toBe(0);
  });

  it('enforces the boundary: authentication, dt:write, tenant scope, an empty strict body and the Idempotency-Key; a replay returns the stored response', async () => {
    const { w, itemId } = await ready();
    const url = twinUrl(w, itemId);
    expect((await app.inject({ method: 'POST', url, headers: { 'idempotency-key': unique('k'), 'x-tenant-id': w.ctx.tenantId, 'x-workspace-id': w.ctx.workspaceId }, payload: {} })).statusCode).toBe(401);
    const email = `${unique('viewer')}@ac2.example`;
    const reg = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: STRONG_PASSWORD } });
    const viewerId = reg.json().id as string;
    await new UserRepository().activate(viewerId);
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: STRONG_PASSWORD } });
    const vctx: TenantContext = { ...w.ctx, userId: viewerId };
    const memberships = new MembershipRepository();
    const m = await memberships.create(vctx, viewerId); await memberships.activate(vctx, m.id);
    await memberships.assignRole(vctx, m.id, (await new RoleRepository().getByCode(vctx, 'viewer')).id);
    expect((await post({ ctx: vctx, token: login.json().rawSessionToken }, url)).statusCode).toBe(403);
    const other = await kit.world();
    expect((await post(other, url)).statusCode).toBe(404);
    expect((await post(w, url, { factsDigest: 'sha256:whatever' })).statusCode).toBe(400); // the caller can assert nothing
    expect((await app.inject({ method: 'POST', url, headers: kit.headers(w), payload: {} })).statusCode).toBe(400);
    expect(await dtCounts(w)).toEqual({ definitions: 0, instances: 0, snapshots: 0 });
    const key = unique('replay');
    const a = await post(w, url, {}, key); const b = await post(w, url, {}, key);
    expect(a.statusCode).toBe(201);
    expect(b.json()).toEqual(a.json());
    expect((await dtCounts(w)).snapshots).toBe(1);
  });

  it('tenant isolation: another tenant cannot read this tenant\'s twin state', async () => {
    const { w, itemId } = await ready();
    expect((await post(w, twinUrl(w, itemId))).statusCode).toBe(201);
    const other = await kit.world();
    expect(await buildInventoryItemTwinService().getLatest(other.ctx, w.businessId, itemId)).toBeNull();
  });
});
