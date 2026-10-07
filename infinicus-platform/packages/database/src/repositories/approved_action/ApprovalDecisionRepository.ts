import { randomUUID } from 'crypto';
import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';
import {
  ApprovalDecisionNotFoundError,
  ApprovalDecisionImmutableError,
} from './errors.js';

export interface ApprovalDecision {
  id: string;
  tenantId: string;
  workspaceId: string;
  businessId: string;
  reviewPackageId: string;
  approverAssignmentId: string;
  decisionCode: string;
  status: string;
  latestVersion: number;
}

export interface DecisionAudit {
  eventType: string;
  detail: Record<string, unknown>;
}

export interface ApprovalDecisionVersion {
  id: string;
  decisionId: string;
  versionNumber: number;
  summary: string;
  status: string;
  correlationId: string;
}

const DECIDED_STATUSES = new Set(['approved', 'approved_with_modifications', 'rejected']);

function rowToDecision(row: Record<string, unknown>): ApprovalDecision {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    workspaceId: row.workspace_id as string,
    businessId: row.business_id as string,
    reviewPackageId: row.review_package_id as string,
    approverAssignmentId: row.approver_assignment_id as string,
    decisionCode: row.decision_code as string,
    status: row.status as string,
    latestVersion: row.latest_version as number,
  };
}

function rowToVersion(row: Record<string, unknown>): ApprovalDecisionVersion {
  return {
    id: row.id as string,
    decisionId: row.decision_id as string,
    versionNumber: row.version_number as number,
    summary: row.summary as string,
    status: row.status as string,
    correlationId: row.correlation_id as string,
  };
}

export class ApprovalDecisionRepository {
  async createDecision(ctx: TenantContext, businessId: string, reviewPackageId: string, approverAssignmentId: string, decisionCode: string, summary: string): Promise<{ decision: ApprovalDecision; version: ApprovalDecisionVersion }> {
    return withTenantTransaction(ctx, async (client) => {
      const decRow = await client.query<Record<string, unknown>>(
        `INSERT INTO approved_business_action.approval_decisions (tenant_id, workspace_id, business_id, review_package_id, approver_assignment_id, decision_code, latest_version)
         VALUES ($1,$2,$3,$4,$5,$6,1) RETURNING *`,
        [ctx.tenantId, ctx.workspaceId, businessId, reviewPackageId, approverAssignmentId, decisionCode]
      );
      const correlationId = randomUUID();
      const versionResult = await client.query<Record<string, unknown>>(
        `INSERT INTO approved_business_action.approval_decision_versions (decision_id, tenant_id, workspace_id, business_id, version_number, summary, correlation_id)
         VALUES ($1,$2,$3,$4,1,$5,$6) RETURNING *`,
        [decRow.rows[0].id, ctx.tenantId, ctx.workspaceId, businessId, summary, correlationId]
      );
      return { decision: rowToDecision(decRow.rows[0]), version: rowToVersion(versionResult.rows[0]) };
    });
  }

  async addRationale(ctx: TenantContext, decisionVersionId: string, businessId: string, rationaleCode: string, statement: string, evidenceReference: Record<string, unknown> = {}): Promise<void> {
    return withTenantTransaction(ctx, async (client) => {
      await client.query(
        `INSERT INTO approved_business_action.approval_decision_rationales (decision_version_id, tenant_id, workspace_id, business_id, rationale_code, statement, evidence_reference)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [decisionVersionId, ctx.tenantId, ctx.workspaceId, businessId, rationaleCode, statement, JSON.stringify(evidenceReference)]
      );
    });
  }

  async addModification(ctx: TenantContext, decisionVersionId: string, businessId: string, modificationCode: string, description: string): Promise<void> {
    return withTenantTransaction(ctx, async (client) => {
      await client.query(
        `INSERT INTO approved_business_action.approval_decision_modifications (decision_version_id, tenant_id, workspace_id, business_id, modification_code, description)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [decisionVersionId, ctx.tenantId, ctx.workspaceId, businessId, modificationCode, description]
      );
    });
  }

