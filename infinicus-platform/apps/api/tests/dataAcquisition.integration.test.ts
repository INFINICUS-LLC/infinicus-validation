/**
 * Live PostgreSQL integration tests for the BUILD-31 Data Acquisition
 * runtime API routes, exercising the full route surface via Fastify's
 * app.inject() against a real database — same pattern as
 * api.integration.test.ts.
 *
 * Requires:
 *   DATABASE_URL       — app_test (RLS enforced)
 *   ADMIN_DATABASE_URL — admin_test (BYPASSRLS)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { loadConfig } from '@infinicus/configuration';
import { createPool, closePool, UserRepository, MembershipRepository, RoleRepository, type TenantContext } from '@infinicus/database';
import { buildApp } from '../src/app.js';

const run = !!process.env.DATABASE_URL;

const T1 = '77777777-3d3d-0000-0000-000000000001';
const WS1 = '77777777-3d3d-0000-0000-000000000002';

let adminPool: Pool | null = null;
let app: FastifyInstance | null = null;

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@da-api-test.example`;
}

function uc(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

const STRONG_PASSWORD = 'Correct-Horse-9!';

async function registerActiveUser(): Promise<{ userId: string; token: string }> {
  const email = uniqueEmail('da-api-user');
  const registerRes = await app!.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: STRONG_PASSWORD } });
  expect(registerRes.statusCode).toBe(201);
  const userId = registerRes.json().id as string;

  const users = new UserRepository();
  await users.activate(userId);

  const loginRes = await app!.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: STRONG_PASSWORD } });
  expect(loginRes.statusCode).toBe(200);
  return { userId, token: loginRes.json().rawSessionToken as string };
}

async function createTenantWithRole(userId: string, roleCode: 'owner' | 'viewer'): Promise<TenantContext> {
  const memberships = new MembershipRepository();
  const roles = new RoleRepository();
  const ctx: TenantContext = { tenantId: T1, workspaceId: WS1, userId };
  const membership = await memberships.create(ctx, userId);
  await memberships.activate(ctx, membership.id);
  const role = await roles.getByCode(ctx, roleCode);
  await memberships.assignRole(ctx, membership.id, role.id);
  return ctx;
}

function tenantHeaders(ctx: TenantContext, token: string) {
  return {
    authorization: `Bearer ${token}`,
    'x-tenant-id': ctx.tenantId,
    'x-workspace-id': ctx.workspaceId,
  };
}

async function createBusiness(ctx: TenantContext): Promise<string> {
  const bizId = crypto.randomUUID();
  await adminPool!.query(
    `INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status)
     VALUES ($1,$2,$3,'DA API Test Biz',$4,'active')`,
    [bizId, ctx.tenantId, ctx.workspaceId, uc('da-api-biz')]
  );
  return bizId;
}

/**
 * Registers a source (always created in `draft`, per createDataSourceBodySchema
 * deliberately not exposing `status` at creation time) and walks it to `active`
 * through the real status-transition endpoint, the only supported path.
 */
async function createActiveSource(ctx: TenantContext, bizId: string, token: string, name = 'Active Source') {
  const createRes = await app!.inject({
    method: 'POST', url: `/v1/businesses/${bizId}/data-sources`,
    headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key') },
    payload: { name, sourceCode: uc('src'), sourceType: 'api' },
  });
  const source = createRes.json();
  const statusRes = await app!.inject({
    method: 'PATCH', url: `/v1/businesses/${bizId}/data-sources/${source.id}/status`,
    headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key') },
    payload: { status: 'active' },
  });
  return statusRes.json();
}

