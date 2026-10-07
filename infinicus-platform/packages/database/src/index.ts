// @infinicus/database — public API
export {
  createPool,
  getPool,
  getDatabasePool,
  query,
  closePool,
  closeDatabasePool,
  withTransaction,
  withTenantTransaction,
  poolStats,
} from './client.js';
export type { DbConfig, TenantContext, PoolStats } from './client.js';
export { runMigrations } from './migrate.js';


// ── Cross-domain eventing repositories (BUILD-33) ───────────────────────────
export {
  EventLedgerRepository,
  OutboxRepository,
  InboxRepository,
  DeadLetterRepository,
  EventSubscriptionRepository,
  EventDeliveryAttemptRepository,
  withEventTransaction,
  EventingError,
  EventLedgerValidationError,
  EventLedgerScopeError,
  EventLedgerConflictError,
  EventLedgerNotFoundError,
} from './eventing/index.js';
export type {
  StoredBusinessEvent,
  EventFailure,
  OutboxStatus,
  InboxStatus,
  SubscriptionStatus as EventSubscriptionStatus,
  OrderingMode,
  DeliveryAttemptStatus,
  OutboxEventInput,
  ClaimBatchOptions,
  InboxProcessingInput,
  InboxProcessingResult,
  CreateEventSubscriptionInput,
  RecordDeliveryAttemptInput,
  EventTransactionContext,
} from './eventing/index.js';

// ── Data Acquisition repositories ─────────────────────────────────────────────
export {
  DataSourceRepository,
  ConnectorRepository,
  CollectionRunRepository,
  COLLECTION_RUN_TRANSITIONS,
  ValidationResultRepository,
  DataQualityScoreRepository,
  ProvenanceRepository,
  MAX_LINEAGE_DEPTH,
  PublicationPackageRepository,
  PUBLICATION_PACKAGE_TRANSITIONS,
  ManualSubmissionRepository,
  MANUAL_SUBMISSION_STATUSES,
  isManualSubmissionStatus,
  WebhookReceiptRepository,
  NotFoundError,
  InvalidStateTransitionError,
  DuplicateSourceCodeError,
  ProvenanceError as DAProvenanceError,
  ValidationError as DAValidationError,
  UnsupportedConnectorError,
  CollectionLimitExceededError,
  PublicationNotReadyError,
  QualityThresholdError,
  WebhookAuthenticationError,
  runGuardedTransition,
  statesAllowing,
  boundedPage,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  emitSourceRegistered,
  emitConnectorRegistered,
  emitCollectionStarted,
  emitCollectionCompleted,
  emitCollectionFailed,
  emitValidationCompleted,
  emitDataQuarantined,
  emitDataQualityScored,
  emitDataPublished,
  hashWebhookToken,
  webhookTokenHashesMatch,
} from './repositories/da/index.js';
export type {
  DataSource,
  CreateDataSourceInput,
  Connector,
  CreateConnectorInput,
  ConnectorType,
  ConnectorStatus,
  ConnectorHealthStatus,
  WebhookConnectorLookup,
  CollectionRun,
  CollectionRunState,
  CreateCollectionRunInput,
  CompleteCollectionRunInput,
  ValidationResult,
  ValidationIssue,
  CreateValidationResultInput,
  CreateValidationIssueInput,
  DataQualityScore,
  CreateDataQualityScoreInput,
  ProvenanceRecord,
  TransformationRecord,
  CreateProvenanceRecordInput,
  CreateTransformationRecordInput,
  PublicationPackage,
  PublicationPackageStatus,
  CreatePublicationPackageInput,
  ManualSubmission,
  CreateManualSubmissionInput,
  ManualSubmissionStatus,
  WebhookReceipt,
  CreateWebhookReceiptInput,
  GuardedTransitionSpec,
  PageOptions,
  BoundedPage,
  OutboxEventId,
} from './repositories/da/index.js';

