/**
 * POS2-01: the POS Core write routes are gated by `requireCapability('pos.core')`. Behaviour is compatibility-identical to the subscription gate:
 * a suspended or canceled tenant gets 402 with the same error name, an active tenant is not blocked by the gate, and the gate is per tenant.
 * Requires DATABASE_URL (app role) and ADMIN_DATABASE_URL (fixtures).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@infinicus/configuration';
import { createPool, closePool, UserRepository, MembershipRepository, RoleRepository, type TenantContext } from '@infinicus/database';
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

describe.runIf(run)('POS2-01 POS Core capability gate: compatibility with the subscription gate', () => {
  beforeAll(async () => {
    const config = loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' });
    createPool({ connectionString: config.databaseUrl, ssl: config.dbSsl });
    adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
    app = await buildApp(config);
  });
  afterAll(async () => { await app?.close(); await adminPool.end(); await closePool(); });

  for (const w of WRITES) {
    it(`${w.name}: a suspended tenant gets 402 SubscriptionSuspendedError, a canceled one 402 SubscriptionCanceledError`, async () => {
      const t = await tenant();
      await entitlements.startSubscription(t.ctx, 'free');
      await entitlements.suspend(t.ctx, 'pos2_test');
      const suspended = await app.inject({ method: 'POST', url: w.url(biz()), headers: headers(t.ctx, t.token), payload: w.payload as object });
      expect(suspended.statusCode).toBe(402);
      expect(suspended.json().error.code).toBe('SubscriptionSuspendedError');
      await entitlements.reactivate(t.ctx, 'pos2_test');
      await entitlements.cancel(t.ctx, 'pos2_test');
      const canceled = await app.inject({ method: 'POST', url: w.url(biz()), headers: headers(t.ctx, t.token), payload: w.payload as object });
      expect(canceled.statusCode).toBe(402);
      expect(canceled.json().error.code).toBe('SubscriptionCanceledError');
    });

    it(`${w.name}: an active tenant is not stopped by the capability gate (it reaches the business check instead)`, async () => {
      const t = await tenant();
      const res = await app.inject({ method: 'POST', url: w.url(biz()), headers: headers(t.ctx, t.token), payload: w.payload as object });
      expect(res.statusCode).not.toBe(402);
      expect(res.json().error?.code).not.toBe('CapabilityNotEntitledError');
      expect(res.statusCode).toBe(404);   // an unknown business, refused after the gate
    });
  }

  it('the gate is per tenant: suspending one tenant does not block another', async () => {
    const a = await tenant(); const b = await tenant();
    await entitlements.startSubscription(a.ctx, 'free'); await entitlements.startSubscription(b.ctx, 'free');
    await entitlements.suspend(a.ctx, 'pos2_test');
    const blocked = await app.inject({ method: 'POST', url: `/v1/businesses/${biz()}/orders`, headers: headers(a.ctx, a.token), payload: {} });
    const ok = await app.inject({ method: 'POST', url: `/v1/businesses/${biz()}/orders`, headers: headers(b.ctx, b.token), payload: {} });
    expect(blocked.statusCode).toBe(402);
    expect(ok.statusCode).not.toBe(402);
  });
});

describe.skipIf(run)('POS2-01 capability gate (skipped, no DATABASE_URL)', () => {
  it('skips live tests when DATABASE_URL is not set', () => { expect(run).toBe(false); });
});
