/**
 * Test-only builders for the P0-6c execution engine tests: a business with an inventory item/warehouse/balance, BO evaluation records that
 * give a modified approval its baseline, sealed packages bound to that item, and a claimed package (real intake service, stub provider).
 * Superuser inserts; never imported by production code.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures edit arbitrary JSON bodies */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { InventoryPolicyEvaluationRepository } from '@infinicus/database';
import { computeGovernanceSubjectDigest } from '@infinicus/handoff-contracts';
import type { AuthoritativePackageStatusProvider, AuthoritativeStatusAnswer, AuthorizedActionPackageV1 } from '@infinicus/handoff-contracts';
import { AuthorizedActionIntakeService, explicitCapabilities, type BoIntakeContext } from '../../src/index.js';
import { INVENTORY_POLICY_EVALUATION_INPUTS_SCHEMA } from '../../src/inventory-policy/InventoryPolicyEvaluationService.js';
import { answerFor, iso, makeWorld, sealedPackage, val, MIN, type World } from './intakeFixture.js';

export const SUPPORTED = explicitCapabilities(['inventory_reorder_policy_update@1']);
export const DIMENSIONS = ['CONSTRAINTS', 'RESOURCE_REQUIREMENTS', 'COST', 'EXPECTED_OUTCOME'] as const;

export interface ExecWorld {
  w: World;
  ctx: BoIntakeContext;
  itemId: string;
  warehouseId: string;
  balanceId: string;
}

export interface ExecWorldOptions {
  baseline?: [number, number];
  onHand?: number;
  /** A second warehouse balance for the same item (the target becomes ambiguous). */
  secondBalance?: boolean;
  /** Skip the balance entirely (no target to mutate). */
  noBalance?: boolean;
}

export async function makeExecWorld(admin: Pool, tenantIds: string[], o: ExecWorldOptions = {}): Promise<ExecWorld> {
  const w = await makeWorld(admin);
  tenantIds.push(w.tenantId);
  const ctx: BoIntakeContext = { tenantId: w.tenantId, workspaceId: w.workspaceId, userId: randomUUID(), businessId: w.businessId };
  const itemId = randomUUID(); const warehouseId = randomUUID(); const balanceId = randomUUID();
  await admin.query(`INSERT INTO platform.inventory_items (id, tenant_id, workspace_id, business_id, sku, name, status) VALUES ($1,$2,$3,$4,$5,'Item','active')`, [itemId, w.tenantId, w.workspaceId, w.businessId, `sku-${itemId}`]);
  const warehouses = o.secondBalance ? [warehouseId, randomUUID()] : [warehouseId];
  for (const id of warehouses) {
    await admin.query(`INSERT INTO platform.warehouses (id, tenant_id, workspace_id, business_id, warehouse_code, name) VALUES ($1,$2,$3,$4,$5,'WH')`, [id, w.tenantId, w.workspaceId, w.businessId, `wh-${id}`]);
  }
  const [rp, rq] = o.baseline ?? [100, 200];
  if (!o.noBalance) {
    await admin.query(
      `INSERT INTO business_operations.inventory_balances (id, tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, quantity_on_hand, reorder_point, reorder_quantity)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [balanceId, w.tenantId, w.workspaceId, w.businessId, itemId, warehouseId, o.onHand ?? 50, rp, rq]);
    if (o.secondBalance) {
      await admin.query(
        `INSERT INTO business_operations.inventory_balances (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, quantity_on_hand, reorder_point, reorder_quantity)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [w.tenantId, w.workspaceId, w.businessId, itemId, warehouses[1], 10, rp, rq]);
    }
  }
  return { w, ctx, itemId, warehouseId, balanceId };
}

export interface PackageSpec {
  /** Final parameters. */
  reorderPoint: number;
  reorderQuantity: number;
  /** A modified approval: the evaluation baseline (default: the world's current balance) and what was proposed before the modification. */
  modified?: {
    baseline: [number, number]; proposed?: [number, number]; evalMutate?: (inputs: any) => void; perDimension?: (inputs: any, dimension: string) => void;
    /** The final parameters the evaluation records were bound to, when they differ from the package's. */
    evalFinal?: { reorderPoint: number; reorderQuantity: number };
    /** The inventory item the evaluation records are filed under, when it differs from the target. */
    recordedItemId?: string;
  };
  mutate?: (body: any) => void;
  window?: { startOffset?: number; endOffset?: number };
  preconditions?: unknown;
}

