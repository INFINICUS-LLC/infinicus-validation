// AuthorizedActionPackage v1 - contract types (P0-5 Block 2).
//
// Locked sources: Master Manifest 8.7 (AuthorizedActionPackage: action ID, decision ID, exact authorized
// parameters, approver, owner, execution window, automation level, budget, preconditions, rollback instructions,
// monitoring metrics, approval record), ABA spec 9 (MODIFY), 13 (ownership), 14-16 (plan, rollback, BO re-check),
// 17 (automation levels), 25 (audit record), 32 (output to BO), 35 (ABA is the source of truth for what was authorized).
// Owner rulings: P0-5 Block 1 D-1..D-7 and R-1..R-11 (see docs/architecture/reconciliation/P0-5_BLOCK1_RECONCILIATION.md).
//
// This module is PURE: serializable data and types only. No database, no I/O, no clock. ABA authors and issues the
// package; Business Operations consumes it through this contract and never reads ABA tables.

/** Contract version of the package schema. A change to the shape or meaning of any field is a NEW version. */
export const AAP_CONTRACT_VERSION = 'aap/1' as const;
/** Versions of the package schema this implementation understands. Anything else is rejected, never guessed at. */
export const SUPPORTED_AAP_CONTRACT_VERSIONS: readonly string[] = [AAP_CONTRACT_VERSION];

/** Canonical serialization version (see canonical.ts). Covered by the digest and checked separately. */
export const AAP_CANONICAL_VERSION = 'aap-canonical/1' as const;
export const SUPPORTED_AAP_CANONICAL_VERSIONS: readonly string[] = [AAP_CANONICAL_VERSION];

/** Digest algorithm. SHA-256 is the only algorithm in v1. The digest is tamper evidence only. */
export const AAP_DIGEST_ALGORITHM = 'sha256' as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

// -------------------------------------------------------------------------------------------------------------------
// Governed applicability (owner ruling D-6, R-4)
// -------------------------------------------------------------------------------------------------------------------

/** Why a governed field legitimately does not apply. The reason is preserved in the package and covered by the digest. */
export interface NotApplicableReason {
  /** Upper-snake code, e.g. NOT_SIMULATION_BACKED. */
  code: string;
  /** Human-readable governed statement. */
  statement: string;
  /**
   * The authoritative basis that makes the field legitimately not apply. REQUIRED where "no bound applies" must be an
   * explicit governed fact (the expiry): an ACTION_SCHEMA basis names the action type (`code@schemaVersion`) whose
   * contract explicitly allows it; a POLICY basis names the governed policy version. "No source found" is never a basis:
   * it is UNAVAILABLE.
   */
  basis?: { kind: 'ACTION_SCHEMA' | 'POLICY'; ref: string };
}

/**
 * VALUE = an authoritative value exists. NOT_APPLICABLE = the field legitimately does not apply (reason preserved).
 * There is deliberately NO `UNAVAILABLE` member: a package with a required field whose source is missing is never
 * issued (R-4). See {@link UnavailableMarker} for how a missing source is expressed BEFORE issuance.
 */
export type Governed<T> =
  | { readonly state: 'VALUE'; readonly value: T }
  | { readonly state: 'NOT_APPLICABLE'; readonly reason: NotApplicableReason };

/**
 * A required source is missing. This marker is only ever produced while a candidate is being assembled; the validator
 * refuses any package that contains one, at any path (error REQUIRED_FIELD_UNAVAILABLE). It cannot be sealed.
 */
export interface UnavailableMarker {
  readonly state: 'UNAVAILABLE';
  /** Names the missing authoritative source. */
  readonly source: string;
}

// -------------------------------------------------------------------------------------------------------------------
// Governance dimensions (owner ruling D-2, R-7)
// -------------------------------------------------------------------------------------------------------------------

