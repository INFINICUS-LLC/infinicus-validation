import type { PoolClient } from 'pg';
import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';
import { OWNER_APPROVER_ASSIGNMENT_CODE } from '../approved_action/authorityProvenance.js';
import type { MembershipFact, OwnershipEvidence } from './classifyOwnership.js';

/**
 * Reads (never writes) the server-side records that prove business ownership.
 * Every query runs with the tenant/workspace context set, so row-level security
 * applies exactly as in normal requests. No input from a browser is used: the
 * business id and the tenant context come from the caller's server-side session
 * or from the operator running the dry-run.
 */

const OWNER_ROLE_MEMBERSHIPS = `
  SELECT m.id AS membership_id, m.user_id, m.status
    FROM tenancy.membership_roles mr
    JOIN tenancy.roles r ON r.id = mr.role_id
    JOIN tenancy.memberships m ON m.id = mr.membership_id
   WHERE r.code = 'owner' AND m.workspace_id = $1`;

function toFact(row: Record<string, unknown>): MembershipFact {
  return { membershipId: row.membership_id as string, userId: row.user_id as string, status: row.status as string };
}

/** `client` must already carry the tenant and workspace settings (see withTenantTransaction). */
export async function loadOwnershipEvidenceWith(
  client: PoolClient,
  scope: { tenantId: string; workspaceId: string },
  businessId: string
): Promise<OwnershipEvidence> {
  const business = await client.query<Record<string, unknown>>(
    'SELECT status, deleted_at FROM platform.businesses WHERE id = $1', [businessId]
  );
  const link = await client.query<Record<string, unknown>>(
    'SELECT id, membership_id, initiated_by FROM onboarding.tenant_onboarding WHERE business_id = $1', [businessId]
  );

  let linkedMembership: OwnershipEvidence['linkedMembership'] = null;
  const linkRow = link.rows[0];
  if (linkRow && linkRow.membership_id) {
    const m = await client.query<Record<string, unknown>>(
      `SELECT m.id AS membership_id, m.user_id, m.status,
              EXISTS (SELECT 1 FROM tenancy.membership_roles mr JOIN tenancy.roles r ON r.id = mr.role_id
                       WHERE mr.membership_id = m.id AND r.code = 'owner'
                         AND (mr.business_id IS NULL OR mr.business_id = $2)) AS has_owner_role
         FROM tenancy.memberships m WHERE m.id = $1`,
      [linkRow.membership_id, businessId]
    );
    if (m.rows[0]) linkedMembership = { ...toFact(m.rows[0]), hasOwnerRole: m.rows[0].has_owner_role as boolean };
  }

  const explicit = await client.query<Record<string, unknown>>(
    `${OWNER_ROLE_MEMBERSHIPS} AND mr.business_id = $2`, [scope.workspaceId, businessId]
  );
  const tenantWide = await client.query<Record<string, unknown>>(
    `${OWNER_ROLE_MEMBERSHIPS} AND mr.business_id IS NULL`, [scope.workspaceId]
  );
  const assignment = await client.query<Record<string, unknown>>(
    `SELECT id, user_id, status FROM approved_business_action.approver_assignments
      WHERE business_id = $1 AND assignment_code = $2`,
    [businessId, OWNER_APPROVER_ASSIGNMENT_CODE]
  );

  return {
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    businessId,
    business: business.rows[0]
      ? { status: business.rows[0].status as string, deleted: business.rows[0].deleted_at !== null }
      : null,
    onboardingLink: linkRow
      ? { onboardingId: linkRow.id as string, membershipId: (linkRow.membership_id as string | null) ?? null, initiatedBy: linkRow.initiated_by as string }
      : null,
    linkedMembership,
    explicitOwners: explicit.rows.map(toFact),
    tenantWideOwners: tenantWide.rows.map(toFact),
    existingAssignment: assignment.rows[0]
      ? { assignmentId: assignment.rows[0].id as string, userId: assignment.rows[0].user_id as string, status: assignment.rows[0].status as string }
      : null,
  };
}

export class OwnershipEvidenceRepository {
  async loadForBusiness(ctx: TenantContext, businessId: string): Promise<OwnershipEvidence> {
    return withTenantTransaction(ctx, (client) =>
      loadOwnershipEvidenceWith(client, { tenantId: ctx.tenantId, workspaceId: ctx.workspaceId }, businessId)
    );
  }
}
