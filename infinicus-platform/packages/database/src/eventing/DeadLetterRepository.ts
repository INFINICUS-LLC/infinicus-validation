import type { TenantContext } from '../client.js';
import { withTenantTransaction } from '../client.js';
import type { EventFailure } from './types.js';

export class DeadLetterRepository {
  async createFromOutbox(ctx: TenantContext, eventId: string, failure: EventFailure): Promise<string> {
    return withTenantTransaction(ctx, async (client) => {
      const outbox=await client.query<Record<string,unknown>>(
        `SELECT * FROM events.outbox_events WHERE id=$1 FOR UPDATE`,
        [eventId],
      );
      const row=outbox.rows[0];
      if(!row) throw new Error('OUTBOX_EVENT_NOT_FOUND');
      const inserted=await client.query<{id:string}>(
        `INSERT INTO events.dead_letter_events
          (tenant_id,workspace_id,original_event_id,original_event,failure_reason,attempt_count)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6)
         RETURNING id`,
        [ctx.tenantId,ctx.workspaceId,eventId,JSON.stringify(row),JSON.stringify(failure),Number(row.attempt_count ?? 0)],
      );
      await client.query(
        `UPDATE events.outbox_events SET status='dead_lettered'
          WHERE id=$1 AND status IN ('processing','failed')`,
        [eventId],
      );
      return inserted.rows[0].id;
    });
  }

  async list(ctx: TenantContext, limit=100) {
    return withTenantTransaction(ctx, async (client) => {
      const r=await client.query<Record<string,unknown>>(
        `SELECT * FROM events.dead_letter_events ORDER BY last_failed_at DESC LIMIT $1`,
        [Math.max(1,Math.min(500,Math.trunc(limit)))],
      );
      return r.rows;
    });
  }

  async markReplayApproved(ctx: TenantContext, deadLetterId: string, approvedBy: string): Promise<void> {
    await withTenantTransaction(ctx, async (client) => {
      const r=await client.query(
        `UPDATE events.dead_letter_events SET approved_by=$2
          WHERE id=$1 AND replay_status='pending'`,
        [deadLetterId,approvedBy],
      );
      if(r.rowCount!==1) throw new Error('DEAD_LETTER_NOT_FOUND_OR_TERMINAL');
    });
  }
}
