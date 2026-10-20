/**
 * POS-6c: order notes (migration 0207). A note is internal text on an OPEN order (1-500 characters after trimming, an empty note clears it, never a card
 * number); it is read-only once the order is completed or voided; the database enforces the length and card-number rules even for direct writes.
 * Live PostgreSQL + real Fastify application. Requires DATABASE_URL and ADMIN_DATABASE_URL, migrated through 0207.
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
const createOrder = (s: Session) => app.inject({ method: 'POST', url: ordersUrl(s.bizId), headers: hdr(s, { 'idempotency-key': uc('key') }), payload: {} });
const addLine = (s: Session, orderId: string, unitPrice: number) => app.inject({ method: 'POST', url: `${ordersUrl(s.bizId)}/${orderId}/line-items`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { description: 'Item', quantity: 1, unitPrice } });
const complete = (s: Session, orderId: string, body: unknown, key = uc('key')) => app.inject({ method: 'POST', url: `${ordersUrl(s.bizId)}/${orderId}/complete`, headers: hdr(s, { 'idempotency-key': key }), payload: body as any });
const getOrder = (s: Session, orderId: string) => app.inject({ method: 'GET', url: `${ordersUrl(s.bizId)}/${orderId}`, headers: hdr(s) });
const cash = (amountTendered: number, reference?: string) => ({ method: 'cash', amountTendered, ...(reference ? { reference } : {}) });
const paymentRows = async (orderId: string) => (await adminPool.query(`SELECT position, method, amount_tendered::float8 AS tendered, amount_applied::float8 AS applied, change_given::float8 AS change, reference FROM business_operations.order_payments WHERE order_id = $1 ORDER BY position`, [orderId])).rows;

/** A business with a declared currency, an open register and one order with a single line of the given price. */
async function ready(currency: string, price: number, openingCash = 0): Promise<{ s: Session; sessionId: string; orderId: string }> {
  const s = await setup('owner');
  expect((await declare(s, currency)).statusCode).toBe(201);
  const reg = await openRegister(s, openingCash);
  expect(reg.statusCode).toBe(201);
  const order = (await createOrder(s)).json();
  expect((await addLine(s, order.id, price)).statusCode).toBe(200);
  return { s, sessionId: reg.json().id, orderId: order.id };
}


/** Another user in the SAME tenant, workspace and business as `s`, holding the given role (the cashier, the manager, ...). */
async function joinAs(s: Session, role: string | { permissions: string[] }): Promise<Session> {
  const { userId, token } = await registerActiveUser();
  const ctx: TenantContext = { ...s.ctx, userId };
  await grantRole(ctx, userId, role);
  return { ctx, token, bizId: s.bizId };
}

const noteUrl = (s: Session, orderId: string) => `${ordersUrl(s.bizId)}/${orderId}/note`;
const putNote = (s: Session, orderId: string, body: unknown, key = uc('key')) => app.inject({ method: 'POST', url: noteUrl(s, orderId), headers: hdr(s, { 'idempotency-key': key }), payload: body as any });
const noteInDb = async (orderId: string) => (await adminPool.query(`SELECT note FROM platform.orders WHERE id = $1`, [orderId])).rows[0].note as string | null;
const noteEvents = async (orderId: string) => (await adminPool.query(`SELECT payload FROM business_operations.order_events WHERE order_id = $1 AND event_type = 'note' ORDER BY created_at, id`, [orderId])).rows.map((r) => r.payload);

