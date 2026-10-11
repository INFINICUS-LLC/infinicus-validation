// P0-5 Block 3c-3 - persistence access for the execution boundaries of an authorized action (table from migration 0179):
// execution window, preconditions, budget, rollback instructions, monitoring metrics and the simulation-run reference.
//
// Each field is a governed value (a real value, or a legitimate NOT_APPLICABLE with a preserved reason) in exactly the
// shape of the `aap/1` contract. A field may be NOT_APPLICABLE only where the action type's governed `applicability`
// (migration 0178) says so; anything unlisted is REQUIRED. UNAVAILABLE is never storable.
//
// This repository STORES and READS. It does not decide whether an action may be authorized, does not build or validate a
// package, emits no events and is not yet called from any route or service. The database verifies the capture, the ACTIVE
// action type, every shape and the applicability rule; guard rejections surface as ValidationError.

import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';
import { ValidationError } from './errors.js';
import { canonical, iso, lock, mapGuardError, requireUuid } from './governanceSupport.js';

const ENTITY = 'AuthorizedActionBoundaries';

// Local, structurally identical to the aap/1 contract's Governed<T> and JsonValue. Kept local so this repository stays
// decoupled from the capture repository (each ABA storage adapter depends only on the tenant client and shared errors).
type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };
type GovernedValue<T> =
  | { readonly state: 'VALUE'; readonly value: T }
  | { readonly state: 'NOT_APPLICABLE'; readonly reason: { readonly code: string; readonly statement: string; readonly basis?: { readonly kind: 'ACTION_SCHEMA' | 'POLICY'; readonly ref: string } } };

export interface ExecutionWindowValue { startsAt: string; endsAt: string | null }
export interface PreconditionValue {
  code: string;
  operator: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte' | 'between' | 'in' | 'not_in' | 'contains';
  operand: JsonValue;
}
export interface BudgetValue { amount: string; currency: string }
export interface RollbackValue { instructions: string }
export interface MonitoringValue { metrics: readonly { metricCode: string; target: JsonValue | null; unit: string | null }[] }

export interface RecordBoundariesInput {
  businessId: string;
  actionId: string;
  /** The action's immutable capture (3c-1), which fixes its action type. */
  captureId: string;
  executionWindow: GovernedValue<ExecutionWindowValue>;
  preconditions: GovernedValue<readonly PreconditionValue[]>;
  budget: GovernedValue<BudgetValue>;
  rollback: GovernedValue<RollbackValue>;
  monitoring: GovernedValue<MonitoringValue>;
  /** The simulation run that backed the recommendation (a soft reference), or a governed NOT_APPLICABLE. */
  simulationRun: GovernedValue<string>;
  authoredByUserId: string;
  correlationId: string;
}

export interface AuthorizedActionBoundaries {
  id: string;
  tenantId: string;
  workspaceId: string;
  businessId: string;
  actionId: string;
  captureId: string;
  boundaryVersion: number;
  supersedesBoundaryVersion: number | null;
  executionWindow: GovernedValue<ExecutionWindowValue>;
  preconditions: GovernedValue<readonly PreconditionValue[]>;
  budget: GovernedValue<BudgetValue>;
  rollback: GovernedValue<RollbackValue>;
  monitoring: GovernedValue<MonitoringValue>;
  simulationRun: GovernedValue<string>;
  authoredByUserId: string;
  authoredAt: string;
}

/** The boundary parts exactly where the `aap/1` contract places them: five `action.*` fields and `lineage.simulationRunId`. */
export interface PackageBoundaryParts {
  action: {
    executionWindow: GovernedValue<ExecutionWindowValue>;
    preconditions: GovernedValue<readonly PreconditionValue[]>;
    budget: GovernedValue<BudgetValue>;
    rollback: GovernedValue<RollbackValue>;
    monitoring: GovernedValue<MonitoringValue>;
  };
  lineage: { simulationRunId: GovernedValue<string> };
}

type Json = Record<string, unknown>;

const BOUNDARIES = 'approved_business_action.authorized_action_boundaries';
const FIELDS = ['executionWindow', 'preconditions', 'budget', 'rollback', 'monitoring', 'simulationRun'] as const;

function rowToBoundaries(row: Json): AuthorizedActionBoundaries {
  return {
    id: row.id as string, tenantId: row.tenant_id as string, workspaceId: row.workspace_id as string, businessId: row.business_id as string,
    actionId: row.action_id as string, captureId: row.capture_id as string, boundaryVersion: row.boundary_version as number,
    supersedesBoundaryVersion: (row.supersedes_boundary_version as number | null) ?? null,
    executionWindow: row.execution_window as AuthorizedActionBoundaries['executionWindow'],
    preconditions: row.preconditions as AuthorizedActionBoundaries['preconditions'],
    budget: row.budget as AuthorizedActionBoundaries['budget'],
    rollback: row.rollback as AuthorizedActionBoundaries['rollback'],
    monitoring: row.monitoring as AuthorizedActionBoundaries['monitoring'],
    simulationRun: row.simulation_run as AuthorizedActionBoundaries['simulationRun'],
    authoredByUserId: row.authored_by_user_id as string, authoredAt: iso(row.authored_at),
  };
}

