/**
 * P0-6h - interim OPERATOR recovery of stranded claims: live PostgreSQL + real Fastify application (RLS enforced for the app role).
 *
 * The control is the engine's existing scoped `runDue` behind `POST /v1/businesses/:businessId/execution-recoveries`. The ABA-owned status port
 * is scripted (the package comes from the BO execution-world kit); the engine, gate, activation record, repositories, audit and routes are real.
 * Requires DATABASE_URL (app role) and ADMIN_DATABASE_URL.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- HTTP payloads are arbitrary JSON */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@infinicus/configuration';
import { createPool, closePool, UserRepository, MembershipRepository, type TenantContext } from '@infinicus/database';
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
// scripted ABA-owned status port, the clock and the kill switch are mutable per test
let provider: ScriptedProvider;
let clockOffsetMs = 0;
let killSwitch = false;

interface Session { ew: ExecWorld; ctx: TenantContext; token: string; userId: string; bizId: string; pkg: any; claimId: string }

async function registerActiveUser(): Promise<{ userId: string; token: string }> {
  const email = `${uc('cr')}@cr-api.example`;
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
    await adminPool.query(`INSERT INTO tenancy.roles (id, tenant_id, code, name, description, scope, is_system) VALUES ($1,$2,$3,'Custom','cr test','tenant',false)`, [roleId, ctx.tenantId, `c-${uc('r')}`]);
    await adminPool.query(`INSERT INTO tenancy.role_permissions (role_id, permission_id) SELECT $1, id FROM tenancy.permissions WHERE code = ANY($2::text[])`, [roleId, role.permissions]);
  }
  await memberships.assignRole(ctx, m.id, roleId);
}
const actionCtx = (ew: ExecWorld, userId: string): TenantContext => ({ tenantId: ew.w.tenantId, workspaceId: ew.w.workspaceId, userId });

/** A tenant with an admin, a CLAIMED (never executed) package, and - when `enabled` - an ENABLED activation. */
async function setup(o: { role?: string | { permissions: string[] }; enabled?: boolean } = {}): Promise<Session> {
  const ew = await makeExecWorld(adminPool, tenantIds, {});
  await adminPool.query(`UPDATE tenancy.tenants SET status='active', plan_code='test' WHERE id=$1`, [ew.w.tenantId]);
  const pkg = await buildPackage(ew, { reorderPoint: 150, reorderQuantity: 250, modified: { baseline: [100, 200] } });
  const { userId, token } = await registerActiveUser();
  const ctx = actionCtx(ew, userId);
  await grantRole(ctx, userId, o.role ?? 'admin');
  if (o.enabled !== false) {
    await new ExecutionActivationService().setActivation(ctx, 'bo:admin', { businessId: ew.ctx.businessId, actionType: ACTION, state: 'ENABLED', reason: 'cr test', correlationId: randomUUID() });
  }
  const { claimId } = await claimPackage(ew, pkg); // the single-use claim exists; nothing has executed
  return { ew, ctx, token, userId, bizId: ew.ctx.businessId, pkg, claimId };
}

