/**
 * POS-8c: the print-job log and print routing (migration 0209). A print attempt is logged AFTER it, with its outcome, append-only and without any content;
 * a receipt only for a completed order, a kitchen ticket not for a voided one; a printer must belong to the business and match the kind; print-routes names
 * the active default printer of each kind. Live PostgreSQL + real Fastify application. Requires DATABASE_URL and ADMIN_DATABASE_URL, migrated through 0209.
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


const jobsUrl = (s: Session, orderId: string) => `${ordersUrl(s.bizId)}/${orderId}/print-jobs`;
const record = (s: Session, orderId: string, body: unknown, key = uc('key')) => app.inject({ method: 'POST', url: jobsUrl(s, orderId), headers: hdr(s, { 'idempotency-key': key }), payload: body as any });
const job = (over: Record<string, unknown> = {}) => ({ kind: 'receipt', trigger: 'automatic', outcome: 'succeeded', printedVia: 'browser', ...over });
const addPrinter = (s: Session, name: string, kind: 'receipt' | 'kitchen', over: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: `/v1/businesses/${s.bizId}/printers`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { name, kind, connection: 'network', paperMm: 80, ...over } });
const voidOrder = (s: Session, orderId: string) => app.inject({ method: 'POST', url: `${ordersUrl(s.bizId)}/${orderId}/void`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { reason: 'test' } });
const jobRows = async (orderId: string) => (await adminPool.query(`SELECT kind, trigger_kind, outcome, failure_code, printed_via, printer_id FROM business_operations.print_jobs WHERE order_id = $1 ORDER BY created_at, id`, [orderId])).rows;

/** A business with one COMPLETED order. */
async function sold(): Promise<{ s: Session; orderId: string }> {
  const { s, orderId } = await ready('USD', 10);
  expect((await complete(s, orderId, { payments: [cash(10)] })).statusCode).toBe(200);
  return { s, orderId };
}