// ── Business Operations repositories ──────────────────────────────────────────
export {
  LeadRepository,
  OpportunityRepository,
  PurchaseOrderRepository,
  SupportCaseRepository,
  IncidentRepository,
  TaskRepository,
  InventoryBalanceRepository,
  BusinessEventRepository,
  ProductRepository,
  RegisterSessionRepository,
  OrderRepository,
} from './repositories/bo/index.js';
export type {
  Lead, CreateLeadInput,
  Opportunity, CreateOpportunityInput,
  PurchaseOrder, CreatePurchaseOrderInput,
  SupportCase, CreateSupportCaseInput,
  Incident, CreateIncidentInput,
  Task, CreateTaskInput,
  InventoryBalance, CreateInventoryBalanceInput,
  BusinessEvent, LogBusinessEventInput, BusinessEventType, BusinessEventAction,
  SalesAggregate, ExpensesAggregate, InventoryAggregate, CustomersAggregate, TeamAggregate,
  RegisterSession, OpenRegisterSessionInput, CloseRegisterSessionInput,
  Product, CreateProductInput, UpdateProductInput,
  Order, OrderLineItem, OrderOperationalStatus, CreateOrderInput, AddLineItemInput,
} from './repositories/bo/index.js';

// ── Business Intelligence repositories (Stage 2D) ───────────────────────────────
export {
  IntelligenceIntakeRepository,
  MetricDefinitionRepository,
  MetricCalculationRepository,
  AnalysisRunRepository,
  AnalysisResultRepository,
  ForecastRepository,
  AnomalyRepository,
  RiskAssessmentRepository,
  InsightPackageRepository,
  BIPublicationPackageRepository,
} from './repositories/bi/index.js';
export type {
  IntakePackage, CreateIntakePackageInput, AnalyticalDataset, DatasetVersion,
  MetricDefinition, MetricDefinitionVersion, CreateMetricDefinitionInput,
  MetricCalculatedValue, RecordCalculationInput, TimeSeriesPoint,
  AnalysisRequest, AnalysisRun, CreateAnalysisRequestInput,
  Finding, FindingVersion, Trend, TrendObservation, CreateFindingInput,
  ForecastModel, ForecastRun, ForecastPoint, ForecastAccuracyRecord,
  AnomalyRule, AnomalyRuleVersion, AnomalyDetection,
  RiskModel, RiskAssessment, BenchmarkDefinition, ComparisonResult,
  InsightPackage, InsightPackageVersion, CreateInsightPackageVersionInput,
  BIPublicationPackage, ComponentDeployment, TargetLayer,
} from './repositories/bi/index.js';

// ── Business Digital Twin repositories (Stage 2E) ────────────────────────────────
export {
  DTIntakeRepository,
  DigitalTwinDefinitionRepository,
  DigitalTwinInstanceRepository,
  DigitalTwinSnapshotRepository,
  StateVariableRepository,
  TwinEntityRepository,
  TwinAssumptionConstraintRepository,
  TwinCalibrationRepository,
  TwinValidationRepository,
  ScenarioBaselineRepository,
  DTPublicationPackageRepository,
  DTComponentRegistryRepository,
} from './repositories/dt/index.js';
export type {
  DTIntakePackage, ReceivePackageInput,
  DigitalTwinDefinition, DigitalTwinDefinitionVersion,
  DigitalTwinInstance,
  DigitalTwinSnapshot, DigitalTwinSnapshotVersion, DigitalTwinSnapshotValue,
  StateVariableDefinition, StateVariableValue,
  TwinEntity, TwinRelationship,
  TwinAssumption, TwinConstraint, TwinConstraintEvaluation,
  TwinCalibrationRun,
  TwinValidationRun,
  ScenarioBaseline, ScenarioBaselineVersion,
  DTPublicationPackage,
  DTComponentRegistryEntry, DTDeployment,
} from './repositories/dt/index.js';

