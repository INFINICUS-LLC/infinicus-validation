/**
 * Live PostgreSQL 16 integration tests for BUILD-29's incident-response
 * HTTP routes (platform-scoped, platform:admin-gated).
 *
 * Requires:
 *   DATABASE_URL       — app_test_user
 *   ADMIN_DATABASE_URL — infinicus_test_admin (BYPASSRLS, fixture setup)
 *
 * Guard pattern: describe.runIf(!!process.env.DATABASE_URL)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@infinicus/configuration';
import { createPool, closePool, UserRepository, MembershipRepository, RoleRepository, type TenantContext } from '@infinicus/database';
import { buildApp } from '../src/app.js';

const run = !!process.env.DATABASE_URL;

let adminPool: Pool;
let app: FastifyInstance;
const STRONG_PASSWORD = 'Correct-Horse-9!';

function uc(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function registerActiveUser(): Promise<{ userId: string; token: string }> {
  const email = `${uc('incident-user')}@incidents-api-test.example`;
  const registerRes = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: STRONG_PASSWORD } });
  expect(registerRes.statusCode).toBe(201);
  const userId = registerRes.json().id as string;
  await new UserRepository().activate(userId);
  const loginRes = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: STRONG_PASSWORD } });
  expect(loginRes.statusCode).toBe(200);
  return { userId, token: loginRes.json().rawSessionToken as string };
}

async function createTenantWithMember(userId: string, roleCode = 'owner'): Promise<TenantContext> {
  const tenantId = randomUUID();
  const workspaceId = randomUUID();
  const suffix = uc('sfx');
  await adminPool.query(
    `INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'Incidents API Test Tenant',$2,'active','test')`,
    [tenantId, `incidents-api-${suffix}`]
  );
  await adminPool.query(
    `INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'Incidents API Test WS',$3,'active')`,
    [workspaceId, tenantId, `incidents-api-ws-${suffix}`]
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

describe.runIf(run)('BUILD-29 incident response HTTP routes — live PostgreSQL', () => {
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

  it('declares an incident, lists it as active, posts an update, resolves it, and reads back the full timeline', async () => {
    const { userId, token } = await registerActiveUser();
    const ctx = await createTenantWithMember(userId);
    const headers = tenantHeaders(ctx, token);

    const declareRes = await app.inject({
      method: 'POST', url: '/v1/incidents', headers,
      payload: { severity: 'sev2', title: uc('Elevated latency'), description: 'p99 latency spike on /v1/health', affectedSystems: ['apps/api'] },
    });
    expect(declareRes.statusCode).toBe(201);
    const incident = declareRes.json();
    expect(incident.status).toBe('investigating');

    const listRes = await app.inject({ method: 'GET', url: '/v1/incidents', headers });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().incidents.some((i: { id: string }) => i.id === incident.id)).toBe(true);

    const updateRes = await app.inject({
      method: 'POST', url: `/v1/incidents/${incident.id}/updates`, headers,
      payload: { message: 'Root cause found: connection pool misconfiguration', statusAtUpdate: 'identified', isCustomerFacing: true },
    });
    expect(updateRes.statusCode).toBe(201);
    expect(updateRes.json().statusAtUpdate).toBe('identified');

    const resolveRes = await app.inject({
      method: 'POST', url: `/v1/incidents/${incident.id}/resolve`, headers,
      payload: { postmortemUrl: 'https://postmortems.example.test/api-latency' },
    });
    expect(resolveRes.statusCode).toBe(200);
    expect(resolveRes.json().status).toBe('resolved');

    const timelineRes = await app.inject({ method: 'GET', url: `/v1/incidents/${incident.id}/updates`, headers });
    expect(timelineRes.statusCode).toBe(200);
    expect(timelineRes.json().updates.map((u: { statusAtUpdate: string }) => u.statusAtUpdate)).toEqual(['investigating', 'identified', 'resolved']);

    const listAfterResolveRes = await app.inject({ method: 'GET', url: '/v1/incidents', headers });
    expect(listAfterResolveRes.json().incidents.some((i: { id: string }) => i.id === incident.id)).toBe(false);
  });

  it('POST /v1/incidents is rejected 403 for a non-admin member', async () => {
    const { userId: ownerUserId } = await registerActiveUser();
    const ctx = await createTenantWithMember(ownerUserId, 'owner');

    const { userId: viewerUserId, token: viewerToken } = await registerActiveUser();
    const memberships = new MembershipRepository();
    const roles = new RoleRepository();
    const membership = await memberships.create(ctx, viewerUserId);
    await memberships.activate(ctx, membership.id);
    const viewerRole = await roles.getByCode(ctx, 'viewer');
    await memberships.assignRole(ctx, membership.id, viewerRole.id);

    const res = await app.inject({
      method: 'POST', url: '/v1/incidents',
      headers: { authorization: `Bearer ${viewerToken}`, 'x-tenant-id': ctx.tenantId, 'x-workspace-id': ctx.workspaceId },
      payload: { severity: 'sev1', title: 'x', description: 'x' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('resolving an already-resolved incident returns 409', async () => {
    const { userId, token } = await registerActiveUser();
    const ctx = await createTenantWithMember(userId);
    const headers = tenantHeaders(ctx, token);

    const declareRes = await app.inject({
      method: 'POST', url: '/v1/incidents', headers,
      payload: { severity: 'sev4', title: uc('Minor issue'), description: 'test' },
    });
    const incidentId = declareRes.json().id;
    await app.inject({ method: 'POST', url: `/v1/incidents/${incidentId}/resolve`, headers, payload: {} });

    const secondResolveRes = await app.inject({ method: 'POST', url: `/v1/incidents/${incidentId}/resolve`, headers, payload: {} });
    expect(secondResolveRes.statusCode).toBe(409);
  });

  it('GET /v1/incidents/:id returns 404 for a nonexistent incident', async () => {
    const { userId, token } = await registerActiveUser();
    const ctx = await createTenantWithMember(userId);
    const res = await app.inject({ method: 'GET', url: `/v1/incidents/${randomUUID()}`, headers: tenantHeaders(ctx, token) });
    expect(res.statusCode).toBe(404);
  });
});

describe.skipIf(run)('BUILD-29 incident response HTTP routes — live PostgreSQL (skipped, no DATABASE_URL)', () => {
  it('skips live tests when DATABASE_URL is not set', () => {
    expect(run).toBe(false);
  });
});


