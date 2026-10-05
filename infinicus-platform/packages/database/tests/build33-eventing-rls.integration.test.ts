/**
 * BUILD-33 v1.1 live PostgreSQL / RLS architecture validation.
 *
 * Requires:
 *   DATABASE_URL       — least-privilege app role (RLS enforced)
 *   ADMIN_DATABASE_URL — privileged test/admin role (BYPASSRLS)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createPool, closePool, getPool } from '../src/client.js';
import {
  EventDeliveryAttemptRepository,
  EventLedgerRepository,
  EventSubscriptionRepository,
  OutboxRepository,
} from '../src/eventing/index.js';
import type { BusinessEventEnvelope, EvidenceClass } from '@infinicus/event-contracts';

const run = Boolean(process.env.DATABASE_URL && process.env.ADMIN_DATABASE_URL);

const T1 = '77777777-3300-4000-8000-000000000001';
const T2 = '77777777-3300-4000-8000-000000000002';
const WS1 = '77777777-3300-4000-8000-000000000011';
const WS1B = '77777777-3300-4000-8000-000000000012';
const WS2 = '77777777-3300-4000-8000-000000000021';
const UID = '77777777-3300-4000-8000-000000000099';

const ctx1 = { tenantId: T1, workspaceId: WS1, userId: UID };
const ctx1b = { tenantId: T1, workspaceId: WS1B, userId: UID };
const ctx2 = { tenantId: T2, workspaceId: WS2, userId: UID };

let adminPool: Pool;

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function eventFor(evidenceClass: EvidenceClass): BusinessEventEnvelope<Record<string, unknown>> {
  const eventId = crypto.randomUUID();
  return {
    eventId,
    eventType: 'operations.inventory.movement_recorded',
    eventVersion: '1.0',
    tenantId: T1,
    workspaceId: WS1,
    businessId: null,
    sourceDomain: 'operations',
    sourceService: 'build-33-live-test',
    aggregateType: 'inventory_movement',
    aggregateId: eventId,
    correlationId: crypto.randomUUID(),
    causationId: null,
    occurredAt: new Date().toISOString(),
    recordedAt: new Date().toISOString(),
    actor: { actorType: 'service', actorId: 'build-33-live-test' },
    idempotencyKey: `build33:${eventId}`,
    payload: { quantity: 1, unit: 'ea' },
    metadata: { test: true },
    provenance: {
      evidenceClass,
      sourceSystem: 'build-33-live-test',
      sourceRecordId: eventId,
    },
    schemaName: 'operations.inventory.movement_recorded',
    schemaVersion: '1.0',
    sensitivity: 'internal',
  };
}

async function setup(): Promise<void> {
  createPool({ connectionString: process.env.DATABASE_URL! });
  adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL! });

  await adminPool.query(
    `INSERT INTO tenancy.tenants (id,name,slug,status,plan_code)
     VALUES
       ($1,'BUILD33 Tenant 1',$2,'active','test'),
       ($3,'BUILD33 Tenant 2',$4,'active','test')
     ON CONFLICT (id) DO NOTHING`,
    [T1, unique('build33-t1'), T2, unique('build33-t2')],
  );

  await adminPool.query(
    `INSERT INTO tenancy.workspaces (id,tenant_id,name,slug,status)
     VALUES
       ($1,$2,'BUILD33 WS1',$3,'active'),
       ($4,$2,'BUILD33 WS1B',$5,'active'),
       ($6,$7,'BUILD33 WS2',$8,'active')
     ON CONFLICT (id) DO NOTHING`,
    [WS1,T1,unique('ws1'),WS1B,unique('ws1b'),WS2,T2,unique('ws2')],
  );
}

async function teardown(): Promise<void> {
  // Event-ledger rows are intentionally immutable and the CI database is
  // ephemeral. Clean only mutable compatibility fixtures.
  await adminPool.query(
    `DELETE FROM events.event_subscriptions
      WHERE subscriber_name LIKE 'build33-live-%'`,
  );
  await adminPool.end();
  await closePool();
}

describe.runIf(run)('BUILD-33 v1.1 — live PostgreSQL/RLS architecture', () => {
  beforeAll(setup);
  afterAll(teardown);

  const ledger = new EventLedgerRepository();
  const subscriptions = new EventSubscriptionRepository();
  const outbox = new OutboxRepository();
  const attempts = new EventDeliveryAttemptRepository();

  it.each([
    'ACTUAL',
    'ASSUMPTION_BASED',
    'BENCHMARK_BASED',
    'ESTIMATED',
    'FORECAST',
    'SIMULATION',
  ] as EvidenceClass[])('round-trips evidence class %s without coercion', async (evidenceClass) => {
    const input = eventFor(evidenceClass);
    const stored = await ledger.append(ctx1, input);
    expect(stored.provenance.evidenceClass).toBe(evidenceClass);

    const found = await ledger.findById(ctx1, input.eventId);
    expect(found.provenance.evidenceClass).toBe(evidenceClass);

    const db = await adminPool.query<{ evidence_class: string; provenance: { evidenceClass: string } }>(
      `SELECT evidence_class, provenance
         FROM events.business_event_ledger
        WHERE event_id=$1`,
      [input.eventId],
    );
    expect(db.rows[0].evidence_class).toBe(evidenceClass);
    expect(db.rows[0].provenance.evidenceClass).toBe(evidenceClass);
  });

  it('enforces ledger immutability even for privileged database access', async () => {
    const input = eventFor('ACTUAL');
    await ledger.append(ctx1, input);
    await expect(
      adminPool.query(
        `UPDATE events.business_event_ledger
            SET metadata='{"mutated":true}'::jsonb
          WHERE event_id=$1`,
        [input.eventId],
      ),
    ).rejects.toThrow(/append-only/i);
  });

  it('blocks cross-tenant and same-tenant cross-workspace ledger reads', async () => {
    const input = eventFor('ACTUAL');
    await ledger.append(ctx1, input);

    await expect(ledger.findById(ctx2, input.eventId)).rejects.toMatchObject({
      code: 'EVENT_LEDGER_NOT_FOUND',
    });
    await expect(ledger.findById(ctx1b, input.eventId)).rejects.toMatchObject({
      code: 'EVENT_LEDGER_NOT_FOUND',
    });
  });

  it('preserves TENANT_WORKSPACE exact workspace isolation', async () => {
    const subscriberName = `build33-live-ws-${unique('sub')}`;
    const created = await subscriptions.create(ctx1, {
      subscriberName,
      eventPattern: 'operations.*',
      destinationType: 'internal',
      destinationReference: 'test://tenant-workspace',
      supportedVersions: ['1.0'],
    });
    expect(created.scope_type).toBe('TENANT_WORKSPACE');

    const ws1 = await subscriptions.listMatching(ctx1, 'operations.inventory.movement_recorded', '1.0');
    expect(ws1.some((row) => row.subscriber_name === subscriberName)).toBe(true);

    const ws1b = await subscriptions.listMatching(ctx1b, 'operations.inventory.movement_recorded', '1.0');
    expect(ws1b.some((row) => row.subscriber_name === subscriberName)).toBe(false);

    const t2 = await subscriptions.listMatching(ctx2, 'operations.inventory.movement_recorded', '1.0');
    expect(t2.some((row) => row.subscriber_name === subscriberName)).toBe(false);
  });

  it('keeps TENANT_GLOBAL subscriptions visible across one tenant only', async () => {
    const subscriberName = `build33-live-tenant-${unique('sub')}`;
    await adminPool.query(
      `INSERT INTO events.event_subscriptions
        (tenant_id,workspace_id,subscriber_name,event_pattern,destination_type,destination_ref,status,supported_versions)
       VALUES ($1,NULL,$2,'operations.*','internal','test://tenant-global','active',ARRAY['1.0'])`,
      [T1, subscriberName],
    );

    const sameTenantWs1 = await subscriptions.listMatching(ctx1, 'operations.inventory.movement_recorded', '1.0');
    const sameTenantWs2 = await subscriptions.listMatching(ctx1b, 'operations.inventory.movement_recorded', '1.0');
    const otherTenant = await subscriptions.listMatching(ctx2, 'operations.inventory.movement_recorded', '1.0');

    expect(sameTenantWs1.some((row) => row.subscriber_name === subscriberName)).toBe(true);
    expect(sameTenantWs2.some((row) => row.subscriber_name === subscriberName)).toBe(true);
    expect(otherTenant.some((row) => row.subscriber_name === subscriberName)).toBe(false);

    const scope = await adminPool.query<{ scope_type: string }>(
      'SELECT scope_type FROM events.event_subscriptions WHERE subscriber_name=$1',
      [subscriberName],
    );
    expect(scope.rows[0].scope_type).toBe('TENANT_GLOBAL');
  });

  it('preserves legacy PLATFORM_GLOBAL subscriptions for privileged relay only', async () => {
    const subscriberName = `build33-live-platform-${unique('sub')}`;
    // This is deliberately inserted using only the original 0007 columns:
    // old platform-global registry rows remain valid after 0172.
    await adminPool.query(
      `INSERT INTO events.event_subscriptions
        (subscriber_name,event_pattern,destination_type,destination_ref,status)
       VALUES ($1,'operations.*','internal','test://platform-global','active')`,
      [subscriberName],
    );

    const privileged = await adminPool.query<{ scope_type: string }>(
      'SELECT scope_type FROM events.event_subscriptions WHERE subscriber_name=$1',
      [subscriberName],
    );
    expect(privileged.rows).toHaveLength(1);
    expect(privileged.rows[0].scope_type).toBe('PLATFORM_GLOBAL');

    const appView = await subscriptions.listMatching(ctx1, 'operations.inventory.movement_recorded', '1.0');
    expect(appView.some((row) => row.subscriber_name === subscriberName)).toBe(false);
  });

  it('records one immutable terminal row per delivery attempt', async () => {
    const event = eventFor('ACTUAL');
    await outbox.enqueue(ctx1, { event });

    const attemptedAt = new Date();
    const completedAt = new Date(attemptedAt.getTime() + 25);
    const attemptId = await attempts.record(ctx1, {
      outboxEventId: event.eventId,
      attemptNumber: 1,
      status: 'succeeded',
      attemptedAt,
      completedAt,
      latencyMs: 25,
      consumerName: 'build33-live-consumer',
      workerId: 'worker-1',
      responseCode: 200,
      responseBody: 'ok',
      metadata: { transport: 'internal' },
    });

    const rows = await attempts.listForOutbox(ctx1, event.eventId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(attemptId);
    expect(rows[0].status).toBe('succeeded');
    expect(rows[0].attempt_number).toBe(1);

    const otherWorkspace = await attempts.listForOutbox(ctx1b, event.eventId);
    expect(otherWorkspace).toHaveLength(0);

    await expect(
      adminPool.query(
        `UPDATE events.event_delivery_attempts
            SET status='failed'
          WHERE id=$1`,
        [attemptId],
      ),
    ).rejects.toThrow(/append-only/i);

    await expect(
      adminPool.query(
        'DELETE FROM events.event_delivery_attempts WHERE id=$1',
        [attemptId],
      ),
    ).rejects.toThrow(/append-only/i);
  });

  it('rejects duplicate attempt numbers instead of overwriting history', async () => {
    const event = eventFor('ACTUAL');
    await outbox.enqueue(ctx1, { event });
    const attemptedAt = new Date();
    const completedAt = new Date(attemptedAt.getTime() + 10);

    const input = {
      outboxEventId: event.eventId,
      attemptNumber: 1,
      status: 'failed' as const,
      attemptedAt,
      completedAt,
      latencyMs: 10,
      consumerName: 'build33-live-consumer',
      failure: {
        code: 'TEST_FAILURE',
        message: 'controlled test failure',
        retryable: true,
        occurredAt: completedAt.toISOString(),
      },
    };

    await attempts.record(ctx1, input);
    await expect(attempts.record(ctx1, input)).rejects.toMatchObject({
      code: '23505',
    });
  });

  it('fails closed with missing or empty tenant/workspace context without UUID-cast crashes', async () => {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');

      const missing = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM events.event_subscriptions',
      );
      expect(Number(missing.rows[0].count)).toBe(0);

      await client.query("SELECT set_config('app.tenant_id','',true)");
      await client.query("SELECT set_config('app.workspace_id','',true)");
      const empty = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM events.event_subscriptions',
      );
      expect(Number(empty.rows[0].count)).toBe(0);

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});

describe.skipIf(run)('BUILD-33 v1.1 live PostgreSQL/RLS (skipped)', () => {
  it('requires DATABASE_URL and ADMIN_DATABASE_URL', () => {
    expect(run).toBe(false);
  });
});