describe.runIf(run)('POS-8c print jobs and routing - live PostgreSQL + Fastify', () => {
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    await app.ready();
  });
  afterAll(async () => { await app?.close(); await adminPool?.end(); await closePool(); });

  it('the migration is recorded; the table has row-level security; update and delete are refused even for the administrator, and the truncate guard is installed', async () => {
    expect((await adminPool.query(`SELECT filename FROM _migrations WHERE filename = '0209_create_print_jobs.sql'`)).rowCount).toBe(1);
    expect((await adminPool.query(`SELECT relrowsecurity FROM pg_class WHERE oid = 'business_operations.print_jobs'::regclass`)).rows[0].relrowsecurity).toBe(true);
    const { s, orderId } = await sold();
    const id = (await record(s, orderId, job())).json().id;
    await expect(adminPool.query(`UPDATE business_operations.print_jobs SET outcome = 'failed', failure_code = 'other' WHERE id = $1`, [id])).rejects.toMatchObject({ code: '23000' });
    await expect(adminPool.query(`DELETE FROM business_operations.print_jobs WHERE id = $1`, [id])).rejects.toMatchObject({ code: '23000' });
    // TRUNCATE is not sent to the shared test database (lock hygiene rule); the guard that refuses it is checked in the catalogue instead.
    const triggers = (await adminPool.query(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'business_operations.print_jobs'::regclass AND NOT tgisinternal ORDER BY tgname`)).rows.map((r) => r.tgname);
    expect(triggers).toEqual(['forbid_mutation_print_jobs', 'forbid_truncate_print_jobs']);
    expect((await jobRows(orderId))).toHaveLength(1);
  });

  it('records an automatic receipt print and a reprint for a completed order; the response and the row carry no content', async () => {
    const { s, orderId } = await sold();
    const a = await record(s, orderId, job());
    expect(a.statusCode).toBe(201);
    expect(Object.keys(a.json()).sort()).toEqual(['createdAt', 'failureCode', 'id', 'kind', 'orderId', 'outcome', 'printedVia', 'printerId', 'trigger']);
    expect((await record(s, orderId, job({ trigger: 'reprint', printedVia: 'device' }))).statusCode).toBe(201);
    expect(await jobRows(orderId)).toEqual([
      { kind: 'receipt', trigger_kind: 'automatic', outcome: 'succeeded', failure_code: null, printed_via: 'browser', printer_id: null },
      { kind: 'receipt', trigger_kind: 'reprint', outcome: 'succeeded', failure_code: null, printed_via: 'device', printer_id: null },
    ]);
    const cols = (await adminPool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'business_operations' AND table_name = 'print_jobs'`)).rows.map((r) => r.column_name);
    expect(cols.sort()).toEqual(['business_id', 'created_at', 'created_by', 'failure_code', 'id', 'kind', 'order_id', 'outcome', 'printed_via', 'printer_id', 'tenant_id', 'trigger_kind', 'workspace_id']);
    const list = (await app.inject({ method: 'GET', url: jobsUrl(s, orderId), headers: hdr(s) })).json().printJobs;
    expect(list.map((j: any) => j.trigger)).toEqual(['reprint', 'automatic']);        // newest first
  });

  it('a failed print records a fixed failure code (default "other"); a code on a success, an unknown code, and any extra field such as content are refused', async () => {
    const { s, orderId } = await sold();
    expect((await record(s, orderId, job({ outcome: 'failed', failureCode: 'timeout' }))).json().failureCode).toBe('timeout');
    expect((await record(s, orderId, job({ outcome: 'failed' }))).json().failureCode).toBe('other');
    for (const bad of [job({ failureCode: 'timeout' }), job({ outcome: 'failed', failureCode: 'paper jam on printer 2' }), job({ content: 'ORD-1 Latte' }), job({ receipt: {} }), job({ kind: 'label' }),
      job({ trigger: 'cron' }), job({ printedVia: 'usb' }), job({ printerId: 'not-a-uuid' })]) {
      expect((await record(s, orderId, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(await jobRows(orderId)).toHaveLength(2);
  });

  it('a receipt only for a completed order; a kitchen ticket for an open or completed order but not a voided one', async () => {
    const { s, orderId } = await ready('USD', 10);
    expect((await record(s, orderId, job())).statusCode).toBe(409);                                         // open: no receipt yet
    expect((await record(s, orderId, job({ kind: 'kitchen', trigger: 'manual' }))).statusCode).toBe(201);   // open: kitchen ticket is fine
    expect((await complete(s, orderId, { payments: [cash(10)] })).statusCode).toBe(200);
    expect((await record(s, orderId, job())).statusCode).toBe(201);
    expect((await record(s, orderId, job({ kind: 'kitchen', trigger: 'reprint' }))).statusCode).toBe(201);
    const v = await ready('USD', 5);
    expect((await voidOrder(v.s, v.orderId)).statusCode).toBe(200);
    expect((await record(v.s, v.orderId, job({ kind: 'kitchen', trigger: 'manual' }))).statusCode).toBe(409);
    expect((await record(v.s, v.orderId, job())).statusCode).toBe(409);
  });

  it('a printer must exist in the business and match the kind; a retired printer can still be named for history', async () => {
    const { s, orderId } = await sold();
    const rp = (await addPrinter(s, 'Front', 'receipt')).json(); const kp = (await addPrinter(s, 'Kitchen', 'kitchen')).json();
    expect((await record(s, orderId, job({ printerId: rp.id }))).json().printerId).toBe(rp.id);
    expect((await record(s, orderId, job({ kind: 'kitchen', trigger: 'manual', printerId: kp.id }))).statusCode).toBe(201);
    expect((await record(s, orderId, job({ printerId: kp.id }))).statusCode).toBe(409);                      // kitchen printer for a receipt
    expect((await record(s, orderId, job({ printerId: randomUUID() }))).statusCode).toBe(404);
    const other = await sold();
    const foreign = (await addPrinter(other.s, 'Foreign', 'receipt')).json();
    expect((await record(s, orderId, job({ printerId: foreign.id }))).statusCode).toBe(404);                  // another business's printer
    expect((await app.inject({ method: 'POST', url: `/v1/businesses/${s.bizId}/printers/${rp.id}/retire`, headers: hdr(s, { 'idempotency-key': uc('key') }) })).statusCode).toBe(200);
    expect((await record(s, orderId, job({ trigger: 'reprint', printerId: rp.id }))).statusCode).toBe(201);
  });

  it('a cashier (bo:write) can record, bo:read alone cannot, reading needs bo:read, and every record needs an Idempotency-Key that replays safely', async () => {
    const { s, orderId } = await sold();
    const cashier = await joinAs(s, { permissions: ['bo:read', 'bo:write'] });
    const reader = await joinAs(s, { permissions: ['bo:read'] });
    const nobody = await joinAs(s, { permissions: ['bo:write'] });
    expect((await record(cashier, orderId, job())).statusCode).toBe(201);
    expect((await record(reader, orderId, job())).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: jobsUrl(reader, orderId), headers: hdr(reader) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: jobsUrl(nobody, orderId), headers: hdr(nobody) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: jobsUrl(s, orderId), headers: hdr(s), payload: job() })).statusCode).toBe(400);
    const key = uc('same');
    const first = await record(s, orderId, job({ trigger: 'reprint' }), key);
    const again = await record(s, orderId, job({ trigger: 'reprint' }), key);
    expect(again.json().id).toBe(first.json().id);
    expect((await jobRows(orderId)).filter((r) => r.trigger_kind === 'reprint')).toHaveLength(1);
  });

  it('is isolated: another workspace sees and records nothing here, and an order of one business is not reachable through another business', async () => {
    const { s, orderId } = await sold();
    await record(s, orderId, job());
    const theirs = await setup();
    expect((await app.inject({ method: 'GET', url: jobsUrl(s, orderId), headers: hdr(theirs) })).statusCode).toBe(404);
    expect((await record(theirs, orderId, job())).statusCode).toBe(404);
    const second = (await adminPool.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'ZZ Second',$4,'active') RETURNING id`, [randomUUID(), s.ctx.tenantId, s.ctx.workspaceId, uc('second')])).rows[0].id as string;
    const viaSecond = await app.inject({ method: 'POST', url: `/v1/businesses/${second}/orders/${orderId}/print-jobs`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: job() });
    expect(viaSecond.statusCode).toBe(404);
    const app_ = new Pool({ connectionString: process.env.DATABASE_URL });
    const countAs = async (x: Session) => { const c = await app_.connect(); try { await c.query('BEGIN'); await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.workspace_id', $2, true)`, [x.ctx.tenantId, x.ctx.workspaceId]); const r = await c.query(`SELECT count(*)::int AS n FROM business_operations.print_jobs WHERE order_id = $1`, [orderId]); await c.query('ROLLBACK'); return r.rows[0].n as number; } finally { c.release(); } };
    try { expect(await countAs(s)).toBe(1); expect(await countAs(theirs)).toBe(0); } finally { await app_.end(); }
  });

  it('the business list is newest first and honours its limit; print-routes names the active default of each kind and nothing else', async () => {
    const { s, orderId } = await sold();
    expect((await app.inject({ method: 'GET', url: `/v1/businesses/${s.bizId}/print-routes`, headers: hdr(s) })).json()).toEqual({ receipt: null, kitchen: null });
    const r1 = (await addPrinter(s, 'R1', 'receipt')).json(); const r2 = (await addPrinter(s, 'R2', 'receipt', { paperMm: 58 })).json(); const k1 = (await addPrinter(s, 'K1', 'kitchen')).json();
    const routes = async () => (await app.inject({ method: 'GET', url: `/v1/businesses/${s.bizId}/print-routes`, headers: hdr(s) })).json();
    expect((await routes()).receipt.id).toBe(r1.id);
    expect((await routes()).kitchen.id).toBe(k1.id);
    await app.inject({ method: 'POST', url: `/v1/businesses/${s.bizId}/printers/${r2.id}/default`, headers: hdr(s, { 'idempotency-key': uc('key') }) });
    expect((await routes()).receipt).toMatchObject({ id: r2.id, paperMm: 58 });
    await app.inject({ method: 'POST', url: `/v1/businesses/${s.bizId}/printers/${k1.id}/retire`, headers: hdr(s, { 'idempotency-key': uc('key') }) });
    expect((await routes()).kitchen).toBeNull();
    for (let i = 0; i < 3; i += 1) await record(s, orderId, job({ trigger: 'reprint' }));
    const all = (await app.inject({ method: 'GET', url: `/v1/businesses/${s.bizId}/print-jobs`, headers: hdr(s) })).json().printJobs;
    expect(all).toHaveLength(3);
    expect((await app.inject({ method: 'GET', url: `/v1/businesses/${s.bizId}/print-jobs?limit=2`, headers: hdr(s) })).json().printJobs).toHaveLength(2);
    expect((await app.inject({ method: 'GET', url: `/v1/businesses/${s.bizId}/print-jobs?limit=500`, headers: hdr(s) })).statusCode).toBe(400);
  });

  it('the database refuses a failed job without a code and a success with one, even for direct writes', async () => {
    const { s, orderId } = await sold();
    const ins = (outcome: string, code: string | null) => adminPool.query(
      `INSERT INTO business_operations.print_jobs (tenant_id, workspace_id, business_id, order_id, kind, trigger_kind, outcome, failure_code, printed_via) VALUES ($1,$2,$3,$4,'receipt','manual',$5,$6,'browser')`,
      [s.ctx.tenantId, s.ctx.workspaceId, s.bizId, orderId, outcome, code]);
    await expect(ins('failed', null)).rejects.toMatchObject({ code: '23514' });
    await expect(ins('succeeded', 'other')).rejects.toMatchObject({ code: '23514' });
    await expect(ins('failed', 'free text')).rejects.toMatchObject({ code: '23514' });
  });
});
