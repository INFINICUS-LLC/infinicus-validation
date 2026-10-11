// P0-5 Block 3c-1 - persistence access for the structured authorized-action capture and the accountable-owner
// assignment (tables from migration 0177).
//
// ABA records, at decision time and immutably: the original proposed parameters, the structured modification delta +
// reason, and the complete FINAL effective parameter set. The package copies the final set; Business Operations never
// derives it. The accountable owner is referenced by canonical Identity/Tenancy ids (user + active membership); ABA stores
// only the assignment and its provenance (ruling R-2).
//
// This repository STORES and READS. It does not decide whether an action may be authorized (no authority, freshness or
// risk checks: that is the approval flow and the issuer), does not read or write a package, emits no events, and is NOT
// yet called from the approval route (wiring it atomically with the decision is a separate, owner-decided step).
// The database re-derives the final set from the original and the delta and rejects any inconsistent capture.

import type { PoolClient } from 'pg';
import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENTITY = 'AuthorizedActionCapture';
/** pg check_violation: every guard in 0177 raises with this code and a readable message. */
const CHECK_VIOLATION = '23514';
const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type ParameterMap = Readonly<Record<string, JsonValue>>;

/** A governed field: a real value, or a legitimate NOT_APPLICABLE with a preserved reason. There is no UNAVAILABLE. */
export type GovernedValue<T> =
  | { readonly state: 'VALUE'; readonly value: T }
  | { readonly state: 'NOT_APPLICABLE'; readonly reason: { readonly code: string; readonly statement: string } };

export interface ProposedParametersValue {
  source: { layer: 'ADI'; recordType: string; recordId: string };
  parameters: ParameterMap;
}
export interface ModificationValue {
  reason: string;
  modifiedByUserId: string;
  modifiedAt: string;
  changes: readonly { parameter: string; operation: 'SET' | 'ADD' | 'REMOVE'; before?: JsonValue; after?: JsonValue }[];
}
export interface ModificationEvaluationValue {
  basis: 'DECLARED_IMPACT' | 'CONSERVATIVE_FULL';
  evidence: readonly { dimension: string; evaluatedAt: string; result: 'PASSED'; evidenceRef: { kind: string; id: string } }[];
}

export interface RecordCaptureInput {
  businessId: string;
  actionId: string;
  decisionId: string;
  decisionVersionId: string;
  decisionStatus: 'approved' | 'approved_with_modifications';
  actionType: { code: string; schemaVersion: string };
  target: { kind: string; id: string };
  proposed: GovernedValue<ProposedParametersValue>;
  modification: GovernedValue<ModificationValue>;
  modificationEvaluation: GovernedValue<ModificationEvaluationValue>;
  /** The complete effective authorized parameter set. The database verifies it equals the original with the delta applied. */
  finalParameters: ParameterMap;
  capturedByUserId: string;
  correlationId: string;
}

export interface AuthorizedActionCapture {
  id: string;
  tenantId: string;
  workspaceId: string;
  businessId: string;
  actionId: string;
  decisionId: string;
  decisionVersionId: string;
  decisionStatus: 'approved' | 'approved_with_modifications';
  actionType: { code: string; schemaVersion: string };
  target: { kind: string; id: string };
  proposed: GovernedValue<ProposedParametersValue>;
  modification: GovernedValue<ModificationValue>;
  modificationEvaluation: GovernedValue<ModificationEvaluationValue>;
  finalParameters: ParameterMap;
  capturedByUserId: string;
  capturedAt: string;
  correlationId: string;
}

export interface AssignOwnerInput {
  businessId: string;
  actionId: string;
  owner: { userId: string; membershipId: string };
  roleCode: string;
  assignedByUserId: string;
  dueAt: GovernedValue<string>;
  escalationPolicy: GovernedValue<{ ref: string }>;
  correlationId: string;
}

export interface OwnerAssignment {
  /** The assignment id the contract's `accountableOwner.assignment.assignmentId` refers to. */
  id: string;
  tenantId: string;
  workspaceId: string;
  businessId: string;
  actionId: string;
  assignmentVersion: number;
  supersedesAssignmentVersion: number | null;
  owner: { userId: string; membershipId: string };
  roleCode: string;
  assignedByUserId: string;
  assignedAt: string;
  dueAt: GovernedValue<string>;
  escalationPolicy: GovernedValue<{ ref: string }>;
  correlationId: string;
}

/** The accountable-owner block exactly as the `aap/1` contract defines it (`AccountableOwner`). */
export interface AccountableOwnerShape {
  identity: { userId: string; membershipId: string };
  roleCode: string;
  assignment: { assignmentId: string; assignedByUserId: string; assignedAt: string };
  dueAt: GovernedValue<string>;
  escalationPolicy: GovernedValue<{ ref: string }>;
}

