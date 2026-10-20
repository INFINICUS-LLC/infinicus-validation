/**
 * POS-8b: printer registry (migration 0208). A business declares its printers (name, kind, connection, paper width); the first active printer of a kind is its
 * default, there is at most one default per kind, names are unique among active printers, printers are retired not deleted, and the registry holds no
 * device address. Declaring needs bo:admin; reading needs bo:read; every write needs an Idempotency-Key. The database enforces the invariants even for
 * direct writes. Live PostgreSQL + real Fastify application. Requires DATABASE_URL and ADMIN_DATABASE_URL, migrated through 0208.
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
  const email = `${uc('tn')}@tn-api.example`;
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
    await adminPool.query(`INSERT INTO tenancy.roles (id, tenant_id, code, name, description, scope, is_system) VALUES ($1,$2,$3,'Custom','tn test','tenant',false)`, [roleId, ctx.tenantId, `c-${uc('r')}`]);
    await adminPool.query(`INSERT INTO tenancy.role_permissions (role_id, permission_id) SELECT $1, id FROM tenancy.permissions WHERE code = ANY($2::text[])`, [roleId, role.permissions]);
  }
  await memberships.assignRole(ctx, m.id, roleId);
}

async function setup(role: string | { permissions: string[] } = 'owner'): Promise<Session> {
  const { userId, token } = await registerActiveUser();
  const tenantId = randomUUID(); const workspaceId = randomUUID(); const sfx = uc('s');
  await adminPool.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'TN API Tenant',$2,'active','test')`, [tenantId, `tna-${sfx}`]);
  await adminPool.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'TN API WS',$3,'active')`, [workspaceId, tenantId, `tna-ws-${sfx}`]);
  const ctx: TenantContext = { tenantId, workspaceId, userId };
  await grantRole(ctx, userId, role);
  const bizId = randomUUID();
  await adminPool.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'ZZ TN Biz',$4,'active')`, [bizId, tenantId, workspaceId, uc('tna-biz')]);
  return { ctx, token, bizId };
}
const hdr = (s: { ctx: TenantContext; token: string }, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${s.token}`, 'x-tenant-id': s.ctx.tenantId, 'x-workspace-id': s.ctx.workspaceId, ...extra,
});
const sessionsUrl = (bizId: string) => `/v1/businesses/${bizId}/register-sessions`;
const ordersUrl = (bizId: string) => `/v1/businesses/${bizId}/orders`;
const declare = (s: Session, currency: string) => app.inject({ method: 'PUT', url: `/v1/businesses/${s.bizId}/declared-currency`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { currency, expectedVersion: null } });
const openRegister = (s: Session, openingCash = 0) => app.inject({ method: 'POST', url: sessionsUrl(s.bizId), headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { openingCash } });

const url = (bizId: string) => `/v1/businesses/${bizId}/printers`;
const create = (s: Session, payload: unknown, key = uc('key')) => app.inject({ method: 'POST', url: url(s.bizId), headers: hdr(s, { 'idempotency-key': key }), payload: payload as any });
const list = (s: Session) => app.inject({ method: 'GET', url: url(s.bizId), headers: hdr(s) });
const makeDefault = (s: Session, id: string) => app.inject({ method: 'POST', url: `${url(s.bizId)}/${id}/default`, headers: hdr(s, { 'idempotency-key': uc('key') }) });
const retire = (s: Session, id: string) => app.inject({ method: 'POST', url: `${url(s.bizId)}/${id}/retire`, headers: hdr(s, { 'idempotency-key': uc('key') }) });
const printer = (name: string, over: Record<string, unknown> = {}) => ({ name, kind: 'receipt', connection: 'network', paperMm: 80, ...over });
const names = (r: any) => (r.json().printers as any[]).map((p) => `${p.name}${p.isDefault ? '*' : ''}${p.status === 'retired' ? '(retired)' : ''}`);

describe.skipIf(!run)('POS-8b printer registry (live database)', () => {
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    await app.ready();
  });
  afterAll(async () => { await app?.close(); await adminPool?.end(); await closePool(); });

  it('the migration is recorded, the table has row-level security and the two partial unique indexes', async () => {
    expect((await adminPool.query(`SELECT filename FROM _migrations WHERE filename = '0208_create_printers.sql'`)).rowCount).toBe(1);
    expect((await adminPool.query(`SELECT relrowsecurity FROM pg_class WHERE oid = 'business_operations.printers'::regclass`)).rows[0].relrowsecurity).toBe(true);
    const idx = (await adminPool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'business_operations' AND tablename = 'printers'`)).rows.map((r) => r.indexname);
    expect(idx).toEqual(expect.arrayContaining(['idx_printers_active_name_per_business', 'idx_printers_one_default_per_business_kind']));
  });

  it('the first active printer of each kind is its default; later ones are not; the response never carries an address', async () => {
    const s = await setup();
    const a = await create(s, printer('Front receipt'));
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ name: 'Front receipt', kind: 'receipt', connection: 'network', paperMm: 80, isDefault: true, status: 'active', retiredAt: null });
    expect(Object.keys(a.json()).sort()).toEqual(['connection', 'createdAt', 'id', 'isDefault', 'kind', 'name', 'paperMm', 'retiredAt', 'status']);
    expect((await create(s, printer('Back receipt', { paperMm: 58 }))).json().isDefault).toBe(false);
    expect((await create(s, printer('Kitchen 1', { kind: 'kitchen', connection: 'usb' }))).json().isDefault).toBe(true);   // default of ITS kind
    expect(names(await list(s))).toEqual(['Kitchen 1*', 'Front receipt*', 'Back receipt']);
  });

  it('creating with isDefault moves the default; switching the default is exact and repeatable', async () => {
    const s = await setup();
    const a = (await create(s, printer('A'))).json(); const b = (await create(s, printer('B', { isDefault: true }))).json();
    expect(b.isDefault).toBe(true);
    expect(names(await list(s))).toEqual(['B*', 'A']);
    expect((await makeDefault(s, a.id)).json().isDefault).toBe(true);
    expect(names(await list(s))).toEqual(['A*', 'B']);
    expect((await makeDefault(s, a.id)).statusCode).toBe(200);                         // already the default: no change
    expect((await adminPool.query(`SELECT count(*)::int AS n FROM business_operations.printers WHERE business_id = $1 AND is_default`, [s.bizId])).rows[0].n).toBe(1);
  });

  it('names are unique among active printers (any letter case) and can be reused once the printer is retired', async () => {
    const s = await setup();
    const a = (await create(s, printer('Counter'))).json();
    expect((await create(s, printer('counter'))).statusCode).toBe(409);
    expect((await create(s, printer('  Counter  '))).statusCode).toBe(409);               // trimmed by the API
    expect((await retire(s, a.id)).statusCode).toBe(200);
    expect((await create(s, printer('Counter'))).statusCode).toBe(201);
  });

  it('retiring keeps the printer for history, clears its default, and a retired printer cannot be the default; retiring twice is harmless', async () => {
    const s = await setup();
    const a = (await create(s, printer('A'))).json(); const b = (await create(s, printer('B'))).json();
    const r = await retire(s, a.id);
    expect(r.json()).toMatchObject({ status: 'retired', isDefault: false });
    expect(r.json().retiredAt).not.toBeNull();
    expect((await retire(s, a.id)).statusCode).toBe(200);
    expect((await makeDefault(s, a.id)).statusCode).toBe(409);
    expect(names(await list(s))).toEqual(['B', 'A(retired)']);                           // no default until one is chosen
    expect((await makeDefault(s, b.id)).json().isDefault).toBe(true);
    expect((await adminPool.query(`SELECT count(*)::int AS n FROM business_operations.printers WHERE business_id = $1`, [s.bizId])).rows[0].n).toBe(2);   // nothing deleted
  });

  it('refuses bad input: unknown kind or connection, paper widths other than 58/80, empty or long names, and any extra field such as an address', async () => {
    const s = await setup();
    for (const bad of [printer('X', { kind: 'label' }), printer('X', { connection: 'wifi' }), printer('X', { paperMm: 70 }), printer(''), printer('   '), printer('x'.repeat(81)),
      printer('X', { address: '192.168.1.50:9100' }), printer('X', { ip: '10.0.0.2' })]) {
      expect((await create(s, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await list(s)).json().printers).toEqual([]);
  });

  it('needs bo:admin to declare, change or retire (bo:write is not enough), bo:read to list, and an Idempotency-Key for every write', async () => {
    const s = await setup('owner');
    const a = (await create(s, printer('A'))).json();
    const writer = await setup({ permissions: ['bo:read', 'bo:write'] });
    expect((await create(writer, printer('W'))).statusCode).toBe(403);
    expect((await makeDefault(writer, a.id)).statusCode).toBe(403);
    expect((await retire(writer, a.id)).statusCode).toBe(403);
    expect((await list(writer)).statusCode).toBe(200);
    const noRead = await setup({ permissions: ['bo:write'] });
    expect((await list(noRead)).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: url(s.bizId), headers: hdr(s), payload: printer('NoKey') })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `${url(s.bizId)}/${a.id}/retire`, headers: hdr(s) })).statusCode).toBe(400);
  });

  it('the same Idempotency-Key replays the first answer and creates one printer', async () => {
    const s = await setup();
    const key = uc('same');
    const first = await create(s, printer('Once'), key);
    const again = await create(s, printer('Once'), key);
    expect(again.statusCode).toBe(201);
    expect(again.json().id).toBe(first.json().id);
    expect((await list(s)).json().printers).toHaveLength(1);
  });

  it('is isolated: another workspace cannot see, change or retire these printers, and a printer of one business is not reachable through another', async () => {
    const mine = await setup(); const theirs = await setup();
    const p = (await create(mine, printer('Mine'))).json();
    expect((await app.inject({ method: 'GET', url: url(mine.bizId), headers: hdr(theirs) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `${url(mine.bizId)}/${p.id}/retire`, headers: hdr(theirs, { 'idempotency-key': uc('key') }) })).statusCode).toBe(404);
    const other = await adminPool.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'ZZ Second Biz',$4,'active') RETURNING id`, [randomUUID(), mine.ctx.tenantId, mine.ctx.workspaceId, uc('second')]);
    const viaOther = await app.inject({ method: 'POST', url: `/v1/businesses/${other.rows[0].id}/printers/${p.id}/retire`, headers: hdr(mine, { 'idempotency-key': uc('key') }) });
    expect(viaOther.statusCode).toBe(404);
    expect((await list(mine)).json().printers[0].status).toBe('active');
  });

  it('row-level security: as the application role, a session scoped to another tenant/workspace sees none of these rows, its own scope sees them', async () => {
    const mine = await setup(); const theirs = await setup();
    await create(mine, printer('Visible'));
    const app_ = new Pool({ connectionString: process.env.DATABASE_URL });
    const countAs = async (s: Session): Promise<number> => {
      const c = await app_.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.workspace_id', $2, true)`, [s.ctx.tenantId, s.ctx.workspaceId]);
        const r = await c.query(`SELECT count(*)::int AS n FROM business_operations.printers WHERE business_id = $1`, [mine.bizId]);
        await c.query('ROLLBACK');
        return r.rows[0].n;
      } finally { c.release(); }
    };
    try { expect(await countAs(mine)).toBe(1); expect(await countAs(theirs)).toBe(0); } finally { await app_.end(); }
  });

  it('the database refuses what the API would never send: two active defaults, a default retired printer, mismatched retired_at, bad paper, untrimmed or empty names', async () => {
    const s = await setup();
    const row = (extra: string, values: unknown[]) => adminPool.query(
      `INSERT INTO business_operations.printers (tenant_id, workspace_id, business_id, name, kind, connection, paper_mm, is_default, status, retired_at${extra ? ', ' + extra : ''})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [s.ctx.tenantId, s.ctx.workspaceId, s.bizId, ...values]);
    await row('', ['D1', 'receipt', 'browser', 58, true, 'active', null]);
    await expect(row('', ['D2', 'receipt', 'browser', 58, true, 'active', null])).rejects.toMatchObject({ code: '23505' });        // second default
    await expect(row('', ['R1', 'receipt', 'browser', 58, true, 'retired', new Date()])).rejects.toMatchObject({ code: '23514' });   // retired default
    await expect(row('', ['R2', 'receipt', 'browser', 58, false, 'retired', null])).rejects.toMatchObject({ code: '23514' });        // retired without time
    await expect(row('', ['R3', 'receipt', 'browser', 58, false, 'active', new Date()])).rejects.toMatchObject({ code: '23514' });   // time without retiring
    await expect(row('', ['P1', 'receipt', 'browser', 57, false, 'active', null])).rejects.toMatchObject({ code: '23514' });
    await expect(row('', [' P2', 'receipt', 'browser', 58, false, 'active', null])).rejects.toMatchObject({ code: '23514' });
    await expect(row('', ['', 'receipt', 'browser', 58, false, 'active', null])).rejects.toMatchObject({ code: '23514' });
    await expect(row('', ['D1', 'receipt', 'usb', 80, false, 'active', null])).rejects.toMatchObject({ code: '23505' });             // same name, same business
  });
});
