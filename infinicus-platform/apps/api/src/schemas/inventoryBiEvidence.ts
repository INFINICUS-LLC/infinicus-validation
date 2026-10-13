import { z } from 'zod';

/** AC-2 Block 5: request BI evidence for one inventory item. The body names only the approved rule-set version (no default); BI computes everything else. */
export const inventoryBiEvidenceParamsSchema = z.object({ businessId: z.string().uuid(), itemId: z.string().uuid() });
export const inventoryBiEvidenceBodySchema = z.object({ ruleSetVersion: z.string().min(1).max(200) }).strict();

export const inventoryBiEvidenceResponseSchema = z.union([
  z.object({
    outcome: z.literal('PUBLISHED'), insightPackageId: z.string().uuid(), insightPackageVersionId: z.string().uuid(), versionNumber: z.number().int(),
    metricValueIds: z.record(z.string(), z.string().uuid()), factsDigest: z.string(), capturedAt: z.string(), validUntil: z.string(),
  }),
  z.object({ outcome: z.literal('NOT_PUBLISHED'), code: z.string(), detail: z.string() }),
]);
