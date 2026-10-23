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

export { PrintJobRepository } from './PrintJobRepository.js';
export type { PrintJob, PrintTrigger, PrintOutcome, PrintFailureCode, PrintedVia, RecordPrintJobInput } from './PrintJobRepository.js';
export { PrinterRepository } from './PrinterRepository.js';
export type { Printer, PrinterKind, PrinterConnection, PaperWidth, CreatePrinterInput } from './PrinterRepository.js';
export { RegisterSessionRepository, RegisterAmountError } from './RegisterSessionRepository.js';
export type { RegisterSession, RegisterSessionSummary, OpenRegisterSessionInput, CloseRegisterSessionInput } from './RegisterSessionRepository.js';

export { OrderRepository } from './OrderRepository.js';
export { OfflineSaleRepository } from './OfflineSaleRepository.js';
export type { OfflineSaleResult } from './OfflineSaleRepository.js';
export {
  OFFLINE_MAX_AGE_SECONDS, MAX_OFFLINE_LINES, MAX_OFFLINE_TENDERS, MAX_OFFLINE_QUANTITY, OfflineSaleRequestError,
  validateOfflineSaleRequest, requestDigest, planOfflineSale, parseScaled4, unitPriceMinor, minorToMajor, exponentOf,
} from './offlineSale.js';
export type {
  OfflineSaleOutcome, ReviewReason, OfflineSaleLineInput, OfflineSaleTenderInput, OfflineSaleRequest, OfflineSaleConfig, ServerProduct, PlannedLine, LineDetail, OfflineSalePlan,
} from './offlineSale.js';
export type { Order, OrderLineItem, OrderPayment, OrderOperationalStatus, CreateOrderInput, AddLineItemInput } from './OrderRepository.js';
export { planPayments, PaymentError, TENDER_METHODS, MAX_PAYMENTS_PER_ORDER, PAYMENT_REFERENCE_MAX } from './tender.js';
export type { PaymentInput, PlannedPayment, TenderMethod } from './tender.js';
export { planDiscount, DiscountError, MAX_DISCOUNTS_PER_ORDER, DISCOUNT_REASON_MAX } from './discount.js';
export type { PlannedDiscount } from './discount.js';

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
  ClaimForExecution, ClaimState, ClaimAwaitingFilter, ExecutionRecord, InsertExecutionInput, InsertAttemptInput, AttemptSummary, ClaimAwaitingExecution,
  ExecutionOutcome, MutationResult, AuthorityVerdictRecord, AttemptOutcome, ExecutionHealthSnapshot, OpenClaimHealthRow, TerminalHealthRow,
} from './AuthorizedActionExecutionRepository.js';

export { SalesFactsRepository } from './SalesFactsRepository.js';
export type { SalesDayCurrencyFacts } from './SalesFactsRepository.js';
export { InventoryOutcomeEvidenceRepository } from './InventoryOutcomeEvidenceRepository.js';
export type { InventoryOutcomeEvidence, InventoryOutcomeEvidenceInput, InventoryIssueEvidence } from './InventoryOutcomeEvidenceRepository.js';
export { InventoryAttributionEvidenceRepository } from './InventoryAttributionEvidenceRepository.js';
export type { InventoryAttributionInput, InventoryAttributionEvidence } from './InventoryAttributionEvidenceRepository.js';
