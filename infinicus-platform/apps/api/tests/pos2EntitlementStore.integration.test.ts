/**
 * POS2-02: the POS Core write routes follow the entitlement STORE once a tenant has rows in it. POS Core alone opens POS and nothing else; Growth alone does not
 * open POS; an expired entitlement stops new POS writes (403); billing suspension still wins (402). Development fixtures only, written through the governed functions.
 * Requires DATABASE_URL (app role) and ADMIN_DATABASE_URL (fixtures).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@infinicus/configuration';
import { createPool, closePool, UserRepository, MembershipRepository, RoleRepository, EntitlementRepository, type TenantContext } from '@infinicus/database';
import { EntitlementService } from '@infinicus/billing';
import { buildApp } from '../src/app.js';

const run = !!process.env.DATABASE_URL;
const STRONG_PASSWORD = 'Correct-Horse-9!';
const uc = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
let adminPool: Pool;
let app: FastifyInstance;
const entitlements = new EntitlementService();

async function tenant(): Promise<{ ctx: TenantContext; token: string }> {
  const email = `${uc('pos2')}@pos2-entitlement.example`;
  const reg = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: STRONG_PASSWORD } });
  const userId = reg.json().id as string;
  await new UserRepository().activate(userId);
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: STRONG_PASSWORD } });
  const tenantId = randomUUID(); const workspaceId = randomUUID(); const sfx = uc('s');
  await adminPool.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'POS2 Tenant',$2,'active','test')`, [tenantId, `pos2-${sfx}`]);
  await adminPool.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'POS2 WS',$3,'active')`, [workspaceId, tenantId, `pos2-ws-${sfx}`]);
  const ctx: TenantContext = { tenantId, workspaceId, userId };
  const m = new MembershipRepository();
  const mem = await m.create(ctx, userId); await m.activate(ctx, mem.id);
  await m.assignRole(ctx, mem.id, (await new RoleRepository().getByCode(ctx, 'owner')).id);
  return { ctx, token: login.json().rawSessionToken as string };
}
const headers = (c: TenantContext, token: string) => ({ authorization: `Bearer ${token}`, 'x-tenant-id': c.tenantId, 'x-workspace-id': c.workspaceId, 'idempotency-key': randomUUID() });

/** One valid-bodied write per POS Core route family (validation runs before the gate, so bodies must be valid). */
const biz = () => randomUUID();
const WRITES: { name: string; url: (b: string) => string; payload: unknown }[] = [
  { name: 'create order', url: (b) => `/v1/businesses/${b}/orders`, payload: {} },
  { name: 'create product', url: (b) => `/v1/businesses/${b}/products`, payload: { name: 'Tea', price: 1.5 } },
  { name: 'open register session', url: (b) => `/v1/businesses/${b}/register-sessions`, payload: { openingCash: 0 } },
  { name: 'create printer', url: (b) => `/v1/businesses/${b}/printers`, payload: { name: 'P', kind: 'receipt', connection: 'browser', paperMm: 80 } },
];


const DAY = 86_400_000;
async function grant(ctx: TenantContext, capability: string, over: { effectiveFrom?: Date; effectiveUntil?: Date } = {}): Promise<void> {
  const c: PoolClient = await adminPool.connect();
  try {
    await c.query('BEGIN'); await c.query("SELECT set_config('app.tenant_id', $1, true)", [ctx.tenantId]);
    await EntitlementRepository.grant(c, ctx.tenantId, { capability, sourceType: 'operator_grant', sourceReference: `fx-${randomUUID()}`, effectiveFrom: new Date(Date.now() - DAY), ...over });
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

describe.runIf(run)('POS2-02 POS Core routes follow the entitlement store', () => {
  beforeAll(async () => {
    const config = loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' });
    createPool({ connectionString: config.databaseUrl, ssl: config.dbSsl });
    adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
    app = await buildApp(config);
  });
  afterAll(async () => { await app?.close(); await adminPool.end(); await closePool(); });
  const post = (t: { ctx: TenantContext; token: string }, w: (typeof WRITES)[number]) =>
    app.inject({ method: 'POST', url: w.url(biz()), headers: headers(t.ctx, t.token), payload: w.payload as object });

  for (const w of WRITES) {
    it(`${w.name}: POS Core alone is enough; Growth alone is refused 403; expired is refused 403`, async () => {
      const pos = await tenant(); await grant(pos.ctx, 'pos.core');
      const posOnly = await post(pos, w);
      expect(posOnly.statusCode).toBe(404);   // past the capability gate, stopped by the unknown business

      const growth = await tenant(); await grant(growth.ctx, 'intelligence.growth');
      const denied = await post(growth, w);
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe('CapabilityNotEntitledError');

      const lapsed = await tenant();
      await grant(lapsed.ctx, 'pos.core', { effectiveFrom: new Date(Date.now() - 10 * DAY), effectiveUntil: new Date(Date.now() - DAY) });
      const expired = await post(lapsed, w);
      expect(expired.statusCode).toBe(403);
      expect(expired.json().error.code).toBe('CapabilityNotEntitledError');
    });
  }

  it('POS Core plus Growth holds POS; a store-entitled tenant is still stopped by a suspended subscription (402)', async () => {
    const both = await tenant(); await grant(both.ctx, 'pos.core'); await grant(both.ctx, 'intelligence.growth');
    expect((await post(both, WRITES[0])).statusCode).toBe(404);
    await entitlements.getSubscriptionWithPlan(both.ctx); await entitlements.suspend(both.ctx, 'pos2_02_test');
    const res = await post(both, WRITES[0]);
    expect(res.statusCode).toBe(402);
    expect(res.json().error.code).toBe('SubscriptionSuspendedError');
  });

  it('reads of the tenant\'s own history are not gated by the capability (a Growth-only tenant can still read its order list; lapse never hides owned records)', async () => {
    const growth = await tenant(); await grant(growth.ctx, 'intelligence.growth');
    const res = await app.inject({ method: 'GET', url: `/v1/businesses/${biz()}/orders`, headers: headers(growth.ctx, growth.token) });
    expect(res.statusCode).not.toBe(402);
    expect(res.json().error?.code).not.toBe('CapabilityNotEntitledError');
  });
});

describe.skipIf(run)('POS2-02 store-driven gate (skipped, no DATABASE_URL)', () => {
  it('skips live tests when DATABASE_URL is not set', () => { expect(run).toBe(false); });
});
