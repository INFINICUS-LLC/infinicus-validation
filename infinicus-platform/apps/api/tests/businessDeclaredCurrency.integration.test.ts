/**
 * Business Administration declared currency - live PostgreSQL + real Fastify application (RLS enforced for the app role).
 * Requires DATABASE_URL (app role) and ADMIN_DATABASE_URL (fixtures / inspection), migrated through 0185.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- HTTP payloads are arbitrary JSON */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@infinicus/configuration';
import { createPool, closePool, UserRepository, MembershipRepository, type TenantContext } from '@infinicus/database';
import { buildApp } from '../src/app.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const STRONG_PASSWORD = 'Correct-Horse-9!';
const uc = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

let adminPool: Pool;
let app: FastifyInstance;

interface Session { ctx: TenantContext; token: string; bizId: string }

async function registerActiveUser(): Promise<{ userId: string; token: string }> {
  const email = `${uc('dc')}@dc-api.example`;
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
    await adminPool.query(`INSERT INTO tenancy.roles (id, tenant_id, code, name, description, scope, is_system) VALUES ($1,$2,$3,'Custom','dc test','tenant',false)`, [roleId, ctx.tenantId, `c-${uc('r')}`]);
    await adminPool.query(`INSERT INTO tenancy.role_permissions (role_id, permission_id) SELECT $1, id FROM tenancy.permissions WHERE code = ANY($2::text[])`, [roleId, role.permissions]);
  }
  await memberships.assignRole(ctx, m.id, roleId);
}

async function setup(role: string | { permissions: string[] } = 'owner'): Promise<Session> {
  const { userId, token } = await registerActiveUser();
  const tenantId = randomUUID(); const workspaceId = randomUUID(); const sfx = uc('s');
  await adminPool.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'DC API Tenant',$2,'active','test')`, [tenantId, `dca-${sfx}`]);
  await adminPool.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'DC API WS',$3,'active')`, [workspaceId, tenantId, `dca-ws-${sfx}`]);
  const ctx: TenantContext = { tenantId, workspaceId, userId };
  await grantRole(ctx, userId, role);
  const bizId = randomUUID();
  await adminPool.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'ZZ DC Biz',$4,'active')`, [bizId, tenantId, workspaceId, uc('dca-biz')]);
  return { ctx, token, bizId };
}
async function addMember(s: Session, role: string | { permissions: string[] }): Promise<Session> {
  const { userId, token } = await registerActiveUser();
  const ctx = { ...s.ctx, userId };
  await grantRole(ctx, userId, role);
  return { ctx, token, bizId: s.bizId };
}

const hdr = (s: { ctx: TenantContext; token: string }, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${s.token}`, 'x-tenant-id': s.ctx.tenantId, 'x-workspace-id': s.ctx.workspaceId, ...extra,
});
const url = (bizId: string) => `/v1/businesses/${bizId}/declared-currency`;
const put = (s: Session, payload: unknown, opts: { bizId?: string; key?: string | null } = {}) =>
  app.inject({ method: 'PUT', url: url(opts.bizId ?? s.bizId), headers: hdr(s, opts.key === null ? {} : { 'idempotency-key': opts.key ?? uc('key') }), payload: payload as any });
const get = (s: Session, bizId = s.bizId) => app.inject({ method: 'GET', url: url(bizId), headers: hdr(s) });
const rowsOf = async (bizId: string) => (await adminPool.query(`SELECT version, declared_currency FROM platform.business_currency_declarations WHERE business_id = $1 ORDER BY version`, [bizId])).rows;

