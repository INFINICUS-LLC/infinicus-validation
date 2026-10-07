import { randomUUID } from 'crypto';
import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';
import { DigitalTwinSnapshotNotFoundError, DigitalTwinSnapshotStateConflictError, DigitalTwinSnapshotImmutableError } from './errors.js';

export interface DigitalTwinSnapshot {
  id: string;
  tenantId: string;
  workspaceId: string;
  businessId: string;
  instanceId: string;
  snapshotCode: string;
  status: string;
  latestVersion: number;
  effectiveAt: Date;
}

export interface DigitalTwinSnapshotVersion {
  id: string;
  snapshotId: string;
  versionNumber: number;
  summary: string;
  status: string;
  correlationId: string;
}

export interface DigitalTwinSnapshotValue {
  variableCode: string;
  valueJson: unknown;
  confidence: number | null;
}

function rowToSnapshot(row: Record<string, unknown>): DigitalTwinSnapshot {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    workspaceId: row.workspace_id as string,
    businessId: row.business_id as string,
    instanceId: row.instance_id as string,
    snapshotCode: row.snapshot_code as string,
    status: row.status as string,
    latestVersion: row.latest_version as number,
    effectiveAt: row.effective_at as Date,
  };
}

function rowToVersion(row: Record<string, unknown>): DigitalTwinSnapshotVersion {
  return {
    id: row.id as string,
    snapshotId: row.snapshot_id as string,
    versionNumber: row.version_number as number,
    summary: row.summary as string,
    status: row.status as string,
    correlationId: row.correlation_id as string,
  };
}

export class DigitalTwinSnapshotRepository {
  async createSnapshot(
    ctx: TenantContext,
    businessId: string,
    instanceId: string,
    snapshotCode: string,
    effectiveAt: Date,
    summary: string,
    dtIntakePackageId?: string
  ): Promise<{ snapshot: DigitalTwinSnapshot; version: DigitalTwinSnapshotVersion }> {
    return withTenantTransaction(ctx, async (client) => {
      const snapResult = await client.query<Record<string, unknown>>(
        `INSERT INTO business_digital_twin.digital_twin_snapshots
           (tenant_id, workspace_id, business_id, instance_id, dt_intake_package_id, snapshot_code, effective_at, latest_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,1) RETURNING *`,
        [ctx.tenantId, ctx.workspaceId, businessId, instanceId, dtIntakePackageId ?? null, snapshotCode, effectiveAt]
      );
      const correlationId = randomUUID();
      const versionResult = await client.query<Record<string, unknown>>(
        `INSERT INTO business_digital_twin.digital_twin_snapshot_versions
           (snapshot_id, tenant_id, workspace_id, business_id, version_number, summary, correlation_id)
         VALUES ($1,$2,$3,$4,1,$5,$6) RETURNING *`,
        [snapResult.rows[0].id, ctx.tenantId, ctx.workspaceId, businessId, summary, correlationId]
      );
      return { snapshot: rowToSnapshot(snapResult.rows[0]), version: rowToVersion(versionResult.rows[0]) };
    });
  }

  async addValue(
    ctx: TenantContext,
    snapshotVersionId: string,
    variableCode: string,
    valueJson: unknown,
    opts: { stateVariableDefinitionId?: string; confidence?: number } = {}
  ): Promise<void> {
    return withTenantTransaction(ctx, async (client) => {
      await client.query(
        `INSERT INTO business_digital_twin.digital_twin_snapshot_values
           (snapshot_version_id, tenant_id, workspace_id, business_id, state_variable_definition_id, variable_code, value_json, confidence)
         VALUES ($1,$2,$3,(SELECT business_id FROM business_digital_twin.digital_twin_snapshot_versions WHERE id = $1),$4,$5,$6,$7)`,
        [snapshotVersionId, ctx.tenantId, ctx.workspaceId, opts.stateVariableDefinitionId ?? null, variableCode, JSON.stringify(valueJson), opts.confidence ?? null]
      );
    });
  }