  /** An audit event written atomically with the decision: if it cannot be written, the decision is not finalised. */
  private async decide(ctx: TenantContext, decisionId: string, decisionVersionId: string, toStatus: string, audit?: DecisionAudit): Promise<ApprovalDecision> {
    return withTenantTransaction(ctx, async (client) => {
      const current = await client.query<Record<string, unknown>>('SELECT * FROM approved_business_action.approval_decisions WHERE id = $1', [decisionId]);
      if (current.rows.length === 0) throw new ApprovalDecisionNotFoundError('ApprovalDecision', decisionId);
      if (DECIDED_STATUSES.has(current.rows[0].status as string)) {
        throw new ApprovalDecisionImmutableError('ApprovalDecision', 'decided decisions cannot be redecided');
      }
      const result = await client.query<Record<string, unknown>>(
        `UPDATE approved_business_action.approval_decisions SET status = $2 WHERE id = $1 RETURNING *`,
        [decisionId, toStatus]
      );
      await client.query(`UPDATE approved_business_action.approval_decision_versions SET status = $2 WHERE id = $1`, [decisionVersionId, toStatus]);
      if (audit) {
        await client.query(
          `INSERT INTO approved_business_action.approval_audit_events (tenant_id, workspace_id, business_id, decision_id, event_type, detail)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [ctx.tenantId, ctx.workspaceId, result.rows[0].business_id, decisionId, audit.eventType, JSON.stringify(audit.detail)]
        );
      }
      return rowToDecision(result.rows[0]);
    });
  }

  /** Approval is distinct from execution — this only records the decision. No external business action is executed here. */
  async approve(ctx: TenantContext, decisionId: string, decisionVersionId: string, audit?: DecisionAudit): Promise<ApprovalDecision> {
    return this.decide(ctx, decisionId, decisionVersionId, 'approved', audit);
  }

  async approveWithModifications(ctx: TenantContext, decisionId: string, decisionVersionId: string, audit?: DecisionAudit): Promise<ApprovalDecision> {
    return this.decide(ctx, decisionId, decisionVersionId, 'approved_with_modifications', audit);
  }

  async reject(ctx: TenantContext, decisionId: string, decisionVersionId: string, audit?: DecisionAudit): Promise<ApprovalDecision> {
    return this.decide(ctx, decisionId, decisionVersionId, 'rejected', audit);
  }

  /** Only legal before a decision is made — decided decisions are immutable (enforced by the database trigger). */
  async supersede(ctx: TenantContext, decisionId: string): Promise<ApprovalDecision> {
    return withTenantTransaction(ctx, async (client) => {
      const current = await client.query<Record<string, unknown>>('SELECT * FROM approved_business_action.approval_decisions WHERE id = $1', [decisionId]);
      if (current.rows.length === 0) throw new ApprovalDecisionNotFoundError('ApprovalDecision', decisionId);
      if (DECIDED_STATUSES.has(current.rows[0].status as string)) {
        throw new ApprovalDecisionImmutableError('ApprovalDecision', 'decided decisions cannot be superseded in place');
      }
      const result = await client.query<Record<string, unknown>>(
        `UPDATE approved_business_action.approval_decisions SET status = 'superseded' WHERE id = $1 RETURNING *`,
        [decisionId]
      );
      return rowToDecision(result.rows[0]);
    });
  }

  async getById(ctx: TenantContext, id: string): Promise<ApprovalDecision> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>('SELECT * FROM approved_business_action.approval_decisions WHERE id = $1', [id]);
      if (result.rows.length === 0) throw new ApprovalDecisionNotFoundError('ApprovalDecision', id);
      return rowToDecision(result.rows[0]);
    });
  }

  async getDecidedForReview(ctx: TenantContext, reviewPackageId: string): Promise<ApprovalDecision[]> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT * FROM approved_business_action.approval_decisions WHERE review_package_id = $1 AND status IN ('approved','approved_with_modifications','rejected') ORDER BY created_at DESC`,
        [reviewPackageId]
      );
      return result.rows.map(rowToDecision);
    });
  }
}
