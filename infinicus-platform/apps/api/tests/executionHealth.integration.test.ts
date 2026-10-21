/**
 * L-OBS-1 - read-only execution health for one business: live PostgreSQL + real Fastify application (RLS enforced for the app role).
 *
 * The health policy is overridden to "due immediately" so a freshly taken claim is observable as STRANDED without waiting 60 s; the recovery
 * control is driven with the same clock seam as claimRecovery.integration.test.ts. Requires DATABASE_URL (app role) and ADMIN_DATABASE_URL.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- HTTP payloads are arbitrary JSON */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@infinicus/configuration';
import { createPool, closePool, UserRepository, MembershipRepository, AuthorizedActionExecutionRepository, type TenantContext } from '@infinicus/database';
import { ExecutionActivationService } from '@infinicus/business-operations-runtime';
import { buildApp } from '../src/app.js';
import { ScriptedProvider, buildPackage, claimPackage, makeExecWorld, type ExecWorld } from '../../../packages/business-operations-runtime/tests/helpers/executionWorld.js';
import { answerFor } from '../../../packages/business-operations-runtime/tests/helpers/intakeFixture.js';
import { deleteMovementsForTenants } from '../../../packages/business-operations-runtime/tests/helpers/movementCleanup.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const STRONG_PASSWORD = 'Correct-Horse-9!';
const uc = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const ACTION = { code: 'inventory_reorder_policy_update', schemaVersion: '1' };
const BO = 'business_operations';

let adminPool: Pool;
let app: FastifyInstance;
const tenantIds: string[] = [];
let provider: ScriptedProvider;
let clockOffsetMs = 0;

interface Session { ew: ExecWorld; ctx: TenantContext; token: string; userId: string; bizId: string; pkg: any; claimId: string | null }

async function registerActiveUser(): Promise<{ userId: string; token: string }> {
  const email = `${uc('eh')}@eh-api.example`;
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
    await adminPool.query(`INSERT INTO tenancy.roles (id, tenant_id, code, name, description, scope, is_system) VALUES ($1,$2,$3,'Custom','eh test','tenant',false)`, [roleId, ctx.tenantId, `c-${uc('r')}`]);
    await adminPool.query(`INSERT INTO tenancy.role_permissions (role_id, permission_id) SELECT $1, id FROM tenancy.permissions WHERE code = ANY($2::text[])`, [roleId, role.permissions]);
  }
  await memberships.assignRole(ctx, m.id, roleId);
}

