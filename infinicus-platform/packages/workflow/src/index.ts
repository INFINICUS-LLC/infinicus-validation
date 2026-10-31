// @infinicus/workflow — customer decision workflow orchestration: business
// selection, BI/DT/simulation/ADI review, ABA approval, OM outcome entry,
// decision history. Composes existing BI/DT/SIM/ADI/ABA/OM repositories —
// introduces no new persistence of its own.

export { DecisionWorkflowService, ApproverAuthorityNotEstablishedError, ApprovalPolicyDeniedError, ApprovalBlockedError, DEFAULT_APPROVER_ASSIGNMENT_CODE } from './DecisionWorkflowService.js';
export type { ReviewApprovalStatus } from './DecisionWorkflowService.js';
export type {
  WorkflowView, DecisionHistory,
  CreateReviewInput, SubmitApprovalInput, GrantApproverAuthorityInput, RevokeApproverAuthorityInput, ApproverAuthorityRecord, RecordOutcomeInput,
} from './DecisionWorkflowService.js';

export { BusinessScopeGuard, ApproverGranteeNotEligibleError } from './BusinessScopeGuard.js';

export { SimulationOrchestrationService, ValidationError as SimulationValidationError } from './SimulationOrchestrationService.js';
export type {
  StartSimulationInput, SimulationRunStatus, SimulationRunStatusResult,
} from './SimulationOrchestrationService.js';

export { TwinComputationService } from './TwinComputationService.js';
export type {
  TwinSnapshotResult, TwinFinancial, TwinCustomers, TwinOperations, TwinTeam,
} from './TwinComputationService.js';

export { BusinessDecisionRecommendationService } from './BusinessDecisionRecommendationService.js';
export type {
  RecommendedDecision, RecommendationResult, ChoiceReviewResult, DecisionHistoryEntry, RiskLevel,
} from './BusinessDecisionRecommendationService.js';
export { assessTwinEvidence } from './twinEvidence.js';
export type { TwinEvidenceAssessment, AreaEvidence, OverallEvidence } from './twinEvidence.js';
export {
  RISK_CLASSES, APPROVER_ROLES, APPROVER_ROLE_TIER, UNCLASSIFIED_RISK_FALLBACK, DEFAULT_APPROVAL_RISK_POLICY,
  evaluateApproval, requirementFor, approverTier, isRiskClass,
} from './approvalRiskPolicy.js';
export type {
  RiskClass, ApproverRole, ApprovalOutcome, ApprovalRiskPolicy, ApprovalRequirement, ApprovalPolicyVerdict,
} from './approvalRiskPolicy.js';
export { deriveRiskClass, determineTimeValidity, RISK_ORDER } from './recommendationAuthoring.js';
export type { DerivedRisk, RiskInputs, TimeValidity, TimeValiditySignals, AuthoredRiskClass } from './recommendationAuthoring.js';
export { evaluateApprovalGate } from './approvalGate.js';
export type { ApprovalGateVerdict, GateBlockCode, GateFacts, TwinFreshness } from './approvalGate.js';
export { buildApprovalAuditDetail, auditEventTypeFor, APPROVAL_AUDIT_SCHEMA } from './approvalAudit.js';
export type { ApprovalAuditEventType, ApprovalAuditInput, ApprovalAuditReasonCode } from './approvalAudit.js';

// ── ABA package issuer (P0-5 Block 3d) ─────────────────────────────────────────
export { AuthorizedActionPackageIssuer, PackageIssuanceRefusedError } from './AuthorizedActionPackageIssuer.js';
export type { IssuePackageRequest, IssuePackageResult, IssuerDependencies } from './AuthorizedActionPackageIssuer.js';
export {
  ISSUER_COMPONENT, ISSUABLE_AUTOMATION_LEVELS, ISSUANCE_ENABLEMENT, POLICY_ACTION_TYPES_KEY, NOT_APPLICABLE_CODE_PATTERN,
  evaluateIssuance, notApplicableCodeProblems, authoritativeInputsKey,
} from './packageIssuancePolicy.js';
export type { IssuanceFacts, IssuanceEvaluation, IssuanceRefusal, IssuanceRefusalCode } from './packageIssuancePolicy.js';

// ── ABA authoring / administration (P0-5) ──────────────────────────────────────
export { SimulationRunRepositoryReferenceVerifier } from './SimulationRunReferenceVerifier.js';
export type { SimulationRunReferenceVerifier, SimulationRunReferenceVerdict } from './SimulationRunReferenceVerifier.js';
export { AbaAuthoringService, deriveFinalParameters } from './AbaAuthoringService.js';
export type {
  AuthoringRequestContext, ActionTypeView, PolicyView, PolicyVersionView, EnablementView, CaptureInput, CaptureView, OwnerInput, OwnerView,
  BoundariesInput, BoundariesView, IssuedPackageView, AuthoringStatusView, AbaAuthoringDependencies,
} from './AbaAuthoringService.js';