describe.runIf(run)('business declared currency API - live PostgreSQL + Fastify', () => {
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    await app.ready();
  });
  afterAll(async () => { await app?.close(); await adminPool?.end(); await closePool(); });

  it('a new business is UNDECLARED even though the tenant carries the silent USD default', async () => {
    const s = await setup('owner');
    const r = await get(s);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'UNDECLARED', businessId: s.bizId, declaration: null });
    expect((await adminPool.query(`SELECT default_currency FROM tenancy.tenants WHERE id = $1`, [s.ctx.tenantId])).rows[0].default_currency).toBe('USD');
    expect((await app.inject({ method: 'GET', url: `${url(s.bizId)}/history`, headers: hdr(s) })).json().items).toEqual([]);
  });

  it('the owner declares USD (201), then EUR for another business, and reads them back', async () => {
    const s = await setup('owner');
    const r = await put(s, { currency: 'USD', expectedVersion: null, reason: 'initial declaration' });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ outcome: 'DECLARED', businessId: s.bizId, declaration: { version: 1, currency: 'USD', provenance: 'EXPLICIT_DECLARATION', declaredByUserId: s.ctx.userId, permissionUsed: 'platform:admin', reason: 'initial declaration' } });
    expect((await get(s)).json()).toMatchObject({ status: 'DECLARED', declaration: { currency: 'USD', version: 1 } });
    const e = await setup('owner');
    expect((await put(e, { currency: 'EUR', expectedVersion: null })).json().declaration.currency).toBe('EUR');
  });

  it('lowercase and malformed currencies are refused with 400 and nothing is written', async () => {
    const s = await setup('owner');
    for (const currency of ['usd', 'US', 'USDX', 'U$D', ' EUR']) {
      expect((await put(s, { currency, expectedVersion: null })).statusCode, currency).toBe(400);
    }
    expect(await rowsOf(s.bizId)).toEqual([]);
  });

  it('the body carries no identity or authority: unknown keys (tenant, workspace, actor, time, version) are refused', async () => {
    const s = await setup('owner');
    for (const extra of [{ tenantId: randomUUID() }, { workspaceId: randomUUID() }, { declaredByUserId: randomUUID() }, { declaredAt: '2001-01-01T00:00:00Z' }, { version: 9 }, { permissionUsed: 'x' }]) {
      expect((await put(s, { currency: 'USD', expectedVersion: null, ...extra })).statusCode, JSON.stringify(extra)).toBe(400);
    }
    expect((await put(s, { currency: 'USD' })).statusCode).toBe(400); // expectedVersion is required (null = undeclared)
    expect(await rowsOf(s.bizId)).toEqual([]);
  });

  it('permission: only platform:admin may declare; admin, member, viewer, bo:write-only and unauthenticated callers are refused', async () => {
    const s = await setup('owner');
    for (const role of ['admin', 'member', 'viewer', { permissions: ['bo:write', 'bo:admin', 'aba:admin'] }] as const) {
      const other = await addMember(s, role as any);
      const r = await put(other, { currency: 'USD', expectedVersion: null });
      expect(r.statusCode, JSON.stringify(role)).toBe(403);
    }
    expect((await app.inject({ method: 'PUT', url: url(s.bizId), headers: { 'idempotency-key': uc('k') }, payload: { currency: 'USD', expectedVersion: null } })).statusCode).toBe(401);
    expect(await rowsOf(s.bizId)).toEqual([]);
  });

  it('reads need bo:read: a viewer can read, a user without it cannot', async () => {
    const s = await setup('owner');
    await put(s, { currency: 'USD', expectedVersion: null });
    expect((await get(await addMember(s, 'viewer'))).json()).toMatchObject({ status: 'DECLARED', declaration: { currency: 'USD' } });
    expect((await get(await addMember(s, { permissions: ['da:read'] }))).statusCode).toBe(403);
  });

  it('scope: another tenant, another workspace and an unknown business cannot declare or read', async () => {
    const s = await setup('owner'); const other = await setup('owner');
    expect((await put(other, { currency: 'USD', expectedVersion: null }, { bizId: s.bizId })).statusCode).toBe(404);
    expect((await get(other, s.bizId)).statusCode).toBe(404);
    expect((await put(s, { currency: 'USD', expectedVersion: null }, { bizId: randomUUID() })).statusCode).toBe(404);
    // a business in a different workspace of the SAME tenant
    const ws2 = randomUUID(); const biz2 = randomUUID();
    await adminPool.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'WS2',$3,'active')`, [ws2, s.ctx.tenantId, `ws2-${ws2}`]);
    await adminPool.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'Other WS',$4,'active')`, [biz2, s.ctx.tenantId, ws2, uc('b2')]);
    expect((await put(s, { currency: 'USD', expectedVersion: null }, { bizId: biz2 })).statusCode).toBe(404);
    // a header naming a tenant the caller does not belong to
    const forged = { ...s, ctx: { ...s.ctx, tenantId: other.ctx.tenantId, workspaceId: other.ctx.workspaceId } };
    expect([403, 404]).toContain((await put(forged, { currency: 'USD', expectedVersion: null })).statusCode);
    expect(await rowsOf(s.bizId)).toEqual([]);
    expect(await rowsOf(biz2)).toEqual([]);
  });

  it('idempotency: the same Idempotency-Key replays the stored response; a fresh key with the same value is a 200 no-op; a missing key is refused', async () => {
    const s = await setup('owner');
    const key = uc('same');
    const first = await put(s, { currency: 'USD', expectedVersion: null }, { key });
    const replay = await put(s, { currency: 'USD', expectedVersion: null }, { key });
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    const again = await put(s, { currency: 'USD', expectedVersion: null });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ outcome: 'UNCHANGED', declaration: { version: 1 } });
    expect((await put(s, { currency: 'USD', expectedVersion: null }, { key: null })).statusCode).toBe(400);
    expect(await rowsOf(s.bizId)).toEqual([{ version: 1, declared_currency: 'USD' }]);
    const audits = (await adminPool.query(`SELECT action FROM audit.audit_events WHERE tenant_id = $1 AND action LIKE 'business_admin.%'`, [s.ctx.tenantId])).rows;
    expect(audits).toEqual([{ action: 'business_admin.declared_currency.declared' }]);
  });

  it('conflicts are explicit (409) and a change keeps history and is audited with the actor from the token', async () => {
    const s = await setup('owner');
    await put(s, { currency: 'USD', expectedVersion: null });
    expect((await put(s, { currency: 'EUR', expectedVersion: null, reason: 'x' })).statusCode).toBe(409); // already declared
    expect((await put(s, { currency: 'EUR', expectedVersion: 4, reason: 'x' })).statusCode).toBe(409); // stale
    expect((await put(s, { currency: 'EUR', expectedVersion: 1 })).statusCode).toBe(400); // reason required
    const changed = await put(s, { currency: 'EUR', expectedVersion: 1, reason: 'moved to the euro area' });
    expect(changed.statusCode).toBe(201);
    expect(changed.json()).toMatchObject({ outcome: 'CHANGED', declaration: { version: 2, currency: 'EUR', priorCurrency: 'USD', supersedesVersion: 1 } });
    expect((await put(s, { currency: 'USD', expectedVersion: 1, reason: 'stale revert' })).statusCode).toBe(409);
    const h = (await app.inject({ method: 'GET', url: `${url(s.bizId)}/history`, headers: hdr(s) })).json();
    expect(h.items.map((i: any) => [i.version, i.currency])).toEqual([[1, 'USD'], [2, 'EUR']]);
    const audit = (await adminPool.query(`SELECT action, actor_id, metadata FROM audit.audit_events WHERE tenant_id = $1 AND action = 'business_admin.declared_currency.changed'`, [s.ctx.tenantId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_id).toBe(s.ctx.userId);
    expect(audit[0].metadata).toMatchObject({ permissionUsed: 'platform:admin', priorCurrency: 'USD', newCurrency: 'EUR', reason: 'moved to the euro area' });
  });

  it('a declaration or change rewrites no inventory cost currency and no evaluation row', async () => {
    const s = await setup('owner');
    const item = randomUUID(); const wh = randomUUID();
    await adminPool.query(`INSERT INTO platform.inventory_items (id, tenant_id, workspace_id, business_id, sku, name) VALUES ($1,$2,$3,$4,$5,'I')`, [item, s.ctx.tenantId, s.ctx.workspaceId, s.bizId, `sku-${item}`]);
    await adminPool.query(`INSERT INTO platform.warehouses (id, tenant_id, workspace_id, business_id, warehouse_code, name) VALUES ($1,$2,$3,$4,$5,'W')`, [wh, s.ctx.tenantId, s.ctx.workspaceId, s.bizId, `wh-${wh}`]);
    await adminPool.query(`INSERT INTO business_operations.inventory_movements (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity, unit_cost, unit_cost_currency) VALUES ($1,$2,$3,$4,$5,'receipt',2,9,'EUR')`, [s.ctx.tenantId, s.ctx.workspaceId, s.bizId, item, wh]);
    const snap = async () => (await adminPool.query(`SELECT md5(string_agg(to_jsonb(m)::text,'|' ORDER BY id)) h FROM business_operations.inventory_movements m WHERE tenant_id = $1`, [s.ctx.tenantId])).rows[0].h;
    const before = await snap();
    await put(s, { currency: 'USD', expectedVersion: null });
    await put(s, { currency: 'JPY', expectedVersion: 1, reason: 'switch' });
    expect(await snap()).toBe(before);
  });
});