/** A tenant with an admin and a business; when `claim` a CLAIMED (never executed) package exists, and the gate is ENABLED. */
async function setup(o: { claim?: boolean } = {}): Promise<Session> {
  const ew = await makeExecWorld(adminPool, tenantIds, {});
  await adminPool.query(`UPDATE tenancy.tenants SET status='active', plan_code='test' WHERE id=$1`, [ew.w.tenantId]);
  const { userId, token } = await registerActiveUser();
  const ctx: TenantContext = { tenantId: ew.w.tenantId, workspaceId: ew.w.workspaceId, userId };
  await grantRole(ctx, userId, 'admin');
  await new ExecutionActivationService().setActivation(ctx, 'bo:admin', { businessId: ew.ctx.businessId, actionType: ACTION, state: 'ENABLED', reason: 'eh test', correlationId: randomUUID() });
  const pkg = await buildPackage(ew, { reorderPoint: 150, reorderQuantity: 250, modified: { baseline: [100, 200] } });
  const claimId = o.claim === false ? null : (await claimPackage(ew, pkg)).claimId;
  return { ew, ctx, token, userId, bizId: ew.ctx.businessId, pkg, claimId };
}
const hdr = (s: { ctx: TenantContext; token: string }, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${s.token}`, 'x-tenant-id': s.ctx.tenantId, 'x-workspace-id': s.ctx.workspaceId, ...extra,
});
const health = (s: Session, opts: { bizId?: string; token?: string } = {}) => app.inject({
  method: 'GET', url: `/v1/businesses/${opts.bizId ?? s.bizId}/execution-health`, headers: hdr({ ctx: s.ctx, token: opts.token ?? s.token }),
});
const recover = (s: Session) => app.inject({
  method: 'POST', url: `/v1/businesses/${s.bizId}/execution-recoveries`, headers: hdr(s, { 'idempotency-key': uc('key') }),
  payload: { actionType: ACTION, reason: 'l-obs-1 test' } as any,
});
const q = async (sql: string, args: unknown[]) => (await adminPool.query(sql, args)).rows;
const writes = async (s: Session) => ({
  executions: (await q(`SELECT count(*)::int n FROM ${BO}.authorized_action_executions WHERE tenant_id=$1`, [s.ctx.tenantId]))[0].n,
  attempts: (await q(`SELECT count(*)::int n FROM ${BO}.authorized_action_execution_attempts WHERE tenant_id=$1`, [s.ctx.tenantId]))[0].n,
  claims: (await q(`SELECT count(*)::int n FROM ${BO}.authorized_action_claims WHERE tenant_id=$1`, [s.ctx.tenantId]))[0].n,
  audits: (await q(`SELECT count(*)::int n FROM audit.audit_events WHERE tenant_id=$1`, [s.ctx.tenantId]))[0].n,
  outbox: (await q(`SELECT count(*)::int n FROM events.outbox_events WHERE tenant_id=$1`, [s.ctx.tenantId]))[0].n,
  balance: (await q(`SELECT reorder_point::float rp, reorder_quantity::float rq, version FROM ${BO}.inventory_balances WHERE id=$1`, [s.ew.balanceId]))[0],
});

describe.runIf(run)('execution health API - live PostgreSQL + Fastify (L-OBS-1)', () => {
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }), {
      executionHealth: { policy: { claimRecoveryMs: 0, backoffMs: [0, 0, 0] } },
      claimRecovery: { statusProviderFor: () => ({ getStatus: (r) => provider.getStatus(r as never) }), clock: () => new Date(Date.now() + clockOffsetMs) },
    });
    await app.ready();
  });
  afterAll(async () => { await deleteMovementsForTenants(adminPool, tenantIds).catch(() => undefined); await app?.close(); await adminPool?.end(); await closePool(); });
  const reset = (s?: Session) => { clockOffsetMs = 0; provider = new ScriptedProvider(() => (s ? answerFor(s.pkg) : null)); };

  it('a business with no claims and no executions is OK with zero counts', async () => {
    const s = await setup({ claim: false });
    const r = await health(s);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      businessId: s.bizId, status: 'OK',
      claims: { open: 0, stranded: 0, retryDue: 0, inProgress: 0, truncated: false, oldestStrandedAgeSeconds: null, attention: [] },
      executions: { succeeded: 0, failed: 0, refused: 0, lastExecutionRecordedAt: null, reasons: [] },
    });
  });

  it('a claim nothing has attempted is STRANDED, listed with its action type, and viewing it writes nothing and drives nothing', async () => {
    const s = await setup(); reset(s);
    const before = await writes(s);
    const r = await health(s);
    expect(r.statusCode).toBe(200);
    const v = r.json();
    expect(v).toMatchObject({ status: 'ATTENTION', claims: { open: 1, stranded: 1, retryDue: 0, inProgress: 0 } });
    expect(v.claims.attention).toHaveLength(1);
    expect(v.claims.attention[0]).toMatchObject({ claimId: s.claimId, state: 'STRANDED', attempts: 0, lastAttemptedAt: null, actionType: ACTION });
    expect(v.claims.oldestStrandedAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(provider.calls).toBe(0);                       // no ABA status call: the view never reaches ABA
    expect(await writes(s)).toEqual(before);              // no execution, attempt, claim, audit or outbox row; the balance is untouched
    expect(before.balance).toMatchObject({ rp: 100, rq: 200, version: 1 });
    await health(s); expect(await writes(s)).toEqual(before); // reading again still writes nothing (no audit of a read either)
  });

  it('an unavailable ABA status leaves an attempt, no outcome: the claim becomes RETRY_DUE and carries the last reason', async () => {
    const s = await setup(); reset(s); clockOffsetMs = 120_000;
    provider.set(() => null);
    const rec = await recover(s);
    expect(rec.statusCode).toBe(200);
    expect(rec.json().results[0]).toMatchObject({ state: 'RETRY', attemptNumber: 1 });
    const v = (await health(s)).json();
    expect(v).toMatchObject({ status: 'ATTENTION', claims: { open: 1, stranded: 0, retryDue: 1 } });
    expect(v.claims.attention[0]).toMatchObject({ claimId: s.claimId, state: 'RETRY_DUE', attempts: 1 });
    expect(typeof v.claims.attention[0].lastAttemptReasonCode).toBe('string');
  });

  it('after recovery executes the claim it is no longer open: stranded 0, one SUCCEEDED, status OK', async () => {
    const s = await setup(); reset(s); clockOffsetMs = 120_000;
    expect((await health(s)).json().claims.stranded).toBe(1);
    expect((await recover(s)).json().results[0]).toMatchObject({ outcome: 'SUCCEEDED' });
    const v = (await health(s)).json();
    expect(v).toMatchObject({ status: 'OK', claims: { open: 0, stranded: 0, retryDue: 0, attention: [] }, executions: { succeeded: 1, failed: 0, refused: 0, succeededInWindow: 1, reasons: [] } });
    expect(typeof v.executions.lastExecutionRecordedAt).toBe('string');
  });

  it('a REFUSED outcome (revoked authority) is reported by reason code and raises ATTENTION', async () => {
    const s = await setup(); reset(s); clockOffsetMs = 120_000;
    provider.set(() => answerFor(s.pkg, { authority: { state: 'REVOKED' } }));
    expect((await recover(s)).json().results[0]).toMatchObject({ outcome: 'REFUSED', reasonCode: 'AUTHORITY_REVOKED' });
    const v = (await health(s)).json();
    expect(v.status).toBe('ATTENTION');
    expect(v.claims.open).toBe(0);
    expect(v.executions).toMatchObject({ refused: 1, refusedInWindow: 1 });
    expect(v.executions.reasons).toEqual([expect.objectContaining({ outcome: 'REFUSED', reasonCode: 'AUTHORITY_REVOKED', total: 1, inWindow: 1 })]);
  });

  it('requires authentication and bo:admin; bo:read alone is refused', async () => {
    const s = await setup(); reset(s);
    expect((await app.inject({ method: 'GET', url: `/v1/businesses/${s.bizId}/execution-health` })).statusCode).toBe(401);
    const viewer = await registerActiveUser();
    await grantRole(s.ctx, viewer.userId, { permissions: ['bo:read'] });
    expect((await health(s, { token: viewer.token })).statusCode).toBe(403);
    const outsider = await registerActiveUser(); // authenticated but holds no membership in this tenant: refused by the platform's tenant resolution
    expect([403, 404]).toContain((await health(s, { token: outsider.token })).statusCode);
  });

  it('is tenant- and business-scoped: another tenant\'s business is a 404 and its claims never appear; a malformed id is 400; the path cannot widen scope', async () => {
    const a = await setup(); const b = await setup(); reset(a);
    const foreign = await health(a, { bizId: b.bizId });
    expect(foreign.statusCode).toBe(404);
    expect(JSON.stringify(foreign.json())).not.toContain(b.claimId as string);
    expect((await health(a, { bizId: randomUUID() })).statusCode).toBe(404);
    expect((await health(a, { bizId: 'not-a-uuid' })).statusCode).toBe(400);
    // each tenant sees only its own claim
    expect((await health(a)).json().claims.attention.map((c: any) => c.claimId)).toEqual([a.claimId]);
    expect((await health(b)).json().claims.attention.map((c: any) => c.claimId)).toEqual([b.claimId]);
  });

  it('the snapshot is filtered to the named business inside one tenant: another business id in the same scope sees none of these claims', async () => {
    const s = await setup();
    const repo = new AuthorizedActionExecutionRepository();
    const own = await repo.executionHealthSnapshot(s.ctx, s.bizId, { openLimit: 50, windowSeconds: 60 });
    expect(own.openClaims.map((c) => c.claimId)).toEqual([s.claimId]);
    const other = await repo.executionHealthSnapshot(s.ctx, randomUUID(), { openLimit: 50, windowSeconds: 60 });
    expect(other).toMatchObject({ openClaimTotal: 0, openClaims: [], terminal: [] });
  });

  it('exposes no mutating verb: POST/PUT/PATCH/DELETE on the path are not routed', async () => {
    const s = await setup(); reset(s);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const r = await app.inject({ method, url: `/v1/businesses/${s.bizId}/execution-health`, headers: hdr(s, { 'idempotency-key': uc('k') }), payload: {} as any });
      expect(r.statusCode, method).toBe(404);
    }
  });
});
