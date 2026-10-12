/**
 * Execution adapter for `inventory_reorder_policy_update@1` (P0-6c; planning decision 6).
 *
 * Consumes ONLY BO's immutable, digest-verified copy of the sealed package (never a request body, recommendation, approval text, browser
 * payload or re-run evaluator input) and the BO-owned evaluation records the package itself references. It orchestrates and judges; the
 * single Business Operations writer (OperationalCommandExecutor.configureInventoryReorderPolicy) performs the SQL, so no second writer
 * exists. The executed values ARE the package's `action.parameters`: nothing is reconstructed, rounded or defaulted.
 *
 * Baseline (ruling O-4): a plain approval has no authoritative "state at authorization time", so it is REFUSED(NO_BASELINE_EVIDENCE) in
 * v1. A modified approval carries BO's own immutable evaluation records (one per governance dimension); their persisted input snapshot
 * holds the balance values the evaluation judged. That snapshot is the compare-and-set baseline; if the live balance differs the action is
 * REFUSED(BASELINE_CHANGED) and the newer state is never overwritten.
 */
import type { PoolClient } from 'pg';
import type { TenantContext } from '@infinicus/database';
import { InventoryPolicyEvaluationRepository } from '@infinicus/database';
import { computeGovernanceSubjectDigest } from '@infinicus/handoff-contracts';
import type { AuthorizedActionPackageV1, JsonValue } from '@infinicus/handoff-contracts';
import { OperationalCommandExecutor, type ReorderPolicyConfigurationResult } from '../OperationalCommandExecutor.js';
import { Decimal } from '../inventory-policy/decimal.js';
import { EVALUATED_DIMENSIONS, SUPPORTED_ACTION, SUPPORTED_TARGET_KIND } from '../inventory-policy/evaluate.js';
import { INVENTORY_POLICY_EVALUATION_INPUTS_SCHEMA, INVENTORY_POLICY_EVALUATION_REFERENCE_KIND } from '../inventory-policy/InventoryPolicyEvaluationService.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_DECIMALS = 4;
const EXCLUSIVE_MAX = Decimal.of(10n ** 14n);
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export interface ParsedReorderPlan {
  itemId: string;
  requested: { reorderPoint: Decimal; reorderQuantity: Decimal; reorderPointNumber: number; reorderQuantityNumber: number };
}
export interface PlanRefusal { code: 'TARGET_INVALID' | 'PARAMETERS_INVALID'; detail: string }

export interface LockedBalance {
  id: string;
  warehouseId: string;
  reorderPoint: Decimal;
  reorderQuantity: Decimal;
  quantityAvailable: Decimal;
  version: number;
  state: 'UNSET' | 'CONFIGURED';
}

export type BaselineResolution =
  | { ok: true; balanceId: string; reorderPoint: Decimal; reorderQuantity: Decimal; evaluationRefs: { kind: string; id: string; dimension: string }[] }
  | { ok: false; code: 'NO_BASELINE_EVIDENCE'; detail: string };

export interface ReorderExecutionAdapterDependencies {
  executor: Pick<OperationalCommandExecutor, 'configureInventoryReorderPolicy'>;
  evaluations: Pick<InventoryPolicyEvaluationRepository, 'getById'>;
}

export class InventoryReorderPolicyExecutionAdapter {
  private readonly d: ReorderExecutionAdapterDependencies;

  constructor(deps: Partial<ReorderExecutionAdapterDependencies> = {}) {
    this.d = { executor: deps.executor ?? new OperationalCommandExecutor(), evaluations: deps.evaluations ?? new InventoryPolicyEvaluationRepository() };
  }

