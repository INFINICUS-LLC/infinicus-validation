import { z } from 'zod';

/**
 * Governed activation of a supported authorized-action type for one business (P0-6e). The body names only the action type, the desired
 * state and a reason. Tenant, workspace and actor come from the authenticated context; `.strict()` makes any other property (an owner, a
 * scope, a time, a permission) a 400.
 */
export const executionActivationParamsSchema = z.object({ businessId: z.string().uuid() });
export const executionActivationQuerySchema = z.object({ code: z.string().min(1).max(128), schemaVersion: z.string().min(1).max(32) }).strict();

export const setExecutionActivationBodySchema = z.object({
  actionType: z.object({ code: z.string().min(1).max(128), schemaVersion: z.string().min(1).max(32) }).strict(),
  state: z.enum(['ENABLED', 'DISABLED']),
  reason: z.string().trim().min(1).max(500),
}).strict();

export const executionActivationViewSchema = z.object({
  businessId: z.string().uuid(),
  actionType: z.object({ code: z.string(), schemaVersion: z.string() }),
  state: z.enum(['ENABLED', 'DISABLED', 'NOT_ACTIVATED']),
  version: z.number().int().nullable(),
  actorUserId: z.string().uuid().nullable(),
  permissionCode: z.string().nullable(),
  reason: z.string().nullable(),
  recordedAt: z.string().nullable(),
});

export const setExecutionActivationResponseSchema = executionActivationViewSchema.extend({ changed: z.boolean() });