/** Governance checks that an execution-affecting modification can invalidate (D-2). No numeric thresholds exist. */
export const GOVERNANCE_DIMENSIONS = [
  'SIMULATION',
  'RISK',
  'CONSTRAINTS',
  'VALIDITY',
  'RESOURCE_REQUIREMENTS',
  'COST',
  'REVERSIBILITY',
  'EXPECTED_OUTCOME',
] as const;
export type GovernanceDimension = (typeof GOVERNANCE_DIMENSIONS)[number];

// -------------------------------------------------------------------------------------------------------------------
// Package parts
// -------------------------------------------------------------------------------------------------------------------

export type RiskClass = 'low' | 'medium' | 'high' | 'critical';
export const RISK_CLASSES: readonly RiskClass[] = ['low', 'medium', 'high', 'critical'];

/** PERSISTED = the persisted ADI-authored class. UNCLASSIFIED_FAIL_CLOSED_HIGH = no class existed; policy treats it as high. */
export type RiskClassBasis = 'PERSISTED' | 'UNCLASSIFIED_FAIL_CLOSED_HIGH';

export type DecisionStatus = 'approved' | 'approved_with_modifications';

/**
 * ABA automation levels an AuthorizedActionPackage can represent (locked ABA spec 17 governs Levels 2-4):
 *   2 = human approval / system execution        -> HUMAN_APPROVAL provenance
 *   3 = rule-authorized automation               -> RULE_AUTHORIZED provenance
 *   4 = future autonomous optimization under explicit governance -> RULE_AUTHORIZED provenance
 * Levels 0 (observe) and 1 (recommend) do not authorize execution and are INVALID for a package.
 * Being representable is a CONTRACT fact; being enabled is a separate, current POLICY fact (see
 * {@link PackageEnablementPolicy}). Level 4 is recognized by the contract and NOT_ENABLED by current policy.
 */
export const AUTOMATION_LEVELS = [2, 3, 4] as const;
export type AutomationLevelValue = (typeof AUTOMATION_LEVELS)[number];

/** Which automation levels the CURRENT implementation issues and executes. A policy value, not a contract constraint. */
export interface PackageEnablementPolicy {
  readonly automationLevels: readonly AutomationLevelValue[];
}

/** Level 2 supported; Level 3 supported only with proper rule-authorization provenance; Level 4 NOT_ENABLED. */
export const CURRENT_PACKAGE_ENABLEMENT: PackageEnablementPolicy = Object.freeze({ automationLevels: Object.freeze([2, 3] as AutomationLevelValue[]) });

export interface PackageIdentity {
  packageId: string;
  /** Integer >= 1. A superseding package is a NEW record that points back through `supersedes`. */
  packageVersion: number;
  supersedes: { packageId: string; packageVersion: number } | null;
}

export interface PackageScope {
  tenantId: string;
  workspaceId: string;
  businessId: string;
}

export interface PackageIssuance {
  /** Database time at issuance, millisecond-precision UTC (see timestamp format in validator). */
  issuedAt: string;
  /** The single component allowed to issue packages (architecture-tested). */
  issuerComponent: string;
}

export interface ActionTypeRef {
  /** Action-type code in the ABA-governed vocabulary. */
  code: string;
  /** Version of that action type's parameter schema. */
  schemaVersion: string;
}

export interface ActionTarget {
  kind: string;
  id: string;
}

export type PreconditionOperator =
  | 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte' | 'between' | 'in' | 'not_in' | 'contains';

export interface Precondition {
  code: string;
  operator: PreconditionOperator;
  operand: JsonValue;
}

export interface MonitoringMetric {
  metricCode: string;
  target: JsonValue | null;
  unit: string | null;
}

export interface AutomationLevel {
  level: AutomationLevelValue;
  /** The governed ABA policy the level comes from (R-3). No policy source = UNAVAILABLE = no issuance. */
  policy: { policyId: string; policyVersionId: string };
}

