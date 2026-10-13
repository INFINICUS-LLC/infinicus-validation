/**
 * AC-2 Block 4 - Business Operations is the canonical operational truth for what Data Acquisition delivered (real PostgreSQL, production buildApp).
 *
 * Data Acquisition output (Block 3) becomes BO truth; BO's OWN reader and the first-action derivation consume it; the baseline reorder policy is stated by
 * a BO-owned, audited, once-only route (owner ruling D2); the declared currency is a business-admin act (D3). DAL is never consulted by BO readers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { loadConfig } from '@infinicus/configuration';
import {
  closePool, createPool, InventoryPolicyFactsRepository, MembershipRepository, RoleRepository, UserRepository, type TenantContext,
} from '@infinicus/database';
import { ReorderPolicyDerivationService } from '@infinicus/business-operations-runtime';
import { buildApp } from '../src/app.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';
import { STRONG_PASSWORD, dalKit, firstActionRecords, unique, type World } from './helpers/dalIngestion.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;

let app: FastifyInstance;
let admin: Pool;
const tenantIds: string[] = [];
let kit: ReturnType<typeof dalKit>;

const baselineUrl = (w: World, itemId: string, warehouseId: string) => `/v1/businesses/${w.businessId}/inventory-items/${itemId}/warehouses/${warehouseId}/initial-reorder-policy`;
const put = (w: { ctx: TenantContext; token: string }, url: string, payload: unknown, key = unique('key')) =>
  app.inject({ method: 'PUT', url, headers: kit.headers(w, { 'idempotency-key': key }), payload: payload as never });

/** DAL -> BO for the first-action facts; returns the canonical identifiers BO generated. */
async function ingested(): Promise<{ w: World; itemId: string; warehouseId: string; balanceId: string }> {
  const w = await kit.world();
  const { packageId } = await kit.publishThroughDal(w, firstActionRecords('SKU-A', 'WH-A'));
  expect((await kit.boIntake(w, packageId)).statusCode).toBe(200);
  const itemId = (await admin.query(`SELECT id FROM platform.inventory_items WHERE business_id=$1`, [w.businessId])).rows[0].id as string;
  const warehouseId = (await admin.query(`SELECT id FROM platform.warehouses WHERE business_id=$1`, [w.businessId])).rows[0].id as string;
  const balanceId = (await admin.query(`SELECT id FROM business_operations.inventory_balances WHERE business_id=$1`, [w.businessId])).rows[0].id as string;
  return { w, itemId, warehouseId, balanceId };
}
const derive = (w: World, itemId: string) => new ReorderPolicyDerivationService().derive(w.ctx, { businessId: w.businessId, itemId, ruleSetVersion: 'inventory-reorder-policy/v1.1.0' });
const snapshotOf = (w: World, itemId: string) => new InventoryPolicyFactsRepository().loadSnapshot(w.ctx, { businessId: w.businessId, inventoryItemId: itemId, windowDays: 90, demandMovementTypes: ['issue'] });

