/**
 * P0-6e - governed activation API: live PostgreSQL + real Fastify application (RLS enforced for the app role).
 * Requires DATABASE_URL (app role) and ADMIN_DATABASE_URL, migrated through 0195.
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
const ACTION = { code: 'inventory_reorder_policy_update', schemaVersion: '1' };

let adminPool: Pool;
let app: FastifyInstance;

interface Session { ctx: TenantContext; token: string; bizId: string }

async function registerActiveUser(): Promise<{ userId: string; token: string }> {
  const email = `${uc('ea')}@ea-api.example`;
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
    await adminPool.query(`INSERT INTO tenancy.roles (id, tenant_id, code, name, description, scope, is_system) VALUES ($1,$2,$3,'Custom','ea test','tenant',false)`, [roleId, ctx.tenantId, `c-${uc('r')}`]);
    await adminPool.query(`INSERT INTO tenancy.role_permissions (role_id, permission_id) SELECT $1, id FROM tenancy.permissions WHERE code = ANY($2::text[])`, [roleId, role.permissions]);
  }
  await memberships.assignRole(ctx, m.id, roleId);
}

async function setup(role: string | { permissions: string[] } = 'admin'): Promise<Session> {
  const { userId, token } = await registerActiveUser();
  const tenantId = randomUUID(); const workspaceId = randomUUID(); const sfx = uc('s');
  await adminPool.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'EA API Tenant',$2,'active','test')`, [tenantId, `eaa-${sfx}`]);
  await adminPool.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'EA API WS',$3,'active')`, [workspaceId, tenantId, `eaa-ws-${sfx}`]);
  const ctx: TenantContext = { tenantId, workspaceId, userId };
  await grantRole(ctx, userId, role);
  const bizId = randomUUID();
  await adminPool.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'ZZ EA Biz',$4,'active')`, [bizId, tenantId, workspaceId, uc('eaa-biz')]);
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
const url = (bizId: string) => `/v1/businesses/${bizId}/execution-activations`;
const put = (s: Session, payload: unknown, opts: { bizId?: string; key?: string | null } = {}) =>
  app.inject({ method: 'PUT', url: url(opts.bizId ?? s.bizId), headers: hdr(s, opts.key === null ? {} : { 'idempotency-key': opts.key ?? uc('key') }), payload: payload as any });
const get = (s: Session, bizId = s.bizId) => app.inject({ method: 'GET', url: `${url(bizId)}?code=${ACTION.code}&schemaVersion=${ACTION.schemaVersion}`, headers: hdr(s) });
const body = (state: 'ENABLED' | 'DISABLED', over: Record<string, unknown> = {}) => ({ actionType: ACTION, state, reason: 'pilot', ...over });
const rowsOf = async (bizId: string) => (await adminPool.query(`SELECT version, state, actor_user_id, permission_code FROM business_operations.execution_capability_activations WHERE business_id = $1 ORDER BY version`, [bizId])).rows;

describe.runIf(run)('execution activation API - live PostgreSQL + Fastify', () => {
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    await app.ready();
  });
  afterAll(async () => { await app?.close(); await adminPool?.end(); await closePool(); });

  it('a business is NOT_ACTIVATED (closed) until an administrator enables it - nothing is activated or backfilled by default', async () => {
    const s = await setup('admin');
    expect((await get(s)).json()).toMatchObject({ businessId: s.bizId, state: 'NOT_ACTIVATED', version: null, actorUserId: null });
    expect(await rowsOf(s.bizId)).toEqual([]);
  });

  it('an admin (bo:admin) enables, is recorded as the actor under bo:admin, and can disable again', async () => {
    const s = await setup('admin');
    const r = await put(s, body('ENABLED'));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ state: 'ENABLED', version: 1, changed: true, actorUserId: s.ctx.userId, permissionCode: 'bo:admin', reason: 'pilot' });
    expect((await get(s)).json()).toMatchObject({ state: 'ENABLED', version: 1 });
    expect((await put(s, body('DISABLED', { reason: 'stop' }))).json()).toMatchObject({ state: 'DISABLED', version: 2, changed: true });
    expect((await rowsOf(s.bizId)).map((x) => `${x.version}:${x.state}`)).toEqual(['1:ENABLED', '2:DISABLED']);
  });

  it('is idempotent: the same Idempotency-Key replays the response; repeating the state changes nothing', async () => {
    const s = await setup('admin');
    const first = await put(s, body('ENABLED'), { key: 'k-1' });
    const replay = await put(s, body('ENABLED'), { key: 'k-1' });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    const again = await put(s, body('ENABLED'), { key: 'k-2' });
    expect(again.json()).toMatchObject({ changed: false, version: 1 });
    expect(await rowsOf(s.bizId)).toHaveLength(1);
    expect((await put(s, body('DISABLED'), { key: 'k-1' })).statusCode).toBe(409); // same key, different body
  });

  it('requires an Idempotency-Key', async () => {
    const s = await setup('admin');
    expect((await put(s, body('ENABLED'), { key: null })).statusCode).toBe(400);
    expect(await rowsOf(s.bizId)).toEqual([]);
  });

  it('permission: bo:admin is required. Members, viewers, ABA approvers and bo:write-only users are refused (403) and nothing is written', async () => {
    const s = await setup('admin');
    const cases: Array<[string, string | { permissions: string[] }]> = [
      ['member', 'member'], ['viewer', 'viewer'], ['aba:admin only', { permissions: ['aba:admin', 'aba:write', 'bo:read'] }], ['bo:write only', { permissions: ['bo:read', 'bo:write'] }],
    ];
    for (const [name, role] of cases) {
      const other = await addMember(s, role);
      expect((await put(other, body('ENABLED'))).statusCode, name).toBe(403);
    }
    expect(await rowsOf(s.bizId)).toEqual([]);
    const granted = await addMember(s, { permissions: ['bo:admin', 'bo:read'] });
    expect((await put(granted, body('ENABLED'))).statusCode).toBe(200);
  });

  it('reading needs bo:read; an unauthenticated caller gets 401', async () => {
    const s = await setup('admin');
    const noBo = await addMember(s, { permissions: ['aba:read'] });
    expect((await get(noBo)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `${url(s.bizId)}?code=${ACTION.code}&schemaVersion=${ACTION.schemaVersion}` })).statusCode).toBe(401);
  });

  it('server-authoritative: the body cannot name an owner, scope, actor, permission or time (strict 400); the actor is always the authenticated user', async () => {
    const s = await setup('admin');
    for (const extra of [{ tenantId: randomUUID() }, { workspaceId: randomUUID() }, { actorUserId: randomUUID() }, { permissionCode: 'platform:admin' }, { recordedAt: '2020-01-01T00:00:00.000Z' }, { version: 7 }]) {
      expect((await put(s, { ...body('ENABLED'), ...extra })).statusCode, JSON.stringify(extra)).toBe(400);
    }
    expect(await rowsOf(s.bizId)).toEqual([]);
    expect((await put(s, body('ENABLED'))).json().actorUserId).toBe(s.ctx.userId);
  });

  it('a business in another tenant is 404 (never enabled, never disclosed)', async () => {
    const a = await setup('admin');
    const b = await setup('admin');
    expect((await put(a, body('ENABLED'), { bizId: b.bizId })).statusCode).toBe(404);
    expect((await get(a, b.bizId)).statusCode).toBe(404);
    expect(await rowsOf(b.bizId)).toEqual([]);
  });

  it('an action type BO cannot execute cannot be enabled (409), and a malformed request is 400; nothing is written', async () => {
    const s = await setup('admin');
    expect((await put(s, body('ENABLED', { actionType: { code: 'other_action', schemaVersion: '1' } }))).statusCode).toBe(409);
    expect((await put(s, body('ENABLED', { actionType: { code: ACTION.code, schemaVersion: '2' } }))).statusCode).toBe(409);
    expect((await put(s, body('ENABLED', { reason: '' }))).statusCode).toBe(400);
    expect((await put(s, { ...body('ENABLED'), state: 'ON' })).statusCode).toBe(400);
    expect(await rowsOf(s.bizId)).toEqual([]);
  });

  it('enabling is audited, provisions the three delivery subscriptions once, and grants no authorization (no receipt, claim or execution exists)', async () => {
    const s = await setup('admin');
    await put(s, body('ENABLED'));
    await put(s, body('ENABLED'));
    const audit = await adminPool.query(`SELECT actor_id, metadata FROM audit.audit_events WHERE tenant_id=$1 AND action='bo.execution_activation.enabled'`, [s.ctx.tenantId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor_id).toBe(s.ctx.userId);
    expect((await adminPool.query(`SELECT subscriber_name FROM events.event_subscriptions WHERE tenant_id=$1 ORDER BY 1`, [s.ctx.tenantId])).rows.map((r) => r.subscriber_name)).toEqual([
      `bo.authorized_action_intake@${s.ctx.workspaceId}`, `bo.authorized_action_recovery@${s.ctx.workspaceId}`, `om.execution_verification@${s.ctx.workspaceId}`,
    ]);
    for (const table of ['authorized_action_receipts', 'authorized_action_claims', 'authorized_action_executions']) {
      expect((await adminPool.query(`SELECT 1 FROM business_operations.${table} WHERE tenant_id=$1`, [s.ctx.tenantId])).rowCount, table).toBe(0);
    }
  });
});
