export { CanonicalEventPublisher } from './CanonicalEventPublisher.js';
export type { CanonicalPublishResult } from './CanonicalEventPublisher.js';
export {
  LegacyOutboxCompatibilityRegistry,
  outboxRecordToCanonicalEvent,
} from './LegacyOutboxCompatibility.js';
export type {
  LegacyOutboxRecord,
  LegacyOutboxCompatibilityProfile,
} from './LegacyOutboxCompatibility.js';
export { assertReplayAuthorized } from './ReplayAuthorization.js';
export type {
  ReplayMode,
  ReplayAuthorization,
  ReplayCandidate,
} from './ReplayAuthorization.js';

export { EventLedgerRepository } from './EventLedgerRepository.js';
export type { StoredBusinessEvent } from './EventLedgerRepository.js';

export { OutboxRepository } from './OutboxRepository.js';
export { InboxRepository } from './InboxRepository.js';
export { DeadLetterRepository } from './DeadLetterRepository.js';
export { EventSubscriptionRepository } from './EventSubscriptionRepository.js';
export { EventDeliveryAttemptRepository } from './EventDeliveryAttemptRepository.js';
export { withEventTransaction } from './EventTransaction.js';

export type {
  EventFailure,
  OutboxStatus,
  InboxStatus,
  SubscriptionStatus,
  OrderingMode,
  DeliveryAttemptStatus,
  OutboxEventInput,
  ClaimBatchOptions,
  InboxProcessingInput,
  InboxProcessingResult,
  CreateEventSubscriptionInput,
  RecordDeliveryAttemptInput,
} from './types.js';
export type { EventTransactionContext } from './EventTransaction.js';

export {
  EventingError,
  EventLedgerValidationError,
  EventLedgerScopeError,
  EventLedgerConflictError,
  EventLedgerNotFoundError,
} from './errors.js';
