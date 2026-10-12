// P0-6d - Outcome Monitoring persistence for execution VERIFICATIONS (table from migration 0194).
//
// OM-OWNED storage only. It records that a Business Operations execution fact was verified (a reference + digest, never a copy of the
// evidence) and OM's own initial outcome verdict. It reads and writes no Business Operations table, offers no UPDATE or DELETE (the table
// is append-only for every role), and judges nothing: the caller supplies the verified facts and the verdict, the database refuses any
// verdict the vocabulary does not yet allow (OBSERVED / VERIFIED / FAILED outcomes need an authoritative measurement model).

import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';

/** The verification cannot be recorded: an invalid identifier, or a different evidence digest is already verified for the execution. */
export class ActionExecutionVerificationConflictError extends Error {
  constructor(reason: string) {
    super(`ActionExecutionVerification conflict: ${reason}`);
    this.name = 'ActionExecutionVerificationConflictError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const S = 'outcome_monitoring';
type Json = Record<string, unknown>;

export interface ActionExecutionVerification {
  id: string;
  tenantId: string;
  workspaceId: string;
  businessId: string;
  executionId: string;
  sourceEventId: string;
  contractVersion: string;
  evidenceDigest: string;
  packageId: string;
  packageVersion: number;
  claimId: string;
  approvedActionId: string | null;
  monitoredActionId: string | null;
  actionType: { code: string; schemaVersion: string };
  target: { kind: string; id: string };
  executionOutcome: 'SUCCEEDED' | 'REFUSED' | 'FAILED';
  mutationResult: 'APPLIED' | 'NO_CHANGE' | 'NOT_APPLICABLE';
  executionRecordedAt: string;
  executionState: string;
  outcomeState: string;
  outcomeStateReason: string;
  verifiedAt: string;
  correlationId: string;
  causationId: string | null;
}

export interface RecordExecutionVerificationInput {
  businessId: string;
  executionId: string;
  sourceEventId: string;
  contractVersion: string;
  evidenceDigest: string;
  packageId: string;
  packageVersion: number;
  claimId: string;
  approvedActionId: string | null;
  actionType: { code: string; schemaVersion: string };
  target: { kind: string; id: string };
  executionOutcome: ActionExecutionVerification['executionOutcome'];
  mutationResult: ActionExecutionVerification['mutationResult'];
  executionRecordedAt: string;
  outcomeState: string;
  outcomeStateReason: string;
  correlationId: string;
  causationId: string | null;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

function rowToVerification(r: Json): ActionExecutionVerification {
  return {
    id: r.id as string, tenantId: r.tenant_id as string, workspaceId: r.workspace_id as string, businessId: r.business_id as string,
    executionId: r.execution_id as string, sourceEventId: r.source_event_id as string, contractVersion: r.contract_version as string,
    evidenceDigest: r.evidence_digest as string, packageId: r.package_id as string, packageVersion: r.package_version as number, claimId: r.claim_id as string,
    approvedActionId: (r.approved_action_id as string | null) ?? null, monitoredActionId: (r.monitored_action_id as string | null) ?? null,
    actionType: { code: r.action_type_code as string, schemaVersion: r.action_type_schema_version as string },
    target: { kind: r.target_kind as string, id: r.target_id as string },
    executionOutcome: r.execution_outcome as ActionExecutionVerification['executionOutcome'], mutationResult: r.mutation_result as ActionExecutionVerification['mutationResult'],
    executionRecordedAt: iso(r.execution_recorded_at), executionState: r.execution_state as string, outcomeState: r.outcome_state as string,
    outcomeStateReason: r.outcome_state_reason as string, verifiedAt: iso(r.verified_at), correlationId: r.correlation_id as string,
    causationId: (r.causation_id as string | null) ?? null,
  };
}

export class ActionExecutionVerificationRepository {
  /**
   * Records the verification of one execution, idempotently. The same execution verified again returns the stored row (`created: false`);
   * the same execution presented with a DIFFERENT evidence digest is a ConflictError (a forged or substituted reference), and nothing is written.
   * OM's monitored action for the approved action is linked when - and only when - it already exists (nothing is created here).
   */
  async record(ctx: TenantContext, input: RecordExecutionVerificationInput): Promise<{ verification: ActionExecutionVerification; created: boolean }> {
    for (const [name, value] of [['businessId', input.businessId], ['executionId', input.executionId], ['sourceEventId', input.sourceEventId], ['packageId', input.packageId], ['claimId', input.claimId], ['correlationId', input.correlationId]] as const) {
      if (!UUID.test(value)) throw new ActionExecutionVerificationConflictError(`${name} must be a lowercase UUID`);
    }
    return withTenantTransaction(ctx, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`om_action_execution_verification:${input.businessId}:${input.executionId}`]);
      const existing = await client.query<Json>(`SELECT * FROM ${S}.action_execution_verifications WHERE business_id = $1 AND execution_id = $2`, [input.businessId, input.executionId]);
      if (existing.rows[0]) {
        if (existing.rows[0].evidence_digest !== input.evidenceDigest) throw new ActionExecutionVerificationConflictError('a different evidence digest is already verified for this execution');
        return { verification: rowToVerification(existing.rows[0]), created: false };
      }
      let monitoredActionId: string | null = null;
      if (input.approvedActionId !== null) {
        const m = await client.query<{ id: string }>(`SELECT id FROM ${S}.monitored_actions WHERE business_id = $1 AND approved_action_id = $2`, [input.businessId, input.approvedActionId]);
        monitoredActionId = m.rows[0]?.id ?? null;
      }
      const r = await client.query<Json>(
        `INSERT INTO ${S}.action_execution_verifications
           (tenant_id, workspace_id, business_id, execution_id, source_event_id, contract_version, evidence_digest, package_id, package_version, claim_id,
            approved_action_id, monitored_action_id, action_type_code, action_type_schema_version, target_kind, target_id, execution_outcome, mutation_result,
            execution_recorded_at, execution_state, outcome_state, outcome_state_reason, correlation_id, causation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'EXECUTION_VERIFIED',$20,$21,$22,$23)
         RETURNING *`,
        [
          ctx.tenantId, ctx.workspaceId, input.businessId, input.executionId, input.sourceEventId, input.contractVersion, input.evidenceDigest, input.packageId, input.packageVersion,
          input.claimId, input.approvedActionId, monitoredActionId, input.actionType.code, input.actionType.schemaVersion, input.target.kind, input.target.id,
          input.executionOutcome, input.mutationResult, input.executionRecordedAt, input.outcomeState, input.outcomeStateReason, input.correlationId, input.causationId,
        ],
      );
      return { verification: rowToVerification(r.rows[0]), created: true };
    });
  }

  async getByExecution(ctx: TenantContext, businessId: string, executionId: string): Promise<ActionExecutionVerification | null> {
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<Json>(`SELECT * FROM ${S}.action_execution_verifications WHERE business_id = $1 AND execution_id = $2`, [businessId, executionId]);
      return r.rows[0] ? rowToVerification(r.rows[0]) : null;
    });
  }
}
