import {
  APPROVER_ROLES, DEFAULT_APPROVAL_RISK_POLICY, evaluateApproval,
  type ApprovalOutcome, type ApprovalRiskPolicy, type ApproverRole, type RiskClass,
} from './approvalRiskPolicy.js';
import {
  BusinessRepository,
  InsightPackageRepository,
  DigitalTwinInstanceRepository, DigitalTwinSnapshotRepository,
  SimulationRunRepository, SimulationResultRepository,
  DecisionCaseRepository, DecisionRecommendationRepository,
  ActionReviewRepository, ApproverAuthorityRepository, ApprovalDecisionRepository,
  OwnershipEvidenceRepository, provenOwnersOf, OWNER_APPROVER_ASSIGNMENT_CODE, normalizeRevocationReason,
  ApproverAuthorityNotFoundError, ApproverAuthorityStateConflictError,
  MonitoredActionRepository, OutcomeObservationRepository,
  type TenantContext, type Business, type CreateBusinessInput,
  type PagedBusinesses, type PageOptions,
  type InsightPackage,
  type DigitalTwinInstance, type DigitalTwinSnapshot,
  type SimulationRun, type SimulationResult,
  type DecisionCase, type DecisionRecommendation,
  type ActionReviewPackage, type ApprovalDecision, type ApproverAssignment, type AuthorityProvenanceEntry,
  type OutcomeObservation, type OutcomeObservationVersion,
} from '@infinicus/database';

const RECENT_LIMIT = 5;

/** Assignment code used by the business-owner approval flow; the assignment must be granted beforehand. */
export const DEFAULT_APPROVER_ASSIGNMENT_CODE = OWNER_APPROVER_ASSIGNMENT_CODE;

/**
 * Thrown when a decision is attempted without approval authority that was
 * established beforehand by an authoritative source. The `.name` is mapped
 * to HTTP 403 by apps/api/src/errors.ts.
 */
export class ApproverAuthorityNotEstablishedError extends Error {
  constructor(reason: string) {
    super(`approver authority not established: ${reason}`);
    this.name = 'ApproverAuthorityNotEstablishedError';
  }
}

/**
 * Thrown when the approver's role does not satisfy the action-risk policy
 * for an approving outcome (P0-2). Mapped to HTTP 403 in apps/api/src/errors.ts.
 */
export class ApprovalPolicyDeniedError extends Error {
  constructor(reason: string) {
    super(`approval policy denied: ${reason}`);
    this.name = 'ApprovalPolicyDeniedError';
  }
}

export interface GrantApproverAuthorityInput {
  approverUserId: string;
  assignmentCode: string;
  /** Approver role (defaults to the generic `approver`, manager tier). Must be a known role. */
  roleCode?: ApproverRole | 'approver';
  /** Request correlation id for the provenance record, where available. */
  correlationId?: string | null;
}

export interface RevokeApproverAuthorityInput {
  assignmentCode: string;
  /** Why authority is withdrawn; required, recorded in the provenance history. */
  reason: string;
  correlationId?: string | null;
}

export interface ApproverAuthorityRecord {
  assignment: ApproverAssignment;
  provenance: AuthorityProvenanceEntry[];
}

export interface WorkflowView {
  business: Business;
  biEvidence: InsightPackage[];
  dtInstances: DigitalTwinInstance[];
  dtLatestSnapshot: DigitalTwinSnapshot | null;
  simulationRuns: SimulationRun[];
  simulationLatestResult: SimulationResult | null;
  adiCases: DecisionCase[];
  adiLatestRecommendation: DecisionRecommendation | null;
  abaReviews: ActionReviewPackage[];
  abaLatestDecision: ApprovalDecision | null;
  outcomes: OutcomeObservation[];
}

export interface DecisionHistory {
  biEvidence: InsightPackage[];
  simulationRuns: SimulationRun[];
  adiCases: DecisionCase[];
  abaReviews: ActionReviewPackage[];
  outcomes: OutcomeObservation[];
}

