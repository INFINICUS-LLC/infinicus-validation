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
      const result = await client.query<{ id: string }>(
        `INSERT INTO events.outbox_events
          (id,event_type,event_version,tenant_id,workspace_id,business_id,correlation_id,causation_id,
           aggregate_type,aggregate_id,payload,headers,available_at,occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14)
         RETURNING id`,
        [
          e.eventId,e.eventType,e.eventVersion,e.tenantId,e.workspaceId,e.businessId,e.correlationId,
          e.causationId,e.aggregateType,e.aggregateId,JSON.stringify(e.payload),
          JSON.stringify(input.headers ?? {}),input.availableAt ?? new Date(),e.occurredAt,
        ],
      );
      return result.rows[0].id;
    });
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
            SET status='processing', attempt_count=o.attempt_count+1
           FROM claimed
          WHERE o.id=claimed.id
          RETURNING o.*`,
        params,
      );
      return result.rows;
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
