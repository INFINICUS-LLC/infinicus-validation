import type { BusinessEventEnvelope } from '@infinicus/event-contracts';

export interface EventFailure {
  code: string;
  message: string;
  retryable: boolean;
  occurredAt: string;
  metadata?: Record<string, unknown>;
}

export type OutboxStatus = 'pending' | 'processing' | 'published' | 'failed' | 'dead_lettered';
export type InboxStatus = 'received' | 'processing' | 'processed' | 'failed';
export type SubscriptionStatus = 'active' | 'paused' | 'disabled' | 'failed';
export type OrderingMode = 'none' | 'aggregate' | 'business' | 'strict';
export type DeliveryAttemptStatus = 'succeeded' | 'failed' | 'timed_out' | 'cancelled';

export interface OutboxEventInput {
  event: BusinessEventEnvelope;
  headers?: Record<string, unknown>;
  availableAt?: Date;
}

export interface ClaimBatchOptions {
  batchSize: number;
  now: Date;
  eventTypes?: string[];
}

export interface InboxProcessingInput {
  eventId: string;
  consumerName: string;
  eventType: string;
  payload: unknown;
}

export type InboxProcessingResult =
  | { state: 'started' }
  | { state: 'already_processed' }
  | { state: 'already_processing' }
  | { state: 'retry_allowed' };

export interface CreateEventSubscriptionInput {
  subscriberName: string;
  eventPattern: string;
  destinationType: string;
  destinationReference: string;
  supportedVersions?: string[];
  consumerGroup?: string | null;
  orderingMode?: OrderingMode;
  timeoutSeconds?: number;
  retryPolicy?: Record<string, unknown>;
}

export interface RecordDeliveryAttemptInput {
  outboxEventId: string;
  attemptNumber: number;
  status: DeliveryAttemptStatus;
  attemptedAt: Date;
  completedAt: Date;
  latencyMs: number;
  subscriptionId?: string | null;
  consumerName?: string | null;
  workerId?: string | null;
  responseCode?: number | null;
  responseBody?: string | null;
  failure?: EventFailure | null;
  metadata?: Record<string, unknown>;
}