// ── Simulation repositories (Stage 2F) ────────────────────────────────────────────
export {
  SimulationIntakeRepository,
  SimulationModelRepository,
  SimulationScenarioRepository,
  SimulationRunRepository,
  SimulationResultRepository,
  SimulationRiskRepository,
  SimulationSensitivityRepository,
  ScenarioComparisonRepository,
  SimulationValidationRepository,
  SimulationPublicationRepository,
  SimulationComponentRegistryRepository,
} from './repositories/simulation/index.js';
export type {
  SimulationIntakePackage, ReceiveSimulationPackageInput,
  SimulationModel, SimulationModelVersion,
  SimulationScenario, SimulationScenarioVersion,
  SimulationRequest, SimulationRun,
  SimulationResult, SimulationResultVersion, SimulationResultMetric,
  SimulationRiskResult, SimulationFailureMode,
  SimulationSensitivityRun, SimulationSensitivityResult,
  ScenarioComparisonRun,
  SimulationValidationRun, SimulationCalibrationRun,
  SimulationPublicationPackage,
  SimulationComponentRegistryEntry, SimulationDeployment,
} from './repositories/simulation/index.js';

// ── AI Decision Intelligence repositories (Stage 2G) ──────────────────────────────
export {
  ADIIntakeRepository,
  DecisionQuestionRepository,
  DecisionCaseRepository,
  ReasoningRunRepository,
  DecisionEvidenceRepository,
  DecisionAlternativeRepository,
  DecisionRecommendationRepository, RISK_CLASSES, normalizeRiskValidity, maxRiskClass,
  DecisionConfidenceRepository,
  DecisionPolicyRepository,
  DecisionMonitoringRequirementRepository,
  ADIPublicationRepository,
  ADIComponentRegistryRepository,
} from './repositories/adi/index.js';
export type {
  ADIIntakePackage, ReceiveADIPackageInput,
  DecisionQuestion,
  DecisionCase,
  ReasoningRequest, ReasoningRun,
  DecisionEvidence,
  DecisionAlternative,
  DecisionRecommendation, DecisionRecommendationVersion, RecommendationRationale, RecommendationRiskValidity, RiskClass,
  DecisionConfidenceScore,
  DecisionPolicy,
  DecisionMonitoringRequirement, DecisionReviewSchedule,
  ADIPublicationPackage,
  ADIComponentRegistryEntry, ADIDeployment,
} from './repositories/adi/index.js';

// ── Approved Business Action repositories (Stage 2H) ───────────────────────────────
export {
  ABAIntakeRepository,
  ActionReviewRepository,
  ApprovalPolicyRepository,
  ApproverAuthorityRepository,
  ApprovalDecisionRepository,
  ApprovedActionRepository,
  ActionExecutionPlanRepository,
  ActionControlGateRepository,
  ApprovalExceptionRepository,
  ApprovalAppealRepository,
  ABAAuditRepository, APPROVAL_EXPIRED_EVENT,
  ABAPublicationRepository,
  ABAComponentRegistryRepository,
} from './repositories/approved_action/index.js';
export type {
  ABAIntakePackage, ReceiveABAPackageInput,
  ActionReviewPackage, ActionReviewVersion, ReviewVersionSnapshot,
  ApprovalPolicy,
  ApproverAssignment, ApprovalDelegation,
  ApprovalDecision, ApprovalDecisionVersion, DecisionAudit,
  ApprovedAction,
  ActionExecutionPlan,
  ActionControlGate, ActionHold, ActionRelease,
  ApprovalException,
  ApprovalAppeal, ApprovalAppealDecision,
  ApprovalAttestation, ApprovalSignature, ExpiryDetectionContext, ExpiryDetectionResult,
  ABAPublicationPackage,
  ABAComponentRegistryEntry, ABADeployment,
} from './repositories/approved_action/index.js';

export { ActionReviewNotFoundError, ApproverAuthorityNotFoundError, ApproverAuthorityStateConflictError } from './repositories/approved_action/errors.js';

