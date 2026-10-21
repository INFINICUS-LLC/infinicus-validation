/**
 * OM-OBS-1 - read-only Outcome Monitoring health for one business: live PostgreSQL + real Fastify application (RLS enforced for the app role).
 *
 * Facts are created through the real repositories wherever one exists (monitored action, observation, delivery attempt, dead letter) and with raw
 * INSERTs as the application role where the production writer is a worker (execution verification, outbox notification). The view is then read over
 * HTTP. Requires DATABASE_URL (application role) and ADMIN_DATABASE_URL (fixtures, row counts).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- HTTP payloads are arbitrary JSON */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@infinicus/configuration';
import {
  createPool, closePool, withTenantTransaction, UserRepository, MembershipRepository, OutcomeObservationRepository, DeadLetterRepository, EventDeliveryAttemptRepository,
  type TenantContext,
} from '@infinicus/database';
import { buildApp } from '../src/app.js';
import { createMonitoredAction } from './helpers/omFixtures.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const STRONG_PASSWORD = 'Correct-Horse-9!';
const uc = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const OM = 'outcome_monitoring';
const EVENT = 'operations.action.executed';
const CONSUMER = 'om.execution_verification';
const DIGEST = `sha256:${'e'.repeat(64)}`;

let admin: Pool;
let app: FastifyInstance;

interface World { ctx: TenantContext; bizId: string; adminToken: string; memberToken: string; adminId: string; memberId: string }

