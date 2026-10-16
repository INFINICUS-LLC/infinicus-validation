/**
 * F-NA05-3 / migration 0200 - the DATABASE refuses an Outcome Monitoring row that references a monitored action of another tenant, workspace
 * or business. Real PostgreSQL, application role (RLS applies), repositories and raw SQL: nothing here goes through the application guard added in
 * F-NA05-1, so every refusal below is the database's own. Each negative test fails if the composite foreign key is absent (see the mutation control
 * in the completion report: drop the constraints and these tests fail).
 *
 * Requires DATABASE_URL (application role) and ADMIN_DATABASE_URL (fixtures, catalog reads).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { createPool, closePool, withTenantTransaction, UserRepository, MembershipRepository, OutcomeObservationRepository, type TenantContext } from '@infinicus/database';
import { createMonitoredAction } from './helpers/omFixtures.js';
import { uc } from './helpers/abaFixtures.js';

const run = !!process.env.DATABASE_URL;
const OM = 'outcome_monitoring';
let admin: Pool;
const repo = new OutcomeObservationRepository();

interface Scope { ctx: TenantContext; bizId: string; actionId: string }

async function userId(): Promise<string> {
  const u = await new UserRepository().createUser({ email: `${uc('f3')}@f3.example`, passwordHash: '$2a$12$fixturefixturefixturefixturefixturefixture' });
  return (await new UserRepository().activate(u.id)).id;
}
async function workspace(tenantId: string, name: string): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,$3,$4,'active')`, [id, tenantId, name, uc('f3ws')]);
  return id;
}
async function scope(ctx: TenantContext): Promise<Scope> {
  const members = new MembershipRepository();
  const m = await members.create(ctx, ctx.userId); await members.activate(ctx, m.id);
  const bizId = randomUUID();
  await admin.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'F3 Biz',$4,'active')`, [bizId, ctx.tenantId, ctx.workspaceId, uc('f3b')]);
  return { ctx, bizId, actionId: await createMonitoredAction(ctx, bizId) };
}
async function tenant(): Promise<{ tenantId: string }> {
  const tenantId = randomUUID();
  await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'F3 Tenant',$2,'active','test')`, [tenantId, uc('f3t')]);
  return { tenantId };
}
/** A second business with its own monitored action in the SAME workspace as `s`. */
async function siblingBusiness(s: Scope): Promise<Scope> {
  const bizId = randomUUID();
  await admin.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'F3 Sibling',$4,'active')`, [bizId, s.ctx.tenantId, s.ctx.workspaceId, uc('f3s')]);
  return { ctx: s.ctx, bizId, actionId: await createMonitoredAction(s.ctx, bizId) };
}

const count = async (sql: string, args: unknown[] = []) => Number((await admin.query(sql, args)).rows[0].n);
const OBS = `SELECT count(*)::int n FROM ${OM}.outcome_observations`;
const VER = `SELECT count(*)::int n FROM ${OM}.action_execution_verifications`;

/** Raw INSERT as the application role inside the caller's tenant context (bypasses every application guard). */
const insertObservation = (ctx: TenantContext, businessId: string, monitoredActionId: string, code = uc('obs')) =>
  withTenantTransaction(ctx, (c) => c.query(
    `INSERT INTO ${OM}.outcome_observations (tenant_id, workspace_id, business_id, monitored_action_id, observation_code, latest_version) VALUES ($1,$2,$3,$4,$5,1) RETURNING id`,
    [ctx.tenantId, ctx.workspaceId, businessId, monitoredActionId, code]));

const insertVerification = (ctx: TenantContext, businessId: string, monitoredActionId: string | null) =>
  withTenantTransaction(ctx, (c) => c.query(
    `INSERT INTO ${OM}.action_execution_verifications (tenant_id,workspace_id,business_id,execution_id,source_event_id,contract_version,evidence_digest,package_id,package_version,claim_id,monitored_action_id,action_type_code,action_type_schema_version,target_kind,target_id,execution_outcome,mutation_result,execution_recorded_at,execution_state,outcome_state,outcome_state_reason,correlation_id)
     VALUES ($1,$2,$3,$4,$5,'execution-evidence/1',$6,$7,1,$8,$9,'c','1','k','t','SUCCEEDED','APPLIED',date_trunc('milliseconds', now()),'EXECUTION_VERIFIED','OUTCOME_PENDING','f3',$10) RETURNING id`,
    [ctx.tenantId, ctx.workspaceId, businessId, randomUUID(), randomUUID(), `sha256:${'b'.repeat(64)}`, randomUUID(), randomUUID(), monitoredActionId, randomUUID()]));

describe.runIf(run)('F-NA05-3 0200 monitored-action scope integrity (live PostgreSQL, application role)', () => {
  let a: Scope; let sibling: Scope; let otherWs: Scope; let otherTenant: Scope;

  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
    const uid = await userId();
    const t1 = await tenant(); const ws1 = await workspace(t1.tenantId, 'F3 WS1'); const ws2 = await workspace(t1.tenantId, 'F3 WS2');
    a = await scope({ tenantId: t1.tenantId, workspaceId: ws1, userId: uid });
    sibling = await siblingBusiness(a);
    otherWs = await scope({ tenantId: t1.tenantId, workspaceId: ws2, userId: uid });
    const t2 = await tenant(); const ws3 = await workspace(t2.tenantId, 'F3 WS3');
    otherTenant = await scope({ tenantId: t2.tenantId, workspaceId: ws3, userId: uid });
  }, 240_000);
  afterAll(async () => { await admin?.end(); await closePool(); });

  describe('observations', () => {
    it('1. a monitored action of the SAME tenant, workspace and business is accepted', async () => {
      const r = await insertObservation(a.ctx, a.bizId, a.actionId);
      expect(r.rows).toHaveLength(1);
    });

    it.each([
      ['2. a different business in the same workspace', () => ({ ctx: a.ctx, biz: a.bizId, action: sibling.actionId })],
      ['3. a different workspace of the same tenant', () => ({ ctx: a.ctx, biz: a.bizId, action: otherWs.actionId })],
      ['4. a different tenant', () => ({ ctx: a.ctx, biz: a.bizId, action: otherTenant.actionId })],
    ])('%s is rejected by the database (23503) and leaves no row', async (_n, pick) => {
      const { ctx, biz, action } = pick();
      const before = await count(OBS);
      await expect(insertObservation(ctx, biz, action)).rejects.toMatchObject({ code: '23503', constraint: 'outcome_observations_monitored_action_scope_fkey' });
      expect(await count(OBS)).toBe(before);
    });

    it('5. a nonexistent monitored action is rejected and leaves no row', async () => {
      const before = await count(OBS);
      await expect(insertObservation(a.ctx, a.bizId, randomUUID())).rejects.toMatchObject({ code: '23503' });
      expect(await count(OBS)).toBe(before);
    });

    it('7-8. the application role cannot even READ the foreign action (RLS), yet the database still refuses the reference', async () => {
      const visible = await withTenantTransaction(a.ctx, (c) => c.query(`SELECT 1 FROM ${OM}.monitored_actions WHERE id = $1`, [otherTenant.actionId]));
      expect(visible.rows).toHaveLength(0);                                                          // RLS unchanged
      const own = await withTenantTransaction(a.ctx, (c) => c.query(`SELECT 1 FROM ${OM}.monitored_actions WHERE id = $1`, [a.actionId]));
      expect(own.rows).toHaveLength(1);
      await expect(insertObservation(a.ctx, a.bizId, otherTenant.actionId)).rejects.toMatchObject({ code: '23503' });
    });

    it('a row can neither be created in another scope pointing at this scope, nor re-pointed: the key columns of a referenced action cannot change', async () => {
      await expect(admin.query(`UPDATE ${OM}.monitored_actions SET business_id = $2 WHERE id = $1`, [a.actionId, sibling.bizId])).rejects.toMatchObject({ code: '23503' });
    });

    it('9. recorded-observation immutability still holds', async () => {
      const { observation, version } = await repo.createObservation(a.ctx, a.bizId, a.actionId, uc('imm'), 's', new Date());
      await repo.record(a.ctx, observation.id, version.id);
      await expect(repo.verify(a.ctx, observation.id, version.id)).rejects.toThrow(/immutable|conflict/i);
    });

    it('10. the repository success path still works in the correct scope', async () => {
      const { observation, version } = await repo.createObservation(a.ctx, a.bizId, a.actionId, uc('ok'), 's', new Date());
      expect((await repo.record(a.ctx, observation.id, version.id)).status).toBe('recorded');
    });
  });

  describe('execution verifications (nullable reference)', () => {
    it('6. a NULL monitored_action_id is permitted (MATCH SIMPLE: not checked)', async () => {
      expect((await insertVerification(a.ctx, a.bizId, null)).rows).toHaveLength(1);
    });
    it('12a. a matching monitored action is accepted', async () => {
      expect((await insertVerification(a.ctx, a.bizId, a.actionId)).rows).toHaveLength(1);
    });
    it.each([
      ['other business', () => sibling.actionId],
      ['other workspace', () => otherWs.actionId],
      ['other tenant', () => otherTenant.actionId],
      ['nonexistent', () => randomUUID()],
    ])('12b. %s is rejected (23503) and leaves no row', async (_n, pick) => {
      const before = await count(VER);
      await expect(insertVerification(a.ctx, a.bizId, pick())).rejects.toMatchObject({ code: '23503' });
      expect(await count(VER)).toBe(before);
    });
  });

  describe('catalog (13)', () => {
    it('the three constraints exist, are validated, MATCH SIMPLE, ON DELETE RESTRICT, on exactly the scope columns; the single-column FKs are kept; migration is registered', async () => {
      const r = await admin.query(`SELECT conname, convalidated, confmatchtype, confdeltype, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname IN ('outcome_observations_monitored_action_scope_fkey','action_execution_verifications_monitored_action_scope_fkey') ORDER BY conname`);
      expect(r.rows).toHaveLength(2);
      for (const row of r.rows) {
        expect(row.convalidated).toBe(true); expect(row.confmatchtype).toBe('s'); expect(row.confdeltype).toBe('r');
        expect(row.def).toContain('(monitored_action_id, tenant_id, workspace_id, business_id) REFERENCES outcome_monitoring.monitored_actions(id, tenant_id, workspace_id, business_id)');
      }
      const u = await admin.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='monitored_actions_scope_key' AND conrelid='outcome_monitoring.monitored_actions'::regclass`);
      expect(u.rows[0].def).toBe('UNIQUE (id, tenant_id, workspace_id, business_id)');
      const old = await admin.query(`SELECT conname FROM pg_constraint WHERE conname IN ('outcome_observations_monitored_action_id_fkey','action_execution_verifications_monitored_action_id_fkey')`);
      expect(old.rows).toHaveLength(2);
      expect(await count(`SELECT count(*)::int n FROM _migrations WHERE filename = '0200_enforce_om_monitored_action_scope_integrity.sql'`)).toBe(1);
      const rls = await admin.query(`SELECT relname, relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE oid IN ('outcome_monitoring.outcome_observations'::regclass,'outcome_monitoring.monitored_actions'::regclass,'outcome_monitoring.action_execution_verifications'::regclass)`);
      expect(rls.rows.every((x) => x.r && x.f)).toBe(true);
    });
  });
});