// ── Business-ownership proof and approver-authority provenance (owner bootstrap) ──
export {
  OWNER_APPROVER_ASSIGNMENT_CODE, PROVENANCE_SCOPE_TYPE, MAX_REVOCATION_REASON_LENGTH, normalizeRevocationReason,
} from './repositories/approved_action/authorityProvenance.js';
export type {
  AuthoritySource, AuthorityAction, OwnershipProofRef, AuthorityProvenanceEntry,
} from './repositories/approved_action/authorityProvenance.js';
export {
  OwnershipEvidenceRepository, loadOwnershipEvidenceWith, classifyOwnership, provenOwnersOf, CANDIDATE_LABEL,
  runOwnerAuthorityDryRun,
} from './repositories/ownership/index.js';
export type {
  OwnershipEvidence, OwnershipVerdict, OwnershipClassification, ProvenOwner, CandidateOwner, MembershipFact,
  DryRunReport, DryRunEntry,
} from './repositories/ownership/index.js';

// ── Outcome Monitoring repositories (Stage 2I) ──────────────────────────────────
export {
  OMIntakeRepository,
  MonitoringPlanRepository,
  MonitoredActionRepository,
  OutcomeObservationRepository,
  OutcomeTargetRepository,
  OutcomeVarianceRepository,
  MonitoringAlertRepository,
  MonitoringIncidentRepository,
  OutcomeAttributionRepository,
  OutcomeReviewRepository,
  LearningFeedbackPackageRepository,
  OMPublicationRepository,
  OMComponentRegistryRepository,
} from './repositories/om/index.js';
export type {
  OMIntakePackage, ReceiveOMPackageInput,
  MonitoringPlan,
  MonitoredAction,
  OutcomeObservation, OutcomeObservationVersion,
  OutcomeTarget,
  OutcomeVarianceRun,
  MonitoringAlertRule, MonitoringAlert,
  MonitoringIncident,
  OutcomeAttributionRun,
  OutcomeReview,
  LearningFeedbackPackage,
  OMPublicationPackage,
  OMComponentRegistryEntry, OMDeployment,
} from './repositories/om/index.js';

// ── Continuous Learning repositories (Stage 2J) ─────────────────────────────────
export {
  CLIntakeRepository,
  LearningCaseRepository,
  LearningFeedbackRepository,
  LearnedLessonRepository,
  LearningPatternRepository,
  ModelEvaluationRepository,
  PolicyEvaluationRepository,
  ImprovementProposalRepository,
  LearningChangeReviewRepository,
  KnowledgeArtifactRepository,
  CLFeedbackPublicationRepository,
  CLComponentRegistryRepository,
} from './repositories/cl/index.js';
export type {
  CLIntakePackage, ReceiveCLPackageInput,
  LearningCase,
  LearningFeedbackRecord,
  LearnedLesson,
  LearningPattern,
  ModelEvaluationRun,
  PolicyEvaluationRun, PolicyChangeProposal,
  ImprovementProposal, ImprovementProposalVersion,
  LearningChangeReview, LearningChangeRelease,
  KnowledgeArtifact,
  CLFeedbackPackage,
  CLComponentRegistryEntry, CLDeployment,
} from './repositories/cl/index.js';

// ── Authentication and Authorization repositories (BUILD-18) ────────────────────
export {
  UserNotFoundError, UserAlreadyExistsError,
  SessionNotFoundError,
  ServiceAccountNotFoundError,
  ApiKeyNotFoundError,
  RoleNotFoundError,
  PermissionNotFoundError,
  MembershipNotFoundError, MembershipAlreadyExistsError,
  InvitationNotFoundError, InvitationStateConflictError,
} from './repositories/auth/errors.js';
export {
  UserRepository,
  SessionRepository,
  EmailVerificationTokenRepository, EmailVerificationTokenNotFoundError,
  ServiceAccountRepository,
  ApiKeyRepository,
  RoleRepository,
  PermissionRepository,
  MembershipRepository,
  InvitationRepository,
  AccessEventRepository,
} from './repositories/auth/index.js';
export type {
  User, CreateUserInput,
  Session,
  EmailVerificationToken,
  ServiceAccount,
  ApiKeyReference,
  Role,
  Permission,
  Membership,
  Invitation,
  AccessEvent, AccessEventType,
} from './repositories/auth/index.js';

