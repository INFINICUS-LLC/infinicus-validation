/**
 * Block B2c - live PostgreSQL proof of the BO governance evidence verifier against REAL evaluation records written by the B2b evaluator
 * (RLS enforced for the app role). Requires DATABASE_URL (app) and ADMIN_DATABASE_URL (superuser fixtures).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { closePool, createPool } from '@infinicus/database';
import { computeGovernanceSubjectDigest, type GovernanceEvidenceRequest } from '@infinicus/handoff-contracts';
import {
  BoGovernanceEvidenceVerifier, InventoryPolicyEvaluationService, INVENTORY_REORDER_POLICY_V1_0_0 as RS,
  INVENTORY_REORDER_POLICY_V1_MAX_EVIDENCE_AGE_MS as MAX_AGE,
} from '../src/index.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';
import { makePolicyWorld, type W } from './helpers/policyWorld.js';

const RUN = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const DIMS = ['CONSTRAINTS', 'RESOURCE_REQUIREMENTS', 'COST', 'EXPECTED_OUTCOME'] as const;
const GOOD = { reorderPoint: 180, reorderQuantity: 200 };
const EPOCH = '1970-01-01T00:00:00.000Z';

describe.runIf(RUN)('BoGovernanceEvidenceVerifier - live PostgreSQL', () => {
  let admin: Pool;
  const tenantIds: string[] = [];
  const service = new InventoryPolicyEvaluationService();
  const verifier = new BoGovernanceEvidenceVerifier();
  const world = (o: Parameters<typeof makePolicyWorld>[2] = {}) => makePolicyWorld(admin, tenantIds, { baseline: [170, 190], ...o });

  const evaluate = (w: W, params: Record<string, number> = GOOD) => service.evaluate(w.ctx, {
    businessId: w.businessId, actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '1' }, target: { kind: 'inventory_item', id: w.itemId },
    finalParameters: params, ruleSetVersion: RS.version, correlationId: randomUUID(),
  }, 'bo:write');
  const ref = (o: { id: string }) => ({ kind: 'bo_inventory_policy_evaluation', id: o.id });
  const req = (w: W, dimension: (typeof DIMS)[number], id: string, over: Partial<GovernanceEvidenceRequest> = {}): GovernanceEvidenceRequest => ({
    tenantId: w.ctx.tenantId, workspaceId: w.ctx.workspaceId, businessId: w.businessId, actorUserId: w.ctx.userId, modifiedAt: EPOCH, dimension, evidenceRef: ref({ id }),
    subject: { actionId: randomUUID(), actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '1' }, target: { kind: 'inventory_item', id: w.itemId }, finalParameters: GOOD }, ...over,
  });
  const idOf = (out: Awaited<ReturnType<typeof evaluate>>, d: string) => out.evaluations.find((e) => e.dimension === d)!.id;

  /** Copies an evaluation row with an explicit evaluated_at / rule-set version (the evaluator never writes these; triggers are suspended in ONE superuser transaction). */
  async function clone(id: string, over: { evaluatedAtSql?: string; ruleSetVersion?: string; inputs?: string } = {}): Promise<string> {
    const c = await admin.connect();
    try {
      await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'");
      const r = await c.query(
        `INSERT INTO business_operations.inventory_policy_evaluations
           (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, dimension, result, subject, subject_digest, rule_set_version, inputs, findings, requested_by_user_id, correlation_id, evaluated_at)
         SELECT tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, dimension, result, subject, subject_digest, COALESCE($2, rule_set_version), COALESCE($3::jsonb, inputs), findings, requested_by_user_id, correlation_id,
                ${over.evaluatedAtSql ?? 'evaluated_at'}
           FROM business_operations.inventory_policy_evaluations WHERE id = $1 RETURNING id`, [id, over.ruleSetVersion ?? null, over.inputs ?? null]);
      await c.query('COMMIT');
      return r.rows[0].id as string;
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }
  const refusedWith = async (r: GovernanceEvidenceRequest, pattern: RegExp) => {
    const v = await verifier.verify(r);
    expect(v.status).toBe('REFUSED');
    expect((v as { reason: string }).reason).toMatch(pattern);
  };

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
        await c.query('DELETE FROM audit.audit_events WHERE tenant_id = ANY($1)', [tenantIds]);
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
      await deleteMovementsForTenants(admin, tenantIds);
    }
    await closePool(); await admin.end();
  });

  it('all four PASSED dimensions of the evaluator verify, answered from the stored record (evaluatedAt is the database stamp)', async () => {
    const w = await world();
    const out = await evaluate(w);
    for (const d of DIMS) {
      const v = await verifier.verify(req(w, d, idOf(out, d)));
      expect(v).toMatchObject({ status: 'VERIFIED', dimension: d, result: 'PASSED', evidenceRef: ref({ id: idOf(out, d) }), authoritativeSource: { layer: 'BUSINESS_OPERATIONS' } });
      expect((v as { evaluatedAt: string }).evaluatedAt).toBe(out.evaluations.find((e) => e.dimension === d)!.evaluatedAt);
    }
  });

  it('FAILED and INDETERMINATE records are rejected (never converted)', async () => {
    const failed = await world();
    const f = await evaluate(failed, { reorderPoint: 400, reorderQuantity: 600 });
    for (const d of DIMS) await refusedWith(req(failed, d, idOf(f, d), { subject: { ...req(failed, d, idOf(f, d)).subject, finalParameters: { reorderPoint: 400, reorderQuantity: 600 } } }), /result is FAILED/);
    const indeterminate = await world({ declared: null });
    const i = await evaluate(indeterminate);
    await refusedWith(req(indeterminate, 'COST', idOf(i, 'COST')), /result is INDETERMINATE/);
    expect((await verifier.verify(req(indeterminate, 'CONSTRAINTS', idOf(i, 'CONSTRAINTS')))).status).toBe('VERIFIED'); // a PASSED sibling still verifies on its own
  });

  it('a missing reference is rejected', async () => {
    const w = await world();
    await refusedWith(req(w, 'COST', randomUUID()), /no such evaluation record/);
  });

  it('wrong tenant, workspace or business is rejected (the record is invisible, not merely mismatched)', async () => {
    const a = await world(); const b = await world();
    const out = await evaluate(a);
    const id = idOf(out, 'COST');
    await refusedWith(req(a, 'COST', id, { tenantId: b.ctx.tenantId }), /no such evaluation record/);
    await refusedWith(req(a, 'COST', id, { workspaceId: randomUUID() }), /no such evaluation record/);
    await refusedWith(req(a, 'COST', id, { businessId: b.businessId }), /no such evaluation record/);
    await refusedWith(req(a, 'COST', id, { businessId: randomUUID() }), /no such evaluation record/);
  });

  it('wrong dimension, action type, schema version, target and parameters are rejected', async () => {
    const w = await world(); const other = await world();
    const out = await evaluate(w);
    const id = idOf(out, 'COST');
    await refusedWith(req(w, 'CONSTRAINTS', id), /evaluates COST, not CONSTRAINTS/);
    const base = req(w, 'COST', id).subject;
    await refusedWith(req(w, 'COST', id, { subject: { ...base, actionType: { code: 'inventory_adjustment', schemaVersion: '1' } } }), /only inventory_reorder_policy_update@1/);
    await refusedWith(req(w, 'COST', id, { subject: { ...base, actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '2' } } }), /only inventory_reorder_policy_update@1/);
    await refusedWith(req(w, 'COST', id, { subject: { ...base, target: { kind: 'inventory_item', id: other.itemId } } }), /different inventory item|digest mismatch/);
    await refusedWith(req(w, 'COST', id, { subject: { ...base, finalParameters: { reorderPoint: 181, reorderQuantity: 200 } } }), /digest mismatch/);
    await refusedWith(req(w, 'COST', id, { subject: { ...base, finalParameters: { ...GOOD, extra: 1 } } }), /digest mismatch/);
  });

  it('the stored digest is exactly the shared contract digest of the persisted subject', async () => {
    const w = await world();
    const out = await evaluate(w);
    expect(out.subjectDigest).toBe(computeGovernanceSubjectDigest({ actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '1' }, target: { kind: 'inventory_item', id: w.itemId }, finalParameters: GOOD } as never));
  });

  it('an unsupported rule-set version on the record is rejected', async () => {
    const w = await world();
    const out = await evaluate(w);
    const bad = await clone(idOf(out, 'COST'), { ruleSetVersion: 'inventory-reorder-policy/v9.9.9' });
    await refusedWith(req(w, 'COST', bad), /not approved and effective/);
  });

  it('a record without the evaluator input envelope is rejected (provenance)', async () => {
    const w = await world();
    const out = await evaluate(w);
    const forged = await clone(idOf(out, 'COST'), { inputs: '{"note":"hand written"}' });
    await refusedWith(req(w, 'COST', forged), /BO evaluator input snapshot/);
  });

  describe('freshness on the database clock (24 hours)', () => {
    it('23h59m old verifies; 24h01m old is stale', async () => {
      const w = await world();
      const out = await evaluate(w);
      const fresh = await clone(idOf(out, 'COST'), { evaluatedAtSql: "date_trunc('milliseconds', clock_timestamp()) - interval '23 hours 59 minutes'" });
      const stale = await clone(idOf(out, 'COST'), { evaluatedAtSql: "date_trunc('milliseconds', clock_timestamp()) - interval '24 hours 1 minute'" });
      expect((await verifier.verify(req(w, 'COST', fresh))).status).toBe('VERIFIED');
      await refusedWith(req(w, 'COST', stale), /older than the maximum evidence age/);
      expect(MAX_AGE).toBe(86_400_000);
    });
  });

  describe('modification chronology', () => {
    it('an evaluation before the decision time is rejected; at or after it verifies', async () => {
      const w = await world();
      const out = await evaluate(w);
      const at = out.evaluations.find((e) => e.dimension === 'COST')!;
      const id = at.id;
      const plus = (ms: number) => new Date(Date.parse(at.evaluatedAt) + ms).toISOString();
      await refusedWith(req(w, 'COST', id, { modifiedAt: plus(1) }), /predates the modification decision/);
      expect((await verifier.verify(req(w, 'COST', id, { modifiedAt: at.evaluatedAt }))).status).toBe('VERIFIED');
      expect((await verifier.verify(req(w, 'COST', id, { modifiedAt: plus(-1) }))).status).toBe('VERIFIED');
    });
  });

  it('the record is immutable: it cannot be rewritten to become PASSED (append-only)', async () => {
    const w = await world({ declared: null });
    const out = await evaluate(w);
    const id = idOf(out, 'COST');
    await expect(admin.query(`UPDATE business_operations.inventory_policy_evaluations SET result = 'PASSED' WHERE id = $1`, [id])).rejects.toThrow(/append-only/);
    await refusedWith(req(w, 'COST', id), /result is INDETERMINATE/);
  });

  it('verifying mutates nothing', async () => {
    const w = await world();
    const out = await evaluate(w);
    const snap = async () => JSON.stringify((await admin.query('SELECT * FROM business_operations.inventory_policy_evaluations WHERE tenant_id=$1 ORDER BY id', [w.ctx.tenantId])).rows)
      + JSON.stringify((await admin.query('SELECT * FROM business_operations.inventory_balances WHERE tenant_id=$1 ORDER BY id', [w.ctx.tenantId])).rows);
    const before = await snap();
    for (const d of DIMS) await verifier.verify(req(w, d, idOf(out, d)));
    expect(await snap()).toBe(before);
  });
});