async function registerActiveUser(): Promise<{ userId: string; token: string }> {
  const email = `${uc('omo')}@omo-api.example`;
  const reg = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: STRONG_PASSWORD } });
  expect(reg.statusCode).toBe(201);
  const userId = reg.json().id as string;
  await new UserRepository().activate(userId);
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: STRONG_PASSWORD } });
  return { userId, token: login.json().rawSessionToken as string };
}
async function grantRole(ctx: TenantContext, userId: string, role: string): Promise<void> {
  const memberships = new MembershipRepository();
  const m = await memberships.create(ctx, userId);
  await memberships.activate(ctx, m.id);
  const roleId = (await admin.query(`SELECT id FROM tenancy.roles WHERE tenant_id IS NULL AND code = $1`, [role])).rows[0].id;
  await memberships.assignRole(ctx, m.id, roleId);
}
async function world(): Promise<World> {
  const tenantId = randomUUID(); const workspaceId = randomUUID(); const bizId = randomUUID();
  await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'OMO T',$2,'active','test')`, [tenantId, uc('omot')]);
  await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'OMO WS',$3,'active')`, [workspaceId, tenantId, uc('omow')]);
  await admin.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'OMO Biz',$4,'active')`, [bizId, tenantId, workspaceId, uc('omob')]);
  const a = await registerActiveUser(); const m = await registerActiveUser();
  const ctx: TenantContext = { tenantId, workspaceId, userId: a.userId };
  await grantRole(ctx, a.userId, 'admin');
  await grantRole(ctx, m.userId, 'member');
  return { ctx, bizId, adminToken: a.token, memberToken: m.token, adminId: a.userId, memberId: m.userId };
}
const hdr = (w: World, token: string) => ({ authorization: `Bearer ${token}`, 'x-tenant-id': w.ctx.tenantId, 'x-workspace-id': w.ctx.workspaceId });
const omHealth = (w: World, o: { token?: string; bizId?: string } = {}) => app.inject({ method: 'GET', url: `/v1/businesses/${o.bizId ?? w.bizId}/outcome-monitoring-health`, headers: hdr(w, o.token ?? w.adminToken) });
const execHealth = (w: World) => app.inject({ method: 'GET', url: `/v1/businesses/${w.bizId}/execution-health`, headers: hdr(w, w.adminToken) });

const verification = (w: World, v: { executionId: string; outcomeState: string; mutationResult?: string; monitoredActionId: string | null }) => withTenantTransaction(w.ctx, (c) => c.query(
  `INSERT INTO ${OM}.action_execution_verifications (tenant_id,workspace_id,business_id,execution_id,source_event_id,contract_version,evidence_digest,package_id,package_version,claim_id,monitored_action_id,action_type_code,action_type_schema_version,target_kind,target_id,execution_outcome,mutation_result,execution_recorded_at,execution_state,outcome_state,outcome_state_reason,correlation_id)
   VALUES ($1,$2,$3,$4,$5,'execution-evidence/1',$6,$7,1,$8,$9,'c','1','k','t','SUCCEEDED',$10,date_trunc('milliseconds', now()),'EXECUTION_VERIFIED',$11,'omo',$12) RETURNING id`,
  [w.ctx.tenantId, w.ctx.workspaceId, w.bizId, v.executionId, randomUUID(), DIGEST, randomUUID(), randomUUID(), v.monitoredActionId, v.mutationResult ?? 'APPLIED', v.outcomeState, randomUUID()]));

/** The execution notification BO emits, as the outbox holds it (reference only). */
async function announce(w: World, executionId: string, status: string, over: { eventType?: string; businessId?: string } = {}): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `INSERT INTO events.outbox_events (id, event_type, event_version, tenant_id, workspace_id, business_id, correlation_id, aggregate_type, aggregate_id, payload, status, attempt_count, occurred_at)
     VALUES ($1,$2,'1',$3,$4,$5,$6,'authorized_action_execution',$7,$8::jsonb,$9,$10, now() - interval '2 minutes')`,
    [id, over.eventType ?? EVENT, w.ctx.tenantId, w.ctx.workspaceId, over.businessId ?? w.bizId, randomUUID(), randomUUID(), JSON.stringify({ executionId, secretLookingField: 'must-not-be-returned' }), status, status === 'pending' ? 0 : 1]);
  return id;
}
async function subscription(w: World): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `INSERT INTO events.event_subscriptions (id, subscriber_name, event_pattern, destination_type, destination_ref, status, tenant_id, workspace_id)
     VALUES ($1,$2,$3,'in_process',$4,'active',$5,$6)`, [id, uc('omo-sub'), EVENT, CONSUMER, w.ctx.tenantId, w.ctx.workspaceId]);
  return id;
}

const COUNTED = [
  `${OM}.action_execution_verifications`, `${OM}.outcome_observations`, `${OM}.monitored_actions`, `${OM}.learning_feedback_packages`, `${OM}.om_publication_packages`,
  'continuous_learning.cl_intake_packages', 'events.outbox_events', 'events.dead_letter_events', 'events.event_delivery_attempts', 'events.inbox_events', 'audit.audit_events',
];
async function counts(w: World): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of COUNTED) out[t] = Number((await admin.query(`SELECT count(*)::int n FROM ${t} WHERE tenant_id = $1`, [w.ctx.tenantId])).rows[0].n);
  return out;
}

describe.runIf(run)('OM-OBS-1 outcome monitoring health API - live PostgreSQL + Fastify', () => {
  let a: World; let b: World;
  let monitoredActionId: string;
  let deadLetterId: string;

  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    await app.ready();
    a = await world(); b = await world();
  });
  afterAll(async () => { await app?.close(); await admin?.end(); await closePool(); });

  it('a business with no Outcome Monitoring facts is OK with zero counts and states what the view cannot tell', async () => {
    const r = await omHealth(a);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      businessId: a.bizId, scope: 'OUTCOME_MONITORING', status: 'OK', attention: [],
      executionHealth: { included: false, see: `/v1/businesses/${a.bizId}/execution-health` },
      verification: { total: 0, awaitingOutcome: 0, inconclusive: 0, unsupportedStateRows: 0, verifiedOutcomes: { supported: false, rows: 0 }, lastVerifiedAt: null },
      missingEvidence: { monitoredActionsWithoutVerification: 0, verificationsWithoutMonitoredAction: 0, announcedNotVerified: 0 },
      announcedExecutions: { total: 0, pending: [] }, failedVerificationAttempts: { total: 0, inWindow: 0, byCode: [] }, deadLetters: { pending: 0, items: [] },
    });
    expect(r.json().limitations.length).toBeGreaterThan(0);
  });

  it('verified-but-unproven executions: PENDING and INCONCLUSIVE are counted separately, linked to the monitored action, and are not an alarm', async () => {
    monitoredActionId = await createMonitoredAction({ ...a.ctx, userId: a.adminId }, a.bizId);
    await new OutcomeObservationRepository().createObservation(a.ctx, a.bizId, monitoredActionId, uc('obs'), 'omo observation', new Date());
    const verified = randomUUID();
    await verification(a, { executionId: verified, outcomeState: 'OUTCOME_PENDING', monitoredActionId });
    await verification(a, { executionId: randomUUID(), outcomeState: 'OUTCOME_INCONCLUSIVE', mutationResult: 'NO_CHANGE', monitoredActionId });
    await verification(a, { executionId: randomUUID(), outcomeState: 'OUTCOME_PENDING', monitoredActionId: null });
    await announce(a, verified, 'published');                      // announced and OM holds its verification: healthy
    const v = (await omHealth(a)).json();
    expect(v.status).toBe('OK');
    expect(v.verification).toMatchObject({ total: 3, executionVerified: 3, awaitingOutcome: 2, inconclusive: 1, unsupportedStateRows: 0, byExecutionOutcome: { SUCCEEDED: 3 }, verifiedOutcomes: { supported: false, rows: 0 } });
    expect(v.verification.lastVerifiedAt).toEqual(expect.any(String));
    expect(v.missingEvidence).toMatchObject({ verificationsWithoutMonitoredAction: 1, monitoredActionsWithoutVerification: 0, announcedNotVerified: 0 });
    expect(v.announcedExecutions).toMatchObject({ total: 1, verified: 1, awaitingDelivery: 0, deadLettered: 0, deliveredNotVerified: 0 });
    expect(v.observationRecords.byStatus).toEqual({ draft: 1 });          // a record, never reported as a verified outcome
  });

  it('missing evidence: an open monitored action with no verification, and executions announced but not verified, are classified by what became of them', async () => {
    const lone = await createMonitoredAction({ ...a.ctx, userId: a.adminId }, a.bizId);
    expect(lone).not.toBe(monitoredActionId);
    const sub = await subscription(a);
    const pendingExec = randomUUID(); const publishedExec = randomUUID(); const deadExec = randomUUID();
    await announce(a, pendingExec, 'pending');
    await announce(a, publishedExec, 'published');                 // delivered, yet OM holds nothing for it: an anomaly
    const deadEvent = await announce(a, deadExec, 'processing');
    await new EventDeliveryAttemptRepository().record(a.ctx, {
      outboxEventId: deadEvent, attemptNumber: 1, status: 'failed', attemptedAt: new Date(Date.now() - 2000), completedAt: new Date(Date.now() - 1000), latencyMs: 1000,
      subscriptionId: sub, consumerName: 'ignored-by-view', workerId: 'w', failure: { code: 'EVIDENCE_INVALID', message: 'secret free text that must never be returned', retryable: false, occurredAt: new Date().toISOString() },
    });
    deadLetterId = await new DeadLetterRepository().createFromOutbox(a.ctx, deadEvent, { code: 'EVIDENCE_INVALID', message: 'secret free text that must never be returned', retryable: false, occurredAt: new Date().toISOString() });

    const r = await omHealth(a);
    const v = r.json();
    expect(v.status).toBe('ATTENTION');
    expect(v.attention).toEqual(['DEAD_LETTERS_PENDING', 'DELIVERED_NOT_VERIFIED', 'VERIFICATION_ATTEMPT_FAILURES_IN_WINDOW']);
    expect(v.missingEvidence).toMatchObject({ monitoredActionsWithoutVerification: 1, announcedNotVerified: 3 });
    expect(v.announcedExecutions).toMatchObject({ total: 4, verified: 1, awaitingDelivery: 1, deadLettered: 1, deliveredNotVerified: 1, truncated: false });
    expect(v.announcedExecutions.oldestAwaitingAgeSeconds).toBeGreaterThanOrEqual(100);
    expect(v.announcedExecutions.pending.map((p: any) => [p.executionId, p.class]).sort()).toEqual([[deadExec, 'DEAD_LETTERED'], [pendingExec, 'AWAITING_DELIVERY'], [publishedExec, 'DELIVERED_NOT_VERIFIED']].sort());
    expect(v.failedVerificationAttempts).toMatchObject({ total: 1, inWindow: 1, byCode: [{ failureCode: 'EVIDENCE_INVALID', status: 'failed', total: 1, inWindow: 1 }] });
    expect(v.deadLetters).toMatchObject({ pending: 1, replayed: 0, abandoned: 0, byCode: [{ code: 'EVIDENCE_INVALID', total: 1, pending: 1 }], truncated: false });
    expect(v.deadLetters.items).toEqual([expect.objectContaining({ id: deadLetterId, originalEventId: deadEvent, executionId: deadExec, code: 'EVIDENCE_INVALID', retryable: false, attempts: 1 })]);
    // no stored event body, no free-text failure message, no internal column or table name leaves the API
    const body = r.body;
    for (const forbidden of ['secret free text', 'must-not-be-returned', 'secretLookingField', 'original_event', 'failure_message', 'outbox_events', 'event_delivery_attempts', 'payload']) expect(body).not.toContain(forbidden);
  });

  it('events for another business or another event type do not count', async () => {
    const before = (await omHealth(a)).json().announcedExecutions.total;
    await announce(a, randomUUID(), 'pending', { eventType: 'operations.something.else' });
    const sibling = randomUUID();
    await admin.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'OMO Sibling',$4,'active')`, [sibling, a.ctx.tenantId, a.ctx.workspaceId, uc('omos')]);
    await announce(a, randomUUID(), 'pending', { businessId: sibling });
    // dead letters of another event type, and of a sibling business, are not this business's Outcome Monitoring dead letters
    const failure = { code: 'OTHER', message: 'x', retryable: false, occurredAt: new Date().toISOString() };
    const dl = new DeadLetterRepository();
    await dl.createFromOutbox(a.ctx, await announce(a, randomUUID(), 'processing', { eventType: 'operations.something.else' }), failure);
    await dl.createFromOutbox(a.ctx, await announce(a, randomUUID(), 'processing', { businessId: sibling }), failure);
    const after = (await omHealth(a)).json();
    expect(after.announcedExecutions.total).toBe(before);
    expect(after.deadLetters).toMatchObject({ pending: 1, byCode: [{ code: 'EVIDENCE_INVALID', total: 1, pending: 1 }] });
    expect((await omHealth(a, { bizId: sibling })).json().announcedExecutions).toMatchObject({ total: 2, awaitingDelivery: 1, deadLettered: 1 });
    expect((await omHealth(a, { bizId: sibling })).json().deadLetters).toMatchObject({ pending: 1, byCode: [{ code: 'OTHER' }] });
  });

  it('authorization: bo:admin only. Unauthenticated is 401; a member without bo:admin is 403; an admin reads', async () => {
    expect((await app.inject({ method: 'GET', url: `/v1/businesses/${a.bizId}/outcome-monitoring-health` })).statusCode).toBe(401);
    const denied = await omHealth(a, { token: a.memberToken });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).not.toContain('executionId');
    expect((await omHealth(a)).statusCode).toBe(200);
  });

  it('tenant isolation: another tenant admin gets the same 404 for a foreign business as for one that does not exist, and sees none of its data', async () => {
    const missingId = randomUUID();
    const foreign = await omHealth(b, { bizId: a.bizId });
    const missing = await omHealth(b, { bizId: missingId });
    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    // identical apart from the per-request correlation id and the id the caller itself asked for (echoed back, which reveals nothing it did not send)
    const shape = (res: { body: string }, asked: string) => JSON.parse(res.body.split(asked).join('<asked>').replace(/"correlationId":"[^"]+"/, '"correlationId":"<c>"'));
    expect(shape(foreign, a.bizId)).toEqual(shape(missing, missingId));
    // B's own business has none of A's facts, even though A's rows exist in the same tables
    const own = (await omHealth(b)).json();
    expect(own).toMatchObject({ status: 'OK', verification: { total: 0 }, announcedExecutions: { total: 0 }, deadLetters: { pending: 0 }, failedVerificationAttempts: { total: 0 } });
    // a token of A against B's scope headers is refused by the existing tenancy checks (not a data path)
    const crossed = await app.inject({ method: 'GET', url: `/v1/businesses/${a.bizId}/outcome-monitoring-health`, headers: hdr(b, a.adminToken) });
    expect([401, 403, 404]).toContain(crossed.statusCode);
  });

  it('a malformed business id is a validation error, not a database error', async () => {
    const r = await app.inject({ method: 'GET', url: `/v1/businesses/not-a-uuid/outcome-monitoring-health`, headers: hdr(a, a.adminToken) });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.statusCode).toBeLessThan(500);
  });

  it('reading writes nothing and emits nothing: no verification, observation, feedback, publication, intake, outbox, dead-letter, attempt, inbox or audit row changes', async () => {
    const before = await counts(a);
    for (let i = 0; i < 3; i += 1) expect((await omHealth(a)).statusCode).toBe(200);
    expect((await omHealth(b, { bizId: a.bizId })).statusCode).toBe(404);
    expect((await omHealth(a, { token: a.memberToken })).statusCode).toBe(403);
    expect(await counts(a)).toEqual(before);
    const dl = await admin.query(`SELECT replay_status, approved_by, replay_event_id FROM events.dead_letter_events WHERE id = $1`, [deadLetterId]);
    expect(dl.rows[0]).toEqual({ replay_status: 'pending', approved_by: null, replay_event_id: null });   // listed, never replayed
    const outbox = await admin.query(`SELECT status FROM events.outbox_events WHERE tenant_id = $1 AND status = 'pending'`, [a.ctx.tenantId]);
    expect(outbox.rowCount).toBeGreaterThan(0);                                                           // the pending notification was not delivered or touched
  });

  it('the learning gate is untouched: viewing health creates no learning, feedback or Control Loop record', async () => {
    const q = async (t: string) => Number((await admin.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n);
    const tables = [`${OM}.learning_feedback_packages`, `${OM}.om_publication_packages`, 'continuous_learning.cl_intake_packages'];
    const before = await Promise.all(tables.map(q));
    await omHealth(a); await omHealth(a);
    expect(await Promise.all(tables.map(q))).toEqual(before);
  });

  it('execution health (L-OBS-1) is unchanged and separate: same business, its own shape, none of the Outcome Monitoring fields', async () => {
    const r = await execHealth(a);
    expect(r.statusCode).toBe(200);
    const v = r.json();
    expect(v).toMatchObject({ businessId: a.bizId, status: 'OK', claims: { open: 0 }, executions: { succeeded: 0, failed: 0, refused: 0 } });
    for (const key of ['verification', 'deadLetters', 'announcedExecutions', 'missingEvidence', 'scope']) expect(v).not.toHaveProperty(key);
    expect((await omHealth(a)).json()).not.toHaveProperty('claims');
    expect((await execHealth(b)).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/v1/businesses/${a.bizId}/execution-health`, headers: hdr(a, a.memberToken) })).statusCode).toBe(403);
  });
});
