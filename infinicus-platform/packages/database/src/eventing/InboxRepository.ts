import type { TenantContext } from '../client.js';
import { withTenantTransaction } from '../client.js';
import type { InboxProcessingInput, InboxProcessingResult } from './types.js';

export class InboxRepository {
  async beginProcessing(ctx: TenantContext, input: InboxProcessingInput): Promise<InboxProcessingResult> {
    return withTenantTransaction(ctx, async (client) => {
      const existing = await client.query<{ status: string }>(
        `SELECT status FROM events.inbox_events WHERE event_id=$1 AND consumer_name=$2 FOR UPDATE`,
        [input.eventId,input.consumerName],
      );
      const status = existing.rows[0]?.status;
      if (status === 'processed') return { state: 'already_processed' };
      if (status === 'processing') return { state: 'already_processing' };
      if (status === 'failed') {
        await client.query(
          `UPDATE events.inbox_events SET status='processing', failed_at=NULL, failure_reason=NULL
            WHERE event_id=$1 AND consumer_name=$2`,
          [input.eventId,input.consumerName],
        );
        return { state: 'retry_allowed' };
      }
      await client.query(
        `INSERT INTO events.inbox_events
          (event_id,consumer_name,event_type,tenant_id,workspace_id,payload,status)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,'processing')`,
        [input.eventId,input.consumerName,input.eventType,ctx.tenantId,ctx.workspaceId,JSON.stringify(input.payload)],
      );
      return { state: 'started' };
    });
  }

  async markProcessed(ctx: TenantContext, eventId: string, consumerName: string): Promise<void> {
    await withTenantTransaction(ctx, async (client) => {
      const r=await client.query(
        `UPDATE events.inbox_events SET status='processed', processed_at=now()
          WHERE event_id=$1 AND consumer_name=$2 AND status='processing'`,
        [eventId,consumerName],
      );
      if(r.rowCount!==1) throw new Error('INVALID_INBOX_TRANSITION');
    });
  }

  async hasProcessed(ctx: TenantContext, eventId: string, consumerName: string): Promise<boolean> {
    return withTenantTransaction(ctx, async (client) => {
      const r=await client.query<{ ok: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM events.inbox_events
            WHERE event_id=$1 AND consumer_name=$2 AND status='processed'
         ) AS ok`,
        [eventId,consumerName],
      );
      return Boolean(r.rows[0]?.ok);
    });
  }
}
