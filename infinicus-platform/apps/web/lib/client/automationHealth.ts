/**
 * The automation health screen's pure logic (AUTO-WEB-1): the response contracts (copies of the existing, read-only Business Operations execution-health
 * read, L-OBS-1, and Outcome Monitoring health read, OM-OBS-1; both require `bo:admin`), validated on every read, the request paths and display helpers.
 * No React, no network. Everything shown is a count, an age, a time, a code or a status the server returned. This file computes nothing: no totals, no
 * rates, no "healthy" verdict of its own (the server's `status` is shown as sent), and reason codes are shown as sent because their meaning is the
 * server's, not this screen's. The contracts' own `limitations` are always shown.
 */
import { z } from 'zod';

const int = z.number().int();
const actionType = z.object({ code: z.string(), schemaVersion: z.string() });

export const executionHealthSchema = z.object({
  businessId: z.string().uuid(),
  status: z.enum(['OK', 'ATTENTION']),
  asOf: z.string(),
  windowSeconds: int,
  claims: z.object({
    open: int, stranded: int, retryDue: int, inProgress: int,
    truncated: z.boolean(),
    oldestStrandedAgeSeconds: int.nullable(),
    attention: z.array(z.object({
      claimId: z.string().uuid(),
      state: z.enum(['STRANDED', 'RETRY_DUE', 'IN_PROGRESS']),
      actionType: actionType.nullable(),
      claimedAt: z.string(),
      attempts: int,
      lastAttemptedAt: z.string().nullable(),
      lastAttemptReasonCode: z.string().nullable(),
      overdueSeconds: int,
      ageSeconds: int,
    })),
  }),
  executions: z.object({
    succeeded: int, failed: int, refused: int, succeededInWindow: int, failedInWindow: int, refusedInWindow: int,
    lastExecutionRecordedAt: z.string().nullable(),
    reasons: z.array(z.object({ outcome: z.enum(['FAILED', 'REFUSED']), reasonCode: z.string(), total: int, inWindow: int, latestRecordedAt: z.string() })),
  }),
});

const counts = z.record(z.string(), int);
export const outcomeHealthSchema = z.object({
  businessId: z.string().uuid(),
  scope: z.literal('OUTCOME_MONITORING'),
  asOf: z.string(),
  windowSeconds: int,
  status: z.enum(['OK', 'ATTENTION']),
  attention: z.array(z.enum(['DEAD_LETTERS_PENDING', 'DELIVERED_NOT_VERIFIED', 'VERIFICATION_ATTEMPT_FAILURES_IN_WINDOW', 'UNSUPPORTED_STATE_ROWS'])),
  executionHealth: z.object({ included: z.literal(false), see: z.string() }),
  verification: z.object({
    total: int, executionVerified: int, awaitingOutcome: int, inconclusive: int,
    byExecutionOutcome: counts,
    unsupportedStateRows: int,
    verifiedOutcomes: z.object({ supported: z.literal(false), rows: int }),
    lastVerifiedAt: z.string().nullable(),
  }),
  missingEvidence: z.object({ monitoredActionsWithoutVerification: int, verificationsWithoutMonitoredAction: int, announcedNotVerified: int }),
  announcedExecutions: z.object({
    total: int, verified: int, awaitingDelivery: int, deadLettered: int, deliveredNotVerified: int,
    oldestAwaitingAgeSeconds: int.nullable(),
    truncated: z.boolean(),
    pending: z.array(z.object({
      outboxEventId: z.string().uuid(), executionId: z.string().nullable(),
      class: z.enum(['AWAITING_DELIVERY', 'DEAD_LETTERED', 'DELIVERED_NOT_VERIFIED']),
      attempts: int, occurredAt: z.string(), ageSeconds: int,
    })),
  }),
  failedVerificationAttempts: z.object({
    total: int, inWindow: int,
    byCode: z.array(z.object({ failureCode: z.string(), status: z.string(), total: int, inWindow: int, latestAt: z.string() })),
  }),
  deadLetters: z.object({
    pending: int, replayed: int, abandoned: int,
    byCode: z.array(z.object({ code: z.string(), total: int, pending: int })),
    truncated: z.boolean(),
    items: z.array(z.object({
      id: z.string().uuid(), originalEventId: z.string().nullable(), executionId: z.string().nullable(), code: z.string(),
      retryable: z.boolean().nullable(), attempts: int, firstFailedAt: z.string(), lastFailedAt: z.string(),
    })),
  }),
  observationRecords: z.object({ byStatus: counts }),
  limitations: z.array(z.string()),
});
export type ExecutionHealth = z.infer<typeof executionHealthSchema>;
export type OutcomeHealth = z.infer<typeof outcomeHealthSchema>;

const base = (businessId: string): string => `/v1/businesses/${encodeURIComponent(businessId)}`;
export const executionHealthPath = (businessId: string): string => `${base(businessId)}/execution-health`;
export const outcomeHealthPath = (businessId: string): string => `${base(businessId)}/outcome-monitoring-health`;

/** A duration for reading ("45 s", "12 min", "3 h 5 min", "2 d 4 h"); null for a negative or non-integer value, which the page shows as unavailable. */
export function formatDuration(seconds: number): string | null {
  if (!Number.isInteger(seconds) || seconds < 0) return null;
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`;
}

/** A timestamp as an unambiguous UTC date and time, or "unavailable" when it cannot be read. */
export function utcDateTime(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 'unavailable' : `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The server's status in words. It is the server's judgement, shown as sent; this screen never derives its own. */
export const statusText = (status: 'OK' | 'ATTENTION'): string => (status === 'OK' ? 'No attention needed' : 'Needs attention');

export const ATTENTION_TEXT: Record<OutcomeHealth['attention'][number], string> = {
  DEAD_LETTERS_PENDING: 'Notifications are waiting in the dead-letter list.',
  DELIVERED_NOT_VERIFIED: 'Some delivered notifications have not been verified yet.',
  VERIFICATION_ATTEMPT_FAILURES_IN_WINDOW: 'Verification attempts failed recently.',
  UNSUPPORTED_STATE_ROWS: 'Some records are in a state this version does not support.',
};
export const CLAIM_STATE_TEXT: Record<ExecutionHealth['claims']['attention'][number]['state'], string> = {
  STRANDED: 'Stranded (due and never attempted)', RETRY_DUE: 'Retry overdue', IN_PROGRESS: 'In progress',
};
export const ANNOUNCED_CLASS_TEXT: Record<OutcomeHealth['announcedExecutions']['pending'][number]['class'], string> = {
  AWAITING_DELIVERY: 'Awaiting delivery', DEAD_LETTERED: 'Dead-lettered', DELIVERED_NOT_VERIFIED: 'Delivered, not verified',
};

/** Entries of a count map in a stable order (by key), so the same data always reads the same way. */
export const sortedCounts = (map: Record<string, number>): [string, number][] => Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
