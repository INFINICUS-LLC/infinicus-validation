/**
 * P0-6b - live PostgreSQL proof of the outbox dispatcher (delivery, ledger, subscriptions, retry/backoff, dead letter, claim recovery).
 * Requires DATABASE_URL (app role, RLS) and ADMIN_DATABASE_URL (fixtures / inspection).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  DeliveryError, EventLedgerRepository, EventSubscriptionRepository, InboxRepository, OutboxDispatcher, OutboxRepository, closePool, createPool, withTenantTransaction,
} from '@infinicus/database';
import type { EventConsumer, StoredBusinessEvent, TenantContext } from '@infinicus/database';
import { BusinessEventContractRegistry } from '@infinicus/event-contracts';
import type { BusinessEventEnvelope } from '@infinicus/event-contracts';
import { makeWorld } from '../../workflow/tests/helpers/issuanceFixture.js';

const run = Boolean(process.env.DATABASE_URL && process.env.ADMIN_DATABASE_URL);
const TYPE = 'control_loop.test.pinged';
const OTHER_TYPE = 'control_loop.test.other';
const NOW = new Date('2026-10-12T10:00:00.000Z');

describe.runIf(run)('P0-6b: OutboxDispatcher', () => {
  let admin: Pool;
  const outbox = new OutboxRepository();
  const subscriptions = new EventSubscriptionRepository();
  const ledger = new EventLedgerRepository();

  const contracts = (): BusinessEventContractRegistry => {
    const r = new BusinessEventContractRegistry();
    for (const eventType of [TYPE, OTHER_TYPE]) {
      r.register({
        eventType, eventVersion: '1', schemaName: eventType, schemaVersion: '1', ownerDomain: 'control_loop', producer: 'test', supportedConsumers: ['test.consumer'],
        sensitivity: 'internal', status: 'active', effectiveFrom: '2026-01-01T00:00:00.000Z', deprecatedAt: null, compatibilityAliases: [],
        validatePayload: (p): p is { n: number } => typeof p === 'object' && p !== null && typeof (p as { n?: unknown }).n === 'number',
      });
    }
    return r;
  };

  interface Scope { ctx: TenantContext; businessId: string }
  async function scope(): Promise<Scope> {
    const w = await makeWorld(admin);
    const businessId = randomUUID();
    const code = `b${businessId.slice(0, 8)}`;
    await admin.query('INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code) VALUES ($1,$2,$3,$4,$5)', [businessId, w.tenantId, w.workspaceId, code, code]);
    return { ctx: { tenantId: w.tenantId, workspaceId: w.workspaceId, userId: randomUUID() }, businessId };
  }
  const event = (s: Scope, over: Partial<BusinessEventEnvelope> = {}): BusinessEventEnvelope => {
    const eventId = randomUUID();
    return {
      eventId, eventType: TYPE, eventVersion: '1', tenantId: s.ctx.tenantId, workspaceId: s.ctx.workspaceId, businessId: s.businessId, sourceDomain: 'control_loop',
      sourceService: 'test.producer', aggregateType: 'thing', aggregateId: randomUUID(), correlationId: randomUUID(), causationId: null, occurredAt: NOW.toISOString(),
      recordedAt: NOW.toISOString(), actor: { actorType: 'system', actorId: 'test' }, idempotencyKey: `k:${eventId}`, payload: { n: 1 }, metadata: {},
      provenance: { evidenceClass: 'ACTUAL', sourceSystem: 'test' }, schemaName: TYPE, schemaVersion: '1', sensitivity: 'internal', ...over,
    };
  };
  const subscribe = (s: Scope, ref = 'test.consumer', retryPolicy: Record<string, unknown> = { maxAttempts: 3, backoffSeconds: [1, 5, 15] }, over: Record<string, unknown> = {}) =>
    subscriptions.create(s.ctx, { subscriberName: `${ref}@${s.ctx.workspaceId}`, eventPattern: TYPE, destinationType: 'in_process', destinationReference: ref, supportedVersions: ['1'], retryPolicy, ...over });
  const row = async (id: string) => (await admin.query('SELECT * FROM events.outbox_events WHERE id=$1', [id])).rows[0];
  const dead = async (id: string) => (await admin.query('SELECT * FROM events.dead_letter_events WHERE original_event_id=$1', [id])).rows;
  const attempts = async (id: string) => (await admin.query('SELECT * FROM events.event_delivery_attempts WHERE outbox_event_id=$1 ORDER BY attempt_number, attempted_at', [id])).rows;

  let clockNow = NOW;
  const dispatcher = (consumers: Record<string, EventConsumer>, over: Record<string, unknown> = {}) => new OutboxDispatcher({
    contracts: contracts(), eventTypes: [TYPE], consumers: new Map(Object.entries(consumers)), workerId: 'w-test', claimTimeoutMs: 60_000, clock: () => clockNow, ...over,
  });
  const ok: EventConsumer = { handle: async () => undefined };

  beforeAll(() => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    createPool({ connectionString: process.env.DATABASE_URL as string });
  });
  afterAll(async () => { await admin?.end(); await closePool(); });

  it('delivers to a matching subscription, appends to the immutable ledger, records the attempt and publishes', async () => {
    clockNow = NOW;
    const s = await scope(); await subscribe(s);
    const e = event(s); await outbox.enqueue(s.ctx, { event: e, availableAt: NOW });
    const got: StoredBusinessEvent[] = [];
    const summary = await dispatcher({ 'test.consumer': { handle: async (_c, ev) => { got.push(ev); } } }).dispatchScope(s.ctx, { batchSize: 10 });
    expect(summary).toEqual({ recovered: 0, claimed: 1, published: 1, retryScheduled: 0, deadLettered: 0 });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ eventId: e.eventId, eventType: TYPE, tenantId: s.ctx.tenantId, payload: { n: 1 } });
    expect((await row(e.eventId)).status).toBe('published');
    expect(await ledger.findById(s.ctx, e.eventId)).toMatchObject({ eventId: e.eventId, idempotencyKey: e.idempotencyKey });
    const a = await attempts(e.eventId);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ status: 'succeeded', worker_id: 'w-test', attempt_number: 1 });
  });

  it('no subscription row = nothing is delivered, but the event is still ledgered and the outbox row published', async () => {
    clockNow = NOW;
    const s = await scope();
    const e = event(s); await outbox.enqueue(s.ctx, { event: e, availableAt: NOW });
    let called = 0;
    const r = await dispatcher({ 'test.consumer': { handle: async () => { called += 1; } } }).dispatchScope(s.ctx, { batchSize: 10 });
    expect(r.published).toBe(1);
    expect(called).toBe(0);
    expect((await ledger.findById(s.ctx, e.eventId)).eventId).toBe(e.eventId);
  });

  it('a paused subscription receives nothing', async () => {
    clockNow = NOW;
    const s = await scope(); const sub = await subscribe(s); await subscriptions.updateStatus(s.ctx, sub.id as string, 'paused');
    const e = event(s); await outbox.enqueue(s.ctx, { event: e, availableAt: NOW });
    let called = 0;
    await dispatcher({ 'test.consumer': { handle: async () => { called += 1; } } }).dispatchScope(s.ctx, { batchSize: 10 });
    expect(called).toBe(0);
  });

  it('retries a retryable failure with the subscription backoff (1s, 5s, 15s) and dead-letters when attempts are exhausted (O-3)', async () => {
    const s = await scope(); await subscribe(s);
    const e = event(s); await outbox.enqueue(s.ctx, { event: e, availableAt: NOW });
    let calls = 0;
    const failing: EventConsumer = { handle: async () => { calls += 1; throw new DeliveryError('TRY_LATER', 'not yet', true); } };

    clockNow = NOW;
    expect(await dispatcher({ 'test.consumer': failing }).dispatchScope(s.ctx, { batchSize: 10 })).toMatchObject({ claimed: 1, retryScheduled: 1, deadLettered: 0 });
    let r = await row(e.eventId);
    expect([r.status, r.attempt_count, new Date(r.available_at).getTime() - NOW.getTime()]).toEqual(['pending', 1, 1000]);

    // not yet due: nothing is claimed
    clockNow = new Date(NOW.getTime() + 500);
    expect((await dispatcher({ 'test.consumer': failing }).dispatchScope(s.ctx, { batchSize: 10 })).claimed).toBe(0);

    clockNow = new Date(NOW.getTime() + 1000);
    expect(await dispatcher({ 'test.consumer': failing }).dispatchScope(s.ctx, { batchSize: 10 })).toMatchObject({ claimed: 1, retryScheduled: 1 });
    r = await row(e.eventId);
    expect([r.attempt_count, new Date(r.available_at).getTime() - clockNow.getTime()]).toEqual([2, 5000]);

    clockNow = new Date(clockNow.getTime() + 5000);
    expect(await dispatcher({ 'test.consumer': failing }).dispatchScope(s.ctx, { batchSize: 10 })).toMatchObject({ claimed: 1, retryScheduled: 0, deadLettered: 1 });
    r = await row(e.eventId);
    expect([r.status, r.attempt_count]).toEqual(['dead_lettered', 3]);
    expect(calls).toBe(3);
    const d = await dead(e.eventId);
    expect(d).toHaveLength(1);
    expect(JSON.parse(d[0].failure_reason).code).toBe('RETRIES_EXHAUSTED:TRY_LATER');
    expect((await attempts(e.eventId)).map((a) => a.status)).toEqual(['failed', 'failed', 'failed']);
  });

  it('a non-retryable failure dead-letters at once; an unexpected error is treated as retryable', async () => {
    clockNow = NOW;
    const s = await scope(); await subscribe(s);
    const a = event(s); const b = event(s);
    await outbox.enqueue(s.ctx, { event: a, availableAt: NOW }); await outbox.enqueue(s.ctx, { event: b, availableAt: NOW });
    const consumer: EventConsumer = { handle: async (_c, ev) => { if (ev.eventId === a.eventId) throw new DeliveryError('FINAL', 'no', false); throw new Error('boom'); } };
    const r = await dispatcher({ 'test.consumer': consumer }).dispatchScope(s.ctx, { batchSize: 10 });
    expect(r).toMatchObject({ claimed: 2, deadLettered: 1, retryScheduled: 1 });
    expect((await row(a.eventId)).status).toBe('dead_lettered');
    expect((await row(b.eventId)).status).toBe('pending');
    expect(JSON.parse((await dead(a.eventId))[0].failure_reason).code).toBe('FINAL');
  });

  it('a matching subscription with no registered consumer is a non-retryable misconfiguration (dead letter)', async () => {
    clockNow = NOW;
    const s = await scope(); await subscribe(s, 'unregistered.consumer');
    const e = event(s); await outbox.enqueue(s.ctx, { event: e, availableAt: NOW });
    expect(await dispatcher({ 'test.consumer': ok }).dispatchScope(s.ctx, { batchSize: 10 })).toMatchObject({ deadLettered: 1 });
    expect(JSON.parse((await dead(e.eventId))[0].failure_reason).code).toBe('NO_CONSUMER_REGISTERED');
  });

  it('a contract-rejected event (invalid payload) is dead-lettered and reaches no consumer or ledger', async () => {
    clockNow = NOW;
    const s = await scope(); await subscribe(s);
    const e = event(s, { payload: { n: 'not-a-number' } }); await outbox.enqueue(s.ctx, { event: e, availableAt: NOW });
    let called = 0;
    expect(await dispatcher({ 'test.consumer': { handle: async () => { called += 1; } } }).dispatchScope(s.ctx, { batchSize: 10 })).toMatchObject({ deadLettered: 1, published: 0 });
    expect(called).toBe(0);
    await expect(ledger.findById(s.ctx, e.eventId)).rejects.toThrow();
    expect(JSON.parse((await dead(e.eventId))[0].failure_reason).code).toBe('CONTRACT_REJECTED');
  });

  it('only claims the configured event types: other rows (including legacy-shaped ones) are never touched', async () => {
    clockNow = NOW;
    const s = await scope(); await subscribe(s);
    const other = event(s, { eventType: OTHER_TYPE, schemaName: OTHER_TYPE }); await outbox.enqueue(s.ctx, { event: other, availableAt: NOW });
    await withTenantTransaction(s.ctx, (c) => c.query(
      `INSERT INTO events.outbox_events (event_type, event_version, tenant_id, workspace_id, correlation_id, aggregate_type, aggregate_id, payload)
       VALUES ('bo.inventory.movement_recorded','1.0',$1,$2,$3,'inventory_movement',$4,'{}')`, [s.ctx.tenantId, s.ctx.workspaceId, randomUUID(), randomUUID()]));
    const mine = event(s); await outbox.enqueue(s.ctx, { event: mine, availableAt: NOW });
    const r = await dispatcher({ 'test.consumer': ok }).dispatchScope(s.ctx, { batchSize: 10 });
    expect(r).toMatchObject({ claimed: 1, published: 1 });
    expect((await row(other.eventId)).status).toBe('pending');
    expect((await admin.query(`SELECT status FROM events.outbox_events WHERE tenant_id=$1 AND event_type='bo.inventory.movement_recorded'`, [s.ctx.tenantId])).rows[0].status).toBe('pending');
  });

  it('is scope-isolated: a dispatch for one tenant never claims or delivers another tenant\'s rows', async () => {
    clockNow = NOW;
    const a = await scope(); const b = await scope(); await subscribe(a); await subscribe(b);
    const ea = event(a); const eb = event(b);
    await outbox.enqueue(a.ctx, { event: ea, availableAt: NOW }); await outbox.enqueue(b.ctx, { event: eb, availableAt: NOW });
    const seen: string[] = [];
    await dispatcher({ 'test.consumer': { handle: async (c, ev) => { seen.push(`${c.tenantId}:${ev.eventId}`); } } }).dispatchScope(a.ctx, { batchSize: 10 });
    expect(seen).toEqual([`${a.ctx.tenantId}:${ea.eventId}`]);
    expect((await row(eb.eventId)).status).toBe('pending');
  });

  it('recovers a row abandoned in processing (worker crash) after the claim timeout, never before, and never a historic row without a claim time', async () => {
    const s = await scope(); await subscribe(s);
    const e = event(s); await outbox.enqueue(s.ctx, { event: e, availableAt: NOW });
    clockNow = NOW;
    // a first worker claims it and "crashes" (claim only; nothing else happens)
    expect(await outbox.claimBatch(s.ctx, { batchSize: 10, now: NOW, eventTypes: [TYPE] })).toHaveLength(1);
    expect((await row(e.eventId)).status).toBe('processing');

    clockNow = new Date(NOW.getTime() + 30_000); // inside the timeout: still owned by the first worker
    expect(await dispatcher({ 'test.consumer': ok }).dispatchScope(s.ctx, { batchSize: 10 })).toMatchObject({ recovered: 0, claimed: 0 });

    clockNow = new Date(NOW.getTime() + 61_000);
    expect(await dispatcher({ 'test.consumer': ok }).dispatchScope(s.ctx, { batchSize: 10 })).toMatchObject({ recovered: 1 });
    // recovered to the retry path and re-delivered in the same pass (claimed a second time)
    const recovered = await row(e.eventId);
    expect([recovered.status, recovered.attempt_count]).toEqual(['published', 2]);

    const historic = event(s); await outbox.enqueue(s.ctx, { event: historic, availableAt: NOW });
    await admin.query(`UPDATE events.outbox_events SET status='processing', claimed_at=NULL WHERE id=$1`, [historic.eventId]);
    clockNow = new Date(NOW.getTime() + 3_600_000);
    expect((await dispatcher({ 'test.consumer': ok }).dispatchScope(s.ctx, { batchSize: 10 })).recovered).toBe(0);
    expect((await row(historic.eventId)).status).toBe('processing');
  });

  it('a retry redelivers idempotently: the ledger keeps one row per event and the inbox dedupes the consumer', async () => {
    const s = await scope(); await subscribe(s);
    const e = event(s); await outbox.enqueue(s.ctx, { event: e, availableAt: NOW });
    const inbox = new InboxRepository();
    let effects = 0;
    let fail = true;
    const consumer: EventConsumer = {
      handle: async (c, ev) => {
        const b = await inbox.beginProcessing(c, { eventId: ev.eventId, consumerName: 'test.consumer', eventType: ev.eventType, payload: ev.payload });
        if (b.state === 'already_processed') return;
        effects += 1;
        if (fail) { await inbox.markFailed(c, ev.eventId, 'test.consumer', 'later'); throw new DeliveryError('LATER', 'later', true); }
        await inbox.markProcessed(c, ev.eventId, 'test.consumer');
      },
    };
    clockNow = NOW;
    await dispatcher({ 'test.consumer': consumer }).dispatchScope(s.ctx, { batchSize: 10 });
    fail = false;
    clockNow = new Date(NOW.getTime() + 1000);
    expect(await dispatcher({ 'test.consumer': consumer }).dispatchScope(s.ctx, { batchSize: 10 })).toMatchObject({ published: 1 });
    expect(effects).toBe(2);
    expect(Number((await admin.query('SELECT count(*) n FROM events.business_event_ledger WHERE event_id=$1', [e.eventId])).rows[0].n)).toBe(1);
    expect((await admin.query(`SELECT status FROM events.inbox_events WHERE event_id=$1`, [e.eventId])).rows[0].status).toBe('processed');
  });

  it('refuses to be built without explicit event types, a worker id or a claim timeout', () => {
    const base = { contracts: contracts(), consumers: new Map(), workerId: 'w', claimTimeoutMs: 1000 };
    expect(() => new OutboxDispatcher({ ...base, eventTypes: [] })).toThrow();
    expect(() => new OutboxDispatcher({ ...base, eventTypes: [TYPE], workerId: ' ' })).toThrow();
    expect(() => new OutboxDispatcher({ ...base, eventTypes: [TYPE], claimTimeoutMs: 0 })).toThrow();
  });

  it('enqueueIfAbsent is idempotent per event id', async () => {
    const s = await scope();
    const e = event(s);
    expect(await outbox.enqueueIfAbsent(s.ctx, { event: e })).toEqual({ id: e.eventId, inserted: true });
    expect(await outbox.enqueueIfAbsent(s.ctx, { event: e })).toEqual({ id: e.eventId, inserted: false });
    expect(Number((await admin.query('SELECT count(*) n FROM events.outbox_events WHERE id=$1', [e.eventId])).rows[0].n)).toBe(1);
  });
});