/** Records the four BO evaluation records for the final parameters and returns their references. */
export async function recordEvaluations(ew: ExecWorld, final: { reorderPoint: number; reorderQuantity: number }, baseline: [number, number], mutate?: (inputs: any) => void, o: { perDimension?: (inputs: any, dimension: string) => void; recordedItemId?: string } = {}) {
  const subject = {
    actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '1' }, target: { kind: 'inventory_item', id: ew.itemId },
    finalParameters: { reorderPoint: final.reorderPoint, reorderQuantity: final.reorderQuantity },
  };
  const inputs: any = {
    schema: INVENTORY_POLICY_EVALUATION_INPUTS_SCHEMA, ruleSet: { id: 'inventory-reorder-policy', version: '1.0.0', parameters: {} }, capturedAt: iso(Date.now()),
    facts: { balances: [{ id: ew.balanceId, warehouseId: ew.warehouseId, reorderPoint: baseline[0], reorderQuantity: baseline[1] }] }, snapshotDigest: `sha256:${'a'.repeat(64)}`,
  };
  mutate?.(inputs);
  const subjectDigest = computeGovernanceSubjectDigest(subject as never);
  const rows = await new InventoryPolicyEvaluationRepository().recordAll(ew.ctx, DIMENSIONS.map((dimension) => {
    const own = JSON.parse(JSON.stringify(inputs));
    o.perDimension?.(own, dimension);
    return {
      businessId: ew.w.businessId, inventoryItemId: o.recordedItemId ?? ew.itemId, warehouseId: ew.warehouseId, dimension, result: 'PASSED' as const, subject: subject as never, subjectDigest,
      ruleSetVersion: '1.0.0', inputs: own, findings: [], requestedByUserId: ew.ctx.userId, correlationId: randomUUID(),
    };
  }));
  return rows.map((r) => ({ dimension: r.dimension, evaluatedAt: r.evaluatedAt, result: 'PASSED', evidenceRef: { kind: 'bo_inventory_policy_evaluation', id: r.id } }));
}

export async function buildPackage(ew: ExecWorld, spec: PackageSpec): Promise<AuthorizedActionPackageV1> {
  const final = { reorderPoint: spec.reorderPoint, reorderQuantity: spec.reorderQuantity };
  let evidence: any[] | null = null;
  if (spec.modified) {
    evidence = await recordEvaluations(ew, spec.modified.evalFinal ?? final, spec.modified.baseline, spec.modified.evalMutate, { perDimension: spec.modified.perDimension, recordedItemId: spec.modified.recordedItemId });
    // The decision must come after the (database-stamped) evaluations and the issuance after the decision, all in the past at intake time.
    const latest = Math.max(...evidence.map((e) => Date.parse(e.evaluatedAt)));
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, latest + 120 - Date.now())));
  }
  return sealedPackage(ew.w, {
    targetId: ew.itemId, parameters: final,
    windowStartOffset: spec.window?.startOffset ?? -2 * MIN, windowEndOffset: spec.window?.endOffset ?? 60 * MIN,
    mutate: (b: any) => {
      if (spec.preconditions !== undefined) b.action.preconditions = val(spec.preconditions);
      if (spec.modified && evidence) {
        const proposed = spec.modified.proposed ?? [spec.reorderPoint - 5, spec.reorderQuantity - 10];
        const earliest = Math.min(...evidence.map((e) => Date.parse(e.evaluatedAt)));
        const latest = Math.max(...evidence.map((e) => Date.parse(e.evaluatedAt)));
        const modifiedAtMs = earliest - 1000;
        b.authorization.decidedAt = iso(latest + 20);
        b.issuance.issuedAt = iso(latest + 40);
        b.authorization.decisionStatus = 'approved_with_modifications';
        b.lineage.proposedParameters = val({ source: { layer: 'ADI', recordType: 'decision_recommendation_version', recordId: randomUUID() }, parameters: { reorderPoint: proposed[0], reorderQuantity: proposed[1] } });
        b.lineage.modification = val({
          reason: 'Adjusted by the approver.', modifiedByUserId: b.authorization.approver.userId, modifiedAt: iso(modifiedAtMs),
          changes: [{ parameter: 'reorderPoint', operation: 'SET', before: proposed[0], after: spec.reorderPoint }, { parameter: 'reorderQuantity', operation: 'SET', before: proposed[1], after: spec.reorderQuantity }],
        });
        b.lineage.modificationEvaluation = val({ basis: 'DECLARED_IMPACT', evidence });
      }
      spec.mutate?.(b);
    },
  });
}

/** A provider whose answer is programmable per call. */
export class ScriptedProvider implements AuthoritativePackageStatusProvider {
  calls = 0;
  constructor(private respond: (n: number) => AuthoritativeStatusAnswer | null | Promise<AuthoritativeStatusAnswer | null>) {}
  async getStatus(): Promise<AuthoritativeStatusAnswer | null> { this.calls += 1; return this.respond(this.calls); }
  set(respond: (n: number) => AuthoritativeStatusAnswer | null | Promise<AuthoritativeStatusAnswer | null>): void { this.respond = respond; }
}

/** Takes the single-use claim through the REAL intake service (stub provider says ISSUED + CURRENT). */
export async function claimPackage(ew: ExecWorld, pkg: AuthorizedActionPackageV1): Promise<{ claimId: string; receiptId: string }> {
  const intake = new AuthorizedActionIntakeService({ statusProvider: new ScriptedProvider(() => answerFor(pkg)), statusMaxAgeMs: 10_000, capabilities: SUPPORTED });
  const r = await intake.intake(ew.ctx, { package: pkg });
  return { claimId: r.claimId, receiptId: r.receiptId };
}

/** The answer the engine's provider gives: CONSUMED by this claim's receipt (the ABA mirror) with CURRENT authority, fresh. */
export const consumedAnswer = (pkg: AuthorizedActionPackageV1, receiptId: string, over: Parameters<typeof answerFor>[1] = {}): AuthoritativeStatusAnswer =>
  answerFor(pkg, { ...over, status: { lifecycle: 'CONSUMED', consumptionReceiptId: receiptId, ...over.status } });
