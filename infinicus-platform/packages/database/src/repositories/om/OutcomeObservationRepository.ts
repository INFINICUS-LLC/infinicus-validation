import { randomUUID } from 'crypto';
import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';
import {
  OutcomeObservationNotFoundError,
  OutcomeObservationImmutableError,
} from './errors.js';

export interface OutcomeObservation {
  id: string;
  tenantId: string;
  workspaceId: string;
  businessId: string;
  monitoredActionId: string;
  observationCode: string;
  status: string;
  latestVersion: number;
}

export interface OutcomeObservationVersion {
  id: string;
  observationId: string;
  versionNumber: number;
  summary: string;
  status: string;
  effectiveAt: Date;
  recordedAt: Date;
  correlationId: string;
}

const DECIDED_STATUSES = new Set(['recorded', 'verified', 'disputed']);

function rowToObservation(row: Record<string, unknown>): OutcomeObservation {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    workspaceId: row.workspace_id as string,
    businessId: row.business_id as string,
    monitoredActionId: row.monitored_action_id as string,
    observationCode: row.observation_code as string,
    status: row.status as string,
    latestVersion: row.latest_version as number,
  };
}

function rowToVersion(row: Record<string, unknown>): OutcomeObservationVersion {
  return {
    id: row.id as string,
    observationId: row.observation_id as string,
    versionNumber: row.version_number as number,
    summary: row.summary as string,
    status: row.status as string,
    effectiveAt: row.effective_at as Date,
    recordedAt: row.recorded_at as Date,
    correlationId: row.correlation_id as string,
  };
}

export class OutcomeObservationRepository {
  async createObservation(ctx: TenantContext, businessId: string, monitoredActionId: string, observationCode: string, summary: string, effectiveAt: Date): Promise<{ observation: OutcomeObservation; version: OutcomeObservationVersion }> {
    return withTenantTransaction(ctx, async (client) => {
      const obsRow = await client.query<Record<string, unknown>>(
        `INSERT INTO outcome_monitoring.outcome_observations (tenant_id, workspace_id, business_id, monitored_action_id, observation_code, latest_version)
         VALUES ($1,$2,$3,$4,$5,1) RETURNING *`,
        [ctx.tenantId, ctx.workspaceId, businessId, monitoredActionId, observationCode]
      );
      const correlationId = randomUUID();
      const versionResult = await client.query<Record<string, unknown>>(
        `INSERT INTO outcome_monitoring.outcome_observation_versions (observation_id, tenant_id, workspace_id, business_id, version_number, summary, effective_at, correlation_id)
         VALUES ($1,$2,$3,$4,1,$5,$6,$7) RETURNING *`,
        [obsRow.rows[0].id, ctx.tenantId, ctx.workspaceId, businessId, summary, effectiveAt, correlationId]
      );
      return { observation: rowToObservation(obsRow.rows[0]), version: rowToVersion(versionResult.rows[0]) };
    });
  }

  async addMeasurement(ctx: TenantContext, observationVersionId: string, businessId: string, metricCode: string, measuredValue: Record<string, unknown>, unit: string | null = null): Promise<void> {
    return withTenantTransaction(ctx, async (client) => {
      await client.query(
        `INSERT INTO outcome_monitoring.outcome_measurements (observation_version_id, tenant_id, workspace_id, business_id, metric_code, measured_value, unit)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [observationVersionId, ctx.tenantId, ctx.workspaceId, businessId, metricCode, JSON.stringify(measuredValue), unit]
      );
    });
  }

  async addEvidence(ctx: TenantContext, observationVersionId: string, businessId: string, evidenceType: string, evidenceReference: Record<string, unknown>): Promise<void> {
    return withTenantTransaction(ctx, async (client) => {
      await client.query(
        `INSERT INTO outcome_monitoring.outcome_evidence (observation_version_id, tenant_id, workspace_id, business_id, evidence_type, evidence_reference)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [observationVersionId, ctx.tenantId, ctx.workspaceId, businessId, evidenceType, JSON.stringify(evidenceReference)]
      );
    });
  }

