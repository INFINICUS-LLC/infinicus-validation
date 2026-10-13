/**
 * Execution adapter for `inventory_reorder_policy_update@1` (P0-6c; planning decision 6).
 *
 * Consumes ONLY BO's immutable, digest-verified copy of the sealed package (never a request body, recommendation, approval text, browser
 * payload or re-run evaluator input) and the BO-owned evaluation records the package itself references. It orchestrates and judges; the
 * single Business Operations writer (OperationalCommandExecutor.configureInventoryReorderPolicy) performs the SQL, so no second writer
 * exists. The executed values ARE the package's `action.parameters`: nothing is reconstructed, rounded or defaulted.
 *
 * Baseline (ruling O-4, as clarified by the owner in the AC-1 corrections): the baseline is always BO's OWN immutable evaluation records (one per
 * governance dimension); their persisted input snapshot holds the balance values the evaluation judged, and that snapshot is the compare-and-set
 * baseline. A MODIFIED approval carries the references in its governed lineage. A PLAIN approval of an ADI proposal carries none, so they are bound
 * through the proposal it accepted (the proposal cites the records BO produced for exactly its parameters) via the
 * {@link ApprovedProposalBaselineSource} port. Without such evidence the approval is REFUSED(NO_BASELINE_EVIDENCE); if the live balance differs from
 * the baseline it is REFUSED(BASELINE_CHANGED) and the newer state is never overwritten. O-4 is not weakened: no baseline, no execution.
 */
import type { PoolClient } from 'pg';
import type { TenantContext } from '@infinicus/database';
import { InventoryPolicyEvaluationRepository } from '@infinicus/database';
import { canonicalize, computeGovernanceSubjectDigest } from '@infinicus/handoff-contracts';
import type { AuthorizedActionPackageV1, JsonValue } from '@infinicus/handoff-contracts';
import { OperationalCommandExecutor, type ReorderPolicyConfigurationResult } from '../OperationalCommandExecutor.js';
import { Decimal } from '../inventory-policy/decimal.js';
import { EVALUATED_DIMENSIONS, SUPPORTED_ACTION, SUPPORTED_TARGET_KIND } from '../inventory-policy/evaluate.js';
import { INVENTORY_POLICY_EVALUATION_INPUTS_SCHEMA, INVENTORY_POLICY_EVALUATION_REFERENCE_KIND } from '../inventory-policy/InventoryPolicyEvaluationService.js';
import { resolveApprovedRuleSet } from '../inventory-policy/ruleSet.js';
import type { ApprovedProposalBaselineSource } from './ApprovedProposalBaselineSource.js';

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
  /** Baseline of a PLAIN approval (owner ruling 1). Absent = a plain approval has no baseline source and is refused (fail closed). */
  proposalBaseline: ApprovedProposalBaselineSource | null;
}

export class InventoryReorderPolicyExecutionAdapter {
  private readonly d: ReorderExecutionAdapterDependencies;

  constructor(deps: Partial<ReorderExecutionAdapterDependencies> = {}) {
    this.d = { executor: deps.executor ?? new OperationalCommandExecutor(), evaluations: deps.evaluations ?? new InventoryPolicyEvaluationRepository(), proposalBaseline: deps.proposalBaseline ?? null };
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
   * The compare-and-set baseline, from BO's own immutable evaluation records. Modified approval: the records referenced by the package lineage.
   * Plain approval: the records cited by the ADI proposal that was approved unchanged (through the port), additionally required to be PASSED and
   * produced under an approved rule set. In both cases every record must be bound to THIS target and THESE final parameters (subject digest) and
   * all must agree on the single balance they judged.
   */
  async resolveBaseline(ctx: TenantContext, pkg: AuthorizedActionPackageV1, plan: ParsedReorderPlan): Promise<BaselineResolution> {
    const none = (detail: string): BaselineResolution => ({ ok: false, code: 'NO_BASELINE_EVIDENCE', detail });
    const me = pkg.lineage.modificationEvaluation;
    let references: { kind: string; id: string; dimension: string }[];
    let plain = false;
    if (me.state === 'VALUE') {
      references = me.value.evidence.map((e) => ({ kind: e.evidenceRef.kind, id: e.evidenceRef.id, dimension: e.dimension }));
    } else {
      plain = true;
      const source = this.d.proposalBaseline;
      if (source === null) return none('a plain approval carries no baseline and no approved-proposal baseline source is configured (fail closed)');
      const proposed = pkg.lineage.proposedParameters;
      if (proposed.state !== 'VALUE') return none('a plain approval needs the ADI proposal it accepted');
      if (canonicalize(proposed.value.parameters as JsonValue) !== canonicalize(pkg.action.parameters as JsonValue)) return none('the approved parameters differ from the ADI proposal they claim to accept unchanged');
      try {
        references = await source.evaluationReferencesFor(ctx, {
          businessId: pkg.scope.businessId, recommendationId: proposed.value.source.recordId,
          actionType: { code: pkg.action.type.code, schemaVersion: pkg.action.type.schemaVersion }, target: { kind: pkg.action.target.kind, id: pkg.action.target.id },
          parameters: pkg.action.parameters as Record<string, JsonValue>,
        });
      } catch { return none('the evaluation evidence of the approved ADI proposal could not be read'); }
      if (references.length === 0) return none('the approved ADI proposal cites no BO evaluation evidence, so there is no authoritative baseline');
    }
    const wanted = new Set<string>(EVALUATED_DIMENSIONS);
    const refs = new Map<string, string>();
    for (const e of references) {
      if (e.kind !== INVENTORY_POLICY_EVALUATION_REFERENCE_KIND || !wanted.has(e.dimension) || refs.has(e.dimension)) return none('the evaluation evidence is not the expected set of BO evaluation references');
      refs.set(e.dimension, e.id);
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
      if (plain) {
        // The ABA capture verified the proposal's evidence when the approval was recorded; BO re-checks what it relies on, from its own records.
        if (record.result !== 'PASSED') return none(`evaluation ${id} is ${record.result}, not PASSED`);
        try { resolveApprovedRuleSet(record.ruleSetVersion); } catch { return none(`evaluation ${id} was produced under a rule set that is not approved`); }
      }
      const inputs = record.inputs as unknown;
      if (!isObject(inputs) || inputs.schema !== INVENTORY_POLICY_EVALUATION_INPUTS_SCHEMA || !isObject(inputs.facts) || !Array.isArray(inputs.facts.balances)) return none(`evaluation ${id} carries no balance snapshot`);
      const balances = inputs.facts.balances as unknown[];
      if (balances.length !== 1 || !isObject(balances[0])) return none('the evaluation snapshot does not identify exactly one balance');
      const b = balances[0];
      const rp = Decimal.fromSnapshotValue(b.reorderPoint); const rq = Decimal.fromSnapshotValue(b.reorderQuantity); // the evaluator records numeric text (P0-6f)
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