/** The stored boundaries as the contract's `action.*` fields and `lineage.simulationRunId`, ready for the issuer to place in a package. */
export function toPackageBoundaryParts(b: AuthorizedActionBoundaries): PackageBoundaryParts {
  return {
    action: { executionWindow: b.executionWindow, preconditions: b.preconditions, budget: b.budget, rollback: b.rollback, monitoring: b.monitoring },
    lineage: { simulationRunId: b.simulationRun },
  };
}

function sameBoundaries(existing: AuthorizedActionBoundaries, input: RecordBoundariesInput): boolean {
  return existing.captureId === input.captureId
    && FIELDS.every((field) => canonical(existing[field]) === canonical(input[field]));
}

function requireGoverned(label: string, value: unknown): void {
  const state = (value as { state?: unknown } | null)?.state;
  if (state !== 'VALUE' && state !== 'NOT_APPLICABLE') {
    throw new ValidationError(ENTITY, [`${label} must be VALUE or NOT_APPLICABLE (UNAVAILABLE can never be stored)`]);
  }
}

export class AuthorizedActionBoundaryRepository {
  /**
   * Records the execution boundaries of an authorized action as the next version of a linear chain. Idempotent: identical
   * boundaries (even with a new correlation id) return the current version; anything different is a new version that
   * supersedes it. Requires the action's capture and an ACTIVE action type (checked by the database).
   */
  async recordBoundaries(ctx: TenantContext, input: RecordBoundariesInput): Promise<AuthorizedActionBoundaries> {
    requireUuid(ENTITY, 'businessId', input.businessId);
    requireUuid(ENTITY, 'actionId', input.actionId);
    requireUuid(ENTITY, 'captureId', input.captureId);
    requireUuid(ENTITY, 'authoredByUserId', input.authoredByUserId);
    requireUuid(ENTITY, 'correlationId', input.correlationId);
    for (const field of FIELDS) requireGoverned(field, input[field]);
    try {
      return await withTenantTransaction(ctx, async (client) => {
        await lock(client, `authorized_action_boundaries:${input.actionId}`);
        const latest = await client.query<Json>(`SELECT * FROM ${BOUNDARIES} WHERE action_id = $1 ORDER BY boundary_version DESC LIMIT 1`, [input.actionId]);
        const current = latest.rows[0] ? rowToBoundaries(latest.rows[0]) : null;
        if (current && sameBoundaries(current, input)) return current;
        const inserted = await client.query<Json>(
          `INSERT INTO ${BOUNDARIES}
             (tenant_id, workspace_id, business_id, action_id, capture_id, boundary_version, supersedes_boundary_version,
              execution_window, preconditions, budget, rollback, monitoring, simulation_run, authored_by_user_id, correlation_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7, $8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15)
           RETURNING *`,
          [
            ctx.tenantId, ctx.workspaceId, input.businessId, input.actionId, input.captureId,
            current ? current.boundaryVersion + 1 : 1, current ? current.boundaryVersion : null,
            JSON.stringify(input.executionWindow), JSON.stringify(input.preconditions), JSON.stringify(input.budget),
            JSON.stringify(input.rollback), JSON.stringify(input.monitoring), JSON.stringify(input.simulationRun),
            input.authoredByUserId, input.correlationId,
          ],
        );
        return rowToBoundaries(inserted.rows[0]);
      });
    } catch (error) {
      return mapGuardError(ENTITY, error);
    }
  }

  async getCurrent(ctx: TenantContext, actionId: string): Promise<AuthorizedActionBoundaries | null> {
    requireUuid(ENTITY, 'actionId', actionId);
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<Json>(`SELECT * FROM ${BOUNDARIES} WHERE action_id = $1 ORDER BY boundary_version DESC LIMIT 1`, [actionId]);
      return r.rows[0] ? rowToBoundaries(r.rows[0]) : null;
    });
  }

  async getVersion(ctx: TenantContext, actionId: string, boundaryVersion: number): Promise<AuthorizedActionBoundaries | null> {
    requireUuid(ENTITY, 'actionId', actionId);
    if (!Number.isInteger(boundaryVersion) || boundaryVersion < 1) throw new ValidationError(ENTITY, ['boundaryVersion must be an integer >= 1']);
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<Json>(`SELECT * FROM ${BOUNDARIES} WHERE action_id = $1 AND boundary_version = $2`, [actionId, boundaryVersion]);
      return r.rows[0] ? rowToBoundaries(r.rows[0]) : null;
    });
  }

  async listVersions(ctx: TenantContext, actionId: string): Promise<AuthorizedActionBoundaries[]> {
    requireUuid(ENTITY, 'actionId', actionId);
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<Json>(`SELECT * FROM ${BOUNDARIES} WHERE action_id = $1 ORDER BY boundary_version`, [actionId]);
      return r.rows.map(rowToBoundaries);
    });
  }
}
