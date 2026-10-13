import { z } from 'zod';

export const reorderPolicyRecommendationParamsSchema = z.object({
  businessId: z.string().uuid(),
  itemId: z.string().uuid(),
});

const recommended = z.object({
  outcome: z.literal('RECOMMENDED'),
  recommendationId: z.string().uuid(),
  recommendationVersionId: z.string().uuid(),
  riskClass: z.string().nullable(),
  validUntil: z.string().nullable(),
  /** The structured adi-proposed-action/1 document (validated by the producer before it is stored). */
  proposal: z.record(z.unknown()),
});

const noRecommendation = z.object({
  outcome: z.literal('NO_RECOMMENDATION'),
  code: z.string(),
  detail: z.string(),
  reasonCodes: z.array(z.string()),
});

export const reorderPolicyRecommendationResponseSchema = z.union([recommended, noRecommendation]);
