import { z } from 'zod';

/** Read-only execution-health view for one business (L-OBS-1). The business comes from the path and is verified against the authenticated context. */
export const executionHealthParamsSchema = z.object({ businessId: z.string().uuid() });

const actionType = z.object({ code: z.string(), schemaVersion: z.string() });

export const executionHealthResponseSchema = z.object({
  businessId: z.string().uuid(),
  status: z.enum(['OK', 'ATTENTION']),
  asOf: z.string(),
  windowSeconds: z.number().int(),
  claims: z.object({
    open: z.number().int(),
    stranded: z.number().int(),
    retryDue: z.number().int(),
    inProgress: z.number().int(),
    truncated: z.boolean(),
    oldestStrandedAgeSeconds: z.number().int().nullable(),
    attention: z.array(z.object({
      claimId: z.string().uuid(),
      state: z.enum(['STRANDED', 'RETRY_DUE', 'IN_PROGRESS']),
      actionType: actionType.nullable(),
      claimedAt: z.string(),
      attempts: z.number().int(),
      lastAttemptedAt: z.string().nullable(),
      lastAttemptReasonCode: z.string().nullable(),
      overdueSeconds: z.number().int(),
      ageSeconds: z.number().int(),
    })),
  }),
  executions: z.object({
    succeeded: z.number().int(),
    failed: z.number().int(),
    refused: z.number().int(),
    succeededInWindow: z.number().int(),
    failedInWindow: z.number().int(),
    refusedInWindow: z.number().int(),
    lastExecutionRecordedAt: z.string().nullable(),
    reasons: z.array(z.object({
      outcome: z.enum(['FAILED', 'REFUSED']),
      reasonCode: z.string(),
      total: z.number().int(),
      inWindow: z.number().int(),
      latestRecordedAt: z.string(),
    })),
  }),
});
