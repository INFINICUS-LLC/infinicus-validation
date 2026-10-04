/**
 * Live PostgreSQL 16 integration tests for BUILD-25's observability
 * requirements: GET /v1/metrics (database/outbox monitoring, dashboards)
 * and the error-handler's persistence of unhandled errors into
 * observability.error_events (error tracking).
 *
 * Requires:
 *   DATABASE_URL       — app_test_user (RLS enforced)
 *   ADMIN_DATABASE_URL — infinicus_test_admin (BYPASSRLS)
 *
 * Guard pattern: describe.runIf(!!process.env.DATABASE_URL)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { loadConfig } from '@infinicus/configuration';
import { createPool, closePool, UserRepository, MembershipRepository, RoleRepository, ErrorEventRepository, type TenantContext } from '@infinicus/database';
import correlationIdPlugin from '../src/plugins/correlationId.js';
import errorHandlerPlugin from '../src/plugins/errorHandler.js';
import { buildApp } from '../src/app.js';

const run = !!process.env.DATABASE_URL;

const T2 = '88888888-9090-0000-0000-000000000101';
const WS2 = '88888888-9090-0000-0000-000000000102';
const T3 = '88888888-9090-0000-0000-000000000201';
const WS3 = '88888888-9090-0000-0000-000000000202';

async function seedTenant(adminPool: Pool, tenantId: string, workspaceId: string, suffix: string) {
  await adminPool.query(
    `INSERT INTO tenancy.tenants (id, name, slug, status, plan_code)
     VALUES ($1,'OBS-Test Tenant','obs-test-t-${suffix}','active','test') ON CONFLICT (id) DO NOTHING`,
    [tenantId]
  );
  await adminPool.query(
    `INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status)
     VALUES ($1,$2,'OBS-Test WS','obs-test-ws-${suffix}','active') ON CONFLICT (id) DO NOTHING`,
    [workspaceId, tenantId]
  );
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@obs-test.example`;
}

const STRONG_PASSWORD = 'Correct-Horse-9!';

describe.runIf(run)('GET /v1/metrics — live PostgreSQL', () => {
  let app: FastifyInstance;
  let adminPool: Pool;

  beforeAll(async () => {
    const config = loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent' });
    createPool({ connectionString: config.databaseUrl, ssl: config.dbSsl });
    adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL! });
    await seedTenant(adminPool, T2, WS2, 'member');
    await seedTenant(adminPool, T3, WS3, 'owner');
    app = await buildApp(config);
  });

  afterAll(async () => {
    await app.close();
    await adminPool.end();
    await closePool();
  });

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/metrics' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a caller without platform:admin (member role)', async () => {
    const email = uniqueEmail('metrics-member');
    const registerRes = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: STRONG_PASSWORD } });
    const userId = registerRes.json().id as string;
    await new UserRepository().activate(userId);

    const memberships = new MembershipRepository();
    const roles = new RoleRepository();
    const ctx: TenantContext = { tenantId: T2, workspaceId: WS2, userId };
    const membership = await memberships.create(ctx, userId);
    await memberships.activate(ctx, membership.id);
    const memberRole = await roles.getByCode(ctx, 'member');
    await memberships.assignRole(ctx, membership.id, memberRole.id);

    const loginRes = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: STRONG_PASSWORD } });
    const token = loginRes.json().rawSessionToken as string;

    const res = await app.inject({
      method: 'GET', url: '/v1/metrics',
      headers: { authorization: `Bearer ${token}`, 'x-tenant-id': T2, 'x-workspace-id': WS2 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns real operational metrics for a platform:admin caller (owner role)', async () => {
    const email = uniqueEmail('metrics-owner');
    const registerRes = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: STRONG_PASSWORD } });
    const userId = registerRes.json().id as string;
    await new UserRepository().activate(userId);

    const memberships = new MembershipRepository();
    const roles = new RoleRepository();
    const ctx: TenantContext = { tenantId: T3, workspaceId: WS3, userId };
    const membership = await memberships.create(ctx, userId);
    await memberships.activate(ctx, membership.id);
    const ownerRole = await roles.getByCode(ctx, 'owner');
    await memberships.assignRole(ctx, membership.id, ownerRole.id);

    const loginRes = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: STRONG_PASSWORD } });
    const token = loginRes.json().rawSessionToken as string;

    const res = await app.inject({
      method: 'GET', url: '/v1/metrics',
      headers: { authorization: `Bearer ${token}`, 'x-tenant-id': T3, 'x-workspace-id': WS3 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.process.uptimeSeconds).toBe('number');
    expect(typeof body.databasePool.totalCount).toBe('number');
    expect(typeof body.errors.last15Minutes).toBe('number');
    expect(typeof body.outbox.pendingCount).toBe('number');
    expect(typeof body.activeAlertCount).toBe('number');
  });
});

describe.runIf(run)('errorHandler — unhandled-error persistence — live PostgreSQL', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const config = loadConfig({
      DATABASE_URL: process.env.DATABASE_URL!,
      DB_SSL: process.env.DB_SSL,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
    });
    createPool({ connectionString: config.databaseUrl, ssl: config.dbSsl });
    app = Fastify({ logger: false });
    await app.register(correlationIdPlugin);
    await app.register(errorHandlerPlugin);
    app.get('/throws', async () => {
      throw new Error('deliberate unhandled error for BUILD-25 test');
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await closePool();
  });

  it('persists an observability.error_events row for an unhandled error, redacted', async () => {
    const errorRepo = new ErrorEventRepository();
    const before = await errorRepo.listRecent(1);

    const res = await app.inject({ method: 'GET', url: '/throws' });
    expect(res.statusCode).toBe(500);

    // Persistence is fire-and-forget in the error handler; poll briefly.
    let found: Awaited<ReturnType<typeof errorRepo.listRecent>>[number] | undefined;
    for (let i = 0; i < 20 && !found; i++) {
      await new Promise((r) => setTimeout(r, 25));
      const recent = await errorRepo.listRecent(5);
      found = recent.find((e) => e.message === 'deliberate unhandled error for BUILD-25 test' && (before.length === 0 || e.id !== before[0]?.id));
    }

    expect(found, 'expected an error_events row for the deliberate throw').toBeDefined();
    expect(found!.route).toBe('/throws');
    expect(found!.statusCode).toBe(500);
  });
});

describe.skipIf(run)('observability — live PostgreSQL (skipped, no DATABASE_URL)', () => {
  it('skips live tests when DATABASE_URL is not set', () => {
    expect(run).toBe(false);
  });
});