export interface CreateReviewInput {
  intakePackageId: string;
  reviewCode: string;
  summary: string;
}

export interface SubmitApprovalInput {
  reviewPackageId: string;
  /**
   * Optional and NEVER a source of authority. The approver is always the
   * authenticated principal (`ctx.userId`); if supplied it must equal it.
   */
  approverUserId?: string;
  /** Code of an approver assignment that was established beforehand. */
  assignmentCode: string;
  decisionCode: string;
  summary: string;
  outcome: ApprovalOutcome;
  /**
   * Action risk class, for TRUSTED server-side callers only. It is not
   * exposed by the API and must come from the governed data model (P0-3).
   * When absent the action is unclassified and treated as high risk.
   */
  riskClass?: RiskClass;
}

export interface RecordOutcomeInput {
  monitoredActionId: string;
  observationCode: string;
  summary: string;
  effectiveAt: Date;
  measurements?: Array<{ metricCode: string; measuredValue: Record<string, unknown>; unit?: string | null }>;
  evidence?: Array<{ evidenceType: string; evidenceReference: Record<string, unknown> }>;
}

/**
 * Composes reads and existing writes from the already-persisted BI, DT,
 * Simulation, ADI, ABA, and OM domains into one decision-workflow view.
 * Per AD-021 ("Platform orchestration does not create business
 * authority... must not make business decisions"), this service never
 * decides anything itself — `submitApprovalDecision` and `recordOutcome`
 * only forward a human's explicit choice to the domain repository that
 * already owns that decision's persistence and immutability rules.
 */
export class DecisionWorkflowService {
  constructor(
    private readonly businesses: BusinessRepository = new BusinessRepository(),
    private readonly insightPackages: InsightPackageRepository = new InsightPackageRepository(),
    private readonly dtInstances: DigitalTwinInstanceRepository = new DigitalTwinInstanceRepository(),
    private readonly dtSnapshots: DigitalTwinSnapshotRepository = new DigitalTwinSnapshotRepository(),
    private readonly simRuns: SimulationRunRepository = new SimulationRunRepository(),
    private readonly simResults: SimulationResultRepository = new SimulationResultRepository(),
    private readonly decisionCases: DecisionCaseRepository = new DecisionCaseRepository(),
    private readonly recommendations: DecisionRecommendationRepository = new DecisionRecommendationRepository(),
    private readonly reviews: ActionReviewRepository = new ActionReviewRepository(),
    private readonly approverAuthority: ApproverAuthorityRepository = new ApproverAuthorityRepository(),
    private readonly ownershipEvidence: OwnershipEvidenceRepository = new OwnershipEvidenceRepository(),
    private readonly approvalDecisions: ApprovalDecisionRepository = new ApprovalDecisionRepository(),
    private readonly monitoredActions: MonitoredActionRepository = new MonitoredActionRepository(),
    private readonly outcomeObservations: OutcomeObservationRepository = new OutcomeObservationRepository(),
    private readonly riskPolicy: ApprovalRiskPolicy = DEFAULT_APPROVAL_RISK_POLICY
  ) {}

  /** Business selection, bounded by LIMIT/OFFSET pushed into the repository query. */
  async listBusinesses(ctx: TenantContext, page: PageOptions = {}): Promise<PagedBusinesses> {
    return this.businesses.listForWorkspace(ctx, page);
  }

  async createBusiness(ctx: TenantContext, input: CreateBusinessInput): Promise<Business> {
    return this.businesses.create(ctx, input);
  }

