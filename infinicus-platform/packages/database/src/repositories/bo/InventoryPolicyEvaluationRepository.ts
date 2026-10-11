// P0-5/P0-6 preparation, Block B2a: persistence for the BO-owned inventory policy EVALUATION RECORD (migration 0182).
//
// This repository stores and reads authoritative evaluation results. It evaluates NOTHING: no rules, thresholds, freshness windows,
// capacity conversions or defaults live here. It does not import ABA, workflow or issuer code, emits no event, mutates no inventory
// and offers no UPDATE or DELETE (the table is append-only for every role).
//
// Transaction behaviour: every call runs through withTenantTransaction, so it joins a caller's shared tenant transaction or opens
// its own RLS-confined one.
//
// Idempotency: NONE by design. Each insert is a new, distinct evaluation fact (a changed or repeated evaluation is a new row with
// its own database time); two evaluations are never silently merged because their content looks alike. Callers that need
// "the latest evaluation of this subject" read it with findForSubject.

import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';
import { NotFoundError } from './errors.js';

export const INVENTORY_POLICY_EVALUATION_DIMENSIONS = ['CONSTRAINTS', 'RESOURCE_REQUIREMENTS', 'COST', 'EXPECTED_OUTCOME'] as const;
export type InventoryPolicyEvaluationDimension = (typeof INVENTORY_POLICY_EVALUATION_DIMENSIONS)[number];

export const INVENTORY_POLICY_EVALUATION_RESULTS = ['PASSED', 'FAILED', 'INDETERMINATE'] as const;
export type InventoryPolicyEvaluationResult = (typeof INVENTORY_POLICY_EVALUATION_RESULTS)[number];

export type EvaluationJson = string | number | boolean | null | EvaluationJson[] | { [key: string]: EvaluationJson };

/** The exact action subject an evaluation is bound to; `subjectDigest` is computed over it with the shared contract helper. */
export interface InventoryPolicyEvaluationSubject {
  actionType: { code: string; schemaVersion: string };
  target: { kind: string; id: string };
  finalParameters: { [key: string]: EvaluationJson };
}

export interface InventoryPolicyEvaluation {
  id: string;
  tenantId: string;
  workspaceId: string;
  businessId: string;
  inventoryItemId: string;
  warehouseId: string | null;
  dimension: InventoryPolicyEvaluationDimension;
  result: InventoryPolicyEvaluationResult;
  subject: InventoryPolicyEvaluationSubject;
  subjectDigest: string;
  ruleSetVersion: string;
  inputs: { [key: string]: EvaluationJson };
  findings: EvaluationJson[];
  /** Database time, millisecond UTC (ISO-8601 with `Z`). */
  evaluatedAt: string;
  requestedByUserId: string;
  correlationId: string;
}

export interface RecordInventoryPolicyEvaluationInput {
  businessId: string;
  inventoryItemId: string;
  warehouseId?: string | null;
  dimension: InventoryPolicyEvaluationDimension;
  result: InventoryPolicyEvaluationResult;
  subject: InventoryPolicyEvaluationSubject;
  subjectDigest: string;
  ruleSetVersion: string;
  inputs: { [key: string]: EvaluationJson };
  findings: EvaluationJson[];
  requestedByUserId: string;
  correlationId: string;
}

export class InventoryPolicyEvaluationValidationError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`InventoryPolicyEvaluation validation failed: ${problems.join('; ')}`);
    this.name = 'ValidationError';
    this.problems = problems;
  }
}

const ENTITY = 'InventoryPolicyEvaluation';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const COLUMNS = `id, tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, dimension, result, subject, subject_digest,
  rule_set_version, inputs, findings, evaluated_at, requested_by_user_id, correlation_id`;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

function isoMs(value: unknown): string {
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}

function rowToEvaluation(row: Record<string, unknown>): InventoryPolicyEvaluation {
  return {
    id: row.id as string, tenantId: row.tenant_id as string, workspaceId: row.workspace_id as string, businessId: row.business_id as string,
    inventoryItemId: row.inventory_item_id as string, warehouseId: (row.warehouse_id as string | null) ?? null,
    dimension: row.dimension as InventoryPolicyEvaluationDimension, result: row.result as InventoryPolicyEvaluationResult,
    subject: row.subject as InventoryPolicyEvaluationSubject, subjectDigest: row.subject_digest as string,
    ruleSetVersion: row.rule_set_version as string, inputs: row.inputs as { [key: string]: EvaluationJson }, findings: row.findings as EvaluationJson[],
    evaluatedAt: isoMs(row.evaluated_at), requestedByUserId: row.requested_by_user_id as string, correlationId: row.correlation_id as string,
  };
}

