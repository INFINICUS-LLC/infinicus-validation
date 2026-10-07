export { DataSourceRepository, NotFoundError } from './DataSourceRepository.js';
export type { DataSource, CreateDataSourceInput } from './DataSourceRepository.js';

export { ConnectorRepository, hashWebhookToken, webhookTokenHashesMatch } from './ConnectorRepository.js';
export type {
  Connector,
  CreateConnectorInput,
  ConnectorType,
  ConnectorStatus,
  ConnectorHealthStatus,
  WebhookConnectorLookup,
} from './ConnectorRepository.js';

export { CollectionRunRepository, COLLECTION_RUN_TRANSITIONS } from './CollectionRunRepository.js';
export type {
  CollectionRun,
  CollectionRunState,
  CreateCollectionRunInput,
  CompleteCollectionRunInput,
} from './CollectionRunRepository.js';

export { ValidationResultRepository } from './ValidationResultRepository.js';
export type {
  ValidationResult,
  ValidationIssue,
  CreateValidationResultInput,
  CreateValidationIssueInput,
} from './ValidationResultRepository.js';

export { DataQualityScoreRepository } from './DataQualityScoreRepository.js';
export type {
  DataQualityScore,
  CreateDataQualityScoreInput,
} from './DataQualityScoreRepository.js';

export { ProvenanceRepository, MAX_LINEAGE_DEPTH } from './ProvenanceRepository.js';
export type {
  ProvenanceRecord,
  TransformationRecord,
  CreateProvenanceRecordInput,
  CreateTransformationRecordInput,
} from './ProvenanceRepository.js';

export {
  PublicationPackageRepository,
  PUBLICATION_PACKAGE_TRANSITIONS,
} from './PublicationPackageRepository.js';
export type {
  PublicationPackage,
  PublicationPackageStatus,
  CreatePublicationPackageInput,
} from './PublicationPackageRepository.js';

export {
  ManualSubmissionRepository,
  MANUAL_SUBMISSION_STATUSES,
  isManualSubmissionStatus,
} from './ManualSubmissionRepository.js';
export type {
  ManualSubmission,
  CreateManualSubmissionInput,
  ManualSubmissionStatus,
} from './ManualSubmissionRepository.js';

export { WebhookReceiptRepository } from './WebhookReceiptRepository.js';
export type { WebhookReceipt, CreateWebhookReceiptInput } from './WebhookReceiptRepository.js';

export {
  InvalidStateTransitionError,
  DuplicateSourceCodeError,
  ProvenanceError,
  ValidationError,
  UnsupportedConnectorError,
  CollectionLimitExceededError,
  PublicationNotReadyError,
  QualityThresholdError,
  WebhookAuthenticationError,
} from './errors.js';

export { runGuardedTransition, statesAllowing } from './guards.js';
export type { GuardedTransitionSpec } from './guards.js';

export { boundedPage, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './pagination.js';
export type { PageOptions, BoundedPage } from './pagination.js';

export {
  emitSourceRegistered,
  emitConnectorRegistered,
  emitCollectionStarted,
  emitCollectionCompleted,
  emitCollectionFailed,
  emitValidationCompleted,
  emitDataQuarantined,
  emitDataQualityScored,
  emitDataPublished,
} from './outbox.js';
export type {
  OutboxEventId,
  SourceRegisteredEvent,
  ConnectorRegisteredEvent,
  CollectionStartedEvent,
  CollectionCompletedEvent,
  CollectionFailedEvent,
  ValidationCompletedEvent,
  DataQuarantinedEvent,
  DataQualityScoredEvent,
  DataPublishedEvent,
} from './outbox.js';