type Json = Record<string, unknown>;

function requireUuid(label: string, value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ValidationError(ENTITY, [`${label} must be a lowercase UUID`]);
  return value;
}

function requireText(label: string, value: unknown, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new ValidationError(ENTITY, [`${label} is required (1-${max} characters)`]);
  }
  return value;
}

function requireGoverned(label: string, value: unknown): void {
  const state = (value as { state?: unknown } | null)?.state;
  if (state !== 'VALUE' && state !== 'NOT_APPLICABLE') {
    throw new ValidationError(ENTITY, [`${label} must be VALUE or NOT_APPLICABLE (UNAVAILABLE can never be stored)`]);
  }
}

/** Stable, key-order-independent serialization for equality of stored and requested documents. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((k) => `${JSON.stringify(k)}:${canonical(object[k])}`).join(',')}}`;
}

/** Maps a 0177 guard rejection to a ValidationError with the database's own message; anything else is rethrown. */
function mapGuardError(error: unknown): never {
  if ((error as { code?: string }).code === CHECK_VIOLATION) {
    throw new ValidationError(ENTITY, [(error as Error).message]);
  }
  throw error;
}

function rowToCapture(row: Json): AuthorizedActionCapture {
  return {
    id: row.id as string, tenantId: row.tenant_id as string, workspaceId: row.workspace_id as string, businessId: row.business_id as string,
    actionId: row.action_id as string, decisionId: row.decision_id as string, decisionVersionId: row.decision_version_id as string,
    decisionStatus: row.decision_status as AuthorizedActionCapture['decisionStatus'],
    actionType: { code: row.action_type_code as string, schemaVersion: row.action_type_schema_version as string },
    target: { kind: row.target_kind as string, id: row.target_id as string },
    proposed: row.proposed as AuthorizedActionCapture['proposed'],
    modification: row.modification as AuthorizedActionCapture['modification'],
    modificationEvaluation: row.modification_evaluation as AuthorizedActionCapture['modificationEvaluation'],
    finalParameters: row.final_parameters as ParameterMap,
    capturedByUserId: row.captured_by_user_id as string, capturedAt: iso(row.captured_at), correlationId: row.correlation_id as string,
  };
}

function rowToOwner(row: Json): OwnerAssignment {
  return {
    id: row.id as string, tenantId: row.tenant_id as string, workspaceId: row.workspace_id as string, businessId: row.business_id as string,
    actionId: row.action_id as string, assignmentVersion: row.assignment_version as number,
    supersedesAssignmentVersion: (row.supersedes_assignment_version as number | null) ?? null,
    owner: { userId: row.owner_user_id as string, membershipId: row.owner_membership_id as string },
    roleCode: row.role_code as string, assignedByUserId: row.assigned_by_user_id as string, assignedAt: iso(row.assigned_at),
    dueAt: row.due_at === null
      ? { state: 'NOT_APPLICABLE', reason: row.due_not_applicable_reason as { code: string; statement: string } }
      : { state: 'VALUE', value: iso(row.due_at) },
    escalationPolicy: row.escalation_policy_ref === null
      ? { state: 'NOT_APPLICABLE', reason: row.escalation_not_applicable_reason as { code: string; statement: string } }
      : { state: 'VALUE', value: { ref: row.escalation_policy_ref as string } },
    correlationId: row.correlation_id as string,
  };
}

/** The assignment as the `aap/1` contract's `accountableOwner` block, ready for the issuer to place in a package. */
export function toAccountableOwnerShape(a: OwnerAssignment): AccountableOwnerShape {
  return {
    identity: { userId: a.owner.userId, membershipId: a.owner.membershipId },
    roleCode: a.roleCode,
    assignment: { assignmentId: a.id, assignedByUserId: a.assignedByUserId, assignedAt: a.assignedAt },
    dueAt: a.dueAt,
    escalationPolicy: a.escalationPolicy,
  };
}

const CAPTURES = 'approved_business_action.authorized_action_captures';
const OWNERS = 'approved_business_action.authorized_action_owner_assignments';