// P0-6a: ABA-owned implementations of the shared execution-boundary ports. Unwired until P0-6b/c.
export { AbaPackageStatusProvider, AbaAuthorizedActionPackageSource, AbaPackageConsumptionRecorder } from './abaExecutionPorts.js';
export type { AbaPackageStatusProviderDependencies } from './abaExecutionPorts.js';
export { evaluateApproverAuthority, evaluateExecutionAuthority, policyCoversActionType } from './executionAuthority.js';
export type { AuthorityState, ApproverAuthority, ExecutionAuthorityFacts, ExecutionAuthorityVerdict } from './executionAuthority.js';

// P0-6b: the ABA producer of control_loop.action.authorized@1 (reference-only; gated; closed by default).
export { ActionAuthorizedAnnouncer, actionAuthorizedPayloadFor } from './ActionAuthorizedAnnouncer.js';
export type { ExecutionCapabilityGateFactory, PackageAnnouncer, AnnouncementOutcome, PackageAnnouncementTrace, ActionAuthorizedAnnouncerDependencies } from './ActionAuthorizedAnnouncer.js';

// ── ADI structured first-action recommendation (AC-1) ──────────────────────────
export {
  ReorderPolicyRecommendationProducer, REORDER_PRODUCER_NAME, REORDER_PRODUCER_VERSION, REORDER_ACTION, REORDER_PRODUCER_RULE_SET_VERSION,
} from './ReorderPolicyRecommendationProducer.js';
export type {
  ReorderPolicyDeriverPort, DeriverCandidate, DeriverRefusal, ProduceReorderRecommendationResult, ReorderPolicyRecommendationProducerDependencies,
} from './ReorderPolicyRecommendationProducer.js';
export { AdiProposedActionSource, ProposedActionIntegrityError } from './ProposedActionSource.js';
export type { ProposedActionSource, StoredProposedAction } from './ProposedActionSource.js';
export { AdiProposalBaselineSource } from './AdiProposalBaselineSource.js';
export * from './InventoryBiEvidenceService.js';
export * from './SalesReportService.js';
export * from './InventoryItemTwinService.js';
export * from './inventoryItemTwinState.js';

// ── Business Intelligence financial reporting (NEW-BI-01) ──────────────────────
export * from './financial/FinancialIntelligenceService.js';
export { buildFinancialReport } from './financial/financialReport.js';
export type { BuildReportInput } from './financial/financialReport.js';
export * from './financial/money.js';
export * from './financial/periods.js';

// ── BI-09 metric and KPI registry rules (BI-2-DEV-01): pure domain, nothing persisted ──
export { METRIC_TYPES, METRIC_AGGREGATIONS, normalizeMetricCode, buildMetricDefinitionContent, canonicalMetricContent, metricContentHash } from './bi/metricDefinition.js';
export type { MetricType, MetricAggregation, MetricScope, MetricDefinition, MetricDefinitionContent, MetricDefinitionInput, MetricDefinitionResult } from './bi/metricDefinition.js';
export { registerMetric, reviseMetric, buildCalculationHandoff, buildMetricLineage, checkMetricDependencies, hasDependencyCycle, latestVersions, validateScope } from './bi/metricRegistry.js';
export type { MetricLineage, WarehouseDatasetRef, CalculationHandoff, MetricRegistryErrorCode, RegisterOutcome, CalculationHandoffOutcome } from './bi/metricRegistry.js';
export { BusinessIntelligenceMetricRegistryService, PERSISTABLE_TIME_GRAINS, PERSISTABLE_STATUSES } from './BusinessIntelligenceMetricRegistryService.js';
export type { MetricWriteResult, MetricHandoffResult, MetricRegistryServiceFailure, MetricRegistryServiceErrorCode } from './BusinessIntelligenceMetricRegistryService.js';

// ── Business Digital Twin representation of governed BI performance evidence (NEW-BDT-01) ──
export * from './performance/BusinessPerformanceTwinService.js';
export { assembleBiPerformanceEvidence, verifyBiPerformanceEvidence, crossCheckRevenue, canonicalJson, digestOf, SALES_REPORT_PROVENANCE_CONTRACT } from './performance/biPerformanceEvidence.js';
export type { AssembleResult, PerformanceRefusalCode } from './performance/biPerformanceEvidence.js';
export * from './performance/PerformanceSimulationHandoffService.js';
export { buildPerformanceBaseline } from './performance/performanceBaseline.js';
export type { PerformanceBaselineBuild } from './performance/performanceBaseline.js';
export * from './performance/twinConfidencePolicy.js';
export { assessSimulationReadiness, PERFORMANCE_VARIABLE_GRAMMAR } from './performance/performanceBaseline.js';
export { verifyPersistedHandoff, handoffDigest, PERFORMANCE_HANDOFF_SCHEMA_VERSION } from './performance/handoffEnvelope.js';

export { BusinessIntelligenceIntakeService, BiIntakeRejectedError, BI_INTAKE_DOMAINS, biDomainForTargetBlock } from './BusinessIntelligenceIntakeService.js';
export type { BiIntakeDomain, BusinessIntelligenceIntakeResult } from './BusinessIntelligenceIntakeService.js';
