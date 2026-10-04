import type { TenantContext } from '../client.js';
import { withTenantTransaction } from '../client.js';
import type { EventFailure, StartDeliveryAttemptInput } from './types.js';

export class EventDeliveryAttemptRepository {
  async start(ctx: TenantContext, input: StartDeliveryAttemptInput): Promise<string> {
    return withTenantTransaction(ctx, async (client) => {
      const r=await client.query<{id:string}>(
        `INSERT INTO events.event_delivery_attempts
          (tenant_id,workspace_id,outbox_event_id,subscription_id,consumer_name,worker_id,
           attempt_number,status,metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'started',$8::jsonb)
         RETURNING id`,
        [
          ctx.tenantId,ctx.workspaceId,input.outboxEventId,input.subscriptionId ?? null,
          input.consumerName ?? null,input.workerId ?? null,input.attemptNumber,
          JSON.stringify(input.metadata ?? {}),
        ],
      );
      return r.rows[0].id;
    });
  }

  async markSucceeded(ctx: TenantContext, attemptId: string, completedAt: Date, latencyMs: number): Promise<void> {
    await withTenantTransaction(ctx, async (client) => {
      const r=await client.query(
        `UPDATE events.event_delivery_attempts
            SET status='succeeded',completed_at=$2,latency_ms=$3
          WHERE id=$1 AND status='started'`,
        [attemptId,completedAt,latencyMs],
      );
      if(r.rowCount!==1) throw new Error('INVALID_DELIVERY_ATTEMPT_TRANSITION');
    });
  }

  async markFailed(ctx: TenantContext, attemptId: string, failure: EventFailure, completedAt: Date, latencyMs: number): Promise<void> {
    await withTenantTransaction(ctx, async (client) => {
      const r=await client.query(
        `UPDATE events.event_delivery_attempts
            SET status='failed',completed_at=$2,latency_ms=$3,failure_code=$4,failure_message=$5,
                metadata=metadata || $6::jsonb
          WHERE id=$1 AND status='started'`,
        [attemptId,completedAt,latencyMs,failure.code,failure.message,JSON.stringify(failure.metadata ?? {})],
      );
      if(r.rowCount!==1) throw new Error('INVALID_DELIVERY_ATTEMPT_TRANSITION');
    });
  }
}
