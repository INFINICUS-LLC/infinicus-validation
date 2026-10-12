import type { PoolClient } from 'pg';
import type { TenantContext } from '../client.js';
import { withTenantTransaction } from '../client.js';
import type { CreateEventSubscriptionInput, SubscriptionStatus } from './types.js';

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Why an existing subscription is not the one asked for (null = it is, and it is active). */
function subscriptionProblem(row: Record<string, unknown>, want: CreateEventSubscriptionInput): string | null {
  if (row.status !== 'active') return 'SUBSCRIPTION_INACTIVE';
  const same = row.event_pattern === want.eventPattern && row.destination_type === want.destinationType && row.destination_ref === want.destinationReference
    && sameJson(row.supported_versions, want.supportedVersions ?? ['1.0'])
    && sameJson(row.retry_policy, want.retryPolicy ?? { maxAttempts: 3, backoffSeconds: 30 });
  return same ? null : 'SUBSCRIPTION_CONFLICT';
}

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
      `SELECT id, status, event_pattern, destination_type, destination_ref, supported_versions, retry_policy FROM events.event_subscriptions WHERE subscriber_name = $1`, [input.subscriberName],
    );
    const row = existing.rows[0];
    if (!row) throw new Error('SUBSCRIPTION_NAME_TAKEN');
    const problem = subscriptionProblem(row, input);
    if (problem) throw new Error(problem);
    return { created: false, id: row.id as string };
  }

  /**
   * True only when every named subscription EXISTS in this scope and is exactly what was asked for AND ACTIVE (same pattern, destination,
   * pinned versions and retry policy). Anything else - missing, paused, disabled, failed, edited - is false. Read-only; fail closed on any doubt.
   */
  async verifyOnClient(client: PoolClient, specs: readonly CreateEventSubscriptionInput[]): Promise<boolean> {
    for (const spec of specs) {
      const r = await client.query<Record<string, unknown>>(
        `SELECT id, status, event_pattern, destination_type, destination_ref, supported_versions, retry_policy FROM events.event_subscriptions WHERE subscriber_name = $1`, [spec.subscriberName],
      );
      if (!r.rows[0] || subscriptionProblem(r.rows[0], spec) !== null) return false;
    }
    return specs.length > 0;
  }

  async verify(ctx: TenantContext, specs: readonly CreateEventSubscriptionInput[]): Promise<boolean> {
    return withTenantTransaction(ctx, (client) => this.verifyOnClient(client, specs));
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
