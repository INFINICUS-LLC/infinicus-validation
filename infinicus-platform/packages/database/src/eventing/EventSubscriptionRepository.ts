import type { PoolClient } from 'pg';
import type { TenantContext } from '../client.js';
import { withTenantTransaction } from '../client.js';
import type { CreateEventSubscriptionInput, SubscriptionStatus } from './types.js';

export class EventSubscriptionRepository {
  async create(ctx: TenantContext, input: CreateEventSubscriptionInput) {
    return withTenantTransaction(ctx, async (client) => {
      const r=await client.query<Record<string,unknown>>(
        `INSERT INTO events.event_subscriptions
          (tenant_id,workspace_id,subscriber_name,event_pattern,destination_type,destination_ref,
           retry_policy,supported_versions,consumer_group,ordering_mode,timeout_seconds)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::text[],$9,$10,$11)
         RETURNING *`,
        [
          ctx.tenantId,ctx.workspaceId,input.subscriberName,input.eventPattern,input.destinationType,
          input.destinationReference,JSON.stringify(input.retryPolicy ?? {maxAttempts:3,backoffSeconds:30}),
          input.supportedVersions ?? ['1.0'],input.consumerGroup ?? null,input.orderingMode ?? 'aggregate',
          input.timeoutSeconds ?? 30,
        ],
      );
      return r.rows[0];
    });
  }

  /**
   * Idempotent, scope-correct creation (P0-6e): the subscription named `subscriberName` exists afterwards in THIS scope with exactly this
   * pattern, destination and pinned versions. Returns `created: false` when it already did. A same-named subscription that differs, or that
   * belongs to another scope, is an error - it is never adopted or overwritten. Runs on the caller's client so it can share a transaction.
   */
  async ensureOnClient(client: PoolClient, ctx: TenantContext, input: CreateEventSubscriptionInput): Promise<{ created: boolean; id: string }> {
    const versions = input.supportedVersions ?? ['1.0'];
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO events.event_subscriptions
         (tenant_id,workspace_id,subscriber_name,event_pattern,destination_type,destination_ref,retry_policy,supported_versions,consumer_group,ordering_mode,timeout_seconds)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::text[],$9,$10,$11)
       ON CONFLICT (subscriber_name) DO NOTHING RETURNING id`,
      [ctx.tenantId, ctx.workspaceId, input.subscriberName, input.eventPattern, input.destinationType, input.destinationReference,
        JSON.stringify(input.retryPolicy ?? { maxAttempts: 3, backoffSeconds: 30 }), versions, input.consumerGroup ?? null, input.orderingMode ?? 'aggregate', input.timeoutSeconds ?? 30],
    );
    if (inserted.rows[0]) return { created: true, id: inserted.rows[0].id };
    // The name is platform-unique and RLS hides other scopes' rows: finding nothing here means the name is taken elsewhere.
    const existing = await client.query<Record<string, unknown>>(
      `SELECT id, event_pattern, destination_type, destination_ref, supported_versions FROM events.event_subscriptions WHERE subscriber_name = $1`, [input.subscriberName],
    );
    const row = existing.rows[0];
    if (!row) throw new Error('SUBSCRIPTION_NAME_TAKEN');
    const same = row.event_pattern === input.eventPattern && row.destination_type === input.destinationType && row.destination_ref === input.destinationReference
      && JSON.stringify(row.supported_versions) === JSON.stringify(versions);
    if (!same) throw new Error('SUBSCRIPTION_CONFLICT');
    return { created: false, id: row.id as string };
  }

  async ensure(ctx: TenantContext, input: CreateEventSubscriptionInput): Promise<{ created: boolean; id: string }> {
    return withTenantTransaction(ctx, (client) => this.ensureOnClient(client, ctx, input));
  }

  async listMatching(ctx: TenantContext, eventType: string, eventVersion: string) {
    return withTenantTransaction(ctx, async (client) => {
      const r=await client.query<Record<string,unknown>>(
        `SELECT * FROM events.event_subscriptions
          WHERE status='active'
            AND $1 LIKE replace(event_pattern, '*', '%')
            AND $2 = ANY(supported_versions)
          ORDER BY subscriber_name`,
        [eventType,eventVersion],
      );
      return r.rows;
    });
  }

  async updateStatus(ctx: TenantContext, id: string, status: SubscriptionStatus): Promise<void> {
    await withTenantTransaction(ctx, async (client) => {
      const r=await client.query(
        `UPDATE events.event_subscriptions SET status=$2, updated_at=now() WHERE id=$1`,
        [id,status],
      );
      if(r.rowCount!==1) throw new Error('SUBSCRIPTION_NOT_FOUND');
    });
  }
}
