/**
 * Block B2c - BO inventory policy evaluation route: live PostgreSQL + real Fastify application (RLS enforced for the app role).
 * Requires DATABASE_URL (app role) and ADMIN_DATABASE_URL (fixtures / inspection), migrated through 0187.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- HTTP payloads are arbitrary JSON */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@infinicus/configuration';
import { createPool, closePool, UserRepository, MembershipRepository, type TenantContext } from '@infinicus/database';
import { buildApp } from '../src/app.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const STRONG_PASSWORD = 'Correct-Horse-9!';
const RULE_SET = 'inventory-reorder-policy/v1.0.0';
const uc = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const DAY = 86_400_000;

let adminPool: Pool;
let app: FastifyInstance;
const tenantIds: string[] = [];

interface Session { ctx: TenantContext; token: string; bizId: string; itemId: string; warehouseId: string }

async function registerActiveUser(): Promise<{ userId: string; token: string }> {
  const email = `${uc('ev')}@ev-api.example`;
  const reg = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: STRONG_PASSWORD } });
  expect(reg.statusCode).toBe(201);
  const userId = reg.json().id as string;
  await new UserRepository().activate(userId);
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: STRONG_PASSWORD } });
  return { userId, token: login.json().rawSessionToken as string };
}
async function grantRole(ctx: TenantContext, userId: string, role: string | { permissions: string[] }): Promise<void> {
  const memberships = new MembershipRepository();
  const m = await memberships.create(ctx, userId);
  await memberships.activate(ctx, m.id);
  let roleId: string;
  if (typeof role === 'string') {
    roleId = (await adminPool.query(`SELECT id FROM tenancy.roles WHERE tenant_id IS NULL AND code = $1`, [role])).rows[0].id;
  } else {
    roleId = randomUUID();
    await adminPool.query(`INSERT INTO tenancy.roles (id, tenant_id, code, name, description, scope, is_system) VALUES ($1,$2,$3,'Custom','ev test','tenant',false)`, [roleId, ctx.tenantId, `c-${uc('r')}`]);
    await adminPool.query(`INSERT INTO tenancy.role_permissions (role_id, permission_id) SELECT $1, id FROM tenancy.permissions WHERE code = ANY($2::text[])`, [roleId, role.permissions]);
  }
  await memberships.assignRole(ctx, m.id, roleId);
}

/** A tenant with one business holding a healthy inventory item: baseline 170/190, declared USD, USD receipt at 10, 12 issues of 75 (demand 900/90d). */
async function setup(role: string | { permissions: string[] } = 'owner'): Promise<Session> {
  const { userId, token } = await registerActiveUser();
  const tenantId = randomUUID(); const workspaceId = randomUUID(); const sfx = uc('s');
  tenantIds.push(tenantId);
  await adminPool.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'EV API Tenant',$2,'active','test')`, [tenantId, `eva-${sfx}`]);
  await adminPool.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'EV API WS',$3,'active')`, [workspaceId, tenantId, `eva-ws-${sfx}`]);
  const ctx: TenantContext = { tenantId, workspaceId, userId };
  await grantRole(ctx, userId, role);
  const bizId = randomUUID(); const itemId = randomUUID(); const warehouseId = randomUUID();
  await adminPool.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'ZZ EV Biz',$4,'active')`, [bizId, tenantId, workspaceId, uc('eva-biz')]);
  await adminPool.query(`INSERT INTO platform.inventory_items (id, tenant_id, workspace_id, business_id, sku, name) VALUES ($1,$2,$3,$4,$5,'Item')`, [itemId, tenantId, workspaceId, bizId, `sku-${itemId}`]);
  await adminPool.query(`INSERT INTO platform.warehouses (id, tenant_id, workspace_id, business_id, warehouse_code, name) VALUES ($1,$2,$3,$4,$5,'WH')`, [warehouseId, tenantId, workspaceId, bizId, `wh-${warehouseId}`]);
  await adminPool.query(`INSERT INTO business_operations.inventory_balances (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, reorder_point, reorder_quantity) VALUES ($1,$2,$3,$4,$5,170,190)`, [tenantId, workspaceId, bizId, itemId, warehouseId]);
  await adminPool.query(`INSERT INTO platform.business_currency_declarations (tenant_id, workspace_id, business_id, version, declared_currency, provenance, declared_by_user_id, permission_used, correlation_id) VALUES ($1,$2,$3,1,'USD','EXPLICIT_DECLARATION',$4,'platform:admin',$5)`, [tenantId, workspaceId, bizId, userId, randomUUID()]);
  const mv = (type: string, qty: number, cost: string | null, cur: string | null, at: Date) => adminPool.query(
    `INSERT INTO business_operations.inventory_movements (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity, unit_cost, unit_cost_currency, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [tenantId, workspaceId, bizId, itemId, warehouseId, type, qty, cost, cur, at]);
  await mv('receipt', 500, '10', 'USD', new Date(Date.now() - 5 * DAY));
  for (let i = 0; i < 12; i += 1) await mv('issue', -75, null, null, new Date(Date.now() - (i + 1) * DAY));
  return { ctx, token, bizId, itemId, warehouseId };
}

