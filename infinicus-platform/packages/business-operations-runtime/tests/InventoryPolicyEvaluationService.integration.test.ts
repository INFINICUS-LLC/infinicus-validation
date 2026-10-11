/**
 * Block B2b - live PostgreSQL proof of the BO-owned evaluator: real facts repository, real declared-currency reader, real B2a evaluation table.
 * Requires DATABASE_URL (app_test_user, RLS enforced) and ADMIN_DATABASE_URL (superuser), migrated through 0187.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { closePool, createPool, InventoryPolicyEvaluationRepository, type TenantContext } from '@infinicus/database';
import { computeGovernanceSubjectDigest } from '@infinicus/handoff-contracts';
import {
  InventoryPolicyEvaluationService, InventoryPolicyEvaluationRefusedError, INVENTORY_REORDER_POLICY_V1_0_0 as RS,
  INVENTORY_POLICY_EVALUATION_INPUTS_SCHEMA,
} from '../src/index.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';

const RUN = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const V = RS.version;
const PERM = 'bo:write';
const DAY = 86_400_000;

describe.runIf(RUN)('InventoryPolicyEvaluationService - live PostgreSQL', () => {
  let admin: Pool;
  const tenantIds: string[] = [];
  const service = new InventoryPolicyEvaluationService();
  const repo = new InventoryPolicyEvaluationRepository();

  interface W { ctx: TenantContext; businessId: string; itemId: string; warehouseId: string }

  async function world(o: { baseline?: [number, number] | null; declared?: string | null; receipt?: { cost: string | null; currency: string | null } | null; issues?: number; issueQty?: number; status?: string } = {}): Promise<W> {
    const tenantId = randomUUID(); const workspaceId = randomUUID(); const businessId = randomUUID(); const itemId = randomUUID(); const warehouseId = randomUUID();
    tenantIds.push(tenantId);
    const slug = `b2b${tenantId.slice(0, 8)}`;
    await admin.query('INSERT INTO tenancy.tenants (id, name, slug) VALUES ($1,$2,$3)', [tenantId, slug, slug]);
    await admin.query('INSERT INTO tenancy.workspaces (id, tenant_id, name, slug) VALUES ($1,$2,$3,$4)', [workspaceId, tenantId, slug, slug]);
    await admin.query('INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code) VALUES ($1,$2,$3,$4,$5)', [businessId, tenantId, workspaceId, slug, slug]);
    await admin.query(`INSERT INTO platform.inventory_items (id, tenant_id, workspace_id, business_id, sku, name, status) VALUES ($1,$2,$3,$4,$5,'Item',$6)`, [itemId, tenantId, workspaceId, businessId, `sku-${itemId}`, o.status ?? 'active']);
    await admin.query(`INSERT INTO platform.warehouses (id, tenant_id, workspace_id, business_id, warehouse_code, name) VALUES ($1,$2,$3,$4,$5,'WH')`, [warehouseId, tenantId, workspaceId, businessId, `wh-${warehouseId}`]);
    const baseline = o.baseline === undefined ? [100, 200] : o.baseline;
    if (baseline !== null) {
      await admin.query(`INSERT INTO business_operations.inventory_balances (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, reorder_point, reorder_quantity) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [tenantId, workspaceId, businessId, itemId, warehouseId, baseline[0], baseline[1]]);
    }
    const declared = o.declared === undefined ? 'USD' : o.declared;
    if (declared !== null) {
      await admin.query(`INSERT INTO platform.business_currency_declarations (tenant_id, workspace_id, business_id, version, declared_currency, provenance, declared_by_user_id, permission_used, correlation_id)
        VALUES ($1,$2,$3,1,$4,'EXPLICIT_DECLARATION',$5,'platform:admin',$6)`, [tenantId, workspaceId, businessId, declared, randomUUID(), randomUUID()]);
    }
    const receipt = o.receipt === undefined ? { cost: '10', currency: 'USD' } : o.receipt;
    const mv = (type: string, qty: number, cost: string | null, currency: string | null, at: Date) => admin.query(
      `INSERT INTO business_operations.inventory_movements (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity, unit_cost, unit_cost_currency, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [tenantId, workspaceId, businessId, itemId, warehouseId, type, qty, cost, currency, at]);
    if (receipt !== null) await mv('receipt', 500, receipt.cost, receipt.currency, new Date(Date.now() - 5 * DAY));
    for (let i = 0; i < (o.issues ?? 12); i += 1) await mv('issue', -(o.issueQty ?? 75), null, null, new Date(Date.now() - (i + 1) * DAY));
    return { ctx: { tenantId, workspaceId, userId: randomUUID() }, businessId, itemId, warehouseId };
  }

  const request = (w: W, params: Record<string, number> = { reorderPoint: 180, reorderQuantity: 200 }, over: Record<string, unknown> = {}) => ({
    businessId: w.businessId, actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '1' }, target: { kind: 'inventory_item', id: w.itemId },
    finalParameters: params, ruleSetVersion: V, correlationId: randomUUID(), ...over,
  });
  const results = (o: { evaluations: { dimension: string; result: string }[] }) => Object.fromEntries(o.evaluations.map((e) => [e.dimension, e.result]));
  const count = async (w: W) => Number((await admin.query('SELECT count(*) FROM business_operations.inventory_policy_evaluations WHERE tenant_id=$1', [w.ctx.tenantId])).rows[0].count);

  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    createPool({ connectionString: process.env.DATABASE_URL! });
  });
  afterAll(async () => {
    if (tenantIds.length > 0) {
      const c = await admin.connect();
      try {
        await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'");
        for (const t of ['business_operations.inventory_policy_evaluations', 'platform.business_currency_declarations', 'business_operations.inventory_balances', 'platform.inventory_items', 'platform.warehouses', 'platform.businesses', 'tenancy.workspaces', 'tenancy.tenants']) {
          await c.query(`DELETE FROM ${t} WHERE ${t === 'tenancy.tenants' ? 'id' : 'tenant_id'} = ANY($1)`, [tenantIds]);
        }
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
      await deleteMovementsForTenants(admin, tenantIds);
    }
    await closePool(); await admin.end();
  });

  // Demand fixture: 12 issues x 75 = 900 => rp >= 175 and rp + rq <= 900. Baseline 100/200: rp 180 is +80% (C5 FAILS) so healthy tests use baseline 170/190.
  it('PASSED across all four dimensions for a healthy item; one append-only row per dimension bound to the exact digest', async () => {
    const w = await world({ baseline: [170, 190] });
    const req = request(w, { reorderPoint: 180, reorderQuantity: 200 });
    const out = await service.evaluate(w.ctx, req, PERM);
    expect(results(out)).toEqual({ CONSTRAINTS: 'PASSED', RESOURCE_REQUIREMENTS: 'PASSED', COST: 'PASSED', EXPECTED_OUTCOME: 'PASSED' });
    expect(out.references.map((r) => r.dimension)).toEqual(['CONSTRAINTS', 'RESOURCE_REQUIREMENTS', 'COST', 'EXPECTED_OUTCOME']);
    expect(out.warehouseId).toBe(w.warehouseId);
    expect(await count(w)).toBe(4);
    const expectedSubject = { actionType: req.actionType, target: req.target, finalParameters: req.finalParameters };
    const digest = computeGovernanceSubjectDigest(expectedSubject as never);
    expect(out.subjectDigest).toBe(digest);
    for (const ev of out.evaluations) {
      const stored = await repo.getById(w.ctx, w.businessId, ev.id);
      expect(stored).toEqual(ev);
      expect(stored!.subjectDigest).toBe(digest);
      expect(stored!.subject).toEqual(expectedSubject);
      expect(stored!.ruleSetVersion).toBe(V);
      expect(stored!.requestedByUserId).toBe(w.ctx.userId);
      expect(stored!.correlationId).toBe(req.correlationId);
      expect(stored!.findings.length).toBeGreaterThan(0);
    }
  });

  it('persists the exact input snapshot: schema, rule-set parameters, window on the database clock, facts and a snapshot digest', async () => {
    const w = await world({ baseline: [170, 190] });
    const out = await service.evaluate(w.ctx, request(w), PERM);
    const inputs = out.evaluations[0].inputs as Record<string, any>;
    expect(inputs.schema).toBe(INVENTORY_POLICY_EVALUATION_INPUTS_SCHEMA);
    expect(inputs.ruleSet).toMatchObject({ id: 'inventory-reorder-policy', version: V, parameters: { orderValueCap: 5000, orderValueCapCurrency: 'USD', demandWindowDays: 90 } });
    expect(inputs.facts.demand).toMatchObject({ count: 12, sumOfMagnitudes: '900.0000', movementTypes: ['issue'] });
    expect(inputs.facts.latestReceipt).toMatchObject({ unitCost: '10.0000', unitCostCurrency: 'USD' });
    expect(inputs.facts.declaredCurrency).toMatchObject({ status: 'DECLARED', currency: 'USD', version: 1 });
    expect(inputs.snapshotDigest).toBe(out.snapshotDigest);
    expect(out.snapshotDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // capture time is the database clock: within a minute of the DB's own now, not a caller value
    const dbNow = (await admin.query('SELECT extract(epoch from now())*1000 AS ms')).rows[0].ms as number;
    expect(Math.abs(Date.parse(inputs.capturedAt) - Number(dbNow))).toBeLessThan(60_000);
    // evaluated_at is stamped by the database on every row
    for (const e of out.evaluations) expect(Math.abs(Date.parse(e.evaluatedAt) - Number(dbNow))).toBeLessThan(60_000);
  });

  it('FAILED is reported and persisted distinctly (change over limit, cap, order value, stock-out)', async () => {
    const w = await world({ baseline: [170, 190] });
    const out = await service.evaluate(w.ctx, request(w, { reorderPoint: 400, reorderQuantity: 600 }), PERM);
    expect(results(out)).toEqual({ CONSTRAINTS: 'FAILED', RESOURCE_REQUIREMENTS: 'FAILED', COST: 'FAILED', EXPECTED_OUTCOME: 'FAILED' });
    const stored = await repo.getById(w.ctx, w.businessId, out.evaluations[0].id);
    expect(stored!.result).toBe('FAILED');
  });

  it('is deterministic over an unchanged fact set: same results, same snapshot digest, new append-only rows each call', async () => {
    const w = await world({ baseline: [170, 190] });
    const a = await service.evaluate(w.ctx, request(w), PERM);
    const b = await service.evaluate(w.ctx, request(w), PERM);
    expect(b.snapshotDigest).toBe(a.snapshotDigest);
    expect(results(b)).toEqual(results(a));
    expect(b.evaluations.map((e) => e.id).some((id) => a.evaluations.map((x) => x.id).includes(id))).toBe(false);
    expect(await count(w)).toBe(8);
    // earlier rows are untouched
    expect(await repo.getById(w.ctx, w.businessId, a.evaluations[0].id)).toEqual(a.evaluations[0]);
  });

  it('a change in BO facts changes the snapshot digest and is a new record, never an update', async () => {
    const w = await world({ baseline: [170, 190] });
    const a = await service.evaluate(w.ctx, request(w), PERM);
    await admin.query(`INSERT INTO business_operations.inventory_movements (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity, occurred_at)
      VALUES ($1,$2,$3,$4,$5,'issue',-5,now() - interval '1 hour')`, [w.ctx.tenantId, w.ctx.workspaceId, w.businessId, w.itemId, w.warehouseId]);
    const b = await service.evaluate(w.ctx, request(w), PERM);
    expect(b.snapshotDigest).not.toBe(a.snapshotDigest);
  });

  describe('INDETERMINATE fails closed', () => {
    it('no declared currency => COST INDETERMINATE (DECLARED_CURRENCY_MISSING); other dimensions unaffected', async () => {
      const w = await world({ baseline: [170, 190], declared: null });
      const out = await service.evaluate(w.ctx, request(w), PERM);
      expect(results(out).COST).toBe('INDETERMINATE');
      expect(results(out).CONSTRAINTS).toBe('PASSED');
      expect(JSON.stringify(out.evaluations.find((e) => e.dimension === 'COST')!.findings)).toContain('DECLARED_CURRENCY_MISSING');
    });
    it('declared currency differing from the cap currency => CAP_CURRENCY_MISMATCH; cost currency mismatch => COST_CURRENCY_MISMATCH', async () => {
      const eur = await world({ baseline: [170, 190], declared: 'EUR', receipt: { cost: '10', currency: 'EUR' } });
      expect(JSON.stringify((await service.evaluate(eur.ctx, request(eur), PERM)).evaluations.find((e) => e.dimension === 'COST')!.findings)).toContain('CAP_CURRENCY_MISMATCH');
      const mismatch = await world({ baseline: [170, 190], receipt: { cost: '10', currency: 'EUR' } });
      expect(JSON.stringify((await service.evaluate(mismatch.ctx, request(mismatch), PERM)).evaluations.find((e) => e.dimension === 'COST')!.findings)).toContain('COST_CURRENCY_MISMATCH');
    });
    it.each([
      ['no receipt', null, 'NO_RECEIPT'],
      ['receipt without cost', { cost: null, currency: null }, 'UNIT_COST_MISSING'],
    ])('%s => COST INDETERMINATE', async (_n, receipt, reason) => {
      const w = await world({ baseline: [170, 190], receipt });
      const out = await service.evaluate(w.ctx, request(w), PERM);
      expect(results(out).COST).toBe('INDETERMINATE');
      expect(JSON.stringify(out.evaluations.find((e) => e.dimension === 'COST')!.findings)).toContain(reason);
    });
    it('a legacy zero unit cost already in the history is INDETERMINATE (0187 is NOT VALID); it is never repaired or rounded', async () => {
      const w = await world({ baseline: [170, 190], receipt: null });
      // Legacy rows pre-date the 0187 CHECK (it is NOT VALID). Seed one by suspending the constraint inside ONE transaction and restoring
      // its exact definition (NOT VALID) before commit, so the schema is identical afterwards.
      const c = await admin.connect();
      try {
        await c.query('BEGIN');
        const def = (await c.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='inventory_movements_unit_cost_positive' AND conrelid='business_operations.inventory_movements'::regclass`)).rows[0].d as string;
        await c.query('ALTER TABLE business_operations.inventory_movements DROP CONSTRAINT inventory_movements_unit_cost_positive');
        await c.query(`INSERT INTO business_operations.inventory_movements (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity, unit_cost, unit_cost_currency, occurred_at)
          VALUES ($1,$2,$3,$4,$5,'receipt',10,0,'USD',now() - interval '1 day')`, [w.ctx.tenantId, w.ctx.workspaceId, w.businessId, w.itemId, w.warehouseId]);
        await c.query(`ALTER TABLE business_operations.inventory_movements ADD CONSTRAINT inventory_movements_unit_cost_positive ${def.replace(/ NOT VALID$/, '')} NOT VALID`);
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
      const out = await service.evaluate(w.ctx, request(w), PERM);
      expect(results(out).COST).toBe('INDETERMINATE');
      expect(JSON.stringify(out.evaluations.find((e) => e.dimension === 'COST')!.findings)).toContain('UNIT_COST_INVALID');
    });
    it('the LATEST receipt decides: an older receipt in another currency is not consulted when a newer valid receipt exists', async () => {
      const w = await world({ baseline: [170, 190] });
      await admin.query(`INSERT INTO business_operations.inventory_movements (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity, unit_cost, unit_cost_currency, occurred_at)
        VALUES ($1,$2,$3,$4,$5,'receipt',10,3,'EUR',now() - interval '30 days')`, [w.ctx.tenantId, w.ctx.workspaceId, w.businessId, w.itemId, w.warehouseId]);
      expect(results(await service.evaluate(w.ctx, request(w), PERM), PERM).COST).toBe('PASSED');
    });
    it('fewer than 10 issues, or none, => EXPECTED_OUTCOME INDETERMINATE (no Simulation substitute)', async () => {
      const few = await world({ baseline: [170, 190], issues: 9 });
      expect(results(await service.evaluate(few.ctx, request(few), PERM)).EXPECTED_OUTCOME).toBe('INDETERMINATE');
      const none = await world({ baseline: [170, 190], issues: 0 });
      expect(results(await service.evaluate(none.ctx, request(none), PERM)).EXPECTED_OUTCOME).toBe('INDETERMINATE');
    });
    it('demand outside the 90-day window or of a non-qualifying movement type is not counted', async () => {
      const w = await world({ baseline: [170, 190], issues: 9 });
      const ins = (type: string, qty: number, ageDays: number) => admin.query(
        `INSERT INTO business_operations.inventory_movements (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now() - ($8 || ' days')::interval)`, [w.ctx.tenantId, w.ctx.workspaceId, w.businessId, w.itemId, w.warehouseId, type, qty, String(ageDays)]);
      await ins('issue', -75, 91); await ins('issue', -75, 120); await admin.query(`INSERT INTO business_operations.inventory_movements (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity, occurred_at) VALUES ($1,$2,$3,$4,$5,'issue',-75, now() - interval '90 days 1 hour')`, [w.ctx.tenantId, w.ctx.workspaceId, w.businessId, w.itemId, w.warehouseId]); await ins('adjustment', -75, 1); await ins('transfer_out', -75, 2);
      const out = await service.evaluate(w.ctx, request(w), PERM);
      const demand = (out.evaluations[0].inputs as any).facts.demand;
      expect(demand.count).toBe(9);
      expect(results(out).EXPECTED_OUTCOME).toBe('INDETERMINATE');
    });
    it('zero baseline (FIRST_CONFIGURATION=NO) => CONSTRAINTS INDETERMINATE; no balance => all INDETERMINATE and the row has no warehouse', async () => {
      const zero = await world({ baseline: [0, 0] });
      expect(results(await service.evaluate(zero.ctx, request(zero), PERM)).CONSTRAINTS).toBe('INDETERMINATE');
      const none = await world({ baseline: null });
      const out = await service.evaluate(none.ctx, request(none), PERM);
      expect(Object.values(results(out))).toEqual(['INDETERMINATE', 'INDETERMINATE', 'INDETERMINATE', 'INDETERMINATE']);
      expect(out.warehouseId).toBeNull();
      expect(out.evaluations[0].warehouseId).toBeNull();
    });
    it('inactive item => CONSTRAINTS FAILED', async () => {
      const w = await world({ baseline: [170, 190], status: 'archived' });
      expect(results(await service.evaluate(w.ctx, request(w), PERM), PERM).CONSTRAINTS).toBe('FAILED');
    });
  });

  describe('refusals (nothing is persisted)', () => {
    const refused = async (w: W, req: any, code: string) => {
      const before = await count(w);
      await expect(service.evaluate(w.ctx, req, PERM)).rejects.toMatchObject({ name: 'ValidationError', code });
      await expect(service.evaluate(w.ctx, req, PERM)).rejects.toBeInstanceOf(InventoryPolicyEvaluationRefusedError);
      expect(await count(w)).toBe(before);
    };
    it.each([
      ['caller-supplied result', { result: 'PASSED' }], ['caller-supplied evaluatedAt', { evaluatedAt: '2026-01-01T00:00:00Z' }],
      ['caller-supplied dimension', { dimension: 'COST' }], ['caller-supplied thresholds', { thresholds: { orderValueCap: 1e9 } }],
      ['caller-supplied digest', { subjectDigest: 'sha256:x' }], ['caller-supplied findings/inputs', { findings: [], inputs: {} }],
    ])('%s is refused', async (_n, extra) => { const w = await world(); await refused(w, request(w, undefined, extra), 'CALLER_SUPPLIED_AUTHORITY'); });
    it('unsupported action type and schema version are refused', async () => {
      const w = await world();
      await refused(w, request(w, undefined, { actionType: { code: 'inventory_adjustment', schemaVersion: '1' } }), 'UNSUPPORTED_ACTION_TYPE');
      await refused(w, request(w, undefined, { actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '2' } }), 'UNSUPPORTED_SCHEMA_VERSION');
    });
    it.each(['inventory-reorder-policy/v0.1.0-DRAFT', 'inventory-reorder-policy/v9.9.9', '', 'latest'])('rule-set version "%s" is refused (no default, no draft)', async (v) => {
      const w = await world(); await refused(w, request(w, undefined, { ruleSetVersion: v }), 'RULE_SET_NOT_APPROVED');
    });
    it('missing rule-set version is refused (no default)', async () => { const w = await world(); const r: any = request(w); delete r.ruleSetVersion; await refused(w, r, 'INVALID_REQUEST'); });
    it('a target that is not a UUID, not an inventory item kind, or not in this business is refused', async () => {
      const w = await world(); const other = await world();
      await refused(w, request(w, undefined, { target: { kind: 'inventory_item', id: 'sku-123' } }), 'TARGET_ID_NOT_UUID');
      await refused(w, request(w, undefined, { target: { kind: 'warehouse', id: w.itemId } }), 'TARGET_KIND_INVALID');
      await refused(w, request(w, undefined, { target: { kind: 'inventory_item', id: other.itemId } }), 'TARGET_UNRESOLVED');
      await refused(w, request(w, undefined, { target: { kind: 'inventory_item', id: randomUUID() } }), 'TARGET_UNRESOLVED');
    });
  });

  it('business scope: an item of another business in the SAME tenant and workspace is not evaluable through this business', async () => {
    const w = await world({ baseline: [170, 190] });
    const otherBusiness = randomUUID(); const otherItem = randomUUID();
    await admin.query('INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code) VALUES ($1,$2,$3,$4,$5)', [otherBusiness, w.ctx.tenantId, w.ctx.workspaceId, `o${otherBusiness.slice(0, 8)}`, `o${otherBusiness.slice(0, 8)}`]);
    await admin.query(`INSERT INTO platform.inventory_items (id, tenant_id, workspace_id, business_id, sku, name) VALUES ($1,$2,$3,$4,$5,'Other')`, [otherItem, w.ctx.tenantId, w.ctx.workspaceId, otherBusiness, `sku-${otherItem}`]);
    const before = await count(w);
    await expect(service.evaluate(w.ctx, request(w, undefined, { target: { kind: 'inventory_item', id: otherItem } }), PERM)).rejects.toMatchObject({ code: 'TARGET_UNRESOLVED' });
    expect(await count(w)).toBe(before);
  });

  it('tenant isolation: another tenant cannot evaluate this tenant\'s item, and its rows are invisible', async () => {
    const a = await world({ baseline: [170, 190] }); const b = await world({ baseline: [170, 190] });
    const out = await service.evaluate(a.ctx, request(a), PERM);
    await expect(service.evaluate(b.ctx, request(a), PERM), PERM).rejects.toMatchObject({ code: 'TARGET_UNRESOLVED' });
    await expect(repo.getById(b.ctx, a.businessId, out.evaluations[0].id)).rejects.toThrow(/not found/i);
  });

  it('does not mutate any operational row (balances, items, movements unchanged)', async () => {
    const w = await world({ baseline: [170, 190] });
    const snap = async () => JSON.stringify([
      (await admin.query('SELECT * FROM business_operations.inventory_balances WHERE tenant_id=$1 ORDER BY id', [w.ctx.tenantId])).rows,
      (await admin.query('SELECT * FROM platform.inventory_items WHERE tenant_id=$1 ORDER BY id', [w.ctx.tenantId])).rows,
      (await admin.query('SELECT * FROM business_operations.inventory_movements WHERE tenant_id=$1 ORDER BY id', [w.ctx.tenantId])).rows,
    ]);
    const before = await snap();
    await service.evaluate(w.ctx, request(w), PERM); await service.evaluate(w.ctx, request(w, { reorderPoint: 999, reorderQuantity: 999 }), PERM);
    expect(await snap()).toBe(before);
  });

  it('evaluation rows cannot be updated or deleted afterwards (B2a append-only guard)', async () => {
    const w = await world({ baseline: [170, 190] });
    const out = await service.evaluate(w.ctx, request(w), PERM);
    await expect(admin.query(`UPDATE business_operations.inventory_policy_evaluations SET result='PASSED' WHERE id=$1`, [out.evaluations[0].id])).rejects.toThrow(/append-only/);
    await expect(admin.query('DELETE FROM business_operations.inventory_policy_evaluations WHERE id=$1', [out.evaluations[0].id])).rejects.toThrow(/append-only/);
  });

  it('records are atomic: all four dimensions or none', async () => {
    const w = await world({ baseline: [170, 190] });
    const failing = new InventoryPolicyEvaluationService({
      evaluations: { recordAll: async (ctx: TenantContext, inputs: any[]) => repo.recordAll(ctx, [...inputs.slice(0, 3), { ...inputs[3], dimension: 'NOT_A_DIMENSION' }]) },
    });
    await expect(failing.evaluate(w.ctx, request(w), PERM)).rejects.toThrow();
    expect(await count(w)).toBe(0);
  });
});
