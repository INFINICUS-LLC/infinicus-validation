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
