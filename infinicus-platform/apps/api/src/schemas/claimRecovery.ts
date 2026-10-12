import { z } from 'zod';

/**
 * Interim operator recovery of stranded claims (P0-6h). The body names only the action type, a reason and an optional bound. Tenant, workspace
 * and actor come from the authenticated context and the business from the path (verified against that context); `.strict()` makes any other
 * property (a claim id, a scope, an owner, a permission, a time) a 400 - the operator cannot name a claim, only ask for the due ones to be driven.
 */
export const claimRecoveryParamsSchema = z.object({ businessId: z.string().uuid() });

export const claimRecoveryBodySchema = z.object({
  actionType: z.object({ code: z.string().min(1).max(128), schemaVersion: z.string().min(1).max(32) }).strict(),
  reason: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(25).optional(),
}).strict();

export const claimRecoveryResponseSchema = z.object({
  businessId: z.string().uuid(),
  actionType: z.object({ code: z.string(), schemaVersion: z.string() }),
  attempted: z.number().int(),
  results: z.array(z.object({
    claimId: z.string().uuid(),
    state: z.enum(['TERMINAL', 'RETRY']),
    outcome: z.string().optional(),
    reasonCode: z.string().nullable().optional(),
    executionId: z.string().uuid().optional(),
    replayed: z.boolean().optional(),
    attemptNumber: z.number().int().optional(),
  })),
});
