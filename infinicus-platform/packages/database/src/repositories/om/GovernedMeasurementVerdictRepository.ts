import type { Pool } from 'pg';
import type { TenantContext } from '../../client.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export interface GovernedMeasurementAssessmentInput {
  verificationId: string;
  definitionId: string | null;
  state: 'OUTCOME_PENDING' | 'OUTCOME_INCONCLUSIVE';
  reason: string;
  sourceDigest: string | null;
  assessmentDigest: string;
  runnerServiceAccountId: string;
}

/** Append-only assessment writer. The injected pool must authenticate as a dedicated, non-bypass OM runner role. */
export class GovernedMeasurementVerdictRepository {
  constructor(private readonly runnerPool: Pool, private readonly expectedDatabaseRole: string) {
    if (!/^[a-z_][a-z0-9_]*$/.test(expectedDatabaseRole)) throw new Error('invalid OM runner database role');
  }

  async record(ctx: TenantContext, businessId: string, assessment: GovernedMeasurementAssessmentInput): Promise<{ id: string; created: boolean }> {
    if (!UUID.test(businessId) || !UUID.test(assessment.verificationId) ||
      (assessment.definitionId !== null && !UUID.test(assessment.definitionId)) || !UUID.test(assessment.runnerServiceAccountId) ||
      !DIGEST.test(assessment.assessmentDigest) || (assessment.sourceDigest !== null && !DIGEST.test(assessment.sourceDigest))) {
      throw new Error('malformed governed measurement assessment');
    }
    const inputDigest = assessment.sourceDigest ?? assessment.assessmentDigest;
    const client = await this.runnerPool.connect();
    try {
      await client.query('BEGIN');
      const role = await client.query<{ name: string; rolsuper: boolean; rolbypassrls: boolean }>(
        `SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
      if (role.rows[0]?.name !== this.expectedDatabaseRole || role.rows[0].rolsuper || role.rows[0].rolbypassrls) {
        throw new Error('OM runner requires its dedicated least-privilege database role');
      }
      await client.query('SELECT set_config($1,$2,true), set_config($3,$4,true)',
        ['app.tenant_id', ctx.tenantId, 'app.workspace_id', ctx.workspaceId]);
      const values = [ctx.tenantId, ctx.workspaceId, businessId, assessment.verificationId,
        assessment.definitionId, assessment.state, assessment.reason, inputDigest,
        assessment.assessmentDigest, assessment.runnerServiceAccountId];
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO outcome_monitoring.governed_outcome_verdicts
          (tenant_id, workspace_id, business_id, execution_verification_id, definition_id,
           outcome_state, reason_code, input_digest, verdict_digest, runner_service_account_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT DO NOTHING RETURNING id`, values);
      const id = inserted.rows[0]?.id ?? (await client.query<{ id: string }>(
        `SELECT id FROM outcome_monitoring.governed_outcome_verdicts
          WHERE tenant_id = $1 AND workspace_id = $2 AND business_id = $3
            AND execution_verification_id = $4
            AND coalesce(definition_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce($5::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
            AND outcome_state = $6 AND reason_code = $7 AND input_digest = $8 AND verdict_digest = $9
            AND runner_service_account_id = $10`, values)).rows[0]?.id;
      if (!id) throw new Error('governed measurement idempotency conflict');
      await client.query('COMMIT');
      return { id, created: inserted.rows.length === 1 };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
