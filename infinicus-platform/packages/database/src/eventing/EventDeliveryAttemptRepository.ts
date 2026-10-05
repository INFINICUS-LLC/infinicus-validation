import type { TenantContext } from '../client.js';
import { withTenantTransaction } from '../client.js';
import type { RecordDeliveryAttemptInput } from './types.js';

export class EventDeliveryAttemptRepository {
  async record(
    ctx: TenantContext,
    input: RecordDeliveryAttemptInput,
  ): Promise<string> {
    if (input.completedAt.getTime() < input.attemptedAt.getTime()) {
      throw new Error('DELIVERY_ATTEMPT_COMPLETED_BEFORE_STARTED');
    }
    if (!Number.isFinite(input.latencyMs) || input.latencyMs < 0) {
      throw new Error('DELIVERY_ATTEMPT_LATENCY_INVALID');
    }
    if (input.status === 'failed' && !input.failure) {
      throw new Error('DELIVERY_ATTEMPT_FAILURE_REQUIRED');
    }

    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO events.event_delivery_attempts (
           tenant_id,
           workspace_id,
           outbox_event_id,
           subscription_id,
           consumer_name,
           worker_id,
           attempt_number,
           status,
           response_code,
           response_body,
           attempted_at,
           completed_at,
           latency_ms,
           failure_code,
           failure_message,
           metadata
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb
         )
         RETURNING id`,
        [
          ctx.tenantId,
          ctx.workspaceId,
          input.outboxEventId,
          input.subscriptionId ?? null,
          input.consumerName ?? null,
          input.workerId ?? null,
          input.attemptNumber,
          input.status,
          input.responseCode ?? null,
          input.responseBody ?? null,
          input.attemptedAt,
          input.completedAt,
          input.latencyMs,
          input.failure?.code ?? null,
          input.failure?.message ?? null,
          JSON.stringify({
            ...(input.metadata ?? {}),
            failure: input.failure ?? null,
          }),
        ],
      );

      return result.rows[0].id;
    });
  }

  async listForOutbox(
    ctx: TenantContext,
    outboxEventId: string,
  ): Promise<Record<string, unknown>[]> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT *
           FROM events.event_delivery_attempts
          WHERE outbox_event_id = $1
          ORDER BY attempt_number ASC, attempted_at ASC`,
        [outboxEventId],
      );
      return result.rows;
    });
  }
}
