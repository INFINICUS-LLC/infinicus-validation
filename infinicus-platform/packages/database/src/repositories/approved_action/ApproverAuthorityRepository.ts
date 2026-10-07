import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';
import { ApproverAuthorityNotFoundError, ValidationError } from './errors.js';
import { PROVENANCE_SCOPE_TYPE, type AuthorityProvenanceEntry } from './authorityProvenance.js';

export interface ApproverAssignment {
  id: string;
  tenantId: string;
  workspaceId: string;
  businessId: string;
  userId: string;
  assignmentCode: string;
  status: string;
  latestVersion: number;
}

export interface ApprovalDelegation {
  id: string;
  delegatorUserId: string;
  delegateUserId: string;
  assignmentId: string;
  status: string;
  startsAt: Date;
  endsAt: Date | null;
}

const ASSIGNMENT_STATUSES = ['draft', 'active', 'revoked'];
const DELEGATION_STATUSES = ['active', 'revoked', 'expired'];

function rowToAssignment(row: Record<string, unknown>): ApproverAssignment {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    workspaceId: row.workspace_id as string,
    businessId: row.business_id as string,
    userId: row.user_id as string,
    assignmentCode: row.assignment_code as string,
    status: row.status as string,
    latestVersion: row.latest_version as number,
  };
}

function rowToDelegation(row: Record<string, unknown>): ApprovalDelegation {
  return {
    id: row.id as string,
    delegatorUserId: row.delegator_user_id as string,
    delegateUserId: row.delegate_user_id as string,
    assignmentId: row.assignment_id as string,
    status: row.status as string,
    startsAt: row.starts_at as Date,
    endsAt: row.ends_at as Date | null,
  };
}

