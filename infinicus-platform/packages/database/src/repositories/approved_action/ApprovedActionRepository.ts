import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';
import { ApprovedActionNotFoundError, ValidationError } from './errors.js';

export interface ApprovedAction {
  id: string;
  tenantId: string;
  workspaceId: string;
  businessId: string;
  decisionId: string;
  actionCode: string;
  status: string;
  latestVersion: number;
  /**
   * The ai_decision_intelligence.decision_recommendations row this action
   * traces back to — null for every row created before migration 0170, and
   * for any caller that doesn't pass one. See 0170's own doc comment for
   * why this previously didn't exist at all.
   */
  sourceRecommendationId: string | null;
}

const VALID_STATUSES = ['draft', 'active', 'completed', 'cancelled', 'superseded'];
const OPERATORS = new Set(['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'between', 'in', 'not_in', 'contains']);

function rowToAction(row: Record<string, unknown>): ApprovedAction {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    workspaceId: row.workspace_id as string,
    businessId: row.business_id as string,
    decisionId: row.decision_id as string,
    actionCode: row.action_code as string,
    status: row.status as string,
    latestVersion: row.latest_version as number,
    sourceRecommendationId: row.source_recommendation_id as string | null,
  };
}

export class ApprovedActionRepository {
  async createAction(
    ctx: TenantContext, businessId: string, decisionId: string, actionCode: string,
    sourceRecommendationId: string | null = null
  ): Promise<ApprovedAction> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `INSERT INTO approved_business_action.approved_actions (tenant_id, workspace_id, business_id, decision_id, action_code, source_recommendation_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [ctx.tenantId, ctx.workspaceId, businessId, decisionId, actionCode, sourceRecommendationId]
      );
      return rowToAction(result.rows[0]);
    });
  }

  /**
   * Bulk lookup for getHistory(): one IN-list query for a whole page of
   * recommendations rather than one query per decision. Returns only rows
   * that have a match — callers index the result by sourceRecommendationId.
   */
  async listBySourceRecommendationIds(ctx: TenantContext, recommendationIds: string[]): Promise<ApprovedAction[]> {
    if (recommendationIds.length === 0) return [];
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT * FROM approved_business_action.approved_actions WHERE source_recommendation_id = ANY($1::uuid[])`,
        [recommendationIds]
      );
      return result.rows.map(rowToAction);
    });
  }

  async createVersion(ctx: TenantContext, actionId: string, businessId: string, description: string): Promise<{ id: string; versionNumber: number }> {
    return withTenantTransaction(ctx, async (client) => {
      const a = await client.query<Record<string, unknown>>('SELECT * FROM approved_business_action.approved_actions WHERE id = $1', [actionId]);
      if (a.rows.length === 0) throw new ApprovedActionNotFoundError('ApprovedAction', actionId);
      const nextVersion = (a.rows[0].latest_version as number) + 1;
      const result = await client.query<Record<string, unknown>>(
        `INSERT INTO approved_business_action.approved_action_versions
           (action_id, tenant_id, workspace_id, business_id, version_number, description, correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,gen_random_uuid()) RETURNING id, version_number`,
        [actionId, ctx.tenantId, ctx.workspaceId, businessId, nextVersion, description]
      );
      await client.query('UPDATE approved_business_action.approved_actions SET latest_version = $2 WHERE id = $1', [actionId, nextVersion]);
      return { id: result.rows[0].id as string, versionNumber: result.rows[0].version_number as number };
    });
  }

  async addStep(ctx: TenantContext, actionVersionId: string, businessId: string, stepNumber: number, description: string): Promise<void> {
    return withTenantTransaction(ctx, async (client) => {
      await client.query(
        `INSERT INTO approved_business_action.approved_action_steps (action_version_id, tenant_id, workspace_id, business_id, step_number, description)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [actionVersionId, ctx.tenantId, ctx.workspaceId, businessId, stepNumber, description]
      );
    });
  }

  async addConstraint(ctx: TenantContext, actionVersionId: string, businessId: string, constraintCode: string, operator: string, operand: unknown): Promise<void> {
    if (!OPERATORS.has(operator)) {
      throw new ValidationError('ApprovedActionConstraint', [`unknown operator: ${operator}`]);
    }
    return withTenantTransaction(ctx, async (client) => {
      await client.query(
        `INSERT INTO approved_business_action.approved_action_constraints (action_version_id, tenant_id, workspace_id, business_id, constraint_code, operator, operand)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [actionVersionId, ctx.tenantId, ctx.workspaceId, businessId, constraintCode, operator, JSON.stringify(operand)]
      );
    });
  }

  async transitionStatus(ctx: TenantContext, actionId: string, toStatus: string): Promise<ApprovedAction> {
    if (!VALID_STATUSES.includes(toStatus)) {
      throw new ValidationError('ApprovedAction', [`unknown status: ${toStatus}`]);
    }
    return withTenantTransaction(ctx, async (client) => {
      const current = await client.query<Record<string, unknown>>('SELECT * FROM approved_business_action.approved_actions WHERE id = $1', [actionId]);
      if (current.rows.length === 0) throw new ApprovedActionNotFoundError('ApprovedAction', actionId);
      const result = await client.query<Record<string, unknown>>(
        `UPDATE approved_business_action.approved_actions SET status = $2 WHERE id = $1 RETURNING *`,
        [actionId, toStatus]
      );
      return rowToAction(result.rows[0]);
    });
  }

  async getById(ctx: TenantContext, id: string): Promise<ApprovedAction> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>('SELECT * FROM approved_business_action.approved_actions WHERE id = $1', [id]);
      if (result.rows.length === 0) throw new ApprovedActionNotFoundError('ApprovedAction', id);
      return rowToAction(result.rows[0]);
    });
  }
}