  async addEvidence(ctx: TenantContext, snapshotVersionId: string, evidenceType: string, evidenceReference: Record<string, unknown>): Promise<void> {
    return withTenantTransaction(ctx, async (client) => {
      await client.query(
        `INSERT INTO business_digital_twin.digital_twin_snapshot_evidence
           (snapshot_version_id, tenant_id, workspace_id, business_id, evidence_type, evidence_reference)
         VALUES ($1,$2,$3,(SELECT business_id FROM business_digital_twin.digital_twin_snapshot_versions WHERE id = $1),$4,$5)`,
        [snapshotVersionId, ctx.tenantId, ctx.workspaceId, evidenceType, JSON.stringify(evidenceReference)]
      );
    });
  }

  async validateSnapshot(ctx: TenantContext, snapshotId: string, snapshotVersionId: string): Promise<DigitalTwinSnapshot> {
    return withTenantTransaction(ctx, async (client) => {
      const current = await client.query<Record<string, unknown>>('SELECT * FROM business_digital_twin.digital_twin_snapshots WHERE id = $1', [snapshotId]);
      if (current.rows.length === 0) throw new DigitalTwinSnapshotNotFoundError('DigitalTwinSnapshot', snapshotId);
      if (current.rows[0].status === 'published') throw new DigitalTwinSnapshotImmutableError('DigitalTwinSnapshot', 'published snapshots cannot be revalidated');
      const result = await client.query<Record<string, unknown>>(
        `UPDATE business_digital_twin.digital_twin_snapshots SET status = 'validated' WHERE id = $1 RETURNING *`,
        [snapshotId]
      );
      await client.query(
        `UPDATE business_digital_twin.digital_twin_snapshot_versions SET status = 'validated' WHERE id = $1`,
        [snapshotVersionId]
      );
      await client.query(
        `INSERT INTO business_digital_twin.digital_twin_snapshot_status_history
           (snapshot_id, tenant_id, workspace_id, business_id, from_status, to_status, correlation_id)
         VALUES ($1,$2,$3,$4,$5,'validated',$6)`,
        [snapshotId, ctx.tenantId, ctx.workspaceId, result.rows[0].business_id, current.rows[0].status, randomUUID()]
      );
      return rowToSnapshot(result.rows[0]);
    });
  }

  async publishSnapshot(ctx: TenantContext, snapshotId: string, snapshotVersionId: string): Promise<DigitalTwinSnapshot> {
    return withTenantTransaction(ctx, async (client) => {
      const current = await client.query<Record<string, unknown>>('SELECT * FROM business_digital_twin.digital_twin_snapshots WHERE id = $1', [snapshotId]);
      if (current.rows.length === 0) throw new DigitalTwinSnapshotNotFoundError('DigitalTwinSnapshot', snapshotId);
      if (current.rows[0].status !== 'validated') {
        throw new DigitalTwinSnapshotStateConflictError('DigitalTwinSnapshot', 'must be validated before publication');
      }
      const result = await client.query<Record<string, unknown>>(
        `UPDATE business_digital_twin.digital_twin_snapshots SET status = 'published' WHERE id = $1 RETURNING *`,
        [snapshotId]
      );
      await client.query(
        `UPDATE business_digital_twin.digital_twin_snapshot_versions SET status = 'published' WHERE id = $1`,
        [snapshotVersionId]
      );
      await client.query(
        `INSERT INTO business_digital_twin.digital_twin_snapshot_status_history
           (snapshot_id, tenant_id, workspace_id, business_id, from_status, to_status, correlation_id)
         VALUES ($1,$2,$3,$4,'validated','published',$5)`,
        [snapshotId, ctx.tenantId, ctx.workspaceId, result.rows[0].business_id, randomUUID()]
      );
      return rowToSnapshot(result.rows[0]);
    });
  }