export interface PackageAction {
  /** ABA authorized-action record this package derives from (reference only; never execution authority). */
  actionId: string;
  actionVersionId: string;
  type: ActionTypeRef;
  target: ActionTarget;
  /** The EXACT effective authorized parameters, authored by ABA (D-1). BO executes this set and nothing else. */
  parameters: Readonly<Record<string, JsonValue>>;
  automationLevel: AutomationLevel;
  executionWindow: Governed<{ startsAt: string; endsAt: string | null }>;
  preconditions: Governed<readonly Precondition[]>;
  budget: Governed<{ amount: string; currency: string }>;
  rollback: Governed<{ instructions: string }>;
  monitoring: Governed<{ metrics: readonly MonitoringMetric[] }>;
}

export interface ProposedParameters {
  /** The ADI record the proposal came from. */
  source: { layer: 'ADI'; recordType: string; recordId: string };
  parameters: Readonly<Record<string, JsonValue>>;
}

export type ModificationOperation = 'SET' | 'ADD' | 'REMOVE';

/** One top-level parameter change. `before` is absent for ADD; `after` is absent for REMOVE. */
export interface ParameterChange {
  parameter: string;
  operation: ModificationOperation;
  before?: JsonValue;
  after?: JsonValue;
}

/** Structured modification delta + reason (D-2). Prose-only modification is not representable. */
export interface Modification {
  reason: string;
  modifiedByUserId: string;
  modifiedAt: string;
  changes: readonly ParameterChange[];
}

export interface GovernanceEvidence {
  dimension: GovernanceDimension;
  evaluatedAt: string;
  result: 'PASSED';
  evidenceRef: { kind: string; id: string };
}

/** Fresh governance evaluation required by an execution-affecting modification (D-2, R-7). */
export interface ModificationEvaluation {
  /** DECLARED_IMPACT = the action schema's parameter->impact map; CONSERVATIVE_FULL = an unmapped parameter forced all dimensions. */
  basis: 'DECLARED_IMPACT' | 'CONSERVATIVE_FULL';
  evidence: readonly GovernanceEvidence[];
}

export interface PackageLineage {
  recommendation: { recommendationId: string; recommendationVersionId: string };
  review: { reviewPackageId: string; reviewVersionId: string };
  decision: { decisionId: string; decisionVersionId: string };
  twinSnapshotId: Governed<string>;
  simulationRunId: Governed<string>;
  proposedParameters: Governed<ProposedParameters>;
  modification: Governed<Modification>;
  modificationEvaluation: Governed<ModificationEvaluation>;
}

/** Risk facts common to every authorization mode. */
export interface RiskFacts {
  riskClass: RiskClass;
  basis: RiskClassBasis;
}

/** Level 2: a human approver decided under assigned authority. `permissionUsed` is REQUIRED and real. */
export interface HumanApprovalProvenance {
  mode: 'HUMAN_APPROVAL';
  decisionStatus: DecisionStatus;
  decidedAt: string;
  approver: { userId: string; assignmentId: string; assignmentVersionId: string; roleCode: string };
  /** The canonical provenance record for the approver's authority (approval_authority_scopes, owner ruling D3). */
  authorityProvenance: { scopeId: string };
  /** Permission the approving request used, as recorded by the approval audit. */
  permissionUsed: string;
  /** The approval audit record (`approval_audit_events`) for the decision. */
  approvalAuditEventId: string;
  risk: RiskFacts & { requiredApproverTier: number; approverTier: number };
}

/**
 * Level 3 / 4: authorized by governed policy and rules, with no per-instance human approval. It never carries a
 * human `permissionUsed`, approver or assignment: a rule-authorized package must not masquerade as a human approval.
 */