  /**
   * Data review / BI evidence / DT state / Simulation execution / ADI
   * recommendation / ABA review / outcome entry — one aggregate read of
   * each stage's most recent state for a business. Any stage with no data
   * yet simply comes back empty/null; this method never fabricates data
   * for a stage that hasn't produced anything.
   */
  async getWorkflowView(ctx: TenantContext, businessId: string): Promise<WorkflowView> {
    const business = await this.businesses.getById(ctx, businessId);

    const biEvidence = (await this.insightPackages.listForBusiness(ctx, businessId)).slice(0, RECENT_LIMIT);

    const dtInstances = await this.dtInstances.getActiveForBusiness(ctx, businessId);
    const dtLatestSnapshot = await this.latestDtSnapshot(ctx, dtInstances);

    const simulationRuns = (await this.simRuns.listForBusiness(ctx, businessId)).slice(0, RECENT_LIMIT);
    const simulationLatestResult = await this.latestSimulationResult(ctx, simulationRuns);

    const adiCases = (await this.decisionCases.listForBusiness(ctx, businessId)).slice(0, RECENT_LIMIT);
    const adiLatestRecommendation = await this.latestRecommendation(ctx, adiCases);

    const abaReviews = (await this.reviews.listForBusiness(ctx, businessId)).slice(0, RECENT_LIMIT);
    const abaLatestDecision = await this.latestApprovalDecision(ctx, abaReviews);

    const outcomes = (await this.outcomeObservations.listForBusiness(ctx, businessId)).slice(0, RECENT_LIMIT);

    return {
      business, biEvidence, dtInstances, dtLatestSnapshot,
      simulationRuns, simulationLatestResult, adiCases, adiLatestRecommendation,
      abaReviews, abaLatestDecision, outcomes,
    };
  }

  /**
   * Decision history: each stage's full recency-ordered list for a
   * business. Presented as separate per-stage lanes rather than one
   * interleaved global timeline, since no domain repository exposes a
   * shared, directly comparable timestamp across stages without an
   * additional cross-domain join this build does not introduce.
   */
  async getDecisionHistory(ctx: TenantContext, businessId: string): Promise<DecisionHistory> {
    const [biEvidence, simulationRuns, adiCases, abaReviews, outcomes] = await Promise.all([
      this.insightPackages.listForBusiness(ctx, businessId),
      this.simRuns.listForBusiness(ctx, businessId),
      this.decisionCases.listForBusiness(ctx, businessId),
      this.reviews.listForBusiness(ctx, businessId),
      this.outcomeObservations.listForBusiness(ctx, businessId),
    ]);
    return { biEvidence, simulationRuns, adiCases, abaReviews, outcomes };
  }

  /** Starts an ABA review package for an already-received ABA intake package (not created by this service — see known limitations). */
  async createReview(ctx: TenantContext, businessId: string, input: CreateReviewInput): Promise<ActionReviewPackage> {
    const review = await this.reviews.createReviewPackage(ctx, businessId, input.intakePackageId, input.reviewCode);
    await this.reviews.createVersion(ctx, review.id, businessId, input.summary);
    await this.reviews.transitionStatus(ctx, review.id, 'in_review');
    return this.reviews.getById(ctx, review.id);
  }

  /**
   * Establishes approval authority for a user. This is the ONLY place an
   * approver assignment is created, and it is a separate operation from
   * deciding: submitApprovalDecision never calls it.
   *
   * The caller MUST be authorised to administer approval authority; the API
   * route enforces the `aba:admin` permission (seeded in migration 0137)
   * before invoking this. Action-risk policy and valid_until are layered on
   * by P0-2 / P0-3 of the reconciliation plan.
   */
  async grantApproverAuthority(ctx: TenantContext, businessId: string, input: GrantApproverAuthorityInput): Promise<ApproverAssignment> {
    const roleCode = input.roleCode ?? 'approver';
    if (roleCode !== 'approver' && !(APPROVER_ROLES as readonly string[]).includes(roleCode)) {
      throw new ApprovalPolicyDeniedError(`unknown approver role: ${String(roleCode)}`);
    }
    const { assignment, created } = await this.approverAuthority.grantActiveAssignment(ctx, {
      businessId,
      userId: input.approverUserId,
      assignmentCode: input.assignmentCode,
      roleCode,
      provenance: {
        action: 'grant',
        source: 'manual-admin',
        businessId,
        assignmentCode: input.assignmentCode,
        granteeUserId: input.approverUserId,
        state: 'active',
        actor: { type: 'user', id: ctx.userId, authority: 'aba:admin' },
        at: new Date().toISOString(),
        correlationId: input.correlationId ?? null,
        proof: null,
        reason: null,
      },
    });
    if (!created) {
      // Idempotent for the same grantee; anything else is a conflict the administrator must resolve explicitly.
      if (assignment.userId !== input.approverUserId) {
        throw new ApproverAuthorityStateConflictError('ApproverAssignment', `assignment code ${input.assignmentCode} is already held by another user`);
      }
      if (assignment.status !== 'active') {
        throw new ApproverAuthorityStateConflictError('ApproverAssignment', `assignment code ${input.assignmentCode} exists with status ${assignment.status}; use a new assignment code`);
      }
    }
    return assignment;
  }