describe.runIf(run)('BUILD-31 Data Acquisition runtime API — live PostgreSQL', () => {
  beforeAll(async () => {
    const appUrl = process.env.DATABASE_URL!;
    const adminUrl = process.env.ADMIN_DATABASE_URL ?? appUrl;
    createPool({ connectionString: appUrl, ssl: true });
    adminPool = new Pool({ connectionString: adminUrl });

    await adminPool.query(
      `INSERT INTO tenancy.tenants (id, name, slug, status, plan_code)
       VALUES ($1,'DA-API-Test Tenant','da-api-t1','active','test') ON CONFLICT (id) DO NOTHING`,
      [T1]
    );
    await adminPool.query(
      `INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status)
       VALUES ($1,$2,'DA-API-Test WS','da-api-ws1','active') ON CONFLICT (id) DO NOTHING`,
      [WS1, T1]
    );

    const config = loadConfig({ DATABASE_URL: appUrl, NODE_ENV: 'test', LOG_LEVEL: 'silent' });
    app = await buildApp(config);
    await app.ready();
  });

  afterAll(async () => {
    if (adminPool) await adminPool.end();
    await app?.close();
    await closePool();
  });

  describe('sources', () => {
    it('rejects registering a source without da:write permission', async () => {
      const { userId, token } = await registerActiveUser();
      const ctx = await createTenantWithRole(userId, 'viewer');
      const bizId = await createBusiness(ctx);

      const res = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/data-sources`,
        headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key') },
        payload: { name: 'Viewer Source', sourceCode: uc('src'), sourceType: 'api' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('registers a source, lists it, gets it by id, and lifecycle-updates its status', async () => {
      const { userId, token } = await registerActiveUser();
      const ctx = await createTenantWithRole(userId, 'owner');
      const bizId = await createBusiness(ctx);

      const createRes = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/data-sources`,
        headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key') },
        payload: { name: 'Sales POS Feed', sourceCode: uc('src'), sourceType: 'api', sensitivityLevel: 'internal' },
      });
      expect(createRes.statusCode).toBe(201);
      const source = createRes.json();
      expect(source.status).toBe('draft');

      const listRes = await app!.inject({ method: 'GET', url: `/v1/businesses/${bizId}/data-sources`, headers: tenantHeaders(ctx, token) });
      expect(listRes.statusCode).toBe(200);
      expect(listRes.json().dataSources.some((s: { id: string }) => s.id === source.id)).toBe(true);

      const getRes = await app!.inject({ method: 'GET', url: `/v1/businesses/${bizId}/data-sources/${source.id}`, headers: tenantHeaders(ctx, token) });
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().id).toBe(source.id);

      const statusRes = await app!.inject({
        method: 'PATCH', url: `/v1/businesses/${bizId}/data-sources/${source.id}/status`,
        headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key') },
        payload: { status: 'active' },
      });
      expect(statusRes.statusCode).toBe(200);
      expect(statusRes.json().status).toBe('active');
    });

    it('rejects a duplicate source code with 409', async () => {
      const { userId, token } = await registerActiveUser();
      const ctx = await createTenantWithRole(userId, 'owner');
      const bizId = await createBusiness(ctx);
      const sourceCode = uc('dup-src');

      const first = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/data-sources`,
        headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key') },
        payload: { name: 'First', sourceCode, sourceType: 'api' },
      });
      expect(first.statusCode).toBe(201);

      const second = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/data-sources`,
        headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key2') },
        payload: { name: 'Second', sourceCode, sourceType: 'api' },
      });
      expect(second.statusCode).toBe(409);
    });

    it('retires (soft-deletes) a source', async () => {
      const { userId, token } = await registerActiveUser();
      const ctx = await createTenantWithRole(userId, 'owner');
      const bizId = await createBusiness(ctx);

      const createRes = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/data-sources`,
        headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key') },
        payload: { name: 'To Delete', sourceCode: uc('src'), sourceType: 'api' },
      });
      const sourceId = createRes.json().id;

      const deleteRes = await app!.inject({
        method: 'DELETE', url: `/v1/businesses/${bizId}/data-sources/${sourceId}`,
        headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key') },
      });
      expect(deleteRes.statusCode).toBe(204);

      const getRes = await app!.inject({ method: 'GET', url: `/v1/businesses/${bizId}/data-sources/${sourceId}`, headers: tenantHeaders(ctx, token) });
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().status).toBe('retired');
    });

    it('returns 404 for a business that does not exist', async () => {
      const { userId, token } = await registerActiveUser();
      const ctx = await createTenantWithRole(userId, 'owner');
      const res = await app!.inject({ method: 'GET', url: `/v1/businesses/${crypto.randomUUID()}/data-sources`, headers: tenantHeaders(ctx, token) });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('connectors', () => {
    it('registers a connector, gets it, records a health check, and updates its status', async () => {
      const { userId, token } = await registerActiveUser();
      const ctx = await createTenantWithRole(userId, 'owner');
      const bizId = await createBusiness(ctx);
      const source = await createActiveSource(ctx, bizId, token, 'Connector Test Source');

      const createRes = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/data-sources/${source.id}/connectors`,
        headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key') },
        payload: { name: 'Manual Connector', connectorType: 'manual_json' },
      });
      expect(createRes.statusCode).toBe(201);
      const connector = createRes.json();
      expect(connector.dataSourceId).toBe(source.id);

      const listRes = await app!.inject({ method: 'GET', url: `/v1/businesses/${bizId}/data-sources/${source.id}/connectors`, headers: tenantHeaders(ctx, token) });
      expect(listRes.statusCode).toBe(200);
      expect(listRes.json().connectors).toHaveLength(1);

      const getRes = await app!.inject({ method: 'GET', url: `/v1/businesses/${bizId}/data-sources/${source.id}/connectors/${connector.id}`, headers: tenantHeaders(ctx, token) });
      expect(getRes.statusCode).toBe(200);

      const healthRes = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/data-sources/${source.id}/connectors/${connector.id}/health-check`,
        headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key') },
        payload: { healthStatus: 'healthy' },
      });
      expect(healthRes.statusCode).toBe(200);
      expect(healthRes.json().healthStatus).toBe('healthy');

      const statusRes = await app!.inject({
        method: 'PATCH', url: `/v1/businesses/${bizId}/data-sources/${source.id}/connectors/${connector.id}/status`,
        headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key') },
        payload: { status: 'active' },
      });
      expect(statusRes.statusCode).toBe(200);
      expect(statusRes.json().status).toBe('active');
    });
  });

  describe('manual intake, collection runs, and their read-only sub-resources', () => {
    it('submits a manual intake batch end to end and reads back every derived resource', async () => {
      const { userId, token } = await registerActiveUser();
      const ctx = await createTenantWithRole(userId, 'owner');
      const bizId = await createBusiness(ctx);
      const source = await createActiveSource(ctx, bizId, token, 'Intake Source');

      const intakeRes = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/data-sources/${source.id}/manual-intake`,
        headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key') },
        payload: { submissionType: 'product_catalog', records: [{ name: 'Widget', price: 9.99 }, { name: 'Gadget', price: 19.99 }] },
      });
      expect(intakeRes.statusCode).toBe(201);
      const result = intakeRes.json();
      expect(result.state).toBe('validated');
      expect(result.recordsAccepted).toBe(2);

      const runRes = await app!.inject({ method: 'GET', url: `/v1/businesses/${bizId}/collection-runs/${result.collectionRunId}`, headers: tenantHeaders(ctx, token) });
      expect(runRes.statusCode).toBe(200);
      expect(runRes.json().state).toBe('validated');

      const listRunsRes = await app!.inject({ method: 'GET', url: `/v1/businesses/${bizId}/collection-runs`, headers: tenantHeaders(ctx, token) });
      expect(listRunsRes.statusCode).toBe(200);
      expect(listRunsRes.json().runs.some((r: { id: string }) => r.id === result.collectionRunId)).toBe(true);

      const validationRes = await app!.inject({ method: 'GET', url: `/v1/businesses/${bizId}/collection-runs/${result.collectionRunId}/validation-results`, headers: tenantHeaders(ctx, token) });
      expect(validationRes.statusCode).toBe(200);
      expect(validationRes.json().validationResults).toHaveLength(1);
      expect(validationRes.json().validationResults[0].isValid).toBe(true);

      const qualityRes = await app!.inject({ method: 'GET', url: `/v1/businesses/${bizId}/collection-runs/${result.collectionRunId}/quality-score`, headers: tenantHeaders(ctx, token) });
      expect(qualityRes.statusCode).toBe(200);
      expect(qualityRes.json().qualityScore.overallScore).toBeGreaterThan(0);

      const provenanceRes = await app!.inject({ method: 'GET', url: `/v1/businesses/${bizId}/collection-runs/${result.collectionRunId}/provenance`, headers: tenantHeaders(ctx, token) });
      expect(provenanceRes.statusCode).toBe(200);
      expect(provenanceRes.json().provenance).toHaveLength(2);
    });

    it('rejects manual intake against an inactive (draft) source with 400', async () => {
      const { userId, token } = await registerActiveUser();
      const ctx = await createTenantWithRole(userId, 'owner');
      const bizId = await createBusiness(ctx);
      const sourceRes = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/data-sources`,
        headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key') },
        payload: { name: 'Draft Source', sourceCode: uc('src'), sourceType: 'api' },
      });
      const source = sourceRes.json();

      const res = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/data-sources/${source.id}/manual-intake`,
        headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key') },
        payload: { submissionType: 'test', records: [{ a: 1 }] },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects a manual intake request missing the Idempotency-Key header', async () => {
      const { userId, token } = await registerActiveUser();
      const ctx = await createTenantWithRole(userId, 'owner');
      const bizId = await createBusiness(ctx);
      const sourceRes = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/data-sources`,
        headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key') },
        payload: { name: 'No Idem Source', sourceCode: uc('src'), sourceType: 'api', status: 'active' },
      });
      const source = sourceRes.json();

      const res = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/data-sources/${source.id}/manual-intake`,
        headers: tenantHeaders(ctx, token),
        payload: { submissionType: 'test', records: [{ a: 1 }] },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('publication packages', () => {
    it('prepares and publishes a publication package end to end, then lists and gets it', async () => {
      const { userId, token } = await registerActiveUser();
      const ctx = await createTenantWithRole(userId, 'owner');
      const bizId = await createBusiness(ctx);
      const source = await createActiveSource(ctx, bizId, token, 'Publish Source');
      const intakeRes = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/data-sources/${source.id}/manual-intake`,
        headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key') },
        payload: { submissionType: 'publish_flow', records: [{ name: 'Item A', price: 10 }] },
      });
      const result = intakeRes.json();

      const prepareRes = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/collection-runs/${result.collectionRunId}/publication-package`,
        headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key') },
        payload: { targetBlock: 'bo-events' },
      });
      expect(prepareRes.statusCode).toBe(201);
      const pkg = prepareRes.json();
      expect(pkg.status).toBe('ready');

      const publishRes = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/publication-packages/${pkg.id}/publish`,
        headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key') },
      });
      expect(publishRes.statusCode).toBe(200);
      expect(publishRes.json().status).toBe('published');

      const listRes = await app!.inject({ method: 'GET', url: `/v1/businesses/${bizId}/publication-packages`, headers: tenantHeaders(ctx, token) });
      expect(listRes.statusCode).toBe(200);
      expect(listRes.json().publicationPackages.some((p: { id: string }) => p.id === pkg.id)).toBe(true);

      const getRes = await app!.inject({ method: 'GET', url: `/v1/businesses/${bizId}/publication-packages/${pkg.id}`, headers: tenantHeaders(ctx, token) });
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().status).toBe('published');
    });

    it('rejects publishing the same package twice with 409', async () => {
      const { userId, token } = await registerActiveUser();
      const ctx = await createTenantWithRole(userId, 'owner');
      const bizId = await createBusiness(ctx);
      const source = await createActiveSource(ctx, bizId, token, 'Double Publish Source');
      const intakeRes = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/data-sources/${source.id}/manual-intake`,
        headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key') },
        payload: { submissionType: 'double_publish', records: [{ a: 1 }] },
      });
      const result = intakeRes.json();
      const prepareRes = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/collection-runs/${result.collectionRunId}/publication-package`,
        headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key') },
        payload: { targetBlock: 'bo-events' },
      });
      const pkg = prepareRes.json();

      const first = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/publication-packages/${pkg.id}/publish`,
        headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key1') },
      });
      expect(first.statusCode).toBe(200);

      const second = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/publication-packages/${pkg.id}/publish`,
        headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key2') },
      });
      expect(second.statusCode).toBe(409);
    });
  });
});

describe.skipIf(run)('BUILD-31 Data Acquisition runtime API — live PostgreSQL (skipped, no DATABASE_URL)', () => {
  it('skips live tests when DATABASE_URL is not set', () => {
    expect(run).toBe(false);
  });
});