  /** Reads the target and the exact requested values from the sealed package. No rounding, coercion or defaulting: anything else refuses. */
  parse(pkg: AuthorizedActionPackageV1): ParsedReorderPlan | PlanRefusal {
    const { type, target, parameters } = pkg.action;
    if (type.code !== SUPPORTED_ACTION.code || type.schemaVersion !== SUPPORTED_ACTION.schemaVersion) {
      return { code: 'PARAMETERS_INVALID', detail: `this adapter executes only ${SUPPORTED_ACTION.code}@${SUPPORTED_ACTION.schemaVersion}` };
    }
    if (target.kind !== SUPPORTED_TARGET_KIND || !UUID.test(target.id)) return { code: 'TARGET_INVALID', detail: 'the target must be an inventory item identified by a lowercase UUID' };
    const keys = Object.keys(parameters).sort();
    if (keys.length !== 2 || keys[0] !== 'reorderPoint' || keys[1] !== 'reorderQuantity') return { code: 'PARAMETERS_INVALID', detail: 'the parameters must be exactly reorderPoint and reorderQuantity' };
    const out: Decimal[] = [];
    for (const name of ['reorderPoint', 'reorderQuantity']) {
      const d = Decimal.fromNumber(parameters[name]);
      if (d === null) return { code: 'PARAMETERS_INVALID', detail: `${name} must be a finite number` };
      if (d.isNegative()) return { code: 'PARAMETERS_INVALID', detail: `${name} must not be negative` };
      if (d.scale > MAX_DECIMALS) return { code: 'PARAMETERS_INVALID', detail: `${name} must have at most ${MAX_DECIMALS} decimal places (it is never rounded)` };
      if (d.gte(EXCLUSIVE_MAX)) return { code: 'PARAMETERS_INVALID', detail: `${name} exceeds the storable range` };
      out.push(d);
    }
    return {
      itemId: target.id,
      requested: { reorderPoint: out[0], reorderQuantity: out[1], reorderPointNumber: parameters.reorderPoint as number, reorderQuantityNumber: parameters.reorderQuantity as number },
    };
  }

  /** Locks every balance row of the target item in this business (FOR UPDATE, stable order). The caller decides on 0 or several. */
  async lockTarget(client: PoolClient, businessId: string, itemId: string): Promise<LockedBalance[]> {
    const r = await client.query<{ id: string; warehouse_id: string; reorder_point: string; reorder_quantity: string; quantity_available: string; version: number; reorder_policy_state: 'UNSET' | 'CONFIGURED' }>(
      `SELECT id, warehouse_id, reorder_point, reorder_quantity, quantity_available, version, reorder_policy_state
         FROM business_operations.inventory_balances
        WHERE business_id = $1 AND inventory_item_id = $2
        ORDER BY id
        FOR UPDATE`,
      [businessId, itemId],
    );
    return r.rows.map((x) => ({
      id: x.id, warehouseId: x.warehouse_id, reorderPoint: Decimal.parse(String(x.reorder_point)) as Decimal, reorderQuantity: Decimal.parse(String(x.reorder_quantity)) as Decimal,
      quantityAvailable: Decimal.parse(String(x.quantity_available)) as Decimal, version: Number(x.version), state: x.reorder_policy_state,
    }));
  }