  /**
   * Revokes an approver assignment. Authority does not remain valid merely because it was once
   * granted: after this the grantee has no authority (submitApprovalDecision only honours an
   * `active` assignment). Idempotent. The route enforces `aba:admin`. Recorded in the append-only
   * provenance history with the revoking user and the reason.
   */
  async revokeApproverAuthority(ctx: TenantContext, businessId: string, input: RevokeApproverAuthorityInput): Promise<{ assignment: ApproverAssignment; changed: boolean }> {
    const reason = normalizeRevocationReason(input.reason);
    const existing = await this.approverAuthority.findByCode(ctx, businessId, input.assignmentCode);
    if (!existing) throw new ApproverAuthorityNotFoundError('ApproverAssignment', input.assignmentCode);
    return this.approverAuthority.revokeAssignment(ctx, existing.id, {
      source: 'manual-admin',
      actor: { type: 'user', id: ctx.userId, authority: 'aba:admin' },
      at: new Date().toISOString(),
      correlationId: input.correlationId ?? null,
      proof: null,
      reason,
    });
  }

  /** The assignment and its full append-only provenance history (grants and revocations). */
  async getApproverAuthority(ctx: TenantContext, businessId: string, assignmentCode: string): Promise<ApproverAuthorityRecord> {
    const assignment = await this.approverAuthority.findByCode(ctx, businessId, assignmentCode);
    if (!assignment) throw new ApproverAuthorityNotFoundError('ApproverAssignment', assignmentCode);
    return { assignment, provenance: await this.approverAuthority.listProvenance(ctx, assignment.id) };
  }

  /**
   * Records a human approver's explicit decision. This forwards the
   * decision — it does not decide anything itself (AD-021). It CHECKS that
   * the authenticated principal already holds an active approver
   * assignment for this business; it never creates one (V-01).
   */
  async submitApprovalDecision(ctx: TenantContext, businessId: string, input: SubmitApprovalInput): Promise<ApprovalDecision> {
    if (input.approverUserId !== undefined && input.approverUserId !== ctx.userId) {
      throw new ApproverAuthorityNotEstablishedError('the approver must be the authenticated principal');
    }
    const assignment = await this.approverAuthority.findActiveForUser(ctx, businessId, ctx.userId, input.assignmentCode);
    if (!assignment) {
      throw new ApproverAuthorityNotEstablishedError('no active approver assignment exists for this user and business');
    }
    await this.assertOwnerAuthorityStillProven(ctx, businessId, assignment);

    const verdict = evaluateApproval({
      riskClass: input.riskClass,
      roleCode: await this.approverAuthority.getCurrentRoleCode(ctx, assignment.id),
      outcome: input.outcome,
      policy: this.riskPolicy,
    });
    if (!verdict.allowed) throw new ApprovalPolicyDeniedError(verdict.reason);

    const { decision, version } = await this.approvalDecisions.createDecision(
      ctx, businessId, input.reviewPackageId, assignment.id, input.decisionCode, input.summary
    );

    switch (input.outcome) {
      case 'approve':
        return this.approvalDecisions.approve(ctx, decision.id, version.id);
      case 'approve_with_modifications':
        return this.approvalDecisions.approveWithModifications(ctx, decision.id, version.id);
      case 'reject':
        return this.approvalDecisions.reject(ctx, decision.id, version.id);
    }
  }