const hdr = (s: { ctx: TenantContext; token: string }, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${s.token}`, 'x-tenant-id': s.ctx.tenantId, 'x-workspace-id': s.ctx.workspaceId, ...extra,
});
const post = (s: Session, payload: unknown, opts: { bizId?: string; key?: string | null; token?: string } = {}) => app.inject({
  method: 'POST', url: `/v1/businesses/${opts.bizId ?? s.bizId}/execution-recoveries`,
  headers: hdr({ ctx: s.ctx, token: opts.token ?? s.token }, opts.key === null ? {} : { 'idempotency-key': opts.key ?? uc('key') }), payload: payload as any,
});
const body = (over: Record<string, unknown> = {}) => ({ actionType: ACTION, reason: 'stranded claim after a long gate closure', ...over });
const due = () => { clockOffsetMs = 120_000; }; // the claim is past the ruled 60 s recovery threshold
const q = async (sql: string, args: unknown[]) => (await adminPool.query(sql, args)).rows;
const executions = (s: Session) => q(`SELECT * FROM ${BO}.authorized_action_executions WHERE tenant_id=$1`, [s.ctx.tenantId]);
const attempts = (s: Session) => q(`SELECT * FROM ${BO}.authorized_action_execution_attempts WHERE tenant_id=$1`, [s.ctx.tenantId]);
const audits = (s: Session) => q(`SELECT actor_type, actor_id, action, entity_type, entity_id, metadata FROM audit.audit_events WHERE tenant_id=$1 AND action LIKE 'bo.claim_recovery.%' ORDER BY occurred_at, action DESC`, [s.ctx.tenantId]);
const balance = async (s: Session) => (await q(`SELECT reorder_point::float rp, reorder_quantity::float rq, version FROM ${BO}.inventory_balances WHERE id=$1`, [s.ew.balanceId]))[0];
const untouched = async (s: Session) => expect(await balance(s)).toMatchObject({ rp: 100, rq: 200, version: 1 });

describe.runIf(run)('operator claim recovery API - live PostgreSQL + Fastify (P0-6h)', () => {
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }), {
      claimRecovery: { statusProviderFor: () => ({ getStatus: (r) => provider.getStatus(r as never) }), clock: () => new Date(Date.now() + clockOffsetMs), killSwitchEngaged: () => killSwitch },
    });
    await app.ready();
  });
  afterAll(async () => { await deleteMovementsForTenants(adminPool, tenantIds).catch(() => undefined); await app?.close(); await adminPool?.end(); await closePool(); });

  const reset = (s?: Session) => {
    clockOffsetMs = 0; killSwitch = false;
    provider = new ScriptedProvider(() => (s ? answerFor(s.pkg) : null));
  };

  it('a bo:admin drives a DUE stranded claim through the one engine: executed once, evidence recorded, audited as a USER action before and after', async () => {
    const s = await setup(); reset(s); due();
    await untouched(s);
    const r = await post(s, body());
    expect(r.statusCode).toBe(200);
    const out = r.json();
    expect(out).toMatchObject({ businessId: s.bizId, actionType: ACTION, attempted: 1 });
    expect(out.results[0]).toMatchObject({ claimId: s.claimId, state: 'TERMINAL', outcome: 'SUCCEEDED', replayed: false });
    expect(await executions(s)).toHaveLength(1);
    expect((await executions(s))[0]).toMatchObject({ outcome: 'SUCCEEDED', mutation_result: 'APPLIED', authority_verdict: 'CURRENT', claim_id: s.claimId });
    expect(await balance(s)).toMatchObject({ rp: 150, rq: 250, version: 2 });
    expect(await q(`SELECT 1 FROM events.outbox_events WHERE tenant_id=$1 AND event_type='operations.action.executed'`, [s.ctx.tenantId])).toHaveLength(1);
    const a = await audits(s);
    expect(a.map((x) => x.action)).toEqual(['bo.claim_recovery.requested', 'bo.claim_recovery.completed']);
    expect(a.every((x) => x.actor_type === 'user' && x.actor_id === s.userId && x.entity_type === 'authorized_action_recovery_request' && x.entity_id === s.bizId)).toBe(true);
    expect(a[0].metadata).toMatchObject({ actionType: 'inventory_reorder_policy_update@1', reason: 'stranded claim after a long gate closure', limit: 10 });
    expect(a[1].metadata).toMatchObject({ attempted: 1, results: [{ claimId: s.claimId, state: 'TERMINAL', outcome: 'SUCCEEDED' }] });
  });

  it('it uses the SAME due rule as the worker: a claim younger than 60 s is not driven (attempted 0), though the request is still audited', async () => {
    const s = await setup(); reset(s); // clock offset 0: the claim was just taken
    const r = await post(s, body());
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ attempted: 0, results: [] });
    expect(await executions(s)).toHaveLength(0);
    expect(await attempts(s)).toHaveLength(0);
    await untouched(s);
    expect((await audits(s)).map((x) => x.action)).toEqual(['bo.claim_recovery.requested', 'bo.claim_recovery.completed']);
  });

  it('a terminal claim is never re-driven: repeating the request with a new key attempts nothing and changes nothing', async () => {
    const s = await setup(); reset(s); due();
    expect((await post(s, body())).json().attempted).toBe(1);
    const second = await post(s, body());
    expect(second.json()).toMatchObject({ attempted: 0, results: [] });
    expect(await executions(s)).toHaveLength(1);
    expect(await balance(s)).toMatchObject({ rp: 150, rq: 250, version: 2 });
  });

  it('the same Idempotency-Key replays the stored response: one execution, one pair of audit rows', async () => {
    const s = await setup(); reset(s); due();
    const key = uc('idem');
    const first = await post(s, body(), { key });
    const again = await post(s, body(), { key });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect(await executions(s)).toHaveLength(1);
    expect(await audits(s)).toHaveLength(2);
  });

  it('requires an Idempotency-Key, authentication and bo:admin - and nothing runs or is audited without them', async () => {
    const s = await setup(); reset(s); due();
    expect((await post(s, body(), { key: null })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/v1/businesses/${s.bizId}/execution-recoveries`, payload: body() as any })).statusCode).toBe(401);
    const viewer = await registerActiveUser();
    await grantRole(s.ctx, viewer.userId, { permissions: ['bo:read'] });
    expect((await post(s, body(), { token: viewer.token })).statusCode).toBe(403);
    expect(await executions(s)).toHaveLength(0);
    expect(await audits(s)).toHaveLength(0);
    await untouched(s);
  });

  it('is REFUSED (409 GATE_CLOSED) while the gate is closed - never bypassed, and the held claim is NOT terminalized: not activated, disabled, and the global kill switch', async () => {
    const notActivated = await setup({ enabled: false }); reset(notActivated); due();
    const a = await post(notActivated, body());
    expect(a.statusCode).toBe(409);
    expect(a.json().error.code).toBe('ClaimRecoveryOperatorError');
    expect(await executions(notActivated)).toHaveLength(0);
    expect(await audits(notActivated)).toHaveLength(0); // refused before anything was attempted or recorded as an attempt

    const killed = await setup(); reset(killed); due(); killSwitch = true;
    expect((await post(killed, body())).statusCode).toBe(409);
    expect(await executions(killed)).toHaveLength(0);
    killSwitch = false;
    await new ExecutionActivationService().setActivation(killed.ctx, 'bo:admin', { businessId: killed.bizId, actionType: ACTION, state: 'DISABLED', reason: 'pause', correlationId: randomUUID() });
    expect((await post(killed, body())).statusCode).toBe(409);
    expect(await executions(killed)).toHaveLength(0);
    expect(await attempts(killed)).toHaveLength(0);
    await untouched(killed);
    // reopening the gate lets the SAME held claim be recovered afterwards
    await new ExecutionActivationService().setActivation(killed.ctx, 'bo:admin', { businessId: killed.bizId, actionType: ACTION, state: 'ENABLED', reason: 'resume', correlationId: randomUUID() });
    expect((await post(killed, body())).json()).toMatchObject({ attempted: 1, results: [{ claimId: killed.claimId, outcome: 'SUCCEEDED' }] });
  });

  it('the FINAL authority check is still mandatory: revoked authority ends REFUSED(AUTHORITY_REVOKED), nothing mutated; unavailable status is a RETRY, not a terminal row', async () => {
    const revoked = await setup(); reset(revoked); due();
    provider.set(() => answerFor(revoked.pkg, { authority: { state: 'REVOKED' } }));
    const r = await post(revoked, body());
    expect(r.json().results[0]).toMatchObject({ state: 'TERMINAL', outcome: 'REFUSED', reasonCode: 'AUTHORITY_REVOKED' });
    await untouched(revoked);

    const down = await setup(); reset(down); due();
    provider.set(() => null);
    const d = await post(down, body());
    expect(d.json().results[0]).toMatchObject({ claimId: down.claimId, state: 'RETRY', attemptNumber: 1, reasonCode: 'STATUS_UNAVAILABLE' });
    expect(await executions(down)).toHaveLength(0);
    expect(await attempts(down)).toHaveLength(1);
    await untouched(down);
  });

  it('is scoped to ONE business in the caller scope: another tenant business is 404 and its claim is untouched; the body cannot name a claim or a scope', async () => {
    const a = await setup(); reset(a); due();
    const b = await setup(); // a different tenant, with its own stranded claim
    expect((await post(a, body(), { bizId: b.bizId })).statusCode).toBe(404);
    expect((await post(a, body(), { bizId: randomUUID() })).statusCode).toBe(404);
    for (const extra of [{ claimId: b.claimId }, { tenantId: b.ctx.tenantId }, { businessId: b.bizId }, { permission: 'x' }, { state: 'ENABLED' }]) {
      expect((await post(a, body(extra))).statusCode, JSON.stringify(extra)).toBe(400);
    }
    expect(await executions(b)).toHaveLength(0);
    expect(await executions(a)).toHaveLength(0);
    await untouched(b);
  });

  it('drives ONLY the requested business: a sibling business in the SAME workspace with its own stranded claim is untouched', async () => {
    const a = await setup(); reset(a); due();
    // a second business in the same tenant and workspace, with its own inventory and its own claimed (never executed) package
    const sibling = a.ew.w.otherBusinessId;
    const itemId = randomUUID(); const warehouseId = randomUUID(); const balanceId = randomUUID();
    await adminPool.query(`INSERT INTO platform.inventory_items (id, tenant_id, workspace_id, business_id, sku, name, status) VALUES ($1,$2,$3,$4,$5,'Item','active')`, [itemId, a.ctx.tenantId, a.ctx.workspaceId, sibling, `sku-${itemId}`]);
    await adminPool.query(`INSERT INTO platform.warehouses (id, tenant_id, workspace_id, business_id, warehouse_code, name) VALUES ($1,$2,$3,$4,$5,'WH')`, [warehouseId, a.ctx.tenantId, a.ctx.workspaceId, sibling, `wh-${warehouseId}`]);
    await adminPool.query(`INSERT INTO ${BO}.inventory_balances (id, tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, quantity_on_hand, reorder_point, reorder_quantity) VALUES ($1,$2,$3,$4,$5,$6,50,100,200)`, [balanceId, a.ctx.tenantId, a.ctx.workspaceId, sibling, itemId, warehouseId]);
    const ew2: ExecWorld = { w: { ...a.ew.w, businessId: sibling }, ctx: { ...a.ew.ctx, businessId: sibling }, itemId, warehouseId, balanceId };
    const pkg2 = await buildPackage(ew2, { reorderPoint: 150, reorderQuantity: 250, modified: { baseline: [100, 200] } });
    const { claimId: claim2 } = await claimPackage(ew2, pkg2);
    await new ExecutionActivationService().setActivation(a.ctx, 'bo:admin', { businessId: sibling, actionType: ACTION, state: 'ENABLED', reason: 'cr test', correlationId: randomUUID() });
    provider.set((req: any) => answerFor(req.packageId === pkg2.identity.packageId ? pkg2 : a.pkg));

    const r = await post(a, body());
    expect(r.json()).toMatchObject({ attempted: 1, results: [{ claimId: a.claimId, outcome: 'SUCCEEDED' }] });
    expect((await executions(a)).map((x) => x.claim_id)).toEqual([a.claimId]);
    expect(await q(`SELECT reorder_point::float rp, reorder_quantity::float rq, version FROM ${BO}.inventory_balances WHERE id=$1`, [balanceId])).toEqual([{ rp: 100, rq: 200, version: 1 }]);
    // the sibling is recovered only when ITS business is named
    expect((await post(a, body(), { bizId: sibling })).json()).toMatchObject({ attempted: 1, results: [{ claimId: claim2 }] });
  });

  it('validates the request: a reason is required, the limit is 1..25, an unsupported action type is refused (409)', async () => {
    const s = await setup(); reset(s); due();
    for (const bad of [{ reason: '' }, { reason: '   ' }, { reason: 'x'.repeat(501) }, { limit: 0 }, { limit: 26 }, { limit: 1.5 }, { actionType: {} }]) {
      expect((await post(s, body(bad))).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await post(s, body({ actionType: { code: 'refund_issue', schemaVersion: '1' } }))).statusCode).toBe(409);
    expect(await executions(s)).toHaveLength(0);
    expect(await audits(s)).toHaveLength(0);
    expect((await post(s, body({ limit: 25 }))).statusCode).toBe(200);
  });
});
