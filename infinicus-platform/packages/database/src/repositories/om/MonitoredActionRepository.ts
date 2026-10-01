import { randomUUID } from 'crypto';
import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';
import { MonitoredActionNotFoundError, MonitoredActionStateConflictError } from './errors.js';

export interface MonitoredAction {
  id: string;
  tenantId: string;
  workspaceId: string;
  businessId: string;
  monitoringPlanId: string;
  approvedActionId: string;
  actionCode: string;
  status: string;
  latestVersion: number;
}

const VALID_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'];

function rowToAction(row: Record<string, unknown>): MonitoredAction {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    workspaceId: row.workspace_id as string,
    businessId: row.business_id as string,
    monitoringPlanId: row.monitoring_plan_id as string,
    approvedActionId: row.approved_action_id as string,
    actionCode: row.action_code as string,
    status: row.status as string,
    latestVersion: row.latest_version as number,
  };
}

export class MonitoredActionRepository {
  /** approvedActionId references approved_business_action.approved_actions directly — the canonical entity, never duplicated. */
  async createMonitoredAction(ctx: TenantContext, businessId: string, monitoringPlanId: string, approvedActionId: string, actionCode: string, description: string): Promise<{ action: MonitoredAction; versionId: string }> {
    return withTenantTransaction(ctx, async (client) => {
      const actionRow = await client.query<Record<string, unknown>>(
        `INSERT INTO outcome_monitoring.monitored_actions (tenant_id, workspace_id, business_id, monitoring_plan_id, approved_action_id, action_code, latest_version)
         VALUES ($1,$2,$3,$4,$5,$6,1) RETURNING *`,
        [ctx.tenantId, ctx.workspaceId, businessId, monitoringPlanId, approvedActionId, actionCode]
      );
      const versionResult = await client.query<Record<string, unknown>>(
        `INSERT INTO outcome_monitoring.monitored_action_versions (monitored_action_id, tenant_id, workspace_id, business_id, version_number, description, correlation_id)
         VALUES ($1,$2,$3,$4,1,$5,$6) RETURNING id`,
        [actionRow.rows[0].id, ctx.tenantId, ctx.workspaceId, businessId, description, randomUUID()]
      );
      return { action: rowToAction(actionRow.rows[0]), versionId: versionResult.rows[0].id as string };
    });
  }

  async addExecutionObservation(ctx: TenantContext, monitoredActionVersionId: string, businessId: string, detail: Record<string, unknown>): Promise<void> {
    return withTenantTransaction(ctx, async (client) => {
      await client.query(
        `INSERT INTO outcome_monitoring.action_execution_observations (monitored_action_version_id, tenant_id, workspace_id, business_id, detail)
         VALUES ($1,$2,$3,$4,$5)`,
        [monitoredActionVersionId, ctx.tenantId, ctx.workspaceId, businessId, JSON.stringify(detail)]
      );
    });
  }

  private async transition(ctx: TenantContext, id: string, toStatus: string, reason?: string): Promise<MonitoredAction> {
    if (!VALID_STATUSES.includes(toStatus)) {
      throw new MonitoredActionStateConflictError('MonitoredAction', `unknown status: ${toStatus}`);
    }
    return withTenantTransaction(ctx, async (client) => {
      const current = await client.query<Record<string, unknown>>('SELECT * FROM outcome_monitoring.monitored_actions WHERE id = $1', [id]);
      if (current.rows.length === 0) throw new MonitoredActionNotFoundError('MonitoredAction', id);
      const fromStatus = current.rows[0].status as string;
      const result = await client.query<Record<string, unknown>>(
        `UPDATE outcome_monitoring.monitored_actions SET status = $2 WHERE id = $1 RETURNING *`,
        [id, toStatus]
      );
      await client.query(
        `INSERT INTO outcome_monitoring.monitored_action_status_history (monitored_action_id, tenant_id, workspace_id, business_id, from_status, to_status, reason, correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,gen_random_uuid())`,
        [id, ctx.tenantId, ctx.workspaceId, result.rows[0].business_id, fromStatus, toStatus, reason ?? null]
      );
      return rowToAction(result.rows[0]);
    });
  }

  async markInProgress(ctx: TenantContext, id: string): Promise<MonitoredAction> {
    return this.transition(ctx, id, 'in_progress');
  }

  async complete(ctx: TenantContext, id: string): Promise<MonitoredAction> {
    return this.transition(ctx, id, 'completed');
  }

  async cancel(ctx: TenantContext, id: string, reason: string): Promise<MonitoredAction> {
    return this.transition(ctx, id, 'cancelled', reason);
  }

  async getById(ctx: TenantContext, id: string): Promise<MonitoredAction> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>('SELECT * FROM outcome_monitoring.monitored_actions WHERE id = $1', [id]);
      if (result.rows.length === 0) throw new MonitoredActionNotFoundError('MonitoredAction', id);
      return rowToAction(result.rows[0]);
    });
  }

  async getByApprovedAction(ctx: TenantContext, businessId: string, approvedActionId: string): Promise<MonitoredAction> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        'SELECT * FROM outcome_monitoring.monitored_actions WHERE business_id = $1 AND approved_action_id = $2',
        [businessId, approvedActionId]
      );
      if (result.rows.length === 0) throw new MonitoredActionNotFoundError('MonitoredAction', approvedActionId);
      return rowToAction(result.rows[0]);
    });
  }

  /**
   * Bulk counterpart to getByApprovedAction for history/listing callers that
   * have a page of approvedActionIds and need the monitored actions for
   * whichever of them actually have one — never throws for an id with no
   * monitored action (most approved actions never reach OM), callers index
   * the result by approvedActionId.
   */
  async listByApprovedActionIds(ctx: TenantContext, approvedActionIds: string[]): Promise<MonitoredAction[]> {
    if (approvedActionIds.length === 0) return [];
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        'SELECT * FROM outcome_monitoring.monitored_actions WHERE approved_action_id = ANY($1::uuid[])',
        [approvedActionIds]
      );
      return result.rows.map(rowToAction);
    });
  }
}