export class ApproverAuthorityRepository {
  async createAssignment(ctx: TenantContext, businessId: string, userId: string, assignmentCode: string): Promise<ApproverAssignment> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `INSERT INTO approved_business_action.approver_assignments (tenant_id, workspace_id, business_id, user_id, assignment_code)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [ctx.tenantId, ctx.workspaceId, businessId, userId, assignmentCode]
      );
      return rowToAssignment(result.rows[0]);
    });
  }

  async createVersion(ctx: TenantContext, assignmentId: string, businessId: string, roleCode: string): Promise<{ id: string; versionNumber: number }> {
    return withTenantTransaction(ctx, async (client) => {
      const a = await client.query<Record<string, unknown>>('SELECT * FROM approved_business_action.approver_assignments WHERE id = $1', [assignmentId]);
      if (a.rows.length === 0) throw new ApproverAuthorityNotFoundError('ApproverAssignment', assignmentId);
      const nextVersion = (a.rows[0].latest_version as number) + 1;
      const result = await client.query<Record<string, unknown>>(
        `INSERT INTO approved_business_action.approver_assignment_versions
           (assignment_id, tenant_id, workspace_id, business_id, version_number, role_code, correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,gen_random_uuid()) RETURNING id, version_number`,
        [assignmentId, ctx.tenantId, ctx.workspaceId, businessId, nextVersion, roleCode]
      );
      await client.query('UPDATE approved_business_action.approver_assignments SET latest_version = $2 WHERE id = $1', [assignmentId, nextVersion]);
      return { id: result.rows[0].id as string, versionNumber: result.rows[0].version_number as number };
    });
  }

  async addAuthorityScope(ctx: TenantContext, assignmentVersionId: string, businessId: string, scopeType: string, scopeValue: unknown): Promise<void> {
    return withTenantTransaction(ctx, async (client) => {
      await client.query(
        `INSERT INTO approved_business_action.approval_authority_scopes (assignment_version_id, tenant_id, workspace_id, business_id, scope_type, scope_value)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [assignmentVersionId, ctx.tenantId, ctx.workspaceId, businessId, scopeType, JSON.stringify(scopeValue)]
      );
    });
  }

  async transitionStatus(ctx: TenantContext, assignmentId: string, toStatus: string): Promise<ApproverAssignment> {
    if (!ASSIGNMENT_STATUSES.includes(toStatus)) {
      throw new ValidationError('ApproverAssignment', [`unknown status: ${toStatus}`]);
    }
    return withTenantTransaction(ctx, async (client) => {
      const current = await client.query<Record<string, unknown>>('SELECT * FROM approved_business_action.approver_assignments WHERE id = $1', [assignmentId]);
      if (current.rows.length === 0) throw new ApproverAuthorityNotFoundError('ApproverAssignment', assignmentId);
      const result = await client.query<Record<string, unknown>>(
        `UPDATE approved_business_action.approver_assignments SET status = $2 WHERE id = $1 RETURNING *`,
        [assignmentId, toStatus]
      );
      return rowToAssignment(result.rows[0]);
    });
  }

  async createDelegation(ctx: TenantContext, businessId: string, delegatorUserId: string, delegateUserId: string, assignmentId: string, endsAt?: Date): Promise<ApprovalDelegation> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `INSERT INTO approved_business_action.approval_delegations
           (tenant_id, workspace_id, business_id, delegator_user_id, delegate_user_id, assignment_id, ends_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [ctx.tenantId, ctx.workspaceId, businessId, delegatorUserId, delegateUserId, assignmentId, endsAt ?? null]
      );
      return rowToDelegation(result.rows[0]);
    });
  }

  async transitionDelegationStatus(ctx: TenantContext, delegationId: string, toStatus: string): Promise<ApprovalDelegation> {
    if (!DELEGATION_STATUSES.includes(toStatus)) {
      throw new ValidationError('ApprovalDelegation', [`unknown status: ${toStatus}`]);
    }
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `UPDATE approved_business_action.approval_delegations SET status = $2 WHERE id = $1 RETURNING *`,
        [delegationId, toStatus]
      );
      if (result.rows.length === 0) throw new ApproverAuthorityNotFoundError('ApprovalDelegation', delegationId);
      return rowToDelegation(result.rows[0]);
    });
  }

  /**
   * Looks up an ALREADY-ESTABLISHED, active approval authority for a user.
   * Read-only by design: approval authority must be issued beforehand by an
   * authoritative source (see DecisionWorkflowService.grantApproverAuthority)
   * and is only ever checked, never created, at decision time.
   */
  async findActiveForUser(ctx: TenantContext, businessId: string, userId: string, assignmentCode: string): Promise<ApproverAssignment | null> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT * FROM approved_business_action.approver_assignments
          WHERE business_id = $1 AND user_id = $2 AND assignment_code = $3 AND status = 'active'`,
        [businessId, userId, assignmentCode]
      );
      return result.rows.length === 0 ? null : rowToAssignment(result.rows[0]);
    });
  }

  /** Finds the assignment holding `assignmentCode` for a business, in any status. The code is unique per business. */
  async findByCode(ctx: TenantContext, businessId: string, assignmentCode: string): Promise<ApproverAssignment | null> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT * FROM approved_business_action.approver_assignments WHERE business_id = $1 AND assignment_code = $2`,
        [businessId, assignmentCode]
      );
      return result.rows.length === 0 ? null : rowToAssignment(result.rows[0]);
    });
  }

  /**
   * Creates an ACTIVE assignment together with its first version and its
   * grant provenance entry in ONE transaction, so there is never a half-made
   * assignment. Idempotent: if the code already exists for the business
   * (including under a concurrent request) nothing is written and the
   * existing assignment is returned with `created: false`.
   */
  async grantActiveAssignment(
    ctx: TenantContext,
    input: { businessId: string; userId: string; assignmentCode: string; roleCode: string; provenance: Omit<AuthorityProvenanceEntry, 'assignmentId'> }
  ): Promise<{ assignment: ApproverAssignment; created: boolean }> {
    try {
      return await withTenantTransaction(ctx, async (client) => {
        const inserted = await client.query<Record<string, unknown>>(
          `INSERT INTO approved_business_action.approver_assignments
             (tenant_id, workspace_id, business_id, user_id, assignment_code, status, latest_version)
           VALUES ($1,$2,$3,$4,$5,'active',1) RETURNING *`,
          [ctx.tenantId, ctx.workspaceId, input.businessId, input.userId, input.assignmentCode]
        );
        const assignment = rowToAssignment(inserted.rows[0]);
        const version = await client.query<Record<string, unknown>>(
          `INSERT INTO approved_business_action.approver_assignment_versions
             (assignment_id, tenant_id, workspace_id, business_id, version_number, role_code, correlation_id)
           VALUES ($1,$2,$3,$4,1,$5,gen_random_uuid()) RETURNING id`,
          [assignment.id, ctx.tenantId, ctx.workspaceId, input.businessId, input.roleCode]
        );
        const entry: AuthorityProvenanceEntry = { ...input.provenance, assignmentId: assignment.id };
        await client.query(
          `INSERT INTO approved_business_action.approval_authority_scopes
             (assignment_version_id, tenant_id, workspace_id, business_id, scope_type, scope_value)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [version.rows[0].id, ctx.tenantId, ctx.workspaceId, input.businessId, PROVENANCE_SCOPE_TYPE, JSON.stringify(entry)]
        );
        return { assignment, created: true };
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        const existing = await this.findByCode(ctx, input.businessId, input.assignmentCode);
        if (existing) return { assignment: existing, created: false };
      }
      throw err;
    }
  }

  /**
   * Revokes an assignment and appends the revocation provenance entry in ONE
   * transaction. Idempotent: an already-revoked assignment is left as is.
   */
  async revokeAssignment(
    ctx: TenantContext,
    assignmentId: string,
    provenance: Omit<AuthorityProvenanceEntry, 'assignmentId' | 'businessId' | 'assignmentCode' | 'granteeUserId' | 'state' | 'action'>
  ): Promise<{ assignment: ApproverAssignment; changed: boolean }> {
    return withTenantTransaction(ctx, async (client) => {
      const current = await client.query<Record<string, unknown>>(
        'SELECT * FROM approved_business_action.approver_assignments WHERE id = $1 FOR UPDATE', [assignmentId]
      );
      if (current.rows.length === 0) throw new ApproverAuthorityNotFoundError('ApproverAssignment', assignmentId);
      const before = rowToAssignment(current.rows[0]);
      if (before.status === 'revoked') return { assignment: before, changed: false };

      const version = await client.query<Record<string, unknown>>(
        `SELECT id FROM approved_business_action.approver_assignment_versions
          WHERE assignment_id = $1 ORDER BY version_number DESC LIMIT 1`, [assignmentId]
      );
      const updated = await client.query<Record<string, unknown>>(
        `UPDATE approved_business_action.approver_assignments SET status = 'revoked' WHERE id = $1 RETURNING *`, [assignmentId]
      );
      const assignment = rowToAssignment(updated.rows[0]);
      if (version.rows.length > 0) {
        const entry: AuthorityProvenanceEntry = {
          ...provenance, action: 'revoke', state: 'revoked', assignmentId,
          businessId: assignment.businessId, assignmentCode: assignment.assignmentCode, granteeUserId: assignment.userId,
        };
        await client.query(
          `INSERT INTO approved_business_action.approval_authority_scopes
             (assignment_version_id, tenant_id, workspace_id, business_id, scope_type, scope_value)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [version.rows[0].id, ctx.tenantId, ctx.workspaceId, assignment.businessId, PROVENANCE_SCOPE_TYPE, JSON.stringify(entry)]
        );
      }
      return { assignment, changed: true };
    });
  }

  /** The assignment's provenance history, oldest first. Append-only: entries are never changed. */
  async listProvenance(ctx: TenantContext, assignmentId: string): Promise<AuthorityProvenanceEntry[]> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT s.scope_value
           FROM approved_business_action.approval_authority_scopes s
           JOIN approved_business_action.approver_assignment_versions v ON v.id = s.assignment_version_id
          WHERE v.assignment_id = $1 AND s.scope_type = $2
          ORDER BY s.created_at, s.id`,
        [assignmentId, PROVENANCE_SCOPE_TYPE]
      );
      return result.rows.map((row) => row.scope_value as AuthorityProvenanceEntry);
    });
  }

  /** Role code of the assignment's latest version, or null if it has none. */
  async getCurrentRoleCode(ctx: TenantContext, assignmentId: string): Promise<string | null> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT role_code FROM approved_business_action.approver_assignment_versions
          WHERE assignment_id = $1 ORDER BY version_number DESC LIMIT 1`,
        [assignmentId]
      );
      return result.rows.length === 0 ? null : (result.rows[0].role_code as string);
    });
  }

  async getById(ctx: TenantContext, id: string): Promise<ApproverAssignment> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>('SELECT * FROM approved_business_action.approver_assignments WHERE id = $1', [id]);
      if (result.rows.length === 0) throw new ApproverAuthorityNotFoundError('ApproverAssignment', id);
      return rowToAssignment(result.rows[0]);
    });
  }
}
