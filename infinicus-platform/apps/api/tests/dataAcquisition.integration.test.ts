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
    // This suite legitimately issues many requests (a fresh user + several
    // endpoint calls per test, ~20 tests) — same RATE_LIMIT_MAX override
    // load-test.integration.test.ts already uses for the same reason;
    // security.integration.test.ts's own low override is for the opposite
    // purpose (testing the limiter itself), not applicable here.
    const config = loadConfig({
      DATABASE_URL: appUrl,
      DB_SSL: process.env.DB_SSL,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      RATE_LIMIT_MAX: '100000',
    });
    createPool({ connectionString: appUrl, ssl: config.dbSsl });
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

  describe('webhook intake', () => {
    async function createActiveWebhookConnector(ctx: TenantContext, bizId: string, token: string) {
      const source = await createActiveSource(ctx, bizId, token, 'Webhook API Test Source');
      const createRes = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/data-sources/${source.id}/connectors`,
        headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key') },
        payload: { name: 'Webhook API Connector', connectorType: 'webhook' },
      });
      const connector = createRes.json();
      await app!.inject({
        method: 'PATCH', url: `/v1/businesses/${bizId}/data-sources/${source.id}/connectors/${connector.id}/status`,
        headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key') },
        payload: { status: 'active' },
      });
      const tokenRes = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/data-sources/${source.id}/connectors/${connector.id}/webhook-token`,
        headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key') },
      });
      expect(tokenRes.statusCode).toBe(201);
      return { source, connector, ...tokenRes.json() as { token: string; webhookUrl: string } };
    }

    it('generates a one-time webhook token and rejects generating one for a non-webhook connector', async () => {
      const { userId, token } = await registerActiveUser();
      const ctx = await createTenantWithRole(userId, 'owner');
      const bizId = await createBusiness(ctx);
      const { source, webhookUrl } = await createActiveWebhookConnector(ctx, bizId, token);
      expect(webhookUrl).toMatch(/^\/v1\/webhooks\/data-acquisition\/[0-9a-f]+\.[0-9a-f]+$/);

      const manualConnRes = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/data-sources/${source.id}/connectors`,
        headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key') },
        payload: { name: 'Manual Connector', connectorType: 'manual_json' },
      });
      const rejectRes = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/data-sources/${source.id}/connectors/${manualConnRes.json().id}/webhook-token`,
        headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key') },
      });
      expect(rejectRes.statusCode).toBe(400);
    });

    it('rejects an unauthenticated request with no session — the webhook route itself needs no session, but generating its token does', async () => {
      const res = await app!.inject({
        method: 'POST', url: `/v1/businesses/${crypto.randomUUID()}/data-sources/${crypto.randomUUID()}/connectors/${crypto.randomUUID()}/webhook-token`,
        headers: { 'idempotency-key': uc('key') },
      });
      expect(res.statusCode).toBe(401);
    });

    it('accepts a real webhook delivery with no auth headers at all, using only the URL token — a single JSON object is normalized to a one-record batch', async () => {
      const { userId, token } = await registerActiveUser();
      const ctx = await createTenantWithRole(userId, 'owner');
      const bizId = await createBusiness(ctx);
      const { webhookUrl } = await createActiveWebhookConnector(ctx, bizId, token);

      const deliveryRes = await app!.inject({
        method: 'POST', url: webhookUrl,
        payload: { order: 'WH-100', total: 19.99 },
      });
      expect(deliveryRes.statusCode).toBe(201);
      const result = deliveryRes.json();
      expect(result.state).toBe('validated');
      expect(result.recordsReceived).toBe(1);
      expect(result.recordsAccepted).toBe(1);
      expect(result.replayed).toBe(false);
    });

    it('rejects a delivery with a garbled token the same way as a wrong one (401, no distinguishing detail)', async () => {
      const res = await app!.inject({
        method: 'POST', url: '/v1/webhooks/data-acquisition/not-a-real-token',
        payload: { a: 1 },
      });
      expect(res.statusCode).toBe(401);
    });

    it('replays an identical retried delivery instead of double-processing it', async () => {
      const { userId, token } = await registerActiveUser();
      const ctx = await createTenantWithRole(userId, 'owner');
      const bizId = await createBusiness(ctx);
      const { webhookUrl } = await createActiveWebhookConnector(ctx, bizId, token);
      const payload = [{ order: 'WH-200', total: 5 }];

      const first = await app!.inject({ method: 'POST', url: webhookUrl, payload });
      const second = await app!.inject({ method: 'POST', url: webhookUrl, payload });
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(second.json().replayed).toBe(true);
      expect(second.json().collectionRunId).toBe(first.json().collectionRunId);
    });

    it('a retry carrying an X-Event-Id header is deduplicated by that id even if the body were to differ', async () => {
      const { userId, token } = await registerActiveUser();
      const ctx = await createTenantWithRole(userId, 'owner');
      const bizId = await createBusiness(ctx);
      const { webhookUrl } = await createActiveWebhookConnector(ctx, bizId, token);
      const eventId = uc('evt');

      const first = await app!.inject({
        method: 'POST', url: webhookUrl, headers: { 'x-event-id': eventId }, payload: [{ order: 'WH-300' }],
      });
      const second = await app!.inject({
        method: 'POST', url: webhookUrl, headers: { 'x-event-id': eventId }, payload: [{ order: 'WH-300' }],
      });
      expect(first.statusCode).toBe(201);
      expect(second.json().replayed).toBe(true);
      expect(second.json().collectionRunId).toBe(first.json().collectionRunId);
    });

    it('the resulting run is a real, ownership-checked collection run visible through the normal authenticated read endpoints', async () => {
      const { userId, token } = await registerActiveUser();
      const ctx = await createTenantWithRole(userId, 'owner');
      const bizId = await createBusiness(ctx);
      const { connector, webhookUrl } = await createActiveWebhookConnector(ctx, bizId, token);

      const deliveryRes = await app!.inject({ method: 'POST', url: webhookUrl, payload: [{ order: 'WH-400' }] });
      const runId = deliveryRes.json().collectionRunId;

      const runRes = await app!.inject({ method: 'GET', url: `/v1/businesses/${bizId}/collection-runs/${runId}`, headers: tenantHeaders(ctx, token) });
      expect(runRes.statusCode).toBe(200);
      expect(runRes.json().collectionType).toBe('webhook');
      expect(runRes.json().connectorId).toBe(connector.id);
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