describe.runIf(run)('AC-2 Block 4: Business Operations canonical truth for DAL-ingested first-action facts', () => {
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
      try {
        await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'");
        await c.query('DELETE FROM audit.audit_events WHERE tenant_id = ANY($1)', [tenantIds]);
        await c.query('COMMIT');
      } catch { await c.query('ROLLBACK').catch(() => undefined); } finally { c.release(); }
      await deleteMovementsForTenants(admin, tenantIds);
    }
    await admin?.end(); await closePool();
  });

  it('BO\'s own facts reader sees the ingested truth: an active item, one balance, the latest receipt cost and currency, and the dated demand history', async () => {
    const { w, itemId, warehouseId, balanceId } = await ingested();
    const s = await snapshotOf(w, itemId);
    expect(s.item).toMatchObject({ id: itemId });
    expect(s.balances).toEqual([{ id: balanceId, warehouseId, reorderPoint: expect.stringMatching(/^0(\.0+)?$/), reorderQuantity: expect.stringMatching(/^0(\.0+)?$/) }]);
    expect(s.latestReceipt).toMatchObject({ unitCostCurrency: 'USD' });
    expect(Number(s.latestReceipt!.unitCost)).toBe(10);
    expect(s.demand.count).toBe(12);
    expect(Number(s.demand.sumOfMagnitudes)).toBe(900);
  });

  it('with the baseline unset and no declared currency BO derives NOTHING: DAL cannot manufacture a recommendation or a policy', async () => {
    const { w, itemId } = await ingested();
    const r = await derive(w, itemId);
    expect(r.derivation).toMatchObject({ outcome: 'NONE', code: 'EVIDENCE_UNAVAILABLE' });
    expect((r.derivation as { reasonCodes: string[] }).reasonCodes).toContain('BASELINE_UNSET_OR_ZERO');
  });

  it('the first policy is stated through the BO-owned route: bo:admin, audited atomically, state UNSET -> CONFIGURED, version bumped', async () => {
    const { w, itemId, warehouseId, balanceId } = await ingested();
    const res = await put(w, baselineUrl(w, itemId, warehouseId), { reorderPoint: 170, reorderQuantity: 190 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ balanceId, applied: true, before: { state: 'UNSET', reorderPoint: '0', reorderQuantity: '0' }, after: { state: 'CONFIGURED', reorderPoint: '170', reorderQuantity: '190' } });
    expect(res.json().after.version).toBe(res.json().before.version + 1);
    const row = (await admin.query(`SELECT reorder_policy_state st, reorder_point::text rp, reorder_quantity::text rq FROM business_operations.inventory_balances WHERE id=$1`, [balanceId])).rows[0];
    expect(row).toMatchObject({ st: 'CONFIGURED' }); expect(Number(row.rp)).toBe(170); expect(Number(row.rq)).toBe(190);
    const audit = (await admin.query(`SELECT actor_id, business_id, entity_id, metadata FROM audit.audit_events WHERE tenant_id=$1 AND action='bo.reorder_policy.initial_configured'`, [w.ctx.tenantId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_id: w.ctx.userId, business_id: w.businessId, entity_id: balanceId });
    expect(audit[0].metadata).toMatchObject({ permissionUsed: 'bo:admin', source: 'BO_COMMAND', before: { state: 'UNSET' }, after: { state: 'CONFIGURED' } });
  });

  it('changing a configured policy is NOT possible here (that stays an authorized action): the second call is 409 and nothing changes', async () => {
    const { w, itemId, warehouseId, balanceId } = await ingested();
    expect((await put(w, baselineUrl(w, itemId, warehouseId), { reorderPoint: 170, reorderQuantity: 190 })).statusCode).toBe(200);
    const again = await put(w, baselineUrl(w, itemId, warehouseId), { reorderPoint: 500, reorderQuantity: 900 });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('ReorderPolicyAlreadyConfiguredError');
    const row = (await admin.query(`SELECT reorder_point::text rp, reorder_quantity::text rq, version FROM business_operations.inventory_balances WHERE id=$1`, [balanceId])).rows[0];
    expect([Number(row.rp), Number(row.rq)]).toEqual([170, 190]);
    expect(await kit.count(`SELECT count(*) n FROM audit.audit_events WHERE tenant_id=$1 AND action='bo.reorder_policy.initial_configured'`, [w.ctx.tenantId])).toBe(1);
  });

  it('the route refuses what it must: unauthenticated, without bo:admin, wrong scope, no balance, non-positive or unknown values, a missing Idempotency-Key', async () => {
    const { w, itemId, warehouseId } = await ingested();
    const url = baselineUrl(w, itemId, warehouseId);
    expect((await app.inject({ method: 'PUT', url, headers: { 'idempotency-key': unique('k'), 'x-tenant-id': w.ctx.tenantId, 'x-workspace-id': w.ctx.workspaceId }, payload: { reorderPoint: 1, reorderQuantity: 1 } })).statusCode).toBe(401);
    // a viewer in the same tenant holds no bo:admin
    const email = `${unique('viewer')}@ac2.example`;
    const reg = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: STRONG_PASSWORD } });
    const viewerId = reg.json().id as string;
    await new UserRepository().activate(viewerId);
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: STRONG_PASSWORD } });
    const vctx: TenantContext = { ...w.ctx, userId: viewerId };
    const memberships = new MembershipRepository();
    const m = await memberships.create(vctx, viewerId); await memberships.activate(vctx, m.id);
    await memberships.assignRole(vctx, m.id, (await new RoleRepository().getByCode(vctx, 'viewer')).id);
    expect((await put({ ctx: vctx, token: login.json().rawSessionToken }, url, { reorderPoint: 1, reorderQuantity: 1 })).statusCode).toBe(403);
    // another tenant cannot reach this business
    const other = await kit.world();
    expect((await put(other, baselineUrl({ ...w }, itemId, warehouseId), { reorderPoint: 1, reorderQuantity: 1 })).statusCode).toBe(404);
    // no balance for this item/warehouse pair
    const noBalance = await put(w, baselineUrl(w, itemId, '11111111-1111-4111-8111-111111111111'), { reorderPoint: 1, reorderQuantity: 1 });
    expect(noBalance.statusCode).toBeGreaterThanOrEqual(400);
    for (const bad of [{ reorderPoint: 0, reorderQuantity: 1 }, { reorderPoint: -5, reorderQuantity: 1 }, { reorderPoint: 1.00001, reorderQuantity: 1 }, { reorderPoint: 1, reorderQuantity: 1, extra: true }, { reorderPoint: '5', reorderQuantity: 1 }]) {
      expect((await put(w, url, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await app.inject({ method: 'PUT', url, headers: kit.headers(w), payload: { reorderPoint: 1, reorderQuantity: 1 } })).statusCode).toBe(400);
    expect(await kit.count(`SELECT count(*) n FROM business_operations.inventory_balances WHERE business_id=$1 AND reorder_policy_state='UNSET'`, [w.businessId])).toBe(1); // nothing was configured by any refusal
  });

  it('the application role cannot write the reorder fields directly: only the governed BO entry points can (migration 0196)', async () => {
    const { w, balanceId } = await ingested();
    const appPool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const c = await appPool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [w.ctx.tenantId]);
        await expect(c.query(`UPDATE business_operations.inventory_balances SET reorder_point = 999 WHERE id = $1`, [balanceId])).rejects.toThrow();
      } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
    } finally { await appPool.end(); }
    const row = (await admin.query(`SELECT reorder_point::text rp FROM business_operations.inventory_balances WHERE id=$1`, [balanceId])).rows[0];
    expect(Number(row.rp)).toBe(0);
  });

  it('DAL-ingested truth plus the BO baseline and the declared currency is sufficient: the BO derivation yields the compliant single step (175/190)', async () => {
    const { w, itemId, warehouseId } = await ingested();
    expect((await put(w, baselineUrl(w, itemId, warehouseId), { reorderPoint: 170, reorderQuantity: 190 })).statusCode).toBe(200);
    // D3: the explicit business-admin declaration (never a DAL fact)
    const declared = await put(w, `/v1/businesses/${w.businessId}/declared-currency`, { currency: 'USD', expectedVersion: null, reason: 'initial declaration' });
    expect(declared.statusCode, declared.body).toBe(201);
    const r = await derive(w, itemId);
    expect(r.derivation).toMatchObject({ outcome: 'CANDIDATE', ruleSetVersion: 'inventory-reorder-policy/v1.1.0', proposed: { reorderPoint: 175, reorderQuantity: 190 }, current: { reorderPoint: '170', reorderQuantity: '190' } });
    expect(r.evidence).toMatchObject({ ruleSetVersion: 'inventory-reorder-policy/v1.1.0' });
    // the derivation wrote nothing: still one audit row for the baseline, no evaluation rows
    expect(await kit.count(`SELECT count(*) n FROM business_operations.inventory_policy_evaluations WHERE business_id=$1`, [w.businessId])).toBe(0);
  });
});
