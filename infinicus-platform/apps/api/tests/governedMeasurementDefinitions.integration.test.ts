import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@infinicus/configuration';
import { buildApp } from '../src/app.js';
import { closePool, createPool, GovernedMeasurementDefinitionRepository, MembershipRepository, UserRepository, withTenantTransaction, type TenantContext } from '@infinicus/database';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const password = 'Correct-Horse-9!';
const unique = () => `${Date.now()}-${randomUUID().slice(0, 8)}`;

describe.runIf(run)('governed measurement definition review API', () => {
  let admin: Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let ctx: TenantContext;
  let businessId: string;
  let adminToken: string;
  let memberToken: string;
  let authorId: string;
  let approverId: string;

  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL! });
    app = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    await app.ready();
    const tenantId = randomUUID(); const workspaceId = randomUUID(); businessId = randomUUID();
    await admin.query(`INSERT INTO tenancy.tenants (id,name,slug,status,plan_code) VALUES ($1,'OM definitions',$2,'active','test')`, [tenantId, unique()]);
    await admin.query(`INSERT INTO tenancy.workspaces (id,tenant_id,name,slug,status) VALUES ($1,$2,'OM definitions',$3,'active')`, [workspaceId, tenantId, unique()]);
    await admin.query(`INSERT INTO platform.businesses (id,tenant_id,workspace_id,legal_name,business_code,status) VALUES ($1,$2,$3,'OM definitions',$4,'active')`, [businessId, tenantId, workspaceId, unique()]);

    const register = async () => {
      const email = `${unique()}@om.example`;
      const response = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password } });
      expect(response.statusCode).toBe(201);
      const userId = response.json().id as string;
      await new UserRepository().activate(userId);
      const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } });
      return { userId, token: login.json().rawSessionToken as string };
    };
    const owner = await register(); const member = await register();
    ctx = { tenantId, workspaceId, userId: owner.userId };
    const memberships = new MembershipRepository();
    for (const [userId, code] of [[owner.userId, 'admin'], [member.userId, 'member']] as const) {
      const membership = await memberships.create(ctx, userId);
      await memberships.activate(ctx, membership.id);
      const role = await admin.query(`SELECT id FROM tenancy.roles WHERE tenant_id IS NULL AND code = $1`, [code]);
      await memberships.assignRole(ctx, membership.id, role.rows[0].id);
    }
    adminToken = owner.token; memberToken = member.token;
    authorId = owner.userId; approverId = member.userId;
  });

  afterAll(async () => { await app?.close(); await admin?.end(); await closePool(); });

  const read = (token: string, id: string) => app.inject({ method: 'GET', url: `/v1/businesses/${id}/outcome-measurement-definitions`,
    headers: { authorization: `Bearer ${token}`, 'x-tenant-id': ctx.tenantId, 'x-workspace-id': ctx.workspaceId } });

  it('returns an empty approved-definition list without inventing policy values', async () => {
    const response = await read(adminToken, businessId);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ businessId, definitions: [], truncated: false });
  });

  it('reads approved immutable values as authored, including a lossless decimal threshold', async () => {
    const id = randomUUID();
    await admin.query(`INSERT INTO outcome_monitoring.governed_measurement_definitions
      (id, tenant_id, workspace_id, business_id, action_type_code, action_type_schema_version,
       metric_code, definition_version, window_seconds, baseline_seconds, minimum_observations,
       attribution_rule_code, success_direction, success_threshold, author_id, approver_id)
      VALUES ($1,$2,$3,$4,'inventory_reorder_policy_update','1','stockout_count',1,86400,86400,5,
              'no_other_policy_change','decrease',0.125,$5,$6)`,
    [id, ctx.tenantId, ctx.workspaceId, businessId, authorId, approverId]);
    const direct = await withTenantTransaction(ctx, (client) => client.query(`SELECT count(*)::int AS n, current_setting('app.tenant_id', true) AS tenant FROM outcome_monitoring.governed_measurement_definitions WHERE business_id = $1`, [businessId]));
    expect(direct.rows[0]).toMatchObject({ n: 1, tenant: ctx.tenantId });
    expect((await new GovernedMeasurementDefinitionRepository().listApproved(ctx, businessId)).definitions).toHaveLength(1);
    const response = await read(adminToken, businessId);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ businessId, truncated: false, definitions: [{
      id, businessId, actionTypeCode: 'inventory_reorder_policy_update', metricCode: 'stockout_count',
      definitionVersion: 1, windowSeconds: 86400, baselineSeconds: 86400,
      minimumObservations: 5, successDirection: 'decrease', successThreshold: '0.125', authorId, approverId,
    }] });
  });

  it('requires business administration and a business in scope', async () => {
    expect((await read(memberToken, businessId)).statusCode).toBe(403);
    expect((await read(adminToken, randomUUID())).statusCode).toBe(404);
  });
});
