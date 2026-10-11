import { z } from 'zod';

/**
 * Business Administration: declared currency (migration 0185). The body carries ONLY the declared value, the version the caller believes is
 * current and a reason. Tenant, workspace, actor, permission, time and version are never accepted from the caller.
 */
export const declaredCurrencyParamsSchema = z.object({ businessId: z.string().uuid() });

export const declareCurrencyBodySchema = z.object({
  /** Canonical three-uppercase-letter code; the service/database refuse anything else (no normalisation). */
  currency: z.string().min(1).max(16),
  /** null = "the business is UNDECLARED"; otherwise the current version number (a mismatch is a 409). */
  expectedVersion: z.number().int().min(1).nullable(),
  reason: z.string().min(1).max(1000).optional(),
}).strict();

export const declaredCurrencyRecordSchema = z.object({
  declarationId: z.string().uuid(),
  version: z.number().int(),
  currency: z.string(),
  priorCurrency: z.string().nullable(),
  supersedesVersion: z.number().int().nullable(),
  provenance: z.literal('EXPLICIT_DECLARATION'),
  declaredByUserId: z.string().uuid(),
  permissionUsed: z.string(),
  reason: z.string().nullable(),
  correlationId: z.string().uuid(),
  declaredAt: z.string(),
});

export const declaredCurrencyViewSchema = z.object({
  status: z.enum(['UNDECLARED', 'DECLARED']),
  businessId: z.string().uuid(),
  /** null when UNDECLARED - there is never a default value here. */
  declaration: declaredCurrencyRecordSchema.nullable(),
});

export const declareCurrencyResponseSchema = z.object({
  outcome: z.enum(['DECLARED', 'CHANGED', 'UNCHANGED']),
  businessId: z.string().uuid(),
  declaration: declaredCurrencyRecordSchema,
});

export const declaredCurrencyHistoryResponseSchema = z.object({
  businessId: z.string().uuid(),
  items: z.array(declaredCurrencyRecordSchema),
});
