import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';

export interface TwinConfidenceScore {
  id: string;
  tenantId: string;
  workspaceId: string;
  businessId: string;
  instanceId: string;
  snapshotVersionId: string | null;
  /** numeric(5,4): at most four decimals, between 0 and 1. */
  confidence: number;
  /** The calculation basis exactly as recorded (the methodology, its version and the evidence of every factor). */
  basis: string;
  createdAt: Date;
}

function rowToScore(row: Record<string, unknown>): TwinConfidenceScore {
  return {
    id: row.id as string, tenantId: row.tenant_id as string, workspaceId: row.workspace_id as string, businessId: row.business_id as string,
    instanceId: row.instance_id as string, snapshotVersionId: (row.snapshot_version_id as string | null) ?? null,
    confidence: Number(row.confidence), basis: row.basis as string, createdAt: row.created_at as Date,
  };
}

/** Append-only Twin Confidence evidence (`twin_confidence_scores`, migration 0057). A score is recorded with the basis it rests on; it is never updated or deleted. */
export class TwinConfidenceScoreRepository {
  async record(ctx: TenantContext, input: { businessId: string; instanceId: string; snapshotVersionId: string; confidence: number; basis: string }): Promise<TwinConfidenceScore> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `INSERT INTO business_digital_twin.twin_confidence_scores (tenant_id, workspace_id, business_id, instance_id, snapshot_version_id, confidence, basis)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [ctx.tenantId, ctx.workspaceId, input.businessId, input.instanceId, input.snapshotVersionId, input.confidence, input.basis]
      );
      return rowToScore(result.rows[0]);
    });
  }

  async getById(ctx: TenantContext, id: string): Promise<TwinConfidenceScore | null> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>('SELECT * FROM business_digital_twin.twin_confidence_scores WHERE id = $1', [id]);
      return result.rows.length === 0 ? null : rowToScore(result.rows[0]);
    });
  }
}
