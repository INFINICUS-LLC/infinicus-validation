import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';

/** Immutable approved definition, read from OM authority storage only. Numeric is returned as a decimal string. */
export interface GovernedMeasurementDefinition {
  id: string;
  businessId: string;
  actionTypeCode: string;
  actionTypeSchemaVersion: string;
  metricCode: string;
  definitionVersion: number;
  windowSeconds: number;
  baselineSeconds: number;
  minimumObservations: number;
  attributionRuleCode: string;
  successDirection: 'increase' | 'decrease';
  successThreshold: string;
  authorId: string;
  approverId: string;
  approvedAt: string;
}
export interface GovernedDefinitionPage { definitions: GovernedMeasurementDefinition[]; truncated: boolean }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class GovernedMeasurementDefinitionRepository {
  async listApproved(ctx: TenantContext, businessId: string): Promise<GovernedDefinitionPage> {
    if (!UUID.test(businessId)) return { definitions: [], truncated: false };
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT id, business_id, action_type_code, action_type_schema_version, metric_code,
                definition_version, window_seconds, baseline_seconds, minimum_observations,
                attribution_rule_code, success_direction, success_threshold::text AS success_threshold,
                author_id, approver_id, approved_at
           FROM outcome_monitoring.governed_measurement_definitions
          WHERE business_id = $1
          ORDER BY action_type_code, metric_code, definition_version DESC, id
          LIMIT 101`, [businessId]);
      return { truncated: result.rows.length > 100, definitions: result.rows.slice(0, 100).map((row) => ({
        id: row.id as string,
        businessId: row.business_id as string,
        actionTypeCode: row.action_type_code as string,
        actionTypeSchemaVersion: row.action_type_schema_version as string,
        metricCode: row.metric_code as string,
        definitionVersion: row.definition_version as number,
        windowSeconds: row.window_seconds as number,
        baselineSeconds: row.baseline_seconds as number,
        minimumObservations: row.minimum_observations as number,
        attributionRuleCode: row.attribution_rule_code as string,
        successDirection: row.success_direction as 'increase' | 'decrease',
        successThreshold: row.success_threshold as string,
        authorId: row.author_id as string,
        approverId: row.approver_id as string,
        approvedAt: (row.approved_at as Date).toISOString(),
      })) };
    });
  }
}