  /** Only legal before publication — published snapshots are immutable (enforced by the database trigger). */
  async supersedeSnapshot(ctx: TenantContext, snapshotId: string): Promise<DigitalTwinSnapshot> {
    return withTenantTransaction(ctx, async (client) => {
      const current = await client.query<Record<string, unknown>>('SELECT * FROM business_digital_twin.digital_twin_snapshots WHERE id = $1', [snapshotId]);
      if (current.rows.length === 0) throw new DigitalTwinSnapshotNotFoundError('DigitalTwinSnapshot', snapshotId);
      if (current.rows[0].status === 'published') {
        throw new DigitalTwinSnapshotImmutableError('DigitalTwinSnapshot', 'published snapshots cannot be superseded in place');
      }
      const result = await client.query<Record<string, unknown>>(
        `UPDATE business_digital_twin.digital_twin_snapshots SET status = 'superseded' WHERE id = $1 RETURNING *`,
        [snapshotId]
      );
      await client.query(
        `INSERT INTO business_digital_twin.digital_twin_snapshot_status_history
           (snapshot_id, tenant_id, workspace_id, business_id, from_status, to_status, correlation_id)
         VALUES ($1,$2,$3,$4,$5,'superseded',$6)`,
        [snapshotId, ctx.tenantId, ctx.workspaceId, result.rows[0].business_id, current.rows[0].status, randomUUID()]
      );
      return rowToSnapshot(result.rows[0]);
    });
  }

  async getById(ctx: TenantContext, id: string): Promise<DigitalTwinSnapshot> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>('SELECT * FROM business_digital_twin.digital_twin_snapshots WHERE id = $1', [id]);
      if (result.rows.length === 0) throw new DigitalTwinSnapshotNotFoundError('DigitalTwinSnapshot', id);
      return rowToSnapshot(result.rows[0]);
    });
  }

  /**
   * Read-only freshness assessment of a snapshot a recommendation was based on (P0-3, owner ruling Q3). Digital Twin
   * state is never mutated here. A recommendation is stale when a NEWER snapshot that has been PUBLISHED exists for the
   * same business after the snapshot it used; drafts, validated-but-unpublished and rejected snapshots do not count.
   * `usable` is false when the reference cannot be verified: unknown id, another business, or a snapshot that was
   * never published (callers must treat that as blocking, not as fresh).
   */
  async assessFreshness(ctx: TenantContext, businessId: string, snapshotId: string): Promise<{ usable: boolean; newerPublishedExists: boolean }> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<{ status: string; newer: boolean }>(
        `SELECT s.status,
                EXISTS (
                  SELECT 1 FROM business_digital_twin.digital_twin_snapshots n
                   WHERE n.business_id = s.business_id AND n.id <> s.id
                     AND n.status IN ('published','superseded') AND n.effective_at > s.effective_at
                ) AS newer
           FROM business_digital_twin.digital_twin_snapshots s
          WHERE s.id = $1 AND s.business_id = $2`,
        [snapshotId, businessId]
      );
      if (result.rows.length === 0) return { usable: false, newerPublishedExists: false };
      const row = result.rows[0];
      const wasPublished = row.status === 'published' || row.status === 'superseded';
      return { usable: wasPublished, newerPublishedExists: row.newer };
    });
  }

  async getPublishedForInstance(ctx: TenantContext, instanceId: string): Promise<DigitalTwinSnapshot[]> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT * FROM business_digital_twin.digital_twin_snapshots WHERE instance_id = $1 AND status = 'published' ORDER BY effective_at DESC`,
        [instanceId]
      );
      return result.rows.map(rowToSnapshot);
    });
  }

  /** Joins to the published version server-side — mirrors SimulationResultRepository.getMetricsForPublishedResult. */
  async getValuesForPublishedSnapshot(ctx: TenantContext, snapshotId: string): Promise<DigitalTwinSnapshotValue[]> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT v.variable_code, v.value_json, v.confidence
         FROM business_digital_twin.digital_twin_snapshot_values v
         JOIN business_digital_twin.digital_twin_snapshot_versions sv ON sv.id = v.snapshot_version_id
         WHERE sv.snapshot_id = $1 AND sv.status = 'published'`,
        [snapshotId]
      );
      return result.rows.map((row) => ({
        variableCode: row.variable_code as string,
        valueJson: row.value_json,
        confidence: row.confidence === null ? null : Number(row.confidence),
      }));
    });
  }
}