describe.runIf(run)('POS-6c order notes - live PostgreSQL + Fastify', () => {
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    await app.ready();
  });
  afterAll(async () => { await app?.close(); await adminPool?.end(); await closePool(); });

  it('the migration is recorded and the column and its check exist', async () => {
    expect((await adminPool.query(`SELECT filename FROM _migrations WHERE filename = '0207_add_order_note.sql'`)).rowCount).toBe(1);
    const col = await adminPool.query(`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'platform' AND table_name = 'orders' AND column_name = 'note'`);
    expect(col.rows[0]).toEqual({ data_type: 'text', is_nullable: 'YES' });
    expect((await adminPool.query(`SELECT 1 FROM pg_constraint WHERE conname = 'orders_note_format'`)).rowCount).toBe(1);
  });

  it('a new order has no note; setting one stores the trimmed text and every read returns it (get and list)', async () => {
    const { s, orderId } = await ready('USD', 10);
    expect((await getOrder(s, orderId)).json().note).toBeNull();
    const r = await putNote(s, orderId, { note: '  Table 4, no sugar  ' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ note: 'Table 4, no sugar', operationalStatus: 'planned', totalAmount: 10 });
    expect(await noteInDb(orderId)).toBe('Table 4, no sugar');
    expect((await getOrder(s, orderId)).json().note).toBe('Table 4, no sugar');
    const list = await app.inject({ method: 'GET', url: `${ordersUrl(s.bizId)}?status=planned&limit=20`, headers: hdr(s) });
    expect(list.json().orders.find((o: any) => o.id === orderId).note).toBe('Table 4, no sugar');
  });

  it('a note can be replaced and cleared; an empty or blank note clears it to NULL; each change leaves an event without the text', async () => {
    const { s, orderId } = await ready('USD', 10);
    expect((await putNote(s, orderId, { note: 'first' })).json().note).toBe('first');
    expect((await putNote(s, orderId, { note: 'second' })).json().note).toBe('second');
    expect((await putNote(s, orderId, { note: '   ' })).json().note).toBeNull();
    expect(await noteInDb(orderId)).toBeNull();
    expect((await putNote(s, orderId, { note: 'third' })).statusCode).toBe(200);
    expect((await putNote(s, orderId, { note: null })).json().note).toBeNull();
    const events = await noteEvents(orderId);
    expect(events.map((e: any) => e.kind)).toEqual(['order_note_set', 'order_note_set', 'order_note_cleared', 'order_note_set', 'order_note_cleared']);
    expect(JSON.stringify(events)).not.toMatch(/first|second|third/);
  });

  it('refuses a bad note with 400 and stores nothing: too long, a card number, unknown fields, a missing note, wrong types', async () => {
    const { s, orderId } = await ready('USD', 10);
    expect((await putNote(s, orderId, { note: 'keep me' })).statusCode).toBe(200);
    for (const body of [
      { note: 'x'.repeat(501) }, { note: 'x'.repeat(1001) },
      { note: 'paid with 4111 1111 1111 1111' }, { note: '4111-1111-1111-1111' }, { note: '4111111111111111' },
      { note: 'ok', extra: 1 }, {}, { note: 42 }, { note: ['a'] },
    ]) {
      expect((await putNote(s, orderId, body)).statusCode, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect(await noteInDb(orderId)).toBe('keep me');
    expect(await noteEvents(orderId)).toHaveLength(1);
  });

  it('the database refuses a bad note even when the API is bypassed: empty text, over 500 characters, a card number; and accepts a valid one', async () => {
    const { orderId } = await ready('USD', 10);
    for (const bad of ['', 'x'.repeat(501), 'card 4111 1111 1111 1111', '4111-1111-1111-1111']) {
      await expect(adminPool.query(`UPDATE platform.orders SET note = $2 WHERE id = $1`, [orderId, bad]), bad.slice(0, 20)).rejects.toMatchObject({ code: '23514' });
    }
    await adminPool.query(`UPDATE platform.orders SET note = $2 WHERE id = $1`, [orderId, 'x'.repeat(500)]);
    expect((await noteInDb(orderId))).toHaveLength(500);
    await adminPool.query(`UPDATE platform.orders SET note = NULL WHERE id = $1`, [orderId]);
  });

  it('a completed or voided order keeps its note but can no longer change it (409)', async () => {
    const { s, orderId } = await ready('USD', 10);
    expect((await putNote(s, orderId, { note: 'pick up at 6' })).statusCode).toBe(200);
    expect((await complete(s, orderId, { payments: [cash(10)] })).statusCode).toBe(200);
    expect((await getOrder(s, orderId)).json()).toMatchObject({ operationalStatus: 'completed', note: 'pick up at 6' });
    expect((await putNote(s, orderId, { note: 'changed after the sale' })).statusCode).toBe(409);
    expect((await putNote(s, orderId, { note: null })).statusCode).toBe(409);
    expect(await noteInDb(orderId)).toBe('pick up at 6');

    const second = await ready('USD', 5);
    expect((await putNote(second.s, second.orderId, { note: 'wrong order' })).statusCode).toBe(200);
    const voided = await app.inject({ method: 'POST', url: `${ordersUrl(second.s.bizId)}/${second.orderId}/void`, headers: hdr(second.s, { 'idempotency-key': uc('key') }), payload: {} });
    expect(voided.statusCode).toBe(200);
    expect((await putNote(second.s, second.orderId, { note: 'again' })).statusCode).toBe(409);
    expect(await noteInDb(second.orderId)).toBe('wrong order');
  });

  it('who may write a note: owner, admin and member (bo:write) yes; viewer (read only) no (403)', async () => {
    const { s, orderId } = await ready('USD', 10);
    for (const role of ['admin', 'member'] as const) {
      const who = await joinAs(s, role);
      expect((await putNote(who, orderId, { note: `by ${role}` })).statusCode, role).toBe(200);
    }
    const viewer = await joinAs(s, 'viewer');
    expect((await putNote(viewer, orderId, { note: 'nope' })).statusCode).toBe(403);
    expect(await noteInDb(orderId)).toBe('by member');
    expect((await getOrder(viewer, orderId)).json().note).toBe('by member');   // a viewer can read it
  });

  it("another tenant cannot write the note of this order (404) and nothing changes", async () => {
    const { s, orderId } = await ready('USD', 10);
    expect((await putNote(s, orderId, { note: 'mine' })).statusCode).toBe(200);
    const other = await setup('owner');
    expect((await putNote(other, orderId, { note: 'theirs' })).statusCode).toBe(404);
    expect(await noteInDb(orderId)).toBe('mine');
  });

  it('the same Idempotency-Key replays instead of writing twice (one event); a missing key is refused', async () => {
    const { s, orderId } = await ready('USD', 10);
    const key = uc('same');
    expect((await putNote(s, orderId, { note: 'once' }, key)).statusCode).toBe(200);
    expect((await putNote(s, orderId, { note: 'once' }, key)).statusCode).toBe(200);
    expect(await noteEvents(orderId)).toHaveLength(1);
    const none = await app.inject({ method: 'POST', url: noteUrl(s, orderId), headers: hdr(s), payload: { note: 'x' } });
    expect(none.statusCode).toBeGreaterThanOrEqual(400);
    expect(await noteInDb(orderId)).toBe('once');
  });

  it('the note does not change the total, the lines or the payments', async () => {
    const { s, orderId } = await ready('KWD', 4.25);
    const before = (await getOrder(s, orderId)).json();
    const after = (await putNote(s, orderId, { note: 'gift wrap' })).json();
    expect({ ...after, note: null, updatedAt: null }).toEqual({ ...before, note: null, updatedAt: null });
    const done = await complete(s, orderId, { payments: [cash(5)] });
    expect(done.json()).toMatchObject({ totalAmount: 4.25, changeDue: 0.75, note: 'gift wrap' });
  });
});
