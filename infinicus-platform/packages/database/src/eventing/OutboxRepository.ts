import type { PoolClient } from 'pg';
import type { TenantContext } from '../client.js';
import { withTenantTransaction } from '../client.js';
import type { ClaimBatchOptions, EventFailure, OutboxEventInput } from './types.js';

export class OutboxRepository {
  async enqueue(ctx: TenantContext, input: OutboxEventInput): Promise<string> {
    const e = input.event;
    if (e.tenantId !== ctx.tenantId || e.workspaceId !== ctx.workspaceId) {
      throw new Error('EVENTING_SCOPE_MISMATCH');
    }
    return withTenantTransaction(ctx, async (client) => {
      const headers = {
        ...(input.headers ?? {}),
        businessEvent: {
          sourceDomain: e.sourceDomain,
          sourceService: e.sourceService,
          metadata: e.metadata,
          provenance: e.provenance,
          schemaName: e.schemaName,
          schemaVersion: e.schemaVersion,
          sensitivity: e.sensitivity,
          actor: e.actor,
          idempotencyKey: e.idempotencyKey,
        },
      };
      const result = await client.query<{ id: string }>(
        `INSERT INTO events.outbox_events
          (id,event_type,event_version,tenant_id,workspace_id,business_id,correlation_id,causation_id,
           aggregate_type,aggregate_id,payload,headers,available_at,occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14)
         RETURNING id`,
        [
          e.eventId,e.eventType,e.eventVersion,e.tenantId,e.workspaceId,e.businessId,e.correlationId,
          e.causationId,e.aggregateType,e.aggregateId,JSON.stringify(e.payload),
          JSON.stringify(headers),input.availableAt ?? new Date(),e.occurredAt,
        ],
      );
      return result.rows[0].id;
    });
  }

  /**
   * Idempotent enqueue for events whose id is deterministic (for example one notification per package version): a second enqueue of the
   * same event id inserts nothing. Joins the caller's shared tenant transaction when one is open, so the event commits or rolls back
   * with the fact it announces.
   */
  async enqueueIfAbsent(ctx: TenantContext, input: OutboxEventInput): Promise<{ id: string; inserted: boolean }> {
    return withTenantTransaction(ctx, (client) => this.enqueueIfAbsentOnClient(client, ctx, input));
  }

  /**
   * The same idempotent enqueue on the CALLER'S client. A producer whose fact is written through its own transaction client (Business
   * Operations' execution engine) uses this so the event row commits or rolls back with that fact: an event can never be lost after the
   * fact commits, nor announce a fact that rolled back.
   */
  async enqueueIfAbsentOnClient(client: PoolClient, ctx: TenantContext, input: OutboxEventInput): Promise<{ id: string; inserted: boolean }> {
    const e = input.event;
    if (e.tenantId !== ctx.tenantId || e.workspaceId !== ctx.workspaceId) {
      throw new Error('EVENTING_SCOPE_MISMATCH');
    }
    const headers = {
      ...(input.headers ?? {}),
      businessEvent: {
        sourceDomain: e.sourceDomain, sourceService: e.sourceService, metadata: e.metadata, provenance: e.provenance,
        schemaName: e.schemaName, schemaVersion: e.schemaVersion, sensitivity: e.sensitivity, actor: e.actor, idempotencyKey: e.idempotencyKey,
      },
    };
    const result = await client.query<{ id: string }>(
      `INSERT INTO events.outbox_events
        (id,event_type,event_version,tenant_id,workspace_id,business_id,correlation_id,causation_id,
         aggregate_type,aggregate_id,payload,headers,available_at,occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        e.eventId,e.eventType,e.eventVersion,e.tenantId,e.workspaceId,e.businessId,e.correlationId,
        e.causationId,e.aggregateType,e.aggregateId,JSON.stringify(e.payload),
        JSON.stringify(headers),input.availableAt ?? new Date(),e.occurredAt,
      ],
    );
    return { id: e.eventId, inserted: result.rows.length === 1 };
  }

  async claimBatch(ctx: TenantContext, options: ClaimBatchOptions) {
    const size = Math.max(1, Math.min(100, Math.trunc(options.batchSize)));
    return withTenantTransaction(ctx, async (client) => {
      const params: unknown[] = [options.now, size];
      let filter = '';
      if (options.eventTypes?.length) {
        params.push(options.eventTypes);
        filter = ' AND event_type = ANY($3::text[])';
      }
      const result = await client.query<Record<string, unknown>>(
        `WITH claimed AS (
           SELECT id FROM events.outbox_events
            WHERE status IN ('pending','failed')
              AND available_at <= $1
              ${filter}
            ORDER BY available_at, created_at
            FOR UPDATE SKIP LOCKED
            LIMIT $2
         )
         UPDATE events.outbox_events o
            SET status='processing', attempt_count=o.attempt_count+1, claimed_at=$1
           FROM claimed
          WHERE o.id=claimed.id
          RETURNING o.*`,
        params,
      );
      return result.rows;
    });
  }

  /**
   * Returns rows that have been 'processing' since before `staleBefore` (a worker crashed or hung mid-delivery) to 'failed', so the normal
   * retry path re-delivers them. Rows without a claim time (historic) are never touched. Delivery is at-least-once; consumers dedupe.
   */
  async recoverStaleClaims(ctx: TenantContext, staleBefore: Date): Promise<number> {
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query(
        `UPDATE events.outbox_events
            SET status='failed',
                headers = headers || jsonb_build_object('lastFailure', jsonb_build_object('code','CLAIM_TIMEOUT','message','claimed by a worker that did not finish','retryable',true))
          WHERE status='processing' AND claimed_at IS NOT NULL AND claimed_at < $1`,
        [staleBefore],
      );
      return r.rowCount ?? 0;
    });
  }

  async markPublished(ctx: TenantContext, eventId: string, publishedAt: Date): Promise<void> {
    await withTenantTransaction(ctx, async (client) => {
      const r = await client.query(
        `UPDATE events.outbox_events SET status='published', published_at=$2
          WHERE id=$1 AND status='processing'`,
        [eventId,publishedAt],
      );
      if (r.rowCount !== 1) throw new Error('INVALID_OUTBOX_TRANSITION');
    });
  }

  async markFailed(ctx: TenantContext, eventId: string, failure: EventFailure): Promise<void> {
    await withTenantTransaction(ctx, async (client) => {
      const r = await client.query(
        `UPDATE events.outbox_events
            SET status='failed',
                headers = headers || jsonb_build_object('lastFailure', $2::jsonb)
          WHERE id=$1 AND status='processing'`,
        [eventId, JSON.stringify(failure)],
      );
      if (r.rowCount !== 1) throw new Error('INVALID_OUTBOX_TRANSITION');
    });
  }

  async scheduleRetry(ctx: TenantContext, eventId: string, availableAt: Date, failure: EventFailure): Promise<void> {
    await withTenantTransaction(ctx, async (client) => {
      const r = await client.query(
        `UPDATE events.outbox_events
            SET status='pending', available_at=$2,
                headers = headers || jsonb_build_object('lastFailure', $3::jsonb)
          WHERE id=$1 AND status='failed'`,
        [eventId, availableAt, JSON.stringify(failure)],
      );
      if (r.rowCount !== 1) throw new Error('INVALID_OUTBOX_TRANSITION');
    });
  }
}