export interface RuleAuthorizedProvenance {
  mode: 'RULE_AUTHORIZED';
  /** The governed ABA policy version that authorizes this automation. */
  policy: { policyId: string; policyVersionId: string };
  /** The specific rule, where the policy is rule-based; otherwise a governed NOT_APPLICABLE. */
  rule: Governed<{ ruleId: string; ruleVersionId: string }>;
  /** Database time at which the governed evaluation passed. */
  evaluatedAt: string;
  /** The system / service principal that evaluated, where one applies. */
  servicePrincipal: Governed<{ principalId: string; component: string }>;
  /** The governance audit record of the rule evaluation. */
  governanceAuditEventId: string;
  risk: RiskFacts;
}

export type PackageAuthorization = HumanApprovalProvenance | RuleAuthorizedProvenance;

export interface AccountableOwner {
  /** Canonical Identity/Tenancy truth (R-2). ABA owns only the assignment and its provenance below. */
  identity: { userId: string; membershipId: string };
  roleCode: string;
  assignment: { assignmentId: string; assignedByUserId: string; assignedAt: string };
  dueAt: Governed<string>;
  escalationPolicy: Governed<{ ref: string }>;
}

export type ExpiryBoundSource = 'DECISION_VALID_UNTIL' | 'EXECUTION_WINDOW_END' | 'EXPLICIT_PACKAGE_EXPIRY';

export interface ExpiryBound {
  source: ExpiryBoundSource;
  at: string;
}

export interface PackageValidity {
  isTimeSensitive: boolean;
  decisionValidUntil: Governed<string>;
  freshness: { assessedAt: string; twin: 'FRESH' | 'NOT_APPLICABLE' };
  /** Every authoritative validity bound that applies. */
  expiryBounds: readonly ExpiryBound[];
  /** The earliest bound (R-6), or NOT_APPLICABLE when no bound applies. */
  expiresAt: Governed<string>;
}

export interface PackageTrace {
  correlationId: string;
  /** The immediate causing record (e.g. the final ABA step that led to issuance). */
  causationId: string;
}

export interface PackageIntegrity {
  canonicalVersion: typeof AAP_CANONICAL_VERSION;
  algorithm: typeof AAP_DIGEST_ALGORITHM;
  /** `sha256:<64 lowercase hex>` over the canonical form of the package without this block. Tamper evidence only. */
  digest: string;
}

/** Everything the digest covers: the whole package except `integrity`. */
export interface AuthorizedActionPackageBody {
  contractVersion: typeof AAP_CONTRACT_VERSION;
  identity: PackageIdentity;
  scope: PackageScope;
  issuance: PackageIssuance;
  action: PackageAction;
  lineage: PackageLineage;
  authorization: PackageAuthorization;
  accountableOwner: AccountableOwner;
  validity: PackageValidity;
  /** v1 packages are single-use (R-5). CONSUMED means BO atomically claimed it, not that execution completed. */
  consumption: { mode: 'SINGLE_USE' };
  trace: PackageTrace;
}

/** A sealed, issuable package. */
export interface AuthorizedActionPackageV1 extends AuthorizedActionPackageBody {
  integrity: PackageIntegrity;
}

// -------------------------------------------------------------------------------------------------------------------
// Persisted lifecycle facts and the authoritative pre-execution status (owner rulings D-4, R-5, R-10)
// -------------------------------------------------------------------------------------------------------------------

/** Persisted lifecycle facts. EXECUTED is NOT an ABA package state; EXECUTABLE is derived, never persisted. */
export const PACKAGE_LIFECYCLE_STATES = ['ISSUED', 'REVOKED', 'SUPERSEDED', 'EXPIRED', 'CONSUMED'] as const;
export type PackageLifecycleState = (typeof PACKAGE_LIFECYCLE_STATES)[number];

/**
 * What ABA's authoritative status contract answers immediately before execution (R-10). It echoes the digest so BO can
 * prove the answer is about the exact package it holds.
 */
export interface AuthoritativePackageStatus {
  packageId: string;
  packageVersion: number;
  digest: string;
  lifecycle: PackageLifecycleState;
  /** Highest package version that exists for this authorized action. */
  latestPackageVersion: number;
  /** Database time at which ABA answered. */
  verifiedAt: string;
}
