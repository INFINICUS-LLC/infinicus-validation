/**
 * Records the BO evaluation evidence of a derived reorder-policy proposal (AC-1 corrections, owner ruling 1).
 *
 * Business Operations owns operational evaluation truth. For a candidate the read-only derivation produced, this appends - through the existing
 * evaluation service and its immutable B2a records - the four evaluation facts of EXACTLY the proposed parameters, and proves that they were
 * judged against the SAME fact snapshot the proposal was derived from (equal snapshot digest) and PASSED. Those records carry the authoritative
 * baseline (the balance values judged); the ADI proposal cites them, and BO later resolves its compare-and-set baseline from them whether the
 * approver accepts the proposal unchanged or modifies it. It mutates no operational row, emits no event, authorizes nothing.
 * If the facts changed between derivation and recording, or any dimension did not PASS, it refuses and the caller rolls the transaction back.
 */
import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@infinicus/database';
import { SUPPORTED_ACTION, SUPPORTED_TARGET_KIND } from './evaluate.js';
import { InventoryPolicyEvaluationService, INVENTORY_POLICY_EVALUATION_REFERENCE_KIND } from './InventoryPolicyEvaluationService.js';

export interface RecordBaselineEvidenceRequest {
  businessId: string;
  itemId: string;
  ruleSetVersion: string;
  parameters: { reorderPoint: number; reorderQuantity: number };
  /** The snapshot digest of the facts the proposal was derived from. */
  snapshotDigest: string;
  /** The permission the request was authorized under (recorded in the evaluation audit event); supplied by the authenticated route. */
  permissionUsed: string;
}

export type RecordBaselineEvidenceResult =
  | { ok: true; snapshotDigest: string; references: { kind: string; id: string; dimension: string }[] }
  | { ok: false; code: 'EVIDENCE_CHANGED' | 'EVIDENCE_NOT_PASSED'; detail: string };

export class ReorderPolicyBaselineEvidenceRecorder {
  constructor(private readonly evaluation: Pick<InventoryPolicyEvaluationService, 'evaluate'> = new InventoryPolicyEvaluationService()) {}

  async record(ctx: TenantContext, request: RecordBaselineEvidenceRequest): Promise<RecordBaselineEvidenceResult> {
    const outcome = await this.evaluation.evaluate(ctx, {
      businessId: request.businessId,
      actionType: { code: SUPPORTED_ACTION.code, schemaVersion: SUPPORTED_ACTION.schemaVersion },
      target: { kind: SUPPORTED_TARGET_KIND, id: request.itemId },
      finalParameters: { reorderPoint: request.parameters.reorderPoint, reorderQuantity: request.parameters.reorderQuantity },
      ruleSetVersion: request.ruleSetVersion,
      correlationId: randomUUID(),
    }, request.permissionUsed);
    if (outcome.snapshotDigest !== request.snapshotDigest) return { ok: false, code: 'EVIDENCE_CHANGED', detail: 'the facts changed between the derivation and the evidence recording' };
    const notPassed = outcome.evaluations.filter((e) => e.result !== 'PASSED').map((e) => `${e.dimension}:${e.result}`);
    if (notPassed.length > 0) return { ok: false, code: 'EVIDENCE_NOT_PASSED', detail: `the recorded evaluation did not pass: ${notPassed.join(', ')}` };
    return {
      ok: true, snapshotDigest: outcome.snapshotDigest,
      references: outcome.evaluations.map((e) => ({ kind: INVENTORY_POLICY_EVALUATION_REFERENCE_KIND, id: e.id, dimension: e.dimension })),
    };
  }
}
