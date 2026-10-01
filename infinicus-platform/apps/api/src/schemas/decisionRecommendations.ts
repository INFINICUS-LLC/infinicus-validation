
import { z } from 'zod';

export const businessIdParamsSchema = z.object({
  businessId: z.string().uuid(),
});

export const recommendationIdParamsSchema = z.object({
  businessId: z.string().uuid(),
  recommendationId: z.string().uuid(),
});

const riskLevelSchema = z.enum(['low', 'medium', 'high']);

export const recommendedDecisionSchema = z.object({
  id: z.string().uuid(),
  decision: z.string(),
  rationale: z.string(),
  expectedOutcome: z.string(),
  riskLevel: riskLevelSchema,
});

export const recommendResponseSchema = z.object({
  decisions: z.array(recommendedDecisionSchema),
});

export const choiceBodySchema = z.object({
  chosen: z.boolean(),
});

export const choiceResponseSchema = z.object({
  approved: z.boolean(),
  approvedActionId: z.string().uuid().nullable(),
});

export const outcomeBodySchema = z.object({
  approvedActionId: z.string().uuid(),
  outcomeNotes: z.string().min(1).max(4000),
});

export const outcomeResponseSchema = z.object({
  observationId: z.string().uuid(),
});

export const historyResponseSchema = z.object({
  decisions: z.array(z.object({
    id: z.string().uuid(),
    decisionText: z.string(),
    recommendedAt: z.string(),
    chosen: z.boolean().nullable(),
    approvedActionId: z.string().uuid().nullable(),
    outcomeNotes: z.string().nullable(),
  })),
});