// ── Tenant onboarding repositories (BUILD-19) ──────────────────────────────
export {
  TenantNotFoundError, TenantSlugConflictError,
  WorkspaceNotFoundError, WorkspaceSlugConflictError,
  BusinessNotFoundError, BusinessCodeConflictError,
  OnboardingNotFoundError, OnboardingStepOrderError, OnboardingAlreadyTerminalError, OnboardingNotInitiatorError,
} from './repositories/onboarding/errors.js';
export {
  TenantRepository,
  WorkspaceRepository,
  BusinessRepository,
  SettingsRepository,
  OnboardingProgressRepository,
  STEP_ORDER as ONBOARDING_STEP_ORDER,
} from './repositories/onboarding/index.js';
export type {
  Tenant, CreateTenantInput,
  Workspace, CreateWorkspaceInput,
  Business, CreateBusinessInput, PagedBusinesses,
  Setting, SettingsScope,
  OnboardingProgress, OnboardingStatus, OnboardingStep,
} from './repositories/onboarding/index.js';

// ── API idempotency-key repository (BUILD-21) ──────────────────────────────
export { IdempotencyConflictError, IdempotencyKeyRepository } from './repositories/api/index.js';

// ── Deployment audit repository (BUILD-23) ──────────────────────────────
export { DeploymentEventNotFoundError, DeploymentEventRepository } from './repositories/deployment/index.js';
export type {
  DeploymentEvent, DeploymentEnvironment, DeploymentStatus, StartDeploymentInput,
} from './repositories/deployment/index.js';
export type { IdempotencyRecord, BeginResult as IdempotencyBeginResult } from './repositories/api/index.js';

// ── Secret rotation audit repository (BUILD-24) ─────────────────────────
export { SecretRotationEventNotFoundError, SecretRotationEventRepository } from './repositories/secrets/index.js';
export type {
  SecretRotationEvent, SecretRotationEnvironment, RecordRotationInput,
} from './repositories/secrets/index.js';

// ── Error tracking and alerting repositories (BUILD-25) ─────────────────
export { ErrorEventRepository, AlertEventRepository, AlertEventNotFoundError, getOutboxBacklog } from './repositories/observability/index.js';
export type {
  ErrorEvent, ErrorEventLevel, RecordErrorInput,
  AlertEvent, AlertSeverity, TriggerAlertInput,
  OutboxBacklog,
} from './repositories/observability/index.js';

// ── Billing and entitlements repositories (BUILD-28) ─────────────────────
export {
  PlanRepository, SubscriptionRepository, UsageRepository,
  BillingNotFoundError, BillingConflictError,
  PlanNotFoundError, SubscriptionNotFoundError, SubscriptionAlreadyExistsError,
  InvalidSubscriptionTransitionError, UsageLimitExceededError,
} from './repositories/billing/index.js';
export type {
  Plan,
  Subscription, SubscriptionStatus, PaymentStatus,
  SubscriptionStatusHistoryEntry, CreateSubscriptionInput, TransitionStatusOptions,
  UsageRecord, UsageMetric,
} from './repositories/billing/index.js';

// ── Incident response repository (BUILD-29) ───────────────────────────────
// Named PlatformIncident*, not Incident*, to avoid colliding with the
// pre-existing business_operations.IncidentRepository (BUILD-08) already
// exported above under "Business Operations repositories".
export { PlatformIncidentRepository, PlatformIncidentNotFoundError, PlatformIncidentAlreadyResolvedError } from './repositories/incident/index.js';
export type {
  PlatformIncident, PlatformIncidentSeverity, PlatformIncidentStatus,
  PlatformIncidentUpdate, DeclarePlatformIncidentInput,
} from './repositories/incident/index.js';


// ── BUILD-33 canonical publication + replay governance ─────────────────────
export {
  CanonicalEventPublisher,
  LegacyOutboxCompatibilityRegistry,
  outboxRecordToCanonicalEvent,
  assertReplayAuthorized,
} from './eventing/index.js';
export type {
  CanonicalPublishResult,
  LegacyOutboxRecord,
  LegacyOutboxCompatibilityProfile,
  ReplayMode,
  ReplayAuthorization,
  ReplayCandidate,
} from './eventing/index.js';
