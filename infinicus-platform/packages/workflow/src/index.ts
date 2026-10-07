// @infinicus/workflow — customer decision workflow orchestration: business
// selection, BI/DT/simulation/ADI review, ABA approval, OM outcome entry,
// decision history. Composes existing BI/DT/SIM/ADI/ABA/OM repositories —
// introduces no new persistence of its own.

export { DecisionWorkflowService, ApproverAuthorityNotEstablishedError, DEFAULT_APPROVER_ASSIGNMENT_CODE } from './DecisionWorkflowService.js';
export type {
  WorkflowView, DecisionHistory,
  CreateReviewInput, SubmitApprovalInput, GrantApproverAuthorityInput, RecordOutcomeInput,
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
  RecommendedDecision, ChoiceReviewResult, DecisionHistoryEntry, RiskLevel,
} from './BusinessDecisionRecommendationService.js';