const hdr = (s: { ctx: TenantContext; token: string }, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${s.token}`, 'x-tenant-id': s.ctx.tenantId, 'x-workspace-id': s.ctx.workspaceId, ...extra,
});
const url = (bizId: string) => `/v1/businesses/${bizId}/inventory-policy-evaluations`;
const body = (s: Session, over: Record<string, unknown> = {}) => ({
  actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '1' }, target: { kind: 'inventory_item', id: s.itemId },
  finalParameters: { reorderPoint: 180, reorderQuantity: 200 }, ruleSetVersion: RULE_SET, ...over,
});
const post = (s: Session, payload: unknown, opts: { bizId?: string; key?: string | null; headers?: Record<string, string> } = {}) =>
  app.inject({ method: 'POST', url: url(opts.bizId ?? s.bizId), headers: { ...hdr(s, opts.key === null ? {} : { 'idempotency-key': opts.key ?? uc('key') }), ...(opts.headers ?? {}) }, payload: payload as any });
const evalRows = async (s: Session) => Number((await adminPool.query(`SELECT count(*) n FROM business_operations.inventory_policy_evaluations WHERE tenant_id = $1`, [s.ctx.tenantId])).rows[0].n);
const operationalSnapshot = async (s: Session) => JSON.stringify(await Promise.all([
  'business_operations.inventory_balances', 'platform.inventory_items', 'business_operations.inventory_movements',
].map(async (t) => (await adminPool.query(`SELECT * FROM ${t} WHERE tenant_id = $1 ORDER BY id`, [s.ctx.tenantId])).rows)));

describe.runIf(run)('BO inventory policy evaluation route - live PostgreSQL + Fastify', () => {
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    if (tenantIds.length > 0) {
      // Teardown only: a superuser transaction suspends the append-only/FK triggers to remove this suite's own rows.
      const c = await adminPool.connect();
      try {
        await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'");
        await c.query('DELETE FROM audit.audit_events WHERE tenant_id = ANY($1)', [tenantIds]);
        await c.query('DELETE FROM business_operations.inventory_policy_evaluations WHERE tenant_id = ANY($1)', [tenantIds]);
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK').catch(() => undefined); } finally { c.release(); }
      await deleteMovementsForTenants(adminPool, tenantIds);
    }
    await adminPool?.end(); await closePool();
  });

  it('the owner gets four evidence REFERENCES (201), bound to the exact subject, persisted append-only; the response grants nothing', async () => {
    const s = await setup('owner');
    const r = await post(s, body(s));
    expect(r.statusCode).toBe(201);
    const j = r.json();
    expect(j).toMatchObject({ businessId: s.bizId, ruleSetVersion: RULE_SET, warehouseId: s.warehouseId });
    expect(j.subjectDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(j.evidence.map((e: any) => e.dimension)).toEqual(['CONSTRAINTS', 'RESOURCE_REQUIREMENTS', 'COST', 'EXPECTED_OUTCOME']);
    for (const e of j.evidence) expect(e).toMatchObject({ kind: 'bo_inventory_policy_evaluation', result: 'PASSED' });
    expect(Object.keys(j).sort()).toEqual(['businessId', 'evidence', 'ruleSetVersion', 'snapshotDigest', 'subjectDigest', 'warehouseId']);
    const rows = (await adminPool.query(`SELECT id, dimension, result, subject_digest, requested_by_user_id, rule_set_version FROM business_operations.inventory_policy_evaluations WHERE tenant_id = $1 ORDER BY dimension`, [s.ctx.tenantId])).rows;
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row).toMatchObject({ subject_digest: j.subjectDigest, requested_by_user_id: s.ctx.userId, rule_set_version: RULE_SET });
    expect(new Set(rows.map((x) => x.id))).toEqual(new Set(j.evidence.map((e: any) => e.id)));
  });

  it('a FAILED evaluation is still a recorded fact: it is returned as FAILED, never as approval', async () => {
    const s = await setup('owner');
    const r = await post(s, body(s, { finalParameters: { reorderPoint: 400, reorderQuantity: 600 } }));
    expect(r.statusCode).toBe(201);
    expect(r.json().evidence.map((e: any) => e.result)).toEqual(['FAILED', 'FAILED', 'FAILED', 'FAILED']);
  });

  it('writes one platform audit event: actor, permission, scope, target, correlation, per-dimension results', async () => {
    const s = await setup('owner');
    const r = await post(s, body(s), { headers: { 'x-correlation-id': randomUUID() } });
    expect(r.statusCode).toBe(201);
    const rows = (await adminPool.query(`SELECT * FROM audit.audit_events WHERE tenant_id = $1 AND action = 'bo.inventory_policy_evaluation.requested'`, [s.ctx.tenantId])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspace_id: s.ctx.workspaceId, business_id: s.bizId, actor_id: s.ctx.userId, entity_type: 'inventory_item', entity_id: s.itemId });
    expect(rows[0].metadata).toMatchObject({ permissionUsed: 'bo:write', subjectDigest: r.json().subjectDigest });
    expect(rows[0].metadata.evaluations).toHaveLength(4);
  });

  describe('authentication, authorization and scope', () => {
    it('unauthenticated -> 401, nothing written', async () => {
      const s = await setup('owner');
      const r = await app.inject({ method: 'POST', url: url(s.bizId), headers: { 'idempotency-key': uc('k') }, payload: body(s) as any });
      expect(r.statusCode).toBe(401);
      expect(await evalRows(s)).toBe(0);
    });
    it('bo:write is required: a role with only bo:read gets 403, nothing written', async () => {
      const s = await setup({ permissions: ['bo:read'] });
      const r = await post(s, body(s));
      expect(r.statusCode).toBe(403);
      expect(await evalRows(s)).toBe(0);
    });
    it('an Idempotency-Key is required', async () => {
      const s = await setup('owner');
      const r = await post(s, body(s), { key: null });
      expect(r.statusCode).toBe(400);
      expect(await evalRows(s)).toBe(0);
    });
    it('tenant, workspace and actor come from the authenticated context: another tenant cannot evaluate this business (404) or its item', async () => {
      const a = await setup('owner'); const b = await setup('owner');
      const r = await post(b, body(a), { bizId: a.bizId });
      expect(r.statusCode).toBe(404);
      expect(await evalRows(a)).toBe(0); expect(await evalRows(b)).toBe(0);
      // own business, other tenant's item id: refused as unresolved
      const r2 = await post(b, body(b, { target: { kind: 'inventory_item', id: a.itemId } }));
      expect(r2.statusCode).toBe(400);
      expect(await evalRows(b)).toBe(0);
    });
    it('a spoofed tenant header for a tenant the user does not belong to is refused', async () => {
      const a = await setup('owner'); const b = await setup('owner');
      const r = await app.inject({ method: 'POST', url: url(a.bizId), headers: { ...hdr(a, { 'idempotency-key': uc('k') }), 'x-tenant-id': b.ctx.tenantId }, payload: body(a) as any });
      expect([401, 403, 404]).toContain(r.statusCode);
      expect(await evalRows(a)).toBe(0);
    });
    it('an item of another business in the SAME tenant is not evaluable through this business', async () => {
      const s = await setup('owner');
      const otherBiz = randomUUID(); const otherItem = randomUUID();
      await adminPool.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'Other',$4,'active')`, [otherBiz, s.ctx.tenantId, s.ctx.workspaceId, uc('o')]);
      await adminPool.query(`INSERT INTO platform.inventory_items (id, tenant_id, workspace_id, business_id, sku, name) VALUES ($1,$2,$3,$4,$5,'O')`, [otherItem, s.ctx.tenantId, s.ctx.workspaceId, otherBiz, `sku-${otherItem}`]);
      const r = await post(s, body(s, { target: { kind: 'inventory_item', id: otherItem } }));
      expect(r.statusCode).toBe(400);
      expect(r.json().error.message).toContain('TARGET_UNRESOLVED');
      expect(await evalRows(s)).toBe(0);
    });
  });

  describe('the caller cannot supply authority', () => {
    it.each([
      ['result', { result: 'PASSED' }], ['findings', { findings: [] }], ['thresholds', { thresholds: { orderValueCap: 1e9 } }], ['evaluatedAt', { evaluatedAt: '2020-01-01T00:00:00.000Z' }],
      ['source layer', { source: { layer: 'BUSINESS_OPERATIONS' } }], ['PASSED status', { status: 'PASSED' }], ['operational facts', { facts: { onHand: 1e6 } }],
      ['snapshot digest', { snapshotDigest: 'sha256:x' }], ['evidence ownership', { ownedBy: 'ABA' }], ['dimension', { dimension: 'COST' }], ['subject digest', { subjectDigest: 'sha256:x' }],
      ['actor', { requestedByUserId: randomUUID() }], ['tenant', { tenantId: randomUUID() }],
    ])('%s in the body -> 400, nothing written', async (_name, extra) => {
      const s = await setup('owner');
      const r = await post(s, body(s, extra));
      expect(r.statusCode).toBe(400);
      expect(await evalRows(s)).toBe(0);
    });
    it('a missing, unknown, draft or future rule-set version is refused (no default)', async () => {
      const s = await setup('owner');
      const missing: any = body(s); delete missing.ruleSetVersion;
      expect((await post(s, missing)).statusCode).toBe(400);
      for (const v of ['', 'inventory-reorder-policy/v0.1.0-DRAFT', 'inventory-reorder-policy/v2.0.0', 'latest']) expect((await post(s, body(s, { ruleSetVersion: v }))).statusCode, v).toBe(400);
      expect(await evalRows(s)).toBe(0);
    });
    it('an unsupported action type or schema version is refused', async () => {
      const s = await setup('owner');
      expect((await post(s, body(s, { actionType: { code: 'inventory_adjustment', schemaVersion: '1' } }))).statusCode).toBe(400);
      expect((await post(s, body(s, { actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '2' } }))).statusCode).toBe(400);
      expect(await evalRows(s)).toBe(0);
    });
  });

  describe('target failure is a REFUSAL, not evidence', () => {
    it.each([
      ['a non-UUID id', { kind: 'inventory_item', id: 'sku-1' }, 'TARGET_ID_NOT_UUID'],
      ['an unknown UUID', { kind: 'inventory_item', id: randomUUID() }, 'TARGET_UNRESOLVED'],
      ['the wrong kind', { kind: 'warehouse', id: randomUUID() }, 'TARGET_KIND_INVALID'],
    ])('%s -> 400 and no evidence row', async (_n, target, code) => {
      const s = await setup('owner');
      const r = await post(s, body(s, { target }));
      expect(r.statusCode).toBe(400);
      expect(r.json().error.message).toContain(code);
      expect(await evalRows(s)).toBe(0);
    });
  });

  describe('idempotency (existing Idempotency-Key infrastructure)', () => {
    it('same key + same request replays the original response and writes nothing more', async () => {
      const s = await setup('owner');
      const key = uc('same');
      const first = await post(s, body(s), { key });
      const again = await post(s, body(s), { key });
      expect(first.statusCode).toBe(201); expect(again.statusCode).toBe(201);
      expect(again.json()).toEqual(first.json());
      expect(await evalRows(s)).toBe(4);
    });
    it('same key + a different request is a conflict and writes nothing', async () => {
      const s = await setup('owner');
      const key = uc('conflict');
      expect((await post(s, body(s), { key })).statusCode).toBe(201);
      const other = await post(s, body(s, { finalParameters: { reorderPoint: 181, reorderQuantity: 200 } }), { key });
      expect(other.statusCode).toBe(409);
      expect(await evalRows(s)).toBe(4);
    });
    it('a genuinely new request (new key) appends NEW immutable evidence; earlier rows are untouched', async () => {
      const s = await setup('owner');
      const first = await post(s, body(s));
      const before = (await adminPool.query(`SELECT * FROM business_operations.inventory_policy_evaluations WHERE tenant_id = $1 ORDER BY id`, [s.ctx.tenantId])).rows;
      const second = await post(s, body(s));
      expect(second.statusCode).toBe(201);
      expect(second.json().snapshotDigest).toBe(first.json().snapshotDigest); // same facts, same snapshot, new records
      const ids1 = first.json().evidence.map((e: any) => e.id); const ids2 = second.json().evidence.map((e: any) => e.id);
      expect(ids2.filter((id: string) => ids1.includes(id))).toEqual([]);
      expect(await evalRows(s)).toBe(8);
      const after = (await adminPool.query(`SELECT * FROM business_operations.inventory_policy_evaluations WHERE tenant_id = $1 AND id = ANY($2) ORDER BY id`, [s.ctx.tenantId, before.map((x) => x.id)])).rows;
      expect(after).toEqual(before);
    });
  });

  it('mutates no inventory row (balances, items, movements) and emits no business event', async () => {
    const s = await setup('owner');
    const before = await operationalSnapshot(s);
    const events = async () => Number((await adminPool.query(`SELECT count(*) n FROM business_operations.business_events WHERE tenant_id = $1`, [s.ctx.tenantId])).rows[0].n);
    const e0 = await events();
    expect((await post(s, body(s))).statusCode).toBe(201);
    expect((await post(s, body(s, { finalParameters: { reorderPoint: 999, reorderQuantity: 999 } }))).statusCode).toBe(201);
    expect(await operationalSnapshot(s)).toBe(before);
    expect(await events()).toBe(e0);
  });
});
