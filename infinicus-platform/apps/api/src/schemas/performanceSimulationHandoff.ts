import { z } from 'zod';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const performanceSimulationHandoffParamsSchema = z.object({ businessId: z.string().uuid() });
/** The reporting period is the only input; the hand-off is derived from the published, integrity-verified twin state, never from figures the caller supplies. */
export const performanceSimulationHandoffBodySchema = z.object({ from: date, to: date }).strict();

export const performanceSimulationHandoffResponseSchema = z.union([
  z.object({
    outcome: z.literal('HANDED_OFF'), replay: z.literal(false), publicationPackageId: z.string().uuid(), scenarioBaselineId: z.string().uuid(),
    scenarioBaselineVersionId: z.string().uuid(), snapshotId: z.string().uuid(), confidenceScoreId: z.string().uuid(),
    envelopeDigest: z.string().regex(/^[0-9a-f]{64}$/), handoff: z.record(z.string(), z.any()),
  }),
  z.object({ outcome: z.literal('HANDED_OFF'), replay: z.literal(true), publicationPackageId: z.string().uuid(), publicationStatus: z.string(), snapshotId: z.string().uuid(), confidenceScoreId: z.string().uuid(), envelopeDigest: z.string().regex(/^[0-9a-f]{64}$/) }),
  z.object({ outcome: z.literal('NOT_HANDED_OFF'), code: z.string(), detail: z.string() }),
]);