  /**
   * The compare-and-set baseline, from BO's own immutable evaluation records referenced by the package (modified approvals only).
   * Every record must be bound to THIS target and THESE final parameters (subject digest) and agree on the single balance it judged.
   */
  async resolveBaseline(ctx: TenantContext, pkg: AuthorizedActionPackageV1, plan: ParsedReorderPlan): Promise<BaselineResolution> {
    const none = (detail: string): BaselineResolution => ({ ok: false, code: 'NO_BASELINE_EVIDENCE', detail });
    const me = pkg.lineage.modificationEvaluation;
    if (me.state !== 'VALUE') return none('a plain approval carries no authoritative baseline (v1 refuses it)');
    const evidence = me.value.evidence;
    const wanted = new Set<string>(EVALUATED_DIMENSIONS);
    const refs = new Map<string, string>();
    for (const e of evidence) {
      if (e.evidenceRef.kind !== INVENTORY_POLICY_EVALUATION_REFERENCE_KIND || !wanted.has(e.dimension) || refs.has(e.dimension)) return none('the evaluation evidence is not the expected set of BO evaluation references');
      refs.set(e.dimension, e.evidenceRef.id);
    }
    if (refs.size !== wanted.size) return none('the evaluation evidence does not cover every evaluated dimension');

    const subjectDigest = computeGovernanceSubjectDigest({
      actionType: { code: pkg.action.type.code, schemaVersion: pkg.action.type.schemaVersion },
      target: { kind: pkg.action.target.kind, id: pkg.action.target.id },
      finalParameters: pkg.action.parameters as Record<string, JsonValue>,
    } as never);

    let agreed: { id: string; reorderPoint: Decimal; reorderQuantity: Decimal } | null = null;
    const evaluationRefs: { kind: string; id: string; dimension: string }[] = [];
    for (const [dimension, id] of refs) {
      let record;
      try { record = await this.d.evaluations.getById(ctx, pkg.scope.businessId, id); } catch { return none(`evaluation ${id} could not be read in this business`); }
      if (record.dimension !== dimension || record.inventoryItemId !== plan.itemId || record.subjectDigest !== subjectDigest) return none(`evaluation ${id} is not bound to this target and these parameters`);
      const inputs = record.inputs as unknown;
      if (!isObject(inputs) || inputs.schema !== INVENTORY_POLICY_EVALUATION_INPUTS_SCHEMA || !isObject(inputs.facts) || !Array.isArray(inputs.facts.balances)) return none(`evaluation ${id} carries no balance snapshot`);
      const balances = inputs.facts.balances as unknown[];
      if (balances.length !== 1 || !isObject(balances[0])) return none('the evaluation snapshot does not identify exactly one balance');
      const b = balances[0];
      const rp = Decimal.fromNumber(b.reorderPoint); const rq = Decimal.fromNumber(b.reorderQuantity);
      if (typeof b.id !== 'string' || !UUID.test(b.id) || rp === null || rq === null) return none('the evaluation snapshot balance is malformed');
      if (agreed !== null && (agreed.id !== b.id || agreed.reorderPoint.cmp(rp) !== 0 || agreed.reorderQuantity.cmp(rq) !== 0)) return none('the evaluation records disagree on the baseline');
      agreed = { id: b.id, reorderPoint: rp, reorderQuantity: rq };
      evaluationRefs.push({ kind: INVENTORY_POLICY_EVALUATION_REFERENCE_KIND, id, dimension });
    }
    if (agreed === null) return none('no baseline');
    return { ok: true, balanceId: agreed.id, reorderPoint: agreed.reorderPoint, reorderQuantity: agreed.reorderQuantity, evaluationRefs };
  }

  /** Applies the change through the single BO writer with the baseline as a compare-and-set. */
  async apply(client: PoolClient, ctx: TenantContext, args: {
    pkg: AuthorizedActionPackageV1; plan: ParsedReorderPlan; balance: LockedBalance; correlationId: string; actorId: string; occurredAt: string;
  }): Promise<ReorderPolicyConfigurationResult> {
    return this.d.executor.configureInventoryReorderPolicy(client, ctx, {
      type: 'configure_inventory_reorder_policy',
      context: {
        tenantId: args.pkg.scope.tenantId, workspaceId: args.pkg.scope.workspaceId, businessId: args.pkg.scope.businessId, correlationId: args.correlationId,
        sourceReference: `authorized_action_package:${args.pkg.identity.packageId}:${args.pkg.identity.packageVersion}`, idempotencyKey: `aap-exec:${args.pkg.identity.packageId}:${args.pkg.identity.packageVersion}`,
        actorId: args.actorId, occurredAt: args.occurredAt,
      },
      payload: {
        inventoryItemId: args.plan.itemId, warehouseId: args.balance.warehouseId, reorderPoint: args.plan.requested.reorderPointNumber,
        reorderQuantity: args.plan.requested.reorderQuantityNumber, configurationSource: 'AUTHORIZED_ACTION_PACKAGE',
        expectedBaseline: { reorderPoint: Number(args.balance.reorderPoint.toString()), reorderQuantity: Number(args.balance.reorderQuantity.toString()) },
      },
    });
  }
}