function validate(input: RecordInventoryPolicyEvaluationInput): void {
  const problems: string[] = [];
  if (!UUID.test(input.businessId)) problems.push('businessId must be a lowercase UUID');
  if (!UUID.test(input.inventoryItemId)) problems.push('inventoryItemId must be a lowercase UUID');
  if (input.warehouseId != null && !UUID.test(input.warehouseId)) problems.push('warehouseId must be a lowercase UUID');
  if (!(INVENTORY_POLICY_EVALUATION_DIMENSIONS as readonly string[]).includes(input.dimension)) problems.push(`dimension must be one of ${INVENTORY_POLICY_EVALUATION_DIMENSIONS.join(', ')}`);
  if (!(INVENTORY_POLICY_EVALUATION_RESULTS as readonly string[]).includes(input.result)) problems.push(`result must be one of ${INVENTORY_POLICY_EVALUATION_RESULTS.join(', ')}`);
  if (!DIGEST.test(String(input.subjectDigest))) problems.push('subjectDigest must be sha256:<64 lowercase hex>');
  if (!nonEmpty(input.ruleSetVersion) || input.ruleSetVersion.length > 200) problems.push('ruleSetVersion must be a non-empty string of at most 200 characters');
  const s = input.subject as unknown;
  if (!isPlainObject(s) || !isPlainObject(s.actionType) || !nonEmpty(s.actionType.code) || !nonEmpty(s.actionType.schemaVersion)
    || !isPlainObject(s.target) || !nonEmpty(s.target.kind) || !nonEmpty(s.target.id) || !isPlainObject(s.finalParameters)) {
    problems.push('subject must be { actionType: { code, schemaVersion }, target: { kind, id }, finalParameters: {} }');
  }
  if (!isPlainObject(input.inputs)) problems.push('inputs must be a JSON object');
  if (!Array.isArray(input.findings)) problems.push('findings must be a JSON array');
  if (!UUID.test(input.requestedByUserId)) problems.push('requestedByUserId must be a lowercase UUID');
  if (!UUID.test(input.correlationId)) problems.push('correlationId must be a lowercase UUID');
  if (problems.length === 0) {
    try { JSON.stringify([input.subject, input.inputs, input.findings]); } catch { problems.push('subject, inputs and findings must be JSON-serializable'); }
  }
  if (problems.length > 0) throw new InventoryPolicyEvaluationValidationError(problems);
}

/** Audit data for the governance-relevant request that produced the rows (written atomically with them). */
export interface InventoryPolicyEvaluationAudit {
  /** The permission the request was authorized under (for example `bo:write`). */
  permissionUsed: string;
}

