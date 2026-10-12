/**
 * Outbox dispatcher (P0-6b) - the missing runtime between BUILD-33's outbox and its consumers.
 *
 * For ONE tenant/workspace scope (the caller supplies the scope; row-level security still applies) it:
 *   1. returns rows a crashed worker left 'processing' to the retry path (claim timeout),
 *   2. claims a batch of the CONFIGURED event types only (legacy outbox rows of other types are never touched),
 *   3. validates each event against the contract registry, appends it to the immutable event ledger (idempotent),
 *   4. delivers it to every matching ACTIVE 'in_process' subscription whose consumer this worker has registered, recording a delivery
 *      attempt per subscription,
 *   5. publishes the outbox row when every delivery succeeded; otherwise retries with the subscription's backoff, and dead-letters after
 *      the subscription's maximum attempts, on a non-retryable failure, or on a contract rejection.
 *
 * Delivery is AT-LEAST-ONCE: a retry re-invokes every matching consumer, so consumers MUST be idempotent (the inbox: `event_id` +
 * consumer name). No exactly-once claim is made. The dispatcher knows no domain: consumers are injected by the composition root, which is
 * also where the 'no subscription row = nothing delivered' default lives. It runs in a SEPARATE worker process, never in the API.
 */
import type { BusinessEventContractRegistry } from '@infinicus/event-contracts';
import type { TenantContext } from '../client.js';
import { DeadLetterRepository } from './DeadLetterRepository.js';
import { EventDeliveryAttemptRepository } from './EventDeliveryAttemptRepository.js';
import type { StoredBusinessEvent } from './EventLedgerRepository.js';
import { EventLedgerRepository } from './EventLedgerRepository.js';
import { EventSubscriptionRepository } from './EventSubscriptionRepository.js';
import { LegacyOutboxCompatibilityRegistry, outboxRecordToCanonicalEvent } from './LegacyOutboxCompatibility.js';
import type { LegacyOutboxRecord } from './LegacyOutboxCompatibility.js';
import { OutboxRepository } from './OutboxRepository.js';
import type { EventFailure } from './types.js';

/** A delivery failure. `retryable: false` sends the event straight to the dead-letter table (a replay needs governed approval). */
export class DeliveryError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'DeliveryError';
  }
}

/** A consumer must be idempotent: the same event may be delivered more than once. */
export interface EventConsumer {
  handle(ctx: TenantContext, event: StoredBusinessEvent): Promise<void>;
}

export const IN_PROCESS_DESTINATION = 'in_process';
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BACKOFF_SECONDS = 30;

export interface OutboxDispatcherDependencies {
  contracts: BusinessEventContractRegistry;
  /** The only event types this dispatcher will claim. Required and non-empty: it must never sweep unrelated (legacy) outbox rows. */
  eventTypes: readonly string[];
  /** Consumers by subscription `destination_ref`. A matching subscription without a registered consumer is a non-retryable misconfiguration. */
  consumers: ReadonlyMap<string, EventConsumer>;
  workerId: string;
  /** How long a row may stay 'processing' before it is considered abandoned. Required: no default is invented. */
  claimTimeoutMs: number;
  clock?: () => Date;
  compatibility?: LegacyOutboxCompatibilityRegistry;
  outbox?: OutboxRepository;
  ledger?: EventLedgerRepository;
  subscriptions?: EventSubscriptionRepository;
  attempts?: EventDeliveryAttemptRepository;
  deadLetters?: DeadLetterRepository;
}

export interface DispatchSummary {
  recovered: number;
  claimed: number;
  published: number;
  retryScheduled: number;
  deadLettered: number;
}

interface RetryPolicy { maxAttempts: number; backoffSeconds: number | number[] }

function readRetryPolicy(raw: unknown): RetryPolicy {
  const r = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const maxAttempts = typeof r.maxAttempts === 'number' && Number.isInteger(r.maxAttempts) && r.maxAttempts >= 1 ? r.maxAttempts : DEFAULT_MAX_ATTEMPTS;
  const b = r.backoffSeconds;
  const backoffSeconds = typeof b === 'number' && b >= 0 ? b
    : Array.isArray(b) && b.length > 0 && b.every((n) => typeof n === 'number' && n >= 0) ? (b as number[]) : DEFAULT_BACKOFF_SECONDS;
  return { maxAttempts, backoffSeconds };
}

/** The wait before attempt `attempt + 1` (1-based `attempt` = the attempt that just failed). An array is indexed per attempt, last value repeats. */
export function backoffFor(policy: RetryPolicy, attempt: number): number {
  const b = policy.backoffSeconds;
  return Array.isArray(b) ? b[Math.min(Math.max(attempt, 1), b.length) - 1] : b;
}

const failureOf = (error: unknown, now: Date): EventFailure => {
  if (error instanceof DeliveryError) return { code: error.code, message: error.message.slice(0, 500), retryable: error.retryable, occurredAt: now.toISOString() };
  return { code: 'CONSUMER_ERROR', message: (error instanceof Error ? error.message : 'consumer failed').slice(0, 500), retryable: true, occurredAt: now.toISOString() };
};

export class OutboxDispatcher {
  private readonly d: Required<Omit<OutboxDispatcherDependencies, 'clock'>> & { clock: () => Date };

