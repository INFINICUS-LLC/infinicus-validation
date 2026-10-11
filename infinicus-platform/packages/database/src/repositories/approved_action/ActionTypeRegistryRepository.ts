// P0-5 Block 3c-2 - persistence access for the ABA-governed action-type registry (tables from migration 0178).
//
// ABA governs authorization semantics: which action types exist, what parameters each accepts, which governance
// dimensions each parameter influences (R-7) and which governed fields may legitimately be NOT_APPLICABLE (D-6).
// "BO can execute this" is a Business Operations fact and lives in BO's own capability registry, never here.
//
// This repository STORES and READS. It ships NO vocabulary: the registry is empty until the owner supplies action types
// (nothing is invented). It does not validate a package, does not decide issuance, emits no events and is not yet called
// from any route or service. The database validates every definition (aap_action_type_problems) and every transition.

import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { canonical, iso, lock, mapGuardError, requireText, requireUuid } from './governanceSupport.js';

const ENTITY = 'ActionTypeDefinition';

export type ActionTypeStatus = 'DRAFT' | 'ACTIVE' | 'RETIRED';

export interface DefineActionTypeInput {
  code: string;
  schemaVersion: string;
  targetKinds: readonly string[];
  parameters: Readonly<Record<string, unknown>>;
  governanceImpact?: Readonly<Record<string, readonly string[]>>;
  applicability?: Readonly<Record<string, string>>;
  definedByUserId: string;
  correlationId: string;
}

export interface ActionTypeDefinition {
  id: string;
  tenantId: string;
  workspaceId: string;
  code: string;
  schemaVersion: string;
  targetKinds: string[];
  parameters: Record<string, unknown>;
  governanceImpact: Record<string, string[]>;
  applicability: Record<string, string>;
  definedByUserId: string;
  createdAt: string;
}

export interface ActionTypeStatusChange {
  actorUserId: string;
  /** Required to retire; optional to activate. */
  reason?: string;
  correlationId: string;
}

export interface ActionTypeWithStatus {
  definition: ActionTypeDefinition;
  status: ActionTypeStatus;
}

/** A definition in the shape of the `aap/1` contract's `ActionTypeContract`, ready for the issuer to load. */
export interface ActionTypeContractShape {
  code: string;
  schemaVersion: string;
  targetKinds: string[];
  parameters: Record<string, unknown>;
  governanceImpact: Record<string, string[]>;
  applicability: Record<string, string>;
}

type Json = Record<string, unknown>;

const DEFINITIONS = 'approved_business_action.action_type_definitions';
const EVENTS = 'approved_business_action.action_type_status_events';

function rowToDefinition(row: Json): ActionTypeDefinition {
  return {
    id: row.id as string, tenantId: row.tenant_id as string, workspaceId: row.workspace_id as string,
    code: row.code as string, schemaVersion: row.schema_version as string,
    targetKinds: row.target_kinds as string[], parameters: row.parameters as Record<string, unknown>,
    governanceImpact: row.governance_impact as Record<string, string[]>, applicability: row.applicability as Record<string, string>,
    definedByUserId: row.defined_by_user_id as string, createdAt: iso(row.created_at),
  };
}

function statusOf(row: Json): ActionTypeStatus {
  if (row.has_retired) return 'RETIRED';
  return row.has_active ? 'ACTIVE' : 'DRAFT';
}

/** The definition as the contract's `ActionTypeContract`. */
export function toActionTypeContract(definition: ActionTypeDefinition): ActionTypeContractShape {
  return {
    code: definition.code, schemaVersion: definition.schemaVersion, targetKinds: [...definition.targetKinds],
    parameters: definition.parameters, governanceImpact: definition.governanceImpact, applicability: definition.applicability,
  };
}

const WITH_STATUS = `SELECT d.*,
    EXISTS (SELECT 1 FROM ${EVENTS} e WHERE e.definition_id = d.id AND e.state = 'ACTIVE')  AS has_active,
    EXISTS (SELECT 1 FROM ${EVENTS} e WHERE e.definition_id = d.id AND e.state = 'RETIRED') AS has_retired
  FROM ${DEFINITIONS} d`;

export class ActionTypeRegistryRepository {
  /**
   * Defines an action type at a schema version. Idempotent: an identical definition returns the stored one; a different
   * definition for the same (code, schema version) is a ConflictError - a changed action type is a NEW schema version.
   * The new definition starts as DRAFT and cannot be used until it is activated.
   */
  async define(ctx: TenantContext, input: DefineActionTypeInput): Promise<ActionTypeDefinition> {
    requireText(ENTITY, 'code', input.code, 100);
    requireText(ENTITY, 'schemaVersion', input.schemaVersion, 50);
    requireUuid(ENTITY, 'definedByUserId', input.definedByUserId);
    requireUuid(ENTITY, 'correlationId', input.correlationId);
    if (!Array.isArray(input.targetKinds)) throw new ValidationError(ENTITY, ['targetKinds must be an array']);
    if (input.parameters === null || typeof input.parameters !== 'object' || Array.isArray(input.parameters)) {
      throw new ValidationError(ENTITY, ['parameters must be an object']);
    }
    const impact = input.governanceImpact ?? {};
    const applicability = input.applicability ?? {};
    try {
      return await withTenantTransaction(ctx, async (client) => {
        await lock(client, `action_type_definition:${ctx.tenantId}:${ctx.workspaceId}:${input.code}@${input.schemaVersion}`);
        const existing = await client.query<Json>(
          `SELECT * FROM ${DEFINITIONS} WHERE code = $1 AND schema_version = $2`, [input.code, input.schemaVersion]);
        if (existing.rows[0]) {
          const stored = rowToDefinition(existing.rows[0]);
          const same = canonical(stored.targetKinds) === canonical(input.targetKinds)
            && canonical(stored.parameters) === canonical(input.parameters)
            && canonical(stored.governanceImpact) === canonical(impact)
            && canonical(stored.applicability) === canonical(applicability);
          if (same) return stored;
          throw new ConflictError(ENTITY, `${input.code}@${input.schemaVersion} is already defined differently; a changed action type is a new schema version`);
        }
        const inserted = await client.query<Json>(
          `INSERT INTO ${DEFINITIONS}
             (tenant_id, workspace_id, code, schema_version, target_kinds, parameters, governance_impact, applicability, defined_by_user_id, correlation_id)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10) RETURNING *`,
          [ctx.tenantId, ctx.workspaceId, input.code, input.schemaVersion, JSON.stringify(input.targetKinds), JSON.stringify(input.parameters),
            JSON.stringify(impact), JSON.stringify(applicability), input.definedByUserId, input.correlationId],
        );
        return rowToDefinition(inserted.rows[0]);
      });
    } catch (error) {
      return mapGuardError(ENTITY, error);
    }
  }

