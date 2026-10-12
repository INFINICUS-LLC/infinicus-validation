export { NotFoundError, ConflictError } from './errors.js';

export { LeadRepository } from './LeadRepository.js';
export type { Lead, CreateLeadInput } from './LeadRepository.js';

export { OpportunityRepository } from './OpportunityRepository.js';
export type { Opportunity, CreateOpportunityInput } from './OpportunityRepository.js';

export { PurchaseOrderRepository } from './PurchaseOrderRepository.js';
export type { PurchaseOrder, CreatePurchaseOrderInput } from './PurchaseOrderRepository.js';

export { SupportCaseRepository } from './SupportCaseRepository.js';
export type { SupportCase, CreateSupportCaseInput } from './SupportCaseRepository.js';

export { IncidentRepository } from './IncidentRepository.js';
export type { Incident, CreateIncidentInput } from './IncidentRepository.js';

export { TaskRepository } from './TaskRepository.js';
export type { Task, CreateTaskInput } from './TaskRepository.js';

export { InventoryBalanceRepository } from './InventoryBalanceRepository.js';
export type { InventoryBalance, CreateInventoryBalanceInput } from './InventoryBalanceRepository.js';

export { BusinessEventRepository } from './BusinessEventRepository.js';
export type {
  BusinessEvent, LogBusinessEventInput, BusinessEventType, BusinessEventAction,
  SalesAggregate, ExpensesAggregate, InventoryAggregate, CustomersAggregate, TeamAggregate,
} from './BusinessEventRepository.js';

export { ProductRepository } from './ProductRepository.js';
export type { Product, CreateProductInput, UpdateProductInput } from './ProductRepository.js';

export { RegisterSessionRepository } from './RegisterSessionRepository.js';
export type { RegisterSession, OpenRegisterSessionInput, CloseRegisterSessionInput } from './RegisterSessionRepository.js';

export { OrderRepository } from './OrderRepository.js';
export type { Order, OrderLineItem, OrderOperationalStatus, CreateOrderInput, AddLineItemInput } from './OrderRepository.js';

export { AuthorizedActionIntakeRepository, MAX_RECEIPT_DOCUMENT_BYTES } from './AuthorizedActionIntakeRepository.js';
export type {
  IntakeOutcome, IntakeEvaluation, IntakeRequest, IntakeResult, IntakeAttemptInput, AuthorizedActionReceipt, AuthorizedActionClaim,
} from './AuthorizedActionIntakeRepository.js';

export {
  InventoryPolicyEvaluationRepository, InventoryPolicyEvaluationValidationError,
  INVENTORY_POLICY_EVALUATION_DIMENSIONS, INVENTORY_POLICY_EVALUATION_RESULTS,
} from './InventoryPolicyEvaluationRepository.js';
export type {
  InventoryPolicyEvaluation, InventoryPolicyEvaluationSubject, InventoryPolicyEvaluationDimension, InventoryPolicyEvaluationResult,
  RecordInventoryPolicyEvaluationInput, EvaluationJson,
} from './InventoryPolicyEvaluationRepository.js';

export { ExecutionCapabilityActivationRepository, ExecutionCapabilityActivationInvalidError } from './ExecutionCapabilityActivationRepository.js';
export type { ExecutionCapabilityActivation, RecordActivationInput, ActivationState } from './ExecutionCapabilityActivationRepository.js';
export { AuthorizedActionExecutionRepository } from './AuthorizedActionExecutionRepository.js';
export type {
  ClaimForExecution, ExecutionRecord, InsertExecutionInput, InsertAttemptInput, AttemptSummary, ClaimAwaitingExecution,
  ExecutionOutcome, MutationResult, AuthorityVerdictRecord, AttemptOutcome,
} from './AuthorizedActionExecutionRepository.js';