  constructor(deps: OutboxDispatcherDependencies) {
    if (!Array.isArray(deps.eventTypes) || deps.eventTypes.length === 0) throw new Error('OutboxDispatcher requires an explicit, non-empty list of event types');
    if (typeof deps.workerId !== 'string' || deps.workerId.trim().length === 0) throw new Error('OutboxDispatcher requires a worker id');
    if (typeof deps.claimTimeoutMs !== 'number' || !Number.isFinite(deps.claimTimeoutMs) || deps.claimTimeoutMs <= 0) throw new Error('claimTimeoutMs must be a positive number');
    this.d = {
      ...deps,
      clock: deps.clock ?? (() => new Date()),
      compatibility: deps.compatibility ?? new LegacyOutboxCompatibilityRegistry(),
      outbox: deps.outbox ?? new OutboxRepository(),
      ledger: deps.ledger ?? new EventLedgerRepository(),
      subscriptions: deps.subscriptions ?? new EventSubscriptionRepository(),
      attempts: deps.attempts ?? new EventDeliveryAttemptRepository(),
      deadLetters: deps.deadLetters ?? new DeadLetterRepository(),
    };
  }

  async dispatchScope(ctx: TenantContext, options: { batchSize: number }): Promise<DispatchSummary> {
    const d = this.d;
    const summary: DispatchSummary = { recovered: 0, claimed: 0, published: 0, retryScheduled: 0, deadLettered: 0 };
    const now = d.clock();
    summary.recovered = await d.outbox.recoverStaleClaims(ctx, new Date(now.getTime() - d.claimTimeoutMs));
    const rows = (await d.outbox.claimBatch(ctx, { batchSize: options.batchSize, now, eventTypes: [...d.eventTypes] })) as unknown as LegacyOutboxRecord[] & Record<string, unknown>[];
    summary.claimed = rows.length;
    for (const row of rows as unknown as (LegacyOutboxRecord & { attempt_count: number })[]) {
      const outcome = await this.processRow(ctx, row);
      summary[outcome] += 1;
    }
    return summary;
  }

  private async processRow(ctx: TenantContext, row: LegacyOutboxRecord & { attempt_count: number }): Promise<'published' | 'retryScheduled' | 'deadLettered'> {
    const d = this.d;
    const deadLetter = async (failure: EventFailure): Promise<'deadLettered'> => {
      await d.deadLetters.createFromOutbox(ctx, row.id, failure);
      return 'deadLettered';
    };

    let event;
    try {
      event = outboxRecordToCanonicalEvent(row, d.compatibility);
    } catch (error) {
      return deadLetter({ ...failureOf(error, d.clock()), code: 'EVENT_NOT_CANONICAL', retryable: false });
    }
    const validation = d.contracts.validate(event);
    if (!validation.valid) {
      return deadLetter({ code: 'CONTRACT_REJECTED', message: validation.reasons.join(',').slice(0, 500), retryable: false, occurredAt: d.clock().toISOString() });
    }

    let stored: StoredBusinessEvent;
    try {
      stored = await d.ledger.append(ctx, event);
    } catch (error) {
      const failure = failureOf(error, d.clock());
      return this.failOrRetry(ctx, row, [{ failure: error instanceof Error && error.name === 'EventLedgerConflictError' ? { ...failure, retryable: false } : failure, policy: readRetryPolicy(null) }]);
    }

    const subscriptions = (await d.subscriptions.listMatching(ctx, stored.eventType, stored.eventVersion)).filter((s) => s.destination_type === IN_PROCESS_DESTINATION);
    const failures: { failure: EventFailure; policy: RetryPolicy }[] = [];
    for (const sub of subscriptions) {
      const policy = readRetryPolicy(sub.retry_policy);
      const consumer = d.consumers.get(String(sub.destination_ref));
      const startedAt = d.clock();
      let failure: EventFailure | null = null;
      if (!consumer) {
        failure = { code: 'NO_CONSUMER_REGISTERED', message: `no consumer is registered for destination ${String(sub.destination_ref)}`, retryable: false, occurredAt: startedAt.toISOString() };
      } else {
        try {
          await consumer.handle(ctx, stored);
        } catch (error) {
          failure = failureOf(error, d.clock());
        }
      }
      const completedAt = d.clock();
      await d.attempts.record(ctx, {
        outboxEventId: row.id, attemptNumber: row.attempt_count, status: failure ? 'failed' : 'succeeded', attemptedAt: startedAt, completedAt,
        latencyMs: Math.max(0, completedAt.getTime() - startedAt.getTime()), subscriptionId: String(sub.id), consumerName: String(sub.subscriber_name),
        workerId: d.workerId, failure,
      });
      if (failure) failures.push({ failure, policy });
    }

    if (failures.length === 0) {
      await d.outbox.markPublished(ctx, row.id, d.clock());
      return 'published';
    }
    return this.failOrRetry(ctx, row, failures);
  }

  private async failOrRetry(
    ctx: TenantContext,
    row: LegacyOutboxRecord & { attempt_count: number },
    failures: { failure: EventFailure; policy: RetryPolicy }[],
  ): Promise<'retryScheduled' | 'deadLettered'> {
    const d = this.d;
    const terminal = failures.find((f) => !f.failure.retryable);
    const maxAttempts = Math.min(...failures.map((f) => f.policy.maxAttempts));
    if (terminal || row.attempt_count >= maxAttempts) {
      const f = terminal ?? failures[0];
      await d.deadLetters.createFromOutbox(ctx, row.id, terminal ? f.failure : { ...f.failure, code: `RETRIES_EXHAUSTED:${f.failure.code}`, retryable: false });
      return 'deadLettered';
    }
    const first = failures.find((f) => f.policy.maxAttempts === maxAttempts) ?? failures[0];
    const wait = backoffFor(first.policy, row.attempt_count);
    await d.outbox.markFailed(ctx, row.id, first.failure);
    await d.outbox.scheduleRetry(ctx, row.id, new Date(d.clock().getTime() + wait * 1000), first.failure);
    return 'retryScheduled';
  }
}
