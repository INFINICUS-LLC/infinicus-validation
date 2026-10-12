/**
 * P0-6b - end-to-end proof of the ABA -> BO notification pipeline with REAL components on real PostgreSQL:
 * ABA issuer -> announcer (gated) -> outbox -> dispatcher/worker -> ledger -> subscription -> BO consumer -> pull via ABA source port ->
 * existing BO intake (authoritative status from the ABA provider) -> single-use claim -> ABA CONSUMED mirror.
 *
 * Nothing is executed and no inventory changes: the pipeline ends at claim + mirror. The production capability registry stays empty; tests
 * inject their own registry and gate. Requires DATABASE_URL (app role, RLS) and ADMIN_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { AuthorizedActionPackageRepository, EventSubscriptionRepository, closePool, createPool } from '@infinicus/database';
import { ACTION_AUTHORIZED_CONSUMER, ACTION_AUTHORIZED_EVENT_TYPE } from '@infinicus/event-contracts';
import { DENY_ALL_EXECUTION_GATE } from '@infinicus/handoff-contracts';
import type { ExecutionCapabilityGate } from '@infinicus/handoff-contracts';
import { explicitCapabilities } from '@infinicus/business-operations-runtime';
import { ActionAuthorizedAnnouncer, AuthorizedActionPackageIssuer } from '@infinicus/workflow';
import { G, HOUR, S, iso, makeIssuable, makeWorld, type IssuableFixture } from '../../workflow/tests/helpers/issuanceFixture.js';
import { buildEventWorker } from '../src/index.js';
import type { ScopeDiscovery } from '../src/index.js';

const run = Boolean(process.env.DATABASE_URL && process.env.ADMIN_DATABASE_URL);
const ACTOR = randomUUID();
const SUPPORTED = explicitCapabilities(['inventory_reorder_policy_update@1']);
const OPEN = G({ startsAt: iso(new Date(Date.now() - HOUR)), endsAt: iso(new Date(Date.now() + 8 * HOUR)) });

describe.runIf(run)('P0-6b: ACTION_AUTHORIZED pipeline (real components)', () => {
  let admin: Pool;
  const packages = new AuthorizedActionPackageRepository();
  const subscriptions = new EventSubscriptionRepository();

  const gateFor = (open: boolean): ExecutionCapabilityGate => ({ isEnabled: async () => open });
  const issuer = (gate: ExecutionCapabilityGate) => new AuthorizedActionPackageIssuer({ announcer: new ActionAuthorizedAnnouncer({ gate }) });
  const only = (f: IssuableFixture): ScopeDiscovery => ({ discover: async () => [{ tenantId: f.world.tenantId, workspaceId: f.world.workspaceId }] });
  const worker = (f: IssuableFixture, over: { gate?: ExecutionCapabilityGate; capabilities?: typeof SUPPORTED; clock?: () => Date } = {}) => buildEventWorker({
    config: { workerId: 'w-e2e', actorUserId: ACTOR, discoveryDatabaseUrl: 'unused', intakeStatusMaxAgeMs: 5000, claimTimeoutMs: 60_000, batchSize: 10, maxScopesPerCycle: 5, pollIntervalMs: 1000 },
    discovery: only(f), gate: over.gate ?? gateFor(true), capabilities: over.capabilities ?? SUPPORTED, ...(over.clock ? { clock: over.clock } : {}),
  });
  const subscribe = (f: IssuableFixture) => subscriptions.create(f.ctx, {
    subscriberName: `${ACTION_AUTHORIZED_CONSUMER}@${f.world.workspaceId}`, eventPattern: ACTION_AUTHORIZED_EVENT_TYPE, destinationType: 'in_process',
    destinationReference: ACTION_AUTHORIZED_CONSUMER, supportedVersions: ['1'], retryPolicy: { maxAttempts: 3, backoffSeconds: [1, 5, 15] },
  });
  const issued = async (gate: ExecutionCapabilityGate = gateFor(true), over: Parameters<typeof makeIssuable>[2] = {}) => {
    const f = await makeIssuable(admin, await makeWorld(admin), { window: OPEN, ...over });
    const r = await issuer(gate).issue(f.ctx, { actionId: f.actionId });
    return { f, r, packageId: r.package.identity.packageId };
  };
  const outboxRows = async (f: IssuableFixture) => (await admin.query('SELECT * FROM events.outbox_events WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY created_at', [f.world.tenantId, f.world.workspaceId])).rows;
  const claims = async (f: IssuableFixture) => (await admin.query('SELECT * FROM business_operations.authorized_action_claims WHERE tenant_id=$1', [f.world.tenantId])).rows;
  const receipts = async (f: IssuableFixture) => (await admin.query('SELECT * FROM business_operations.authorized_action_receipts WHERE tenant_id=$1', [f.world.tenantId])).rows;
  const lifecycle = async (packageId: string) => (await admin.query(`SELECT state, consumption_receipt_id FROM ${S}.authorized_action_package_lifecycle_events WHERE package_id=$1 ORDER BY created_at`, [packageId])).rows;
  const dead = async (f: IssuableFixture) => (await admin.query('SELECT * FROM events.dead_letter_events WHERE tenant_id=$1', [f.world.tenantId])).rows;
  const inbox = async (f: IssuableFixture) => (await admin.query('SELECT status FROM events.inbox_events WHERE tenant_id=$1', [f.world.tenantId])).rows;

  beforeAll(() => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    createPool({ connectionString: process.env.DATABASE_URL as string });
  });
  afterAll(async () => { await admin?.end(); await closePool(); });

  it('happy path: issuance announces; the worker delivers; BO receives, claims once; ABA mirrors CONSUMED with the BO receipt; nothing else happens', async () => {
    const { f, r, packageId } = await issued();
    await subscribe(f);
    const rows = await outboxRows(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_type: ACTION_AUTHORIZED_EVENT_TYPE, status: 'pending', aggregate_id: packageId });
    // reference-only: the outbox payload carries no package body
    expect(Object.keys(rows[0].payload).sort()).toEqual(['actionType', 'automationLevel', 'decisionId', 'digest', 'expiresAt', 'issuedAt', 'packageId', 'packageVersion', 'scope']);
    expect(JSON.stringify(rows[0].payload)).not.toContain('reorderPoint');

    const summary = await worker(f).runOnce();
    expect(summary).toMatchObject({ scopes: 1, claimed: 1, published: 1, deadLettered: 0, scopeErrors: 0 });

    const c = await claims(f);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ package_id: packageId, package_version: 1 });
    const rc = await receipts(f);
    expect(rc).toHaveLength(1);
    expect(rc[0].digest).toBe(r.package.integrity.digest);
    expect(await lifecycle(packageId)).toEqual([{ state: 'ISSUED', consumption_receipt_id: null }, { state: 'CONSUMED', consumption_receipt_id: rc[0].id }]);
    expect((await outboxRows(f))[0].status).toBe('published');
    expect(await inbox(f)).toEqual([{ status: 'processed' }]);
    expect(Number((await admin.query('SELECT count(*) n FROM events.business_event_ledger WHERE tenant_id=$1', [f.world.tenantId])).rows[0].n)).toBe(1);
    // the pipeline stops at claim: no inventory balance or movement exists in this scope
    expect(Number((await admin.query('SELECT count(*) n FROM business_operations.inventory_movements WHERE tenant_id=$1', [f.world.tenantId])).rows[0].n)).toBe(0);
    expect(Number((await admin.query('SELECT count(*) n FROM business_operations.inventory_balances WHERE tenant_id=$1', [f.world.tenantId])).rows[0].n)).toBe(0);
  });

  it('a second worker pass is a no-op: one receipt, one claim, one mirror', async () => {
    const { f, packageId } = await issued();
    await subscribe(f);
    await worker(f).runOnce();
    const again = await worker(f).runOnce();
    expect(again).toMatchObject({ claimed: 0, published: 0 });
    expect(await claims(f)).toHaveLength(1);
    expect(await receipts(f)).toHaveLength(1);
    expect((await lifecycle(packageId)).filter((e) => e.state === 'CONSUMED')).toHaveLength(1);
  });

  it('re-issuing the identical package is idempotent: the announcement id is deterministic, so no second notification row', async () => {
    const f = await makeIssuable(admin, await makeWorld(admin), { window: OPEN });
    const gate = gateFor(true);
    const first = await issuer(gate).issue(f.ctx, { actionId: f.actionId });
    const replay = await issuer(gate).issue(f.ctx, { actionId: f.actionId });
    expect([first.outcome, replay.outcome]).toEqual(['ISSUED', 'REPLAYED']);
    expect(await outboxRows(f)).toHaveLength(1);
  });

  it('a failed announcement refuses and rolls back the whole issuance: no package version, no audit, no outbox row', async () => {
    const f = await makeIssuable(admin, await makeWorld(admin), { window: OPEN });
    const broken = new AuthorizedActionPackageIssuer({ announcer: { announce: async () => { throw new Error('outbox down'); } } });
    await expect(broken.issue(f.ctx, { actionId: f.actionId })).rejects.toMatchObject({ codes: ['ANNOUNCEMENT_FAILED'] });
    expect(Number((await admin.query(`SELECT count(*) n FROM ${S}.authorized_action_package_versions WHERE business_id=$1`, [f.businessId])).rows[0].n)).toBe(0);
    expect(Number((await admin.query(`SELECT count(*) n FROM ${S}.approval_audit_events WHERE business_id=$1 AND event_type='package.issued'`, [f.businessId])).rows[0].n)).toBe(0);
    expect(await outboxRows(f)).toHaveLength(0);
  });

  it('gate CLOSED at the producer: nothing is announced, the package stays ISSUED; a later identical issue request announces it once the gate opens', async () => {
    const f = await makeIssuable(admin, await makeWorld(admin), { window: OPEN });
    const closed = await issuer(DENY_ALL_EXECUTION_GATE).issue(f.ctx, { actionId: f.actionId });
    expect(closed.outcome).toBe('ISSUED');
    expect(await outboxRows(f)).toHaveLength(0);
    expect((await packages.getAuthoritativeStatus(f.ctx, closed.package.identity.packageId, 1))?.lifecycle).toBe('ISSUED');
    await subscribe(f);
    expect(await worker(f).runOnce()).toMatchObject({ claimed: 0 });

    const reopened = await issuer(gateFor(true)).issue(f.ctx, { actionId: f.actionId });
    expect(reopened.outcome).toBe('REPLAYED');
    expect(await outboxRows(f)).toHaveLength(1);
    expect(await worker(f).runOnce()).toMatchObject({ claimed: 1, published: 1 });
    expect(await claims(f)).toHaveLength(1);
  });

  it('the default issuer (no announcer) and a default-built worker (deny-all gate, empty production registry) do nothing', async () => {
    const f = await makeIssuable(admin, await makeWorld(admin), { window: OPEN });
    await new AuthorizedActionPackageIssuer().issue(f.ctx, { actionId: f.actionId });
    expect(await outboxRows(f)).toHaveLength(0);

    const g = await issued(gateFor(true)); await subscribe(g.f);
    const w = buildEventWorker({
      config: { workerId: 'w-default', actorUserId: ACTOR, discoveryDatabaseUrl: 'unused', intakeStatusMaxAgeMs: 5000, claimTimeoutMs: 60_000, batchSize: 10, maxScopesPerCycle: 5, pollIntervalMs: 1000 },
      discovery: only(g.f),
    });
    expect(await w.runOnce()).toMatchObject({ claimed: 1, deadLettered: 1, published: 0 });
    expect(JSON.parse((await dead(g.f))[0].failure_reason).code).toBe('CAPABILITY_DISABLED');
    expect(await claims(g.f)).toHaveLength(0);
    expect(await receipts(g.f)).toHaveLength(0);
    expect(await inbox(g.f)).toHaveLength(0);
  });

  it('gate closed at the consumer: dead letter CAPABILITY_DISABLED, no receipt, claim, inbox or mirror (a replay needs governed approval)', async () => {
    const { f, packageId } = await issued();
    await subscribe(f);
    expect(await worker(f, { gate: gateFor(false) }).runOnce()).toMatchObject({ deadLettered: 1 });
    expect(JSON.parse((await dead(f))[0].failure_reason).code).toBe('CAPABILITY_DISABLED');
    expect(await receipts(f)).toHaveLength(0);
    expect(await claims(f)).toHaveLength(0);
    expect((await lifecycle(packageId)).map((e) => e.state)).toEqual(['ISSUED']);
  });

  it('a gate that throws is a closed gate (producer and consumer)', async () => {
    const boom: ExecutionCapabilityGate = { isEnabled: async () => { throw new Error('gate down'); } };
    const f = await makeIssuable(admin, await makeWorld(admin), { window: OPEN });
    await issuer(boom).issue(f.ctx, { actionId: f.actionId });
    expect(await outboxRows(f)).toHaveLength(0);
    const { f: g } = await issued(); await subscribe(g);
    expect(await worker(g, { gate: boom }).runOnce()).toMatchObject({ deadLettered: 1 });
  });

  it('no subscription row = no delivery: the event is ledgered and published, BO never hears of it', async () => {
    const { f, packageId } = await issued();
    expect(await worker(f).runOnce()).toMatchObject({ claimed: 1, published: 1 });
    expect(await claims(f)).toHaveLength(0);
    expect((await lifecycle(packageId)).map((e) => e.state)).toEqual(['ISSUED']);
  });

  it('authority revoked after issuance: BO intake refuses (final outcome), no claim, no mirror; the notification is handled, not retried', async () => {
    const { f, packageId } = await issued();
    await subscribe(f);
    const c = await admin.connect();
    try {
      await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'");
      await c.query(`UPDATE ${S}.approver_assignments SET status='revoked' WHERE id=$1`, [f.assignmentId]);
      await c.query('COMMIT');
    } finally { c.release(); }
    expect(await worker(f).runOnce()).toMatchObject({ claimed: 1, published: 1, deadLettered: 0 });
    expect(await claims(f)).toHaveLength(0);
    const attempt = (await admin.query('SELECT outcome, refusal_codes FROM business_operations.authorized_action_intake_attempts WHERE tenant_id=$1', [f.world.tenantId])).rows;
    expect(attempt).toHaveLength(1);
    expect(attempt[0].outcome).toBe('REFUSED');
    expect(attempt[0].refusal_codes).toContain('AUTHORITY_REVOKED');
    expect((await lifecycle(packageId)).map((e) => e.state)).toEqual(['ISSUED']);
    expect(await inbox(f)).toEqual([{ status: 'processed' }]);
  });

  it('a revoked package is refused at BO intake and never claimed', async () => {
    const { f, packageId } = await issued();
    await subscribe(f);
    await packages.revoke(f.ctx, packageId, 1, { actorUserId: f.approverUserId, reason: 'withdrawn', correlationId: randomUUID() });
    expect(await worker(f).runOnce()).toMatchObject({ published: 1 });
    expect(await claims(f)).toHaveLength(0);
  });

  it('an action type BO cannot execute (production registry) is received-and-refused, never claimed', async () => {
    const { f } = await issued(); await subscribe(f);
    await worker(f, { capabilities: explicitCapabilities([]) }).runOnce();
    expect(await claims(f)).toHaveLength(0);
    const attempt = (await admin.query('SELECT refusal_codes FROM business_operations.authorized_action_intake_attempts WHERE tenant_id=$1', [f.world.tenantId])).rows;
    expect(attempt[0].refusal_codes).toContain('ACTION_TYPE_UNSUPPORTED_BY_EXECUTOR');
  });

  it('the notification becomes dispatchable only when the execution window opens', async () => {
    const future = G({ startsAt: iso(new Date(Date.now() + 2 * HOUR)), endsAt: iso(new Date(Date.now() + 8 * HOUR)) });
    const { f } = await issued(gateFor(true), { window: future });
    const [r] = await outboxRows(f);
    expect(new Date(r.available_at).getTime()).toBeGreaterThan(Date.now() + HOUR);
    await subscribe(f);
    expect(await worker(f).runOnce()).toMatchObject({ claimed: 0 });
    expect(await claims(f)).toHaveLength(0);
  });

  it('a pull that returns a different package than the event names is refused (no claim)', async () => {
    const a = await issued(); const b = await issued();
    await subscribe(a.f);
    // point A's notification at B's package id (an attacker-shaped event): the scope differs, so the pull yields nothing and BO claims nothing
    await admin.query(`UPDATE events.outbox_events SET payload = jsonb_set(payload, '{packageId}', to_jsonb($2::text)) WHERE tenant_id=$1`, [a.f.world.tenantId, b.packageId]);
    expect(await worker(a.f).runOnce()).toMatchObject({ claimed: 1, retryScheduled: 1, published: 0 });
    expect(await claims(a.f)).toHaveLength(0);
    expect(await claims(b.f)).toHaveLength(0);
  });
});
