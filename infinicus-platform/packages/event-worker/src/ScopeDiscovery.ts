/**
 * Which tenant/workspace scopes currently have dispatchable outbox rows.
 *
 * Row-level security (correctly) hides every other tenant's rows from the application role, so a worker that serves all tenants needs a
 * cross-tenant READ of scope identifiers only. That read is deliberately a separate, narrowly-granted connection (a dedicated discovery
 * role with SELECT on the five columns below), NOT a function the API role can call: the API connection can never enumerate other
 * tenants. Everything the worker then does for a scope runs through the normal application connection under that scope's RLS.
 * With no discovery connection configured the worker finds nothing and does nothing (fail closed).
 */
import type { Pool } from 'pg';

export interface DispatchableScope {
  tenantId: string;
  workspaceId: string;
}

export interface ScopeDiscovery {
  discover(input: { now: Date; eventTypes: readonly string[]; staleBefore: Date; limit: number }): Promise<DispatchableScope[]>;
}

export class SqlScopeDiscovery implements ScopeDiscovery {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async discover(input: { now: Date; eventTypes: readonly string[]; staleBefore: Date; limit: number }): Promise<DispatchableScope[]> {
    const limit = Math.max(1, Math.min(500, Math.trunc(input.limit)));
    const r = await this.pool.query<{ tenant_id: string; workspace_id: string }>(
      `SELECT DISTINCT tenant_id, workspace_id
         FROM events.outbox_events
        WHERE workspace_id IS NOT NULL
          AND event_type = ANY($1::text[])
          AND ((status IN ('pending','failed') AND available_at <= $2)
            OR (status = 'processing' AND claimed_at IS NOT NULL AND claimed_at < $3))
        ORDER BY tenant_id, workspace_id
        LIMIT $4`,
      [[...input.eventTypes], input.now, input.staleBefore, limit],
    );
    return r.rows.map((row) => ({ tenantId: row.tenant_id, workspaceId: row.workspace_id }));
  }
}
