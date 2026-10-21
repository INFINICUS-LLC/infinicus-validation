import { z } from 'zod';

/** Read-only Outcome Monitoring health view for one business (OM-OBS-1). The business comes from the path and is verified against the authenticated context. */
export const outcomeMonitoringHealthParamsSchema = z.object({ businessId: z.string().uuid() });

const counts = z.record(z.string(), z.number().int());

export const outcomeMonitoringHealthResponseSchema = z.object({
  businessId: z.string().uuid(),
  scope: z.literal('OUTCOME_MONITORING'),
  asOf: z.string(),
  windowSeconds: z.number().int(),
  status: z.enum(['OK', 'ATTENTION']),
  attention: z.array(z.enum(['DEAD_LETTERS_PENDING', 'DELIVERED_NOT_VERIFIED', 'VERIFICATION_ATTEMPT_FAILURES_IN_WINDOW', 'UNSUPPORTED_STATE_ROWS'])),
  executionHealth: z.object({ included: z.literal(false), see: z.string() }),
  verification: z.object({
    total: z.number().int(),
    executionVerified: z.number().int(),
    awaitingOutcome: z.number().int(),
    inconclusive: z.number().int(),
    byExecutionOutcome: counts,
    unsupportedStateRows: z.number().int(),
    verifiedOutcomes: z.object({ supported: z.literal(false), rows: z.number().int() }),
    lastVerifiedAt: z.string().nullable(),
  }),
  missingEvidence: z.object({
    monitoredActionsWithoutVerification: z.number().int(),
    verificationsWithoutMonitoredAction: z.number().int(),
    announcedNotVerified: z.number().int(),
  }),
  announcedExecutions: z.object({
    total: z.number().int(),
    verified: z.number().int(),
    awaitingDelivery: z.number().int(),
    deadLettered: z.number().int(),
    deliveredNotVerified: z.number().int(),
    oldestAwaitingAgeSeconds: z.number().int().nullable(),
    truncated: z.boolean(),
    pending: z.array(z.object({
      outboxEventId: z.string().uuid(),
      executionId: z.string().nullable(),
      class: z.enum(['AWAITING_DELIVERY', 'DEAD_LETTERED', 'DELIVERED_NOT_VERIFIED']),
      attempts: z.number().int(),
      occurredAt: z.string(),
      ageSeconds: z.number().int(),
    })),
  }),
  failedVerificationAttempts: z.object({
    total: z.number().int(),
    inWindow: z.number().int(),
    byCode: z.array(z.object({ failureCode: z.string(), status: z.string(), total: z.number().int(), inWindow: z.number().int(), latestAt: z.string() })),
  }),
  deadLetters: z.object({
    pending: z.number().int(),
    replayed: z.number().int(),
    abandoned: z.number().int(),
    byCode: z.array(z.object({ code: z.string(), total: z.number().int(), pending: z.number().int() })),
    truncated: z.boolean(),
    items: z.array(z.object({
      id: z.string().uuid(),
      originalEventId: z.string().nullable(),
      executionId: z.string().nullable(),
      code: z.string(),
      retryable: z.boolean().nullable(),
      attempts: z.number().int(),
      firstFailedAt: z.string(),
      lastFailedAt: z.string(),
    })),
  }),
  observationRecords: z.object({ byStatus: counts }),
  limitations: z.array(z.string()),
});
