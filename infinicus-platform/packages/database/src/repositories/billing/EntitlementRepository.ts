import type { PoolClient } from 'pg';
import { withTenantTransaction, type TenantContext } from '../../client.js';

/** Where an entitlement came from. Opaque to capability semantics: no provider, plan or price is encoded here. */
export type EntitlementSourceType = 'compatibility' | 'trial' | 'subscription' | 'add_on' | 'enterprise_contract' | 'operator_grant';
export type EntitlementStatus = 'active' | 'revoked';

export interface EntitlementRecord {
  id: string;
  tenantId: string;
  capability: string;
  sourceType: EntitlementSourceType;
  sourceReference: string;
  effectiveFrom: Date;
  effectiveUntil: Date | null;
  status: EntitlementStatus;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface GrantEntitlementInput {
  capability: string;
  sourceType: EntitlementSourceType;
  sourceReference: string;
  effectiveFrom: Date;
  effectiveUntil?: Date | null;
}

/** What the store says about one tenant at one moment. `total` counts every row ever written, including expired and revoked ones. */
export interface EntitlementSnapshot {
  total: number;
  /** Distinct capabilities effective at the moment asked about (database time when none is given). */
  effective: string[];
}

interface Row {
  id: string; tenant_id: string; capability: string; source_type: EntitlementSourceType; source_reference: string;
  effective_from: Date; effective_until: Date | null; status: EntitlementStatus; revoked_at: Date | null; created_at: Date;
}
const map = (r: Row): EntitlementRecord => ({
  id: r.id, tenantId: r.tenant_id, capability: r.capability, sourceType: r.source_type, sourceReference: r.source_reference,
  effectiveFrom: r.effective_from, effectiveUntil: r.effective_until, status: r.status, revokedAt: r.revoked_at, createdAt: r.created_at,
});

/** The one definition of "effective at T": started, not ended, not revoked at or before T. Shared by every read so none can drift. */
const EFFECTIVE_AT = `(e.effective_from <= $2 AND (e.effective_until IS NULL OR $2 < e.effective_until) AND (e.revoked_at IS NULL OR $2 < e.revoked_at))`;

/**
 * Reads of billing.entitlements run as the application role under forced row-level security (tenant-scoped). The application role cannot write the
 * table; entitlements are minted only by the governed `grant` and `revoke` below, which take a client that the future governed commercial process owns
 * (inside a transaction whose `app.tenant_id` is the tenant being written) and are not used by any request-serving code.
 */
export class EntitlementRepository {
  async snapshot(ctx: TenantContext, at?: Date): Promise<EntitlementSnapshot> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<{ total: number; effective: string[] }>(
        `SELECT count(*)::int AS total,
                coalesce(array_agg(DISTINCT e.capability) FILTER (WHERE ${EFFECTIVE_AT}), '{}') AS effective
           FROM billing.entitlements e
          WHERE e.tenant_id = $1`,
        [ctx.tenantId, at ?? (await client.query<{ now: Date }>('SELECT now() AS now')).rows[0].now]
      );
      return { total: result.rows[0].total, effective: result.rows[0].effective };
    });
  }

  async list(ctx: TenantContext): Promise<EntitlementRecord[]> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Row>(
        'SELECT * FROM billing.entitlements WHERE tenant_id = $1 ORDER BY capability, effective_from, source_type, source_reference', [ctx.tenantId]);
      return result.rows.map(map);
    });
  }

  /** Governed write (idempotent). The client's transaction must have app.tenant_id set to `tenantId`. */
  static async grant(client: PoolClient, tenantId: string, input: GrantEntitlementInput): Promise<{ id: string; created: boolean }> {
    const result = await client.query<{ out_entitlement_id: string; out_created: boolean }>(
      'SELECT * FROM billing.grant_entitlement($1, $2, $3, $4, $5, $6)',
      [tenantId, input.capability, input.sourceType, input.sourceReference, input.effectiveFrom, input.effectiveUntil ?? null]);
    return { id: result.rows[0].out_entitlement_id, created: result.rows[0].out_created };
  }

  /** Governed write (one-way). Returns false when it was already revoked. */
  static async revoke(client: PoolClient, tenantId: string, entitlementId: string): Promise<boolean> {
    const result = await client.query<{ revoke_entitlement: boolean }>('SELECT billing.revoke_entitlement($1, $2)', [tenantId, entitlementId]);
    return result.rows[0].revoke_entitlement;
  }
}