export class InventoryPolicyEvaluationRepository {
  /**
   * Appends one evaluation fact. The database stamps `evaluated_at`, checks the item and warehouse belong to this tenant, workspace and
   * business, and enforces the vocabulary and shape constraints. A rejected row raises; nothing is retried or corrected.
   */
  async record(ctx: TenantContext, input: RecordInventoryPolicyEvaluationInput): Promise<InventoryPolicyEvaluation> {
    validate(input);
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `INSERT INTO business_operations.inventory_policy_evaluations
           (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, dimension, result, subject, subject_digest,
            rule_set_version, inputs, findings, requested_by_user_id, correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::jsonb,$12::jsonb,$13,$14)
         RETURNING ${COLUMNS}`,
        [
          ctx.tenantId, ctx.workspaceId, input.businessId, input.inventoryItemId, input.warehouseId ?? null, input.dimension, input.result,
          JSON.stringify(input.subject), input.subjectDigest, input.ruleSetVersion, JSON.stringify(input.inputs), JSON.stringify(input.findings),
          input.requestedByUserId, input.correlationId,
        ],
      );
      return rowToEvaluation(result.rows[0]);
    });
  }

  /**
   * Appends several evaluation facts ATOMICALLY (one tenant transaction): all rows are written or none is. Each row is validated first and goes
   * through exactly the same INSERT as `record`; this is a batching convenience, not a second writer. Returns the rows in input order.
   */
  async recordAll(ctx: TenantContext, inputs: RecordInventoryPolicyEvaluationInput[], audit?: InventoryPolicyEvaluationAudit): Promise<InventoryPolicyEvaluation[]> {
    if (inputs.length === 0) throw new InventoryPolicyEvaluationValidationError(['at least one evaluation is required']);
    for (const input of inputs) validate(input);
    if (audit !== undefined && !nonEmpty(audit.permissionUsed)) throw new InventoryPolicyEvaluationValidationError(['audit.permissionUsed is required']);
    return withTenantTransaction(ctx, async (client) => {
      const out: InventoryPolicyEvaluation[] = [];
      for (const input of inputs) {
        const result = await client.query<Record<string, unknown>>(
          `INSERT INTO business_operations.inventory_policy_evaluations
             (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, dimension, result, subject, subject_digest,
              rule_set_version, inputs, findings, requested_by_user_id, correlation_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::jsonb,$12::jsonb,$13,$14)
           RETURNING ${COLUMNS}`,
          [
            ctx.tenantId, ctx.workspaceId, input.businessId, input.inventoryItemId, input.warehouseId ?? null, input.dimension, input.result,
            JSON.stringify(input.subject), input.subjectDigest, input.ruleSetVersion, JSON.stringify(input.inputs), JSON.stringify(input.findings),
            input.requestedByUserId, input.correlationId,
          ],
        );
        out.push(rowToEvaluation(result.rows[0]));
      }
      if (audit !== undefined) {
        // The platform audit record (audit.audit_events, the same record every layer uses - not a second source of truth), written on the
        // SAME client so the evaluation facts and their audit commit or roll back together.
        const first = inputs[0];
        await client.query(
          `INSERT INTO audit.audit_events
             (tenant_id, workspace_id, business_id, actor_type, actor_id, action, entity_type, entity_id, metadata, correlation_id)
           VALUES ($1,$2,$3,'user',$4,'bo.inventory_policy_evaluation.requested','inventory_item',$5,$6::jsonb,$7)`,
          [
            ctx.tenantId, ctx.workspaceId, first.businessId, ctx.userId, first.inventoryItemId,
            JSON.stringify({
              permissionUsed: audit.permissionUsed, subjectDigest: first.subjectDigest, ruleSetVersion: first.ruleSetVersion, target: (first.subject as { target: unknown }).target,
              evaluations: out.map((e) => ({ id: e.id, dimension: e.dimension, result: e.result, evaluatedAt: e.evaluatedAt })),
            }),
            first.correlationId,
          ],
        );
      }
      return out;
    });
  }

  /**
   * One evaluation by id PLUS the database clock read in the same statement (millisecond UTC), for evidence verification: the
   * freshness decision must use the database's time, not the caller's. Same scope rule as `getById`; anything else is NotFound.
   */
  async getByIdWithDatabaseNow(ctx: TenantContext, businessId: string, id: string): Promise<{ evaluation: InventoryPolicyEvaluation; databaseNow: string }> {
    if (!UUID.test(businessId) || !UUID.test(id)) throw new NotFoundError(ENTITY, id);
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT ${COLUMNS}, to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS database_now
           FROM business_operations.inventory_policy_evaluations
          WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND business_id = $4`,
        [id, ctx.tenantId, ctx.workspaceId, businessId],
      );
      if (result.rows.length === 0) throw new NotFoundError(ENTITY, id);
      return { evaluation: rowToEvaluation(result.rows[0]), databaseNow: result.rows[0].database_now as string };
    });
  }

  /** One evaluation by id within the caller's tenant and workspace AND the stated business; anything else is NotFound. */
  async getById(ctx: TenantContext, businessId: string, id: string): Promise<InventoryPolicyEvaluation> {
    if (!UUID.test(businessId) || !UUID.test(id)) throw new NotFoundError(ENTITY, id);
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT ${COLUMNS} FROM business_operations.inventory_policy_evaluations
          WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND business_id = $4`,
        [id, ctx.tenantId, ctx.workspaceId, businessId],
      );
      if (result.rows.length === 0) throw new NotFoundError(ENTITY, id);
      return rowToEvaluation(result.rows[0]);
    });
  }

  /** All evaluations of one exact subject (by digest), newest first, optionally for one dimension. Used later to verify evidence. */
  async findForSubject(ctx: TenantContext, businessId: string, subjectDigest: string, dimension?: InventoryPolicyEvaluationDimension): Promise<InventoryPolicyEvaluation[]> {
    if (!UUID.test(businessId) || !DIGEST.test(subjectDigest)) return [];
    return withTenantTransaction(ctx, async (client) => {
      const params: unknown[] = [ctx.tenantId, ctx.workspaceId, businessId, subjectDigest];
      let dimensionClause = '';
      if (dimension !== undefined) { params.push(dimension); dimensionClause = ` AND dimension = $${params.length}`; }
      const result = await client.query<Record<string, unknown>>(
        `SELECT ${COLUMNS} FROM business_operations.inventory_policy_evaluations
          WHERE tenant_id = $1 AND workspace_id = $2 AND business_id = $3 AND subject_digest = $4${dimensionClause}
          ORDER BY evaluated_at DESC, id DESC`,
        params,
      );
      return result.rows.map(rowToEvaluation);
    });
  }

  /** Recent evaluations of one business, newest first (bounded). */
  async listForBusiness(ctx: TenantContext, businessId: string, limit = 50): Promise<InventoryPolicyEvaluation[]> {
    if (!UUID.test(businessId)) return [];
    const bounded = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT ${COLUMNS} FROM business_operations.inventory_policy_evaluations
          WHERE tenant_id = $1 AND workspace_id = $2 AND business_id = $3 ORDER BY evaluated_at DESC, id DESC LIMIT $4`,
        [ctx.tenantId, ctx.workspaceId, businessId, bounded],
      );
      return result.rows.map(rowToEvaluation);
    });
  }
}
