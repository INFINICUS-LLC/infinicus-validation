/**
 * Live PostgreSQL 16 integration tests for BUILD-28's billing HTTP routes
 * and the server-side entitlement enforcement wired into businesses.ts's
 * write routes (app.requireActiveSubscription()).
 *
 * Requires:
 *   DATABASE_URL       — app_test_user (RLS enforced)
 *   ADMIN_DATABASE_URL — infinicus_test_admin (BYPASSRLS, fixture setup)
 *
 * Guard pattern: describe.runIf(!!process.env.DATABASE_URL)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@infinicus/configuration';
import {
  createPool, closePool,
  UserRepository, MembershipRepository, RoleRepository,
  type TenantContext,
} from '@infinicus/database';
import { EntitlementService } from '@infinicus/billing';
import { buildApp } from '../src/app.js';

const run = !!process.env.DATABASE_URL;

let adminPool: Pool;
let app: FastifyInstance;
const entitlements = new EntitlementService();

const STRONG_PASSWORD = 'Correct-Horse-9!';

function uc(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function registerActiveUser(): Promise<{ userId: string; token: string }> {
  const email = `${uc('billing-user')}@billing-api-test.example`;
  const registerRes = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: STRONG_PASSWORD } });
  expect(registerRes.statusCode).toBe(201);
  const userId = registerRes.json().id as string;
  await new UserRepository().activate(userId);
  const loginRes = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: STRONG_PASSWORD } });
  expect(loginRes.statusCode).toBe(200);
  return { userId, token: loginRes.json().rawSessionToken as string };
}

/** Creates a fresh tenant+workspace and an active membership for userId with roleCode (default 'owner'). */
async function createTenantWithMember(userId: string, roleCode = 'owner'): Promise<TenantContext> {
  const tenantId = randomUUID();
  const workspaceId = randomUUID();
  const suffix = uc('sfx');
  await adminPool.query(
    `INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'Billing API Test Tenant',$2,'active','test')`,
    [tenantId, `billing-api-${suffix}`]
  );
  await adminPool.query(
    `INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'Billing API Test WS',$3,'active')`,
    [workspaceId, tenantId, `billing-api-ws-${suffix}`]
  );
  const ctx: TenantContext = { tenantId, workspaceId, userId };
  const memberships = new MembershipRepository();
  const roles = new RoleRepository();
  const membership = await memberships.create(ctx, userId);
  await memberships.activate(ctx, membership.id);
  const role = await roles.getByCode(ctx, roleCode);
  await memberships.assignRole(ctx, membership.id, role.id);
  return ctx;
}

function tenantHeaders(ctx: TenantContext, token: string) {
  return { authorization: `Bearer ${token}`, 'x-tenant-id': ctx.tenantId, 'x-workspace-id': ctx.workspaceId };
}

describe.runIf(run)('BUILD-28 billing HTTP routes — live PostgreSQL', () => {
  beforeAll(async () => {
    const config = loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent' });
    createPool({ connectionString: config.databaseUrl, ssl: config.dbSsl });
    adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
    app = await buildApp(config);
  });

  afterAll(async () => {
    await app?.close();
    await adminPool.end();
    await closePool();
  });

  it('GET /v1/billing/subscription lazily provisions the free plan for a tenant that never called /trial', async () => {
    const { userId, token } = await registerActiveUser();
    const ctx = await createTenantWithMember(userId);

    const res = await app.inject({ method: 'GET', url: '/v1/billing/subscription', headers: tenantHeaders(ctx, token) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('active');
    expect(body.plan.code).toBe('free');
    expect(body.usage).toEqual({ simulation_runs: 0, reasoning_runs: 0 });
  });

  it('POST /v1/billing/trial starts a pro trial for an owner, and rejects a second call for the same tenant', async () => {
    const { userId, token } = await registerActiveUser();
    const ctx = await createTenantWithMember(userId);

    const res = await app.inject({
      method: 'POST', url: '/v1/billing/trial', headers: tenantHeaders(ctx, token), payload: { planCode: 'pro' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('trialing');
    expect(body.plan.code).toBe('pro');
    expect(body.trialEndsAt).not.toBeNull();

    const secondRes = await app.inject({
      method: 'POST', url: '/v1/billing/trial', headers: tenantHeaders(ctx, token), payload: { planCode: 'pro' },
    });
    expect(secondRes.statusCode).toBe(409);
  });

  it('POST /v1/billing/trial is rejected for a non-admin member (permission gate)', async () => {
    const { userId: ownerUserId } = await registerActiveUser();
    const ctx = await createTenantWithMember(ownerUserId, 'owner');

    const { userId: memberUserId, token: memberToken } = await registerActiveUser();
    const memberships = new MembershipRepository();
    const roles = new RoleRepository();
    const membership = await memberships.create(ctx, memberUserId);
    await memberships.activate(ctx, membership.id);
    const viewerRole = await roles.getByCode(ctx, 'viewer');
    await memberships.assignRole(ctx, membership.id, viewerRole.id);

    const res = await app.inject({
      method: 'POST', url: '/v1/billing/trial',
      headers: { authorization: `Bearer ${memberToken}`, 'x-tenant-id': ctx.tenantId, 'x-workspace-id': ctx.workspaceId },
      payload: { planCode: 'pro' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST /v1/billing/payment-result records a failed payment and moves the subscription into grace_period', async () => {
    const { userId, token } = await registerActiveUser();
    const ctx = await createTenantWithMember(userId);
    await app.inject({ method: 'POST', url: '/v1/billing/trial', headers: tenantHeaders(ctx, token), payload: { planCode: 'free' } });

    const res = await app.inject({
      method: 'POST', url: '/v1/billing/payment-result', headers: tenantHeaders(ctx, token),
      payload: { status: 'failed', externalInvoiceReference: 'inv-http-test-001' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('grace_period');
    expect(body.paymentStatus).toBe('failed');
    expect(body.gracePeriodEndsAt).not.toBeNull();
  });

  it('a suspended tenant is blocked from a billing-gated business-write route (server-side enforcement, 402)', async () => {
    const { userId, token } = await registerActiveUser();
    const ctx = await createTenantWithMember(userId);
    await entitlements.startSubscription(ctx, 'free');
    await entitlements.suspend(ctx, 'billing_http_test_suspension');

    const res = await app.inject({
      method: 'POST', url: `/v1/businesses/${randomUUID()}/decisions`, headers: tenantHeaders(ctx, token),
      payload: {
        intakePackageId: randomUUID(), reviewCode: uc('review'), approverUserId: userId,
        assignmentCode: uc('assign'), decisionCode: 'approve', summary: 'test', outcome: 'approve',
      },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().error.code).toBe('SubscriptionSuspendedError');
  });
});

describe.skipIf(run)('BUILD-28 billing HTTP routes — live PostgreSQL (skipped, no DATABASE_URL)', () => {
  it('skips live tests when DATABASE_URL is not set', () => {
    expect(run).toBe(false);
  });
});


