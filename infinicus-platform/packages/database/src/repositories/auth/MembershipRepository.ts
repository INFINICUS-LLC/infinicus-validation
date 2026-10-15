import type { TenantContext } from '../../client.js';
import { withTenantTransaction, withTransaction } from '../../client.js';
import { MembershipNotFoundError, MembershipAlreadyExistsError } from './errors.js';

export interface Membership {
  id: string;
  tenantId: string;
  workspaceId: string;
  userId: string;
  status: string;
  joinedAt: Date | null;
  createdAt: Date;
}

/** One workspace the user is an ACTIVE member of (ids, names and statuses only; no roles or permissions). */
export interface ActiveMembershipSummary {
  tenantId: string;
  tenantName: string;
  tenantStatus: string;
  workspaceId: string;
  workspaceName: string;
  workspaceStatus: string;
  joinedAt: Date | null;
}

const VALID_STATUSES = ['invited', 'active', 'suspended', 'removed'];

function rowToMembership(row: Record<string, unknown>): Membership {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    workspaceId: row.workspace_id as string,
    userId: row.user_id as string,
    status: row.status as string,
    joinedAt: row.joined_at as Date | null,
    createdAt: row.created_at as Date,
  };
}

export class MembershipRepository {
  async create(ctx: TenantContext, userId: string): Promise<Membership> {
    return withTenantTransaction(ctx, async (client) => {
      const existing = await client.query<Record<string, unknown>>(
        'SELECT id FROM tenancy.memberships WHERE user_id = $1 AND workspace_id = $2', [userId, ctx.workspaceId]
      );
      if (existing.rows.length > 0) {
        throw new MembershipAlreadyExistsError('Membership', `user ${userId} already a member of workspace ${ctx.workspaceId}`);
      }
      const result = await client.query<Record<string, unknown>>(
        `INSERT INTO tenancy.memberships (tenant_id, workspace_id, user_id, created_by)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [ctx.tenantId, ctx.workspaceId, userId, ctx.userId]
      );
      return rowToMembership(result.rows[0]);
    });
  }

  /**
   * The workspaces the given user is an ACTIVE member of, across tenants (migration 0199). The user id must come from a VALIDATED session: the
   * database function refuses unless it equals the transaction's app.user_id, which is set here from the same argument, so this lists exactly one
   * user's own memberships and never anyone else's. It authorizes nothing: every business request still resolves membership and permission itself.
   */
  async listActiveForUser(userId: string): Promise<ActiveMembershipSummary[]> {
    return withTransaction(async (client) => {
      await client.query('SELECT set_config($1, $2, true)', ['app.user_id', userId]);
      const result = await client.query<Record<string, unknown>>('SELECT * FROM tenancy.list_active_memberships($1)', [userId]);
      return result.rows.map((r) => ({
        tenantId: r.out_tenant_id as string,
        tenantName: r.out_tenant_name as string,
        tenantStatus: r.out_tenant_status as string,
        workspaceId: r.out_workspace_id as string,
        workspaceName: r.out_workspace_name as string,
        workspaceStatus: r.out_workspace_status as string,
        joinedAt: r.out_joined_at as Date | null,
      }));
    });
  }

  async getById(ctx: TenantContext, id: string): Promise<Membership> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>('SELECT * FROM tenancy.memberships WHERE id = $1', [id]);
      if (result.rows.length === 0) throw new MembershipNotFoundError('Membership', id);
      return rowToMembership(result.rows[0]);
    });
  }

  async getByUserAndWorkspace(ctx: TenantContext, userId: string): Promise<Membership> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        'SELECT * FROM tenancy.memberships WHERE user_id = $1 AND workspace_id = $2', [userId, ctx.workspaceId]
      );
      if (result.rows.length === 0) throw new MembershipNotFoundError('Membership', userId);
      return rowToMembership(result.rows[0]);
    });
  }

  private async transition(ctx: TenantContext, id: string, toStatus: string): Promise<Membership> {
    if (!VALID_STATUSES.includes(toStatus)) {
      throw new MembershipNotFoundError('Membership', id);
    }
    return withTenantTransaction(ctx, async (client) => {
      const extra = toStatus === 'active' ? ', joined_at = COALESCE(joined_at, now())' : '';
      const result = await client.query<Record<string, unknown>>(
        `UPDATE tenancy.memberships SET status = $2${extra} WHERE id = $1 RETURNING *`, [id, toStatus]
      );
      if (result.rows.length === 0) throw new MembershipNotFoundError('Membership', id);
      return rowToMembership(result.rows[0]);
    });
  }

  async activate(ctx: TenantContext, id: string): Promise<Membership> {
    return this.transition(ctx, id, 'active');
  }

  async suspend(ctx: TenantContext, id: string): Promise<Membership> {
    return this.transition(ctx, id, 'suspended');
  }

  async remove(ctx: TenantContext, id: string): Promise<Membership> {
    return this.transition(ctx, id, 'removed');
  }

  async assignRole(ctx: TenantContext, membershipId: string, roleId: string, businessId: string | null = null): Promise<void> {
    return withTenantTransaction(ctx, async (client) => {
      await client.query(
        `INSERT INTO tenancy.membership_roles (membership_id, role_id, business_id, assigned_by)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (membership_id, role_id) DO NOTHING`,
        [membershipId, roleId, businessId, ctx.userId]
      );
    });
  }

  async revokeRole(ctx: TenantContext, membershipId: string, roleId: string): Promise<void> {
    return withTenantTransaction(ctx, async (client) => {
      await client.query(
        'DELETE FROM tenancy.membership_roles WHERE membership_id = $1 AND role_id = $2', [membershipId, roleId]
      );
    });
  }

  async listRoleIds(ctx: TenantContext, membershipId: string): Promise<string[]> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        'SELECT role_id FROM tenancy.membership_roles WHERE membership_id = $1', [membershipId]
      );
      return result.rows.map((r) => r.role_id as string);
    });
  }
}
