import { z } from 'zod';

/**
 * Business Operations: request an inventory policy evaluation (P0-5 Block B2c). The body names ONLY the subject to evaluate and an approved
 * rule-set version. The caller can never supply a result, findings, thresholds, facts, snapshot digest, source, evidence ownership or any
 * time: `.strict()` makes any such property a 400, and the service refuses it again.
 */
export const inventoryPolicyEvaluationParamsSchema = z.object({ businessId: z.string().uuid() });

export const requestInventoryPolicyEvaluationBodySchema = z.object({
  actionType: z.object({ code: z.string().min(1).max(128), schemaVersion: z.string().min(1).max(32) }).strict(),
  target: z.object({ kind: z.string().min(1).max(64), id: z.string().min(1).max(128) }).strict(),
  /** The exact FINAL parameters being evaluated; the evaluator binds its records to their digest. */
  finalParameters: z.record(z.string(), z.any()),
  /** An approved rule-set version, named explicitly (there is no default). */
  ruleSetVersion: z.string().min(1).max(200),
}).strict();

/** An evidence REFERENCE - not an authorization. ABA verifies it later through the GovernanceEvidenceVerifier port. */
export const evidenceReferenceSchema = z.object({
  kind: z.literal('bo_inventory_policy_evaluation'),
  id: z.string().uuid(),
  dimension: z.enum(['CONSTRAINTS', 'RESOURCE_REQUIREMENTS', 'COST', 'EXPECTED_OUTCOME']),
  result: z.enum(['PASSED', 'FAILED', 'INDETERMINATE']),
  evaluatedAt: z.string(),
});

export const inventoryPolicyEvaluationResponseSchema = z.object({
  businessId: z.string().uuid(),
  subjectDigest: z.string(),
  ruleSetVersion: z.string(),
  snapshotDigest: z.string(),
  warehouseId: z.string().uuid().nullable(),
  evidence: z.array(evidenceReferenceSchema).length(4),
});