  private async decide(ctx: TenantContext, observationId: string, observationVersionId: string, toStatus: string): Promise<OutcomeObservation> {
    return withTenantTransaction(ctx, async (client) => {
      const current = await client.query<Record<string, unknown>>('SELECT * FROM outcome_monitoring.outcome_observations WHERE id = $1', [observationId]);
      if (current.rows.length === 0) throw new OutcomeObservationNotFoundError('OutcomeObservation', observationId);
      if (DECIDED_STATUSES.has(current.rows[0].status as string)) {
        throw new OutcomeObservationImmutableError('OutcomeObservation', 'recorded observations cannot be re-recorded');
      }
      const result = await client.query<Record<string, unknown>>(
        `UPDATE outcome_monitoring.outcome_observations SET status = $2 WHERE id = $1 RETURNING *`,
        [observationId, toStatus]
      );
      await client.query(`UPDATE outcome_monitoring.outcome_observation_versions SET status = $2 WHERE id = $1`, [observationVersionId, toStatus]);
      return rowToObservation(result.rows[0]);
    });
  }

  /** OM observes and evaluates; it does not silently rewrite historical decisions. Recorded observations are permanently immutable. */
  async record(ctx: TenantContext, observationId: string, observationVersionId: string): Promise<OutcomeObservation> {
    return this.decide(ctx, observationId, observationVersionId, 'recorded');
  }

  async verify(ctx: TenantContext, observationId: string, observationVersionId: string): Promise<OutcomeObservation> {
    return this.decide(ctx, observationId, observationVersionId, 'verified');
  }

  async dispute(ctx: TenantContext, observationId: string, observationVersionId: string): Promise<OutcomeObservation> {
    return this.decide(ctx, observationId, observationVersionId, 'disputed');
  }

  /** Only legal before an observation is recorded — recorded observations are immutable (enforced by the database trigger). */
  async supersede(ctx: TenantContext, observationId: string): Promise<OutcomeObservation> {
    return withTenantTransaction(ctx, async (client) => {
      const current = await client.query<Record<string, unknown>>('SELECT * FROM outcome_monitoring.outcome_observations WHERE id = $1', [observationId]);
      if (current.rows.length === 0) throw new OutcomeObservationNotFoundError('OutcomeObservation', observationId);
      if (DECIDED_STATUSES.has(current.rows[0].status as string)) {
        throw new OutcomeObservationImmutableError('OutcomeObservation', 'recorded observations cannot be superseded in place');
      }
      const result = await client.query<Record<string, unknown>>(
        `UPDATE outcome_monitoring.outcome_observations SET status = 'superseded' WHERE id = $1 RETURNING *`,
        [observationId]
      );
      return rowToObservation(result.rows[0]);
    });
  }

  async getById(ctx: TenantContext, id: string): Promise<OutcomeObservation> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>('SELECT * FROM outcome_monitoring.outcome_observations WHERE id = $1', [id]);
      if (result.rows.length === 0) throw new OutcomeObservationNotFoundError('OutcomeObservation', id);
      return rowToObservation(result.rows[0]);
    });
  }

  async getDecidedForAction(ctx: TenantContext, monitoredActionId: string): Promise<OutcomeObservation[]> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT * FROM outcome_monitoring.outcome_observations WHERE monitored_action_id = $1 AND status IN ('recorded','verified','disputed') ORDER BY created_at DESC`,
        [monitoredActionId]
      );
      return result.rows.map(rowToObservation);
    });
  }

  async listForBusiness(ctx: TenantContext, businessId: string): Promise<OutcomeObservation[]> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        'SELECT * FROM outcome_monitoring.outcome_observations WHERE business_id = $1 ORDER BY created_at DESC', [businessId]
      );
      return result.rows.map(rowToObservation);
    });
  }

  /**
   * Bulk text lookup for getHistory(): for each monitored action, the summary
   * of its most recently recorded/verified/disputed observation (there can be
   * more than one observation per monitored action over time — DISTINCT ON
   * picks the newest). A monitored action with no decided observation yet is
   * simply absent from the result — callers index by monitoredActionId.
   */
  async listLatestDecidedForActions(ctx: TenantContext, monitoredActionIds: string[]): Promise<Array<{ monitoredActionId: string; summary: string; recordedAt: Date }>> {
    if (monitoredActionIds.length === 0) return [];
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT DISTINCT ON (o.monitored_action_id)
           o.monitored_action_id AS monitored_action_id, v.summary AS summary, v.recorded_at AS recorded_at
         FROM outcome_monitoring.outcome_observations o
         JOIN outcome_monitoring.outcome_observation_versions v
           ON v.observation_id = o.id AND v.version_number = o.latest_version
         WHERE o.monitored_action_id = ANY($1::uuid[]) AND o.status IN ('recorded','verified','disputed')
         ORDER BY o.monitored_action_id, v.recorded_at DESC`,
        [monitoredActionIds]
      );
      return result.rows.map(row => ({
        monitoredActionId: row.monitored_action_id as string,
        summary: row.summary as string,
        recordedAt: row.recorded_at as Date,
      }));
    });
  }
}
