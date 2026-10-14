import { z } from 'zod';

/** AC-2 Block 6: request the BDT current state of one inventory item. No body fields: the twin is derived from the latest BI evidence, never from the caller. */
export const inventoryItemTwinParamsSchema = z.object({ businessId: z.string().uuid(), itemId: z.string().uuid() });
export const inventoryItemTwinBodySchema = z.object({}).strict();

export const inventoryItemTwinResponseSchema = z.union([
  z.object({
    outcome: z.literal('PUBLISHED'), snapshotId: z.string().uuid(), snapshotVersionId: z.string().uuid(), instanceId: z.string().uuid(),
    effectiveAt: z.string(), validUntil: z.string(), factsDigest: z.string(), state: z.record(z.string(), z.any()),
  }),
  z.object({ outcome: z.literal('NOT_PUBLISHED'), code: z.string(), detail: z.string() }),
]);
