import { z } from 'zod';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const businessPerformanceTwinParamsSchema = z.object({ businessId: z.string().uuid() });
/** The reporting period is the only input; the twin is derived from BI evidence, never from figures the caller supplies. */
export const businessPerformanceTwinBodySchema = z.object({ from: date, to: date }).strict();
export const businessPerformanceTwinQuerySchema = z.object({ from: date.optional(), to: date.optional() }).refine((q) => (q.from === undefined) === (q.to === undefined), { message: 'from and to go together' });

const state = z.record(z.string(), z.any());
export const businessPerformanceTwinPublishResponseSchema = z.union([
  z.object({ outcome: z.literal('PUBLISHED'), snapshotId: z.string().uuid(), snapshotVersionId: z.string().uuid(), instanceId: z.string().uuid(), effectiveAt: z.string(), evidenceDigest: z.string(), state }),
  z.object({ outcome: z.literal('NOT_PUBLISHED'), code: z.string(), detail: z.string() }),
]);
export const businessPerformanceTwinLatestResponseSchema = z.object({
  snapshotId: z.string().uuid(), effectiveAt: z.string(), state,
  integrity: z.object({ valid: z.boolean(), reasons: z.array(z.string()) }),
});