  /** Activates a DRAFT definition. Idempotent for an already ACTIVE one; a RETIRED one cannot be re-activated. */
  async activate(ctx: TenantContext, definitionId: string, change: ActionTypeStatusChange): Promise<ActionTypeWithStatus> {
    return this.change(ctx, definitionId, change, 'ACTIVE');
  }

  /** Retires an ACTIVE definition with a reason. Idempotent for an already RETIRED one; a DRAFT one cannot be retired. */
  async retire(ctx: TenantContext, definitionId: string, change: ActionTypeStatusChange): Promise<ActionTypeWithStatus> {
    return this.change(ctx, definitionId, change, 'RETIRED');
  }

  private async change(ctx: TenantContext, definitionId: string, change: ActionTypeStatusChange, target: 'ACTIVE' | 'RETIRED'): Promise<ActionTypeWithStatus> {
    requireUuid(ENTITY, 'definitionId', definitionId);
    requireUuid(ENTITY, 'actorUserId', change.actorUserId);
    requireUuid(ENTITY, 'correlationId', change.correlationId);
    if (change.reason !== undefined) requireText(ENTITY, 'reason', change.reason, 1000);
    if (target === 'RETIRED') requireText(ENTITY, 'reason', change.reason, 1000);
    try {
      return await withTenantTransaction(ctx, async (client) => {
        await lock(client, `action_type_status:${definitionId}`);
        const current = await client.query<Json>(`${WITH_STATUS} WHERE d.id = $1`, [definitionId]);
        if (!current.rows[0]) throw new NotFoundError(ENTITY, definitionId);
        const status = statusOf(current.rows[0]);
        const definition = rowToDefinition(current.rows[0]);
        if (status === target) return { definition, status };
        if (target === 'ACTIVE' && status === 'RETIRED') throw new ConflictError(ENTITY, 'a retired action type cannot be re-activated; define a new schema version');
        if (target === 'RETIRED' && status === 'DRAFT') throw new ConflictError(ENTITY, 'only an ACTIVE action type can be retired');
        await client.query(
          `INSERT INTO ${EVENTS} (tenant_id, workspace_id, definition_id, state, actor_user_id, reason, correlation_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [ctx.tenantId, ctx.workspaceId, definitionId, target, change.actorUserId, change.reason ?? null, change.correlationId],
        );
        return { definition, status: target };
      });
    } catch (error) {
      return mapGuardError(ENTITY, error);
    }
  }

  async get(ctx: TenantContext, code: string, schemaVersion: string): Promise<ActionTypeWithStatus | null> {
    requireText(ENTITY, 'code', code, 100);
    requireText(ENTITY, 'schemaVersion', schemaVersion, 50);
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<Json>(`${WITH_STATUS} WHERE d.code = $1 AND d.schema_version = $2`, [code, schemaVersion]);
      return r.rows[0] ? { definition: rowToDefinition(r.rows[0]), status: statusOf(r.rows[0]) } : null;
    });
  }

  async getById(ctx: TenantContext, definitionId: string): Promise<ActionTypeWithStatus | null> {
    requireUuid(ENTITY, 'definitionId', definitionId);
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<Json>(`${WITH_STATUS} WHERE d.id = $1`, [definitionId]);
      return r.rows[0] ? { definition: rowToDefinition(r.rows[0]), status: statusOf(r.rows[0]) } : null;
    });
  }

  /** The definition only if it is ACTIVE: DRAFT and RETIRED action types resolve to null (they cannot be authorized). */
  async resolveActive(ctx: TenantContext, code: string, schemaVersion: string): Promise<ActionTypeDefinition | null> {
    const found = await this.get(ctx, code, schemaVersion);
    return found && found.status === 'ACTIVE' ? found.definition : null;
  }

  /** Every definition in the caller's scope with its derived status (DRAFT, ACTIVE or RETIRED), for administration reads. */
  async listAll(ctx: TenantContext): Promise<ActionTypeWithStatus[]> {
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<Json>(`${WITH_STATUS} ORDER BY d.code, d.schema_version`);
      return r.rows.map((row) => ({ definition: rowToDefinition(row), status: statusOf(row) }));
    });
  }

  /** Every ACTIVE definition in the caller's scope, as contract-shaped entries for the issuer to load. */
  async listActive(ctx: TenantContext): Promise<ActionTypeDefinition[]> {
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<Json>(`${WITH_STATUS} ORDER BY d.code, d.schema_version`);
      return r.rows.filter((row) => statusOf(row) === 'ACTIVE').map(rowToDefinition);
    });
  }
}