  /**
   * An owner authority that was issued automatically (onboarding/backfill) rests on an ownership
   * relationship. If that relationship no longer holds (owner membership removed, suspended or
   * stripped of the owner role) the assignment must not stay silently authoritative: the decision is
   * refused. Nothing is revoked automatically — an administrator reviews and revokes explicitly.
   * Manual administrator grants are explicit decisions and are not re-derived from ownership.
   */
  private async assertOwnerAuthorityStillProven(ctx: TenantContext, businessId: string, assignment: ApproverAssignment): Promise<void> {
    if (assignment.assignmentCode !== OWNER_APPROVER_ASSIGNMENT_CODE) return;
    const history = await this.approverAuthority.listProvenance(ctx, assignment.id);
    const lastGrant = [...history].reverse().find((entry) => entry.action === 'grant');
    if (!lastGrant || lastGrant.source === 'manual-admin') return;
    const evidence = await this.ownershipEvidence.loadForBusiness(ctx, businessId);
    if (!provenOwnersOf(evidence).owners.some((owner) => owner.userId === ctx.userId)) {
      throw new ApproverAuthorityNotEstablishedError(
        'the ownership relationship that justified this authority no longer holds; an administrator must review it'
      );
    }
  }

  /**
   * Records an outcome observation against an already-tracked monitored
   * action (not created by this service — see known limitations) and
   * finalizes it. Once recorded, the observation is permanently immutable
   * (enforced by OutcomeObservationRepository / the database trigger).
   */
  async recordOutcome(ctx: TenantContext, businessId: string, input: RecordOutcomeInput): Promise<{ observation: OutcomeObservation; version: OutcomeObservationVersion }> {
    const { observation, version } = await this.outcomeObservations.createObservation(
      ctx, businessId, input.monitoredActionId, input.observationCode, input.summary, input.effectiveAt
    );

    for (const measurement of input.measurements ?? []) {
      await this.outcomeObservations.addMeasurement(ctx, version.id, businessId, measurement.metricCode, measurement.measuredValue, measurement.unit ?? null);
    }
    for (const evidence of input.evidence ?? []) {
      await this.outcomeObservations.addEvidence(ctx, version.id, businessId, evidence.evidenceType, evidence.evidenceReference);
    }

    const recorded = await this.outcomeObservations.record(ctx, observation.id, version.id);
    return { observation: recorded, version };
  }

  private async latestDtSnapshot(ctx: TenantContext, instances: DigitalTwinInstance[]): Promise<DigitalTwinSnapshot | null> {
    for (const instance of instances) {
      const published = await this.dtSnapshots.getPublishedForInstance(ctx, instance.id);
      if (published.length > 0) return published[0];
    }
    return null;
  }

  private async latestSimulationResult(ctx: TenantContext, runs: SimulationRun[]): Promise<SimulationResult | null> {
    for (const run of runs) {
      const published = await this.simResults.getPublishedForRun(ctx, run.id);
      if (published.length > 0) return published[0];
    }
    return null;
  }

  private async latestRecommendation(ctx: TenantContext, cases: DecisionCase[]): Promise<DecisionRecommendation | null> {
    for (const decisionCase of cases) {
      const published = await this.recommendations.getPublishedForCase(ctx, decisionCase.id);
      if (published.length > 0) return published[0];
    }
    return null;
  }

  private async latestApprovalDecision(ctx: TenantContext, reviews: ActionReviewPackage[]): Promise<ApprovalDecision | null> {
    for (const review of reviews) {
      const decided = await this.approvalDecisions.getDecidedForReview(ctx, review.id);
      if (decided.length > 0) return decided[0];
    }
    return null;
  }
}
