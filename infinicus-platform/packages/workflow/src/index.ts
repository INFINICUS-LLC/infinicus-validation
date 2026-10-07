// @infinicus/workflow — customer decision workflow orchestration: business
// selection, BI/DT/simulation/ADI review, ABA approval, OM outcome entry,
// decision history. Composes existing BI/DT/SIM/ADI/ABA/OM repositories —
// introduces no new persistence of its own.

export { DecisionWorkflowService, ApproverAuthorityNotEstablishedError, ApprovalPolicyDeniedError, DEFAULT_APPROVER_ASSIGNMENT_CODE } from './DecisionWorkflowService.js';
export type {
  WorkflowView, DecisionHistory,
  CreateReviewInput, SubmitApprovalInput, GrantApproverAuthorityInput, RevokeApproverAuthorityInput, ApproverAuthorityRecord, RecordOutcomeInput,
} from './DecisionWorkflowService.js';

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
