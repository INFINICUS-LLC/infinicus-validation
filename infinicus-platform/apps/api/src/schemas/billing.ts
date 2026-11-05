import { z } from 'zod';

export const planSummarySchema = z.object({
  code: z.string(),
  name: z.string(),
  priceCents: z.number(),
  currency: z.string(),
  billingInterval: z.string(),
  limits: z.record(z.string(), z.union([z.number(), z.null()])),
  features: z.record(z.string(), z.boolean()),
});

export const subscriptionResponseSchema = z.object({
  id: z.string(),
  status: z.string(),
  trialEndsAt: z.string().nullable(),
  currentPeriodStart: z.string(),
  currentPeriodEnd: z.string(),
  gracePeriodEndsAt: z.string().nullable(),
  paymentStatus: z.string(),
  plan: planSummarySchema,
  usage: z.record(z.string(), z.number()),
});

export const startTrialBodySchema = z.object({
  planCode: z.string().min(1).max(64).default('free'),
});