async function lockAction(client: PoolClient, kind: string, actionId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${kind}:${actionId}`]);
}

function sameCapture(existing: AuthorizedActionCapture, input: RecordCaptureInput): boolean {
  return existing.decisionId === input.decisionId && existing.decisionVersionId === input.decisionVersionId
    && existing.decisionStatus === input.decisionStatus
    && existing.actionType.code === input.actionType.code && existing.actionType.schemaVersion === input.actionType.schemaVersion
    && existing.target.kind === input.target.kind && existing.target.id === input.target.id
    && canonical(existing.proposed) === canonical(input.proposed)
    && canonical(existing.modification) === canonical(input.modification)
    && canonical(existing.modificationEvaluation) === canonical(input.modificationEvaluation)
    && canonical(existing.finalParameters) === canonical(input.finalParameters);
}

/** A due instant is compared as an instant, not as text ("...:00Z" and "...:00.000Z" are the same replay). */
function normaliseDue(due: AssignOwnerInput['dueAt']): AssignOwnerInput['dueAt'] {
  if (due.state !== 'VALUE') return due;
  const ms = Date.parse(due.value);
  return Number.isNaN(ms) ? due : { state: 'VALUE', value: new Date(ms).toISOString() };
}

function sameOwner(existing: OwnerAssignment, input: AssignOwnerInput): boolean {
  return existing.owner.userId === input.owner.userId && existing.owner.membershipId === input.owner.membershipId
    && existing.roleCode === input.roleCode
    && canonical(normaliseDue(existing.dueAt)) === canonical(normaliseDue(input.dueAt))
    && canonical(existing.escalationPolicy) === canonical(input.escalationPolicy);
}

export class AuthorizedActionCaptureRepository {
  /**
   * Records the one immutable capture of an authorized action. Idempotent: an identical capture returns the stored row (a
   * replay may carry a new correlation id); a different capture for the same action is a ConflictError, never an edit.
   */
  async recordCapture(ctx: TenantContext, input: RecordCaptureInput): Promise<AuthorizedActionCapture> {
    requireUuid('businessId', input.businessId);
    requireUuid('actionId', input.actionId);
    requireUuid('decisionId', input.decisionId);
    requireUuid('decisionVersionId', input.decisionVersionId);
    requireUuid('capturedByUserId', input.capturedByUserId);
    requireUuid('correlationId', input.correlationId);
    if (input.decisionStatus !== 'approved' && input.decisionStatus !== 'approved_with_modifications') {
      throw new ValidationError(ENTITY, ['decisionStatus must be approved or approved_with_modifications']);
    }
    requireText('actionType.code', input.actionType?.code, 100);
    requireText('actionType.schemaVersion', input.actionType?.schemaVersion, 50);
    requireText('target.kind', input.target?.kind, 100);
    requireText('target.id', input.target?.id, 200);
    requireGoverned('proposed', input.proposed);
    requireGoverned('modification', input.modification);
    requireGoverned('modificationEvaluation', input.modificationEvaluation);
    if (input.finalParameters === null || typeof input.finalParameters !== 'object' || Array.isArray(input.finalParameters)) {
      throw new ValidationError(ENTITY, ['finalParameters must be an object']);
    }
    try {
      return await withTenantTransaction(ctx, async (client) => {
        await lockAction(client, 'authorized_action_capture', input.actionId);
        const existing = await client.query<Json>(`SELECT * FROM ${CAPTURES} WHERE action_id = $1`, [input.actionId]);
        if (existing.rows[0]) {
          const stored = rowToCapture(existing.rows[0]);
          if (sameCapture(stored, input)) return stored;
          throw new ConflictError(ENTITY, 'a different capture is already recorded for this authorized action (captures are immutable)');
        }
        const inserted = await client.query<Json>(
          `INSERT INTO ${CAPTURES}
             (tenant_id, workspace_id, business_id, action_id, decision_id, decision_version_id, decision_status,
              action_type_code, action_type_schema_version, target_kind, target_id,
              proposed, modification, modification_evaluation, final_parameters, captured_by_user_id, correlation_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7, $8,$9,$10,$11, $12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16,$17)
           RETURNING *`,
          [
            ctx.tenantId, ctx.workspaceId, input.businessId, input.actionId, input.decisionId, input.decisionVersionId, input.decisionStatus,
            input.actionType.code, input.actionType.schemaVersion, input.target.kind, input.target.id,
            JSON.stringify(input.proposed), JSON.stringify(input.modification), JSON.stringify(input.modificationEvaluation),
            JSON.stringify(input.finalParameters), input.capturedByUserId, input.correlationId,
          ],
        );
        return rowToCapture(inserted.rows[0]);
      });
    } catch (error) {
      return mapGuardError(error);
    }
  }

  async getCaptureByActionId(ctx: TenantContext, actionId: string): Promise<AuthorizedActionCapture | null> {
    requireUuid('actionId', actionId);
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<Json>(`SELECT * FROM ${CAPTURES} WHERE action_id = $1`, [actionId]);
      return r.rows[0] ? rowToCapture(r.rows[0]) : null;
    });
  }

  /**
   * Assigns the accountable owner of an authorized action as the next version of a linear chain. Re-assigning to the same
   * owner, role, due date and escalation is a no-op that returns the current version. The owner must be a real user with an
   * ACTIVE membership in this tenant and workspace (checked by the database against Identity/Tenancy).
   */
  async assignOwner(ctx: TenantContext, input: AssignOwnerInput): Promise<OwnerAssignment> {
    requireUuid('businessId', input.businessId);
    requireUuid('actionId', input.actionId);
    requireUuid('owner.userId', input.owner?.userId);
    requireUuid('owner.membershipId', input.owner?.membershipId);
    requireUuid('assignedByUserId', input.assignedByUserId);
    requireUuid('correlationId', input.correlationId);
    requireText('roleCode', input.roleCode, 100);
    requireGoverned('dueAt', input.dueAt);
    requireGoverned('escalationPolicy', input.escalationPolicy);
    if (input.dueAt.state === 'VALUE' && Number.isNaN(Date.parse(input.dueAt.value))) {
      throw new ValidationError(ENTITY, ['dueAt must be an ISO timestamp']);
    }
    if (input.escalationPolicy.state === 'VALUE') requireText('escalationPolicy.ref', input.escalationPolicy.value.ref, 200);
    try {
      return await withTenantTransaction(ctx, async (client) => {
        await lockAction(client, 'authorized_action_owner', input.actionId);
        const latest = await client.query<Json>(`SELECT * FROM ${OWNERS} WHERE action_id = $1 ORDER BY assignment_version DESC LIMIT 1`, [input.actionId]);
        const current = latest.rows[0] ? rowToOwner(latest.rows[0]) : null;
        if (current && sameOwner(current, input)) return current;
        const version = current ? current.assignmentVersion + 1 : 1;
        const inserted = await client.query<Json>(
          `INSERT INTO ${OWNERS}
             (tenant_id, workspace_id, business_id, action_id, assignment_version, supersedes_assignment_version,
              owner_user_id, owner_membership_id, role_code, assigned_by_user_id,
              due_at, due_not_applicable_reason, escalation_policy_ref, escalation_not_applicable_reason, correlation_id)
           VALUES ($1,$2,$3,$4,$5,$6, $7,$8,$9,$10, $11,$12::jsonb,$13,$14::jsonb,$15)
           RETURNING *`,
          [
            ctx.tenantId, ctx.workspaceId, input.businessId, input.actionId, version, current ? current.assignmentVersion : null,
            input.owner.userId, input.owner.membershipId, input.roleCode, input.assignedByUserId,
            input.dueAt.state === 'VALUE' ? input.dueAt.value : null,
            input.dueAt.state === 'NOT_APPLICABLE' ? JSON.stringify(input.dueAt.reason) : null,
            input.escalationPolicy.state === 'VALUE' ? input.escalationPolicy.value.ref : null,
            input.escalationPolicy.state === 'NOT_APPLICABLE' ? JSON.stringify(input.escalationPolicy.reason) : null,
            input.correlationId,
          ],
        );
        return rowToOwner(inserted.rows[0]);
      });
    } catch (error) {
      return mapGuardError(error);
    }
  }

  async getCurrentOwner(ctx: TenantContext, actionId: string): Promise<OwnerAssignment | null> {
    requireUuid('actionId', actionId);
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<Json>(`SELECT * FROM ${OWNERS} WHERE action_id = $1 ORDER BY assignment_version DESC LIMIT 1`, [actionId]);
      return r.rows[0] ? rowToOwner(r.rows[0]) : null;
    });
  }

  async getOwnerVersion(ctx: TenantContext, actionId: string, assignmentVersion: number): Promise<OwnerAssignment | null> {
    requireUuid('actionId', actionId);
    if (!Number.isInteger(assignmentVersion) || assignmentVersion < 1) throw new ValidationError(ENTITY, ['assignmentVersion must be an integer >= 1']);
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<Json>(`SELECT * FROM ${OWNERS} WHERE action_id = $1 AND assignment_version = $2`, [actionId, assignmentVersion]);
      return r.rows[0] ? rowToOwner(r.rows[0]) : null;
    });
  }

  async listOwnerVersions(ctx: TenantContext, actionId: string): Promise<OwnerAssignment[]> {
    requireUuid('actionId', actionId);
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<Json>(`SELECT * FROM ${OWNERS} WHERE action_id = $1 ORDER BY assignment_version`, [actionId]);
      return r.rows.map(rowToOwner);
    });
  }

  /** Throws NotFoundError when the action has no capture; convenience for the issuer, which cannot proceed without one. */
  async requireCapture(ctx: TenantContext, actionId: string): Promise<AuthorizedActionCapture> {
    const capture = await this.getCaptureByActionId(ctx, actionId);
    if (!capture) throw new NotFoundError(ENTITY, actionId);
    return capture;
  }
}
