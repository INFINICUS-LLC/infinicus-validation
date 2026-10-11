/**
 * Block B2a - live PostgreSQL proof for migration 0182 (BO inventory policy evaluation record) and its repository.
 * Requires DATABASE_URL (app_test_user, RLS enforced) and ADMIN_DATABASE_URL (BYPASSRLS), migrated through 0182.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createPool, closePool } from '../src/client.js';
import {
  InventoryPolicyEvaluationRepository, InventoryPolicyEvaluationValidationError, INVENTORY_POLICY_EVALUATION_DIMENSIONS, INVENTORY_POLICY_EVALUATION_RESULTS,
  type RecordInventoryPolicyEvaluationInput,
} from '../src/index.js';

const run = !!process.env.DATABASE_URL;
const MIGRATION = readFileSync(resolve(__dirname, '../../../infrastructure/database/migrations/0182_create_bo_inventory_policy_evaluations.sql'), 'utf8');
const APPEND_ONLY = /business_operations\.inventory_policy_evaluations: append-only table - (UPDATE|DELETE|TRUNCATE) is not permitted/;
const digestOf = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

interface World { tenantId: string; workspaceId: string; businessId: string; otherBusinessId: string; itemId: string; warehouseId: string; otherBizItemId: string; otherBizWarehouseId: string; userId: string }

describe.runIf(run)('BO inventory policy evaluations (0182) - live PostgreSQL', () => {
  let admin: Pool; let app: Pool;
  let a: World; let b: World;
  const repo = new InventoryPolicyEvaluationRepository();

  async function world(): Promise<World> {
    const w: World = { tenantId: randomUUID(), workspaceId: randomUUID(), businessId: randomUUID(), otherBusinessId: randomUUID(), itemId: randomUUID(), warehouseId: randomUUID(),
      otherBizItemId: randomUUID(), otherBizWarehouseId: randomUUID(), userId: randomUUID() };
    await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'B2a',$2,'active','test')`, [w.tenantId, `b2a-${w.tenantId}`]);
    await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'WS',$3,'active')`, [w.workspaceId, w.tenantId, `ws-${w.workspaceId}`]);
    for (const [biz, item, wh] of [[w.businessId, w.itemId, w.warehouseId], [w.otherBusinessId, w.otherBizItemId, w.otherBizWarehouseId]] as const) {
      await admin.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'B2a Biz',$4,'active')`, [biz, w.tenantId, w.workspaceId, `b2a-${biz}`]);
      await admin.query(`INSERT INTO platform.inventory_items (id, tenant_id, workspace_id, business_id, sku, name) VALUES ($1,$2,$3,$4,$5,'Item')`, [item, w.tenantId, w.workspaceId, biz, `sku-${item}`]);
      await admin.query(`INSERT INTO platform.warehouses (id, tenant_id, workspace_id, business_id, warehouse_code, name) VALUES ($1,$2,$3,$4,$5,'WH')`, [wh, w.tenantId, w.workspaceId, biz, `wh-${wh}`]);
    }
    return w;
  }
  const ctxOf = (w: World) => ({ tenantId: w.tenantId, workspaceId: w.workspaceId, userId: w.userId });
  const subjectFor = (w: World, over: Record<string, unknown> = {}) => ({
    actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '1' }, target: { kind: 'inventory_item', id: w.itemId },
    finalParameters: { reorderPoint: 15, reorderQuantity: 60 }, ...over,
  });
  const input = (w: World, over: Partial<RecordInventoryPolicyEvaluationInput> = {}): RecordInventoryPolicyEvaluationInput => ({
    businessId: w.businessId, inventoryItemId: w.itemId, warehouseId: w.warehouseId, dimension: 'CONSTRAINTS', result: 'PASSED', subject: subjectFor(w),
    subjectDigest: digestOf('subject-1'), ruleSetVersion: 'rules-test-1', inputs: { onHand: 12 }, findings: [{ rule: 'r1', outcome: 'PASSED' }],
    requestedByUserId: w.userId, correlationId: randomUUID(), ...over,
  });
  /** A raw insert as the admin role, so the DATABASE constraints (not the repository's validation) are what is proven. */
  const rawInsert = (w: World, over: Record<string, unknown> = {}) => {
    const r = { tenant_id: w.tenantId, workspace_id: w.workspaceId, business_id: w.businessId, inventory_item_id: w.itemId, warehouse_id: null, dimension: 'CONSTRAINTS', result: 'PASSED',
      subject: JSON.stringify(subjectFor(w)), subject_digest: digestOf('x'), rule_set_version: 'rules-test-1', inputs: '{}', findings: '[]', requested_by_user_id: w.userId, correlation_id: randomUUID(), ...over };
    const cols = Object.keys(r);
    return admin.query(`INSERT INTO business_operations.inventory_policy_evaluations (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}${['subject', 'inputs', 'findings'].includes(cols[i]) ? '::jsonb' : ''}`).join(',')}) RETURNING id`, cols.map((c) => (r as any)[c]));
  };

  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL! });
    app = new Pool({ connectionString: process.env.DATABASE_URL! });
    createPool({ connectionString: process.env.DATABASE_URL! });
    a = await world(); b = await world();
  });
  afterAll(async () => { await closePool(); await admin.end(); await app.end(); });

  describe('persistence', () => {
    it('stores PASSED, FAILED and INDETERMINATE distinctly, each of the four dimensions, and returns exactly what was stored', async () => {
      for (const result of INVENTORY_POLICY_EVALUATION_RESULTS) {
        const stored = await repo.record(ctxOf(a), input(a, { result, findings: [{ rule: 'r', outcome: result }] }));
        expect(stored).toMatchObject({ result, tenantId: a.tenantId, workspaceId: a.workspaceId, businessId: a.businessId, inventoryItemId: a.itemId, warehouseId: a.warehouseId, ruleSetVersion: 'rules-test-1' });
        expect(await repo.getById(ctxOf(a), a.businessId, stored.id)).toEqual(stored);
      }
      for (const dimension of INVENTORY_POLICY_EVALUATION_DIMENSIONS) {
        expect((await repo.record(ctxOf(a), input(a, { dimension }))).dimension).toBe(dimension);
      }
      expect([...INVENTORY_POLICY_EVALUATION_DIMENSIONS]).toEqual(['CONSTRAINTS', 'RESOURCE_REQUIREMENTS', 'COST', 'EXPECTED_OUTCOME']);
    });

    it('stores the subject verbatim and the subject digest exactly; the warehouse is optional', async () => {
      const digest = digestOf('exact');
      const stored = await repo.record(ctxOf(a), input(a, { subjectDigest: digest, warehouseId: null, subject: subjectFor(a, { finalParameters: { reorderPoint: 99, nested: { k: [1, 2] } } }) }));
      expect(stored.subjectDigest).toBe(digest);
      expect(stored.warehouseId).toBeNull();
      expect(stored.subject).toEqual(subjectFor(a, { finalParameters: { reorderPoint: 99, nested: { k: [1, 2] } } }));
    });

    it('database constraints reject an invalid dimension, result, rule-set version, digest, subject, inputs and findings', async () => {
      const bad: [string, Record<string, unknown>][] = [
        ['dimension', { dimension: 'REVERSIBILITY' }], ['dimension', { dimension: 'SIMULATION' }], ['result', { result: 'VERIFIED' }], ['result', { result: 'passed' }],
        ['empty rule set', { rule_set_version: '   ' }], ['digest', { subject_digest: 'sha256:abc' }], ['digest', { subject_digest: digestOf('x').toUpperCase() }], ['digest', { subject_digest: 'md5:00' }],
        ['subject not an object', { subject: '[]' }], ['subject without finalParameters', { subject: JSON.stringify({ actionType: { code: 'c', schemaVersion: '1' }, target: { kind: 'k', id: 'i' } }) }],
        ['subject target id blank', { subject: JSON.stringify(subjectFor(a, { target: { kind: 'inventory_item', id: ' ' } })) }],
        ['inputs array', { inputs: '[]' }], ['findings object', { findings: '{}' }],
      ];
      for (const [name, over] of bad) await expect(rawInsert(a, over), name).rejects.toThrow();
      expect((await rawInsert(a)).rowCount).toBe(1);
    });

    it('repository validation rejects malformed input before it reaches the database', async () => {
      const cases: [string, Partial<RecordInventoryPolicyEvaluationInput>][] = [
        ['dimension', { dimension: 'COSTS' as never }], ['result', { result: 'OK' as never }], ['digest', { subjectDigest: 'sha256:zz' }], ['rule set', { ruleSetVersion: '' }],
        ['subject', { subject: { actionType: { code: 'c', schemaVersion: '1' } } as never }], ['inputs', { inputs: [] as never }], ['findings', { findings: {} as never }],
        ['business id', { businessId: 'nope' }], ['correlation', { correlationId: 'nope' }],
      ];
      for (const [name, over] of cases) await expect(repo.record(ctxOf(a), input(a, over)), name).rejects.toBeInstanceOf(InventoryPolicyEvaluationValidationError);
    });

    it('evaluated_at is the database clock in milliseconds: a caller-supplied time is overwritten', async () => {
      const r = await rawInsert(a, { evaluated_at: '2001-01-01T00:00:00Z' });
      const row = (await admin.query(`SELECT evaluated_at, (evaluated_at = date_trunc('milliseconds', evaluated_at)) AS ms, (now() - evaluated_at) < interval '1 minute' AS recent FROM business_operations.inventory_policy_evaluations WHERE id = $1`, [r.rows[0].id])).rows[0];
      expect(row.ms).toBe(true); expect(row.recent).toBe(true);
      const stored = await repo.record(ctxOf(a), input(a));
      expect(stored.evaluatedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      expect(Date.now() - Date.parse(stored.evaluatedAt)).toBeLessThan(60_000);
    });

    it('has no idempotency by design: the same content recorded twice is two distinct facts', async () => {
      const i = input(a, { subjectDigest: digestOf('twice') });
      const one = await repo.record(ctxOf(a), i); const two = await repo.record(ctxOf(a), i);
      expect(two.id).not.toBe(one.id);
      expect((await repo.findForSubject(ctxOf(a), a.businessId, digestOf('twice'))).map((e) => e.id).sort()).toEqual([one.id, two.id].sort());
    });
  });

  describe('subject binding', () => {
    it('findForSubject returns only evaluations of that exact digest and dimension, newest first', async () => {
      const d1 = digestOf('bind-1'); const d2 = digestOf('bind-2');
      const c = await repo.record(ctxOf(a), input(a, { subjectDigest: d1, dimension: 'COST' }));
      await repo.record(ctxOf(a), input(a, { subjectDigest: d2, dimension: 'COST' }));
      await repo.record(ctxOf(a), input(a, { subjectDigest: d1, dimension: 'EXPECTED_OUTCOME' }));
      expect((await repo.findForSubject(ctxOf(a), a.businessId, d1, 'COST')).map((e) => e.id)).toEqual([c.id]);
      expect((await repo.findForSubject(ctxOf(a), a.businessId, d1)).length).toBe(2);
      expect(await repo.findForSubject(ctxOf(a), a.businessId, digestOf('never'))).toEqual([]);
    });
  });

  describe('immutability (every role)', () => {
    let id = '';
    beforeAll(async () => { id = (await repo.record(ctxOf(a), input(a, { subjectDigest: digestOf('immutable') }))).id; });
    const unchanged = async () => expect((await admin.query(`SELECT result, rule_set_version FROM business_operations.inventory_policy_evaluations WHERE id=$1`, [id])).rows).toEqual([{ result: expect.any(String), rule_set_version: 'rules-test-1' }]);

    it('UPDATE is refused for the application role and the admin role, including a result flip', async () => {
      await expect(admin.query(`UPDATE business_operations.inventory_policy_evaluations SET result='FAILED' WHERE id=$1`, [id])).rejects.toThrow(APPEND_ONLY);
      await expect(admin.query(`UPDATE business_operations.inventory_policy_evaluations SET rule_set_version='x'`)).rejects.toThrow(APPEND_ONLY);
      const client = await app.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.workspace_id',$2,true)`, [a.tenantId, a.workspaceId]);
        await expect(client.query(`UPDATE business_operations.inventory_policy_evaluations SET result='PASSED' WHERE id=$1`, [id])).rejects.toThrow(APPEND_ONLY);
      } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
      await unchanged();
    });

    it('DELETE is refused for the application role and the admin role; the row survives', async () => {
      await expect(admin.query(`DELETE FROM business_operations.inventory_policy_evaluations WHERE id=$1`, [id])).rejects.toThrow(APPEND_ONLY);
      await expect(admin.query(`DELETE FROM business_operations.inventory_policy_evaluations`)).rejects.toThrow(APPEND_ONLY);
      const client = await app.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.workspace_id',$2,true)`, [a.tenantId, a.workspaceId]);
        await expect(client.query(`DELETE FROM business_operations.inventory_policy_evaluations WHERE id=$1`, [id])).rejects.toThrow(APPEND_ONLY);
      } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
      await unchanged();
    });

    it('TRUNCATE (plain and CASCADE) is refused for the admin and the application role', async () => {
      await expect(admin.query(`TRUNCATE business_operations.inventory_policy_evaluations`)).rejects.toThrow(APPEND_ONLY);
      await expect(admin.query(`TRUNCATE business_operations.inventory_policy_evaluations CASCADE`)).rejects.toThrow(APPEND_ONLY);
      await expect(app.query(`TRUNCATE business_operations.inventory_policy_evaluations`)).rejects.toThrow();
      await unchanged();
    });

    it('exactly the guard triggers exist, bound to business_operations.forbid_mutation, and a re-run of the migration is safe', async () => {
      const q = `SELECT t.tgname, p.proname, (t.tgtype & 1) = 1 AS per_row, (t.tgtype & 32) = 32 AS on_truncate, t.tgenabled
                   FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid WHERE t.tgrelid = 'business_operations.inventory_policy_evaluations'::regclass AND NOT t.tgisinternal ORDER BY t.tgname`;
      const expected = [
        { tgname: 'forbid_mutation_inventory_policy_evaluations', proname: 'forbid_mutation', per_row: true, on_truncate: false, tgenabled: 'O' },
        { tgname: 'forbid_truncate_inventory_policy_evaluations', proname: 'forbid_mutation', per_row: false, on_truncate: true, tgenabled: 'O' },
        { tgname: 'guard_inventory_policy_evaluation_insert', proname: 'guard_inventory_policy_evaluation_insert', per_row: true, on_truncate: false, tgenabled: 'O' },
      ];
      expect((await admin.query(q)).rows).toEqual(expected);
      await admin.query(MIGRATION); await admin.query(MIGRATION);
      expect((await admin.query(q)).rows).toEqual(expected);
      expect((await admin.query(`SELECT count(*)::int n FROM _migrations WHERE filename='0182_create_bo_inventory_policy_evaluations.sql'`)).rows[0].n).toBe(1);
      await unchanged();
    });
  });

  describe('tenant, workspace and business isolation', () => {
    it('RLS is enabled and forced with the tenant + workspace policy', async () => {
      const f = (await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'business_operations.inventory_policy_evaluations'::regclass`)).rows[0];
      expect(f).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      expect((await admin.query(`SELECT 1 FROM pg_policies WHERE schemaname='business_operations' AND tablename='inventory_policy_evaluations' AND policyname='inventory_policy_evaluations_isolation'`)).rowCount).toBe(1);
    });

    it('another tenant, another workspace and another business of the same workspace cannot read the row', async () => {
      const mine = await repo.record(ctxOf(a), input(a, { subjectDigest: digestOf('iso') }));
      await expect(repo.getById(ctxOf(b), a.businessId, mine.id)).rejects.toThrow(/not found/);
      await expect(repo.getById(ctxOf(a), a.otherBusinessId, mine.id)).rejects.toThrow(/not found/);
      await expect(repo.getById({ ...ctxOf(a), workspaceId: randomUUID() }, a.businessId, mine.id)).rejects.toThrow(/not found/);
      expect(await repo.findForSubject(ctxOf(b), a.businessId, digestOf('iso'))).toEqual([]);
      expect(await repo.findForSubject(ctxOf(a), a.otherBusinessId, digestOf('iso'))).toEqual([]);
      expect((await repo.listForBusiness(ctxOf(b), a.businessId)).length).toBe(0);
      expect((await repo.listForBusiness(ctxOf(a), a.otherBusinessId)).every((e) => e.businessId === a.otherBusinessId)).toBe(true);
      // raw application-role access with the wrong tenant context sees no rows at all
      const client = await app.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.workspace_id',$2,true)`, [b.tenantId, b.workspaceId]);
        expect((await client.query(`SELECT id FROM business_operations.inventory_policy_evaluations WHERE id=$1`, [mine.id])).rowCount).toBe(0);
        await expect(client.query(
          `INSERT INTO business_operations.inventory_policy_evaluations (tenant_id, workspace_id, business_id, inventory_item_id, dimension, result, subject, subject_digest, rule_set_version, inputs, findings, requested_by_user_id, correlation_id)
           VALUES ($1,$2,$3,$4,'COST','PASSED',$5::jsonb,$6,'r','{}'::jsonb,'[]'::jsonb,$7,$8)`,
          [a.tenantId, a.workspaceId, a.businessId, a.itemId, JSON.stringify(subjectFor(a)), digestOf('x'), a.userId, randomUUID()])).rejects.toThrow();
      } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
    });

    it('the target must belong to the same tenant, workspace and business: an item or warehouse of another business, workspace or tenant is refused', async () => {
      await expect(repo.record(ctxOf(a), input(a, { inventoryItemId: a.otherBizItemId }))).rejects.toThrow(/inventory item is not in this tenant, workspace and business/);
      await expect(repo.record(ctxOf(a), input(a, { inventoryItemId: b.itemId }))).rejects.toThrow(/inventory item is not in this tenant, workspace and business/);
      await expect(repo.record(ctxOf(a), input(a, { inventoryItemId: randomUUID() }))).rejects.toThrow();
      await expect(repo.record(ctxOf(a), input(a, { warehouseId: a.otherBizWarehouseId }))).rejects.toThrow(/warehouse is not in this tenant, workspace and business/);
      await expect(repo.record(ctxOf(a), input(a, { warehouseId: b.warehouseId }))).rejects.toThrow();
      // the same checks apply to a privileged writer: the guard is a trigger, not a convention
      await expect(rawInsert(a, { inventory_item_id: a.otherBizItemId })).rejects.toThrow(/inventory item is not in this tenant, workspace and business/);
      await expect(rawInsert(a, { warehouse_id: a.otherBizWarehouseId })).rejects.toThrow(/warehouse is not in this tenant, workspace and business/);
    });
  });

  describe('regression', () => {
    it('recording an evaluation touches no inventory, movement, event or ABA table', async () => {
      const tables = ['business_operations.inventory_balances', 'business_operations.inventory_movements', 'business_operations.business_events', 'events.outbox_events', 'events.business_event_ledger',
        'approved_business_action.authorized_action_package_versions', 'approved_business_action.authorized_action_captures'];
      const count = async () => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, (await admin.query(`SELECT count(*)::int n FROM ${t} WHERE tenant_id=$1`, [a.tenantId])).rows[0].n])));
      const before = await count();
      await repo.record(ctxOf(a), input(a, { subjectDigest: digestOf('side-effects') }));
      expect(await count()).toEqual(before);
    });
  });
});
