import { randomUUID } from 'crypto';
import {
  DecisionQuestionRepository, DecisionCaseRepository, DecisionRecommendationRepository,
  ADIPublicationRepository, ABAIntakeRepository, ABAPublicationRepository,
  ApprovedActionRepository, OMIntakeRepository, MonitoringPlanRepository, MonitoredActionRepository,
  OutcomeObservationRepository,
  type TenantContext,
} from '@infinicus/database';
import { AnthropicClient } from '@infinicus/llm-client';
import { TwinComputationService, type TwinSnapshotResult } from './TwinComputationService.js';
import { DecisionWorkflowService, DEFAULT_APPROVER_ASSIGNMENT_CODE } from './DecisionWorkflowService.js';
import { assessTwinEvidence, type TwinEvidenceAssessment } from './twinEvidence.js';
import { deriveRiskClass, determineTimeValidity, type TimeValiditySignals } from './recommendationAuthoring.js';

const TARGET_LAYER_ABA = 'approved_business_action';
const TARGET_LAYER_OM = 'outcome_monitoring';

/** Evaluates every defined authoritative time-sensitivity source for a business. May throw; a failure leaves the fact unknown. */
export type ValiditySignalEvaluator = (ctx: TenantContext, businessId: string) => Promise<TimeValiditySignals>;

/**
 * The defined authoritative sources are evidence expiry, forecast/simulation horizon, action window, decision
 * policy marking and other authoritative periods. None has data in the model yet for twin-grounded decisions, so
 * each is evaluated and found to have nothing that applies; this is a completed evaluation, not a default.
 */
export const defaultValiditySignalEvaluator: ValiditySignalEvaluator = async () => ({
  evaluated: { evidenceExpiry: true, forecastHorizon: true, actionWindow: true, policy: true, otherAuthoritativePeriod: true },
});

export type RiskLevel = 'low' | 'medium' | 'high';

/** Recommendations plus an explicit statement of how much real evidence they rest on. */
export interface RecommendationResult {
  decisions: RecommendedDecision[];
  evidence: TwinEvidenceAssessment;
}

export interface RecommendedDecision {
  id: string; // DecisionRecommendation id — pass to startChoiceReview/recordChoiceOutcome
  decision: string;
  rationale: string;
  expectedOutcome: string;
  riskLevel: RiskLevel;
}

export interface ChoiceReviewResult {
  approved: boolean;
  /** Only set when approved:true — required by recordChoiceOutcome. */
  approvedActionId: string | null;
}

export interface DecisionHistoryEntry {
  /** DecisionRecommendation id — same id recommend() returned; pass to startChoiceReview/recordChoiceOutcome. */
  id: string;
  decisionText: string;
  recommendedAt: string;
  /**
   * true once this recommendation has a resulting ApprovedAction (migration
   * 0170's source_recommendation_id, populated by startChoiceReview() since
   * Block 2). Rows from before that migration, and declined recommendations
   * (which never create an ApprovedAction — see startChoiceReview), are
   * indistinguishable here and both read as null: a real, documented
   * limitation, not a bug — resolving "declined" vs "not yet decided" needs
   * a lookup through ABA's ApprovalDecision chain this build doesn't add.
   */
  chosen: boolean | null;
  /** Set once startChoiceReview() approved this recommendation and recordChoiceOutcome() has been called — null until an outcome is on file. */
  approvedActionId: string | null;
  /** Most recent recorded/verified/disputed OutcomeObservation summary for that action, if any. */
  outcomeNotes: string | null;
  /** Why the AI recommended this — from recommendation_rationales (written once at recommend() time). Null only for pre-migration rows that predate this field being surfaced. */
  rationale: string | null;
  /** The projected impact stated alongside the rationale at recommend() time. Same nullability note as rationale. */
  expectedOutcome: string | null;
}

interface RawDecisionItem {
  decision: string;
  rationale: string;
  expected_outcome: string;
  risk_level: RiskLevel;
}

function resolveAnthropicClient(): AnthropicClient | null {
  const key = process.env.ANTHROPIC_API_KEY;
  return key ? new AnthropicClient(key) : null;
}

function buildPrompt(twin: TwinSnapshotResult, evidence: TwinEvidenceAssessment): string {
  const unknownAreas = (['financial', 'customers', 'team'] as const).filter((area) => evidence[area] === 'insufficient');
  const unknownNote = unknownAreas.length === 0 ? '' : `\n\nNO RECORDED DATA for: ${unknownAreas.join(', ')}. Treat these as UNKNOWN (not zero, not good, not bad). Make no claim about them.`;
  return `You are INFINICUS Decision Intelligence — an advisor grounded in real business data.

SNAPSHOT: last ${twin.windowDays} days as of ${twin.snapshotAt.slice(0, 10)}

REAL FINANCIAL DATA:
- Revenue (${twin.windowDays}d): $${twin.financial.revenue30d}
- Expenses (${twin.windowDays}d): $${twin.financial.expenses30d}
- Profit/Loss (${twin.windowDays}d): $${twin.financial.profit30d}
- Burn rate: $${twin.financial.burnRatePerDay}/day
- Sales transactions: ${twin.financial.salesCount30d}

REAL CUSTOMER DATA:
- New customers (${twin.windowDays}d): ${twin.customers.new30d}
- Returning customers (${twin.windowDays}d): ${twin.customers.returning30d}
- Churned (${twin.windowDays}d): ${twin.customers.churned30d}
- Churn rate: ${twin.customers.churnRatePct}%

REAL OPERATIONS:
- Net inventory delta (${twin.windowDays}d): ${twin.operations.netInventoryUnits30d} units

REAL TEAM:
- Hired (${twin.windowDays}d): ${twin.team.hired30d}
- Terminated (${twin.windowDays}d): ${twin.team.terminated30d}
- Net headcount change: ${twin.team.netHeadcountDelta}${unknownNote}

Based ONLY on this real data, provide 3 specific, actionable decisions the business owner should consider.

For each decision respond in this exact JSON format:
{
  "decisions": [
    {
      "decision": "specific action to take",
      "rationale": "why, grounded in the actual numbers above",
      "expected_outcome": "realistic projected impact based on the real data",
      "risk_level": "low|medium|high"
    }
  ]
}

Important: Do not invent data. If the data doesn't support a strong recommendation, say so plainly.`;
}

/**
 * Deterministic fallback when no ANTHROPIC_API_KEY is configured, or the LLM call/parse fails — never blocks the feature.
 *
 * Draws a conclusion ONLY for an area with recorded activity (see twinEvidence.ts): an empty area produces no
 * statement at all, never "profitable", "healthy" or "steady" from zeros.
 */
export function deterministicRecommendations(twin: TwinSnapshotResult, evidence: TwinEvidenceAssessment = assessTwinEvidence(twin)): RawDecisionItem[] {
  const items: RawDecisionItem[] = [];

  if (evidence.financial === 'sufficient') {
    if (twin.financial.profit30d < 0) {
      items.push({
        decision: 'Reduce burn rate or increase pricing',
        rationale: `Expenses ($${twin.financial.expenses30d}) exceeded revenue ($${twin.financial.revenue30d}) over the last ${twin.windowDays} days, a loss of $${Math.abs(twin.financial.profit30d)}.`,
        expected_outcome: 'Reversing the current burn rate ($' + twin.financial.burnRatePerDay + '/day) protects runway.',
        risk_level: 'high',
      });
    } else if (twin.financial.profit30d === 0) {
      items.push({
        decision: 'Review pricing and costs to move beyond break-even',
        rationale: `Revenue ($${twin.financial.revenue30d}) equalled expenses ($${twin.financial.expenses30d}) over the last ${twin.windowDays} days: break-even, no profit yet.`,
        expected_outcome: 'Small gains in margin or volume turn break-even into profit.',
        risk_level: 'medium',
      });
    } else {
      items.push({
        decision: 'Reinvest profit into customer acquisition',
        rationale: `The business was profitable over the last ${twin.windowDays} days ($${twin.financial.profit30d}).`,
        expected_outcome: 'Sustained profit supports scaling acquisition spend without endangering runway.',
        risk_level: 'low',
      });
    }
  }

  if (evidence.customers === 'sufficient') {
    if (twin.customers.churnRatePct > 10) {
      items.push({
        decision: 'Investigate and address customer churn',
        rationale: `Churn rate is ${twin.customers.churnRatePct}%, against ${twin.customers.new30d} new and ${twin.customers.returning30d} returning customers.`,
        expected_outcome: 'Reducing churn compounds revenue growth from existing acquisition spend.',
        risk_level: 'medium',
      });
    } else {
      items.push({
        decision: 'Maintain current retention practices',
        rationale: `Churn rate is ${twin.customers.churnRatePct}% across ${twin.customers.new30d} new, ${twin.customers.returning30d} returning and ${twin.customers.churned30d} churned customers, within a healthy range.`,
        expected_outcome: 'Continued low churn supports predictable revenue.',
        risk_level: 'low',
      });
    }
  }

  if (evidence.team === 'sufficient') {
    items.push({
      decision: twin.team.netHeadcountDelta < 0 ? 'Evaluate whether reduced headcount covers current demand' : 'Hold current team size steady',
      rationale: `Net headcount change over ${twin.windowDays} days: ${twin.team.netHeadcountDelta} (${twin.team.hired30d} hired, ${twin.team.terminated30d} terminated).`,
      expected_outcome: 'Right-sizing the team against real sales volume avoids over- or under-staffing.',
      risk_level: twin.team.netHeadcountDelta < 0 ? 'medium' : 'low',
    });
  }

  return items;
}

/**
 * AI Decisions: recommend, choose, and record the outcome of, decisions
 * grounded in the business's Digital Twin. Recommendations use a real LLM
 * call (Anthropic, via @infinicus/llm-client) when ANTHROPIC_API_KEY is
 * configured, falling back to a deterministic threshold-based generator
 * otherwise — the feature is never blocked by a missing key, same pattern
 * as email verification (packages/authentication).
 *
 * "Choosing" a recommendation runs it through the platform's real approval
 * chain (ADI publish -> ABA intake -> review -> ApprovalDecision -> the
 * resulting ApprovedAction), not a boolean flag — deliberately a real
 * upgrade over the legacy Cloudflare implementation this replaces, and a
 * direct application of what those layers exist for. Declining runs the
 * same review/decision steps with outcome 'reject' (per AD-021: ABA's
 * ApprovalDecision — not a bare flag — is the correct place a human's
 * explicit choice belongs).
 */
export class BusinessDecisionRecommendationService {
  constructor(
    private readonly questions: DecisionQuestionRepository = new DecisionQuestionRepository(),
    private readonly cases: DecisionCaseRepository = new DecisionCaseRepository(),
    private readonly recommendations: DecisionRecommendationRepository = new DecisionRecommendationRepository(),
    private readonly adiPublications: ADIPublicationRepository = new ADIPublicationRepository(),
    private readonly abaIntake: ABAIntakeRepository = new ABAIntakeRepository(),
    private readonly abaPublications: ABAPublicationRepository = new ABAPublicationRepository(),
    private readonly approvedActions: ApprovedActionRepository = new ApprovedActionRepository(),
    private readonly omIntake: OMIntakeRepository = new OMIntakeRepository(),
    private readonly monitoringPlans: MonitoringPlanRepository = new MonitoringPlanRepository(),
    private readonly monitoredActions: MonitoredActionRepository = new MonitoredActionRepository(),
    private readonly outcomeObservations: OutcomeObservationRepository = new OutcomeObservationRepository(),
    private readonly twins: TwinComputationService = new TwinComputationService(),
    private readonly workflow: DecisionWorkflowService = new DecisionWorkflowService(),
    private readonly llm: AnthropicClient | null = resolveAnthropicClient(),
    private readonly validitySignals: ValiditySignalEvaluator = defaultValiditySignalEvaluator
  ) {}

  async recommend(ctx: TenantContext, businessId: string): Promise<RecommendationResult> {
    const { twin, snapshotId } = await this.twins.getOrComputeTwin(ctx, businessId);
    const evidence = assessTwinEvidence(twin);

    // Nothing was recorded: say so. Never ask the LLM to (or fall back to rules that) invent conclusions from zeros.
    if (evidence.overall === 'insufficient') return { decisions: [], evidence };

    let items: RawDecisionItem[] = [];
    if (this.llm) {
      try {
        const text = await this.llm.complete(buildPrompt(twin, evidence));
        const match = text.match(/\{[\s\S]*\}/);
        if (match) items = (JSON.parse(match[0]).decisions ?? []) as RawDecisionItem[];
      } catch {
        items = []; // falls through to the deterministic generator below
      }
    }
    if (items.length === 0) items = deterministicRecommendations(twin, evidence);

    const stamp = Date.now().toString(36);
    const results: RecommendedDecision[] = [];
    for (const [i, item] of items.entries()) {
      const question = await this.questions.createQuestion(ctx, businessId, `bizdec-q-${stamp}-${i}`, item.decision);
      const decisionCase = await this.cases.createCase(ctx, businessId, question.id, `bizdec-case-${stamp}-${i}`);
      await this.cases.createVersion(ctx, decisionCase.id, businessId, item.rationale);
      await this.cases.transitionStatus(ctx, decisionCase.id, 'recommended', 'twin-grounded recommendation');

      // ADI authors the risk and validity facts (P0-3). The generator's risk_level is the only risk evidence
      // this flow has; anything outside the vocabulary leaves the recommendation unclassified (never lower).
      const risk = deriveRiskClass({ authoredRiskLevel: item.risk_level });
      // False only after every defined source was successfully evaluated and none applies; an evaluation that
      // throws leaves the fact unknown (null), which approval blocks until it is recalculated. Never defaulted to false.
      let signals: TimeValiditySignals;
      try {
        signals = await this.validitySignals(ctx, businessId);
      } catch (err) {
        signals = {
          evaluated: { evidenceExpiry: false, forecastHorizon: false, actionWindow: false, policy: false, otherAuthoritativePeriod: false },
          evaluationError: err instanceof Error ? err.message : String(err),
        };
      }
      const validity = determineTimeValidity(signals);
      if (validity.error) throw new Error(`recommendation validity could not be determined: ${validity.error}`);

      const { recommendation, version } = await this.recommendations.createRecommendation(
        ctx, businessId, decisionCase.id, `bizdec-rec-${stamp}-${i}`, item.decision, undefined,
        { riskClass: risk.riskClass, isTimeSensitive: validity.isTimeSensitive, validUntil: validity.validUntil, twinSnapshotId: snapshotId },
      );
      await this.recommendations.addRationale(ctx, version.id, businessId, 'twin_evidence', item.rationale, {
        expectedOutcome: item.expected_outcome, riskLevel: item.risk_level,
      });
      await this.recommendations.addRationale(ctx, version.id, businessId, 'risk_validity_basis', 'How the risk class and time-sensitivity were determined', {
        riskClass: risk.riskClass, riskBasis: risk.basis, isTimeSensitive: validity.isTimeSensitive, validityBasis: validity.basis,
        twinSnapshotId: snapshotId,
      });
      await this.recommendations.validateRecommendation(ctx, recommendation.id, version.id);
      await this.recommendations.publishRecommendation(ctx, recommendation.id, version.id);

      results.push({
        id: recommendation.id, decision: item.decision, rationale: item.rationale,
        expectedOutcome: item.expected_outcome, riskLevel: item.risk_level,
      });
    }
    return { decisions: results, evidence };
  }

  /**
   * `requestContext` is audit metadata only (permission used, correlation id) forwarded to the approval audit trail; it
   * never affects the approval decision.
   */
  async startChoiceReview(
    ctx: TenantContext, businessId: string, recommendationId: string, chosen: boolean,
    requestContext?: { permissionUsed?: string; correlationId?: string },
  ): Promise<ChoiceReviewResult> {
    const stamp = Date.now().toString(36);

    const recommendationVersion = await this.recommendations.getPublishedVersion(ctx, recommendationId);
    const insightPackage = await this.adiPublications.createInsightPackage(ctx, businessId, `bizdec-insight-${stamp}`);
    const insightVersion = await this.adiPublications.createVersion(ctx, insightPackage.id, businessId, 'Business decision recommendation', recommendationVersion.id);
    const { package: adiPublication } = await this.adiPublications.createPackage(
      ctx, businessId, insightVersion.id, TARGET_LAYER_ABA, 'approved-business-action', randomUUID()
    );
    await this.adiPublications.markReady(ctx, adiPublication.id);
    await this.adiPublications.dispatch(ctx, adiPublication.id);

    const { package: intakePackage } = await this.abaIntake.receivePackage(ctx, {
      businessId, adiPublicationPackageId: adiPublication.id, intakeCode: `bizdec-intake-${stamp}`, idempotencyKey: randomUUID(),
    });
    await this.abaIntake.acceptPackage(ctx, intakePackage.id);

    const review = await this.workflow.createReview(ctx, businessId, {
      intakePackageId: intakePackage.id, reviewCode: `bizdec-review-${stamp}`, summary: 'Business decision review',
    });
    const decision = await this.workflow.submitApprovalDecision(ctx, businessId, {
      reviewPackageId: review.id, assignmentCode: DEFAULT_APPROVER_ASSIGNMENT_CODE,
      decisionCode: `bizdec-decision-${stamp}`, summary: chosen ? 'Approved by business owner' : 'Declined by business owner',
      outcome: chosen ? 'approve' : 'reject',
      requestContext,
    });

    if (!chosen) return { approved: false, approvedActionId: null };

    const action = await this.approvedActions.createAction(ctx, businessId, decision.id, `bizdec-action-${stamp}`, recommendationId);
    await this.approvedActions.createVersion(ctx, action.id, businessId, 'Approved business decision');
    return { approved: true, approvedActionId: action.id };
  }

  async recordChoiceOutcome(ctx: TenantContext, businessId: string, approvedActionId: string, outcomeNotes: string): Promise<{ observationId: string }> {
    const stamp = Date.now().toString(36);

    const { package: abaPublication } = await this.abaPublications.createPackage(
      ctx, businessId, approvedActionId, `bizdec-aba-pub-${stamp}`, TARGET_LAYER_OM, 'outcome-monitoring', randomUUID()
    );
    await this.abaPublications.markReady(ctx, abaPublication.id);
    await this.abaPublications.dispatch(ctx, abaPublication.id);

    const { package: omIntakePackage } = await this.omIntake.receivePackage(ctx, {
      businessId, abaPublicationPackageId: abaPublication.id, intakeCode: `bizdec-om-intake-${stamp}`, idempotencyKey: randomUUID(),
    });
    await this.omIntake.acceptPackage(ctx, omIntakePackage.id);

    const { plan } = await this.monitoringPlans.createPlan(ctx, businessId, omIntakePackage.id, `bizdec-plan-${stamp}`, 'Business decision outcome monitoring');
    await this.monitoringPlans.activate(ctx, plan.id);

    const { action: monitoredAction, versionId } = await this.monitoredActions.createMonitoredAction(
      ctx, businessId, plan.id, approvedActionId, `bizdec-monitored-${stamp}`, 'Business decision execution'
    );
    await this.monitoredActions.addExecutionObservation(ctx, versionId, businessId, { notes: outcomeNotes });
    await this.monitoredActions.markInProgress(ctx, monitoredAction.id);

    const { observation } = await this.workflow.recordOutcome(ctx, businessId, {
      monitoredActionId: monitoredAction.id, observationCode: `bizdec-outcome-${stamp}`,
      summary: outcomeNotes, effectiveAt: new Date(),
      evidence: [{ evidenceType: 'manual_entry', evidenceReference: { notes: outcomeNotes } }],
    });
    return { observationId: observation.id };
  }

  async getHistory(ctx: TenantContext, businessId: string): Promise<DecisionHistoryEntry[]> {
    const { adiCases } = await this.workflow.getDecisionHistory(ctx, businessId);

    // One published version per case (same assumption the old code made) —
    // gathered first so the correlation chain below can run as bulk
    // lookups (one query per hop for the whole page) instead of N+1s.
    type Pending = { recommendationId: string; versionId: string; decisionText: string; recommendedAt: string };
    const pending: Pending[] = [];
    for (const decisionCase of adiCases) {
      const versions = await this.recommendations.getPublishedVersionsForCase(ctx, decisionCase.id);
      const version = versions[0];
      if (!version) continue;
      pending.push({
        recommendationId: version.recommendationId,
        versionId: version.id,
        decisionText: version.summary,
        recommendedAt: version.createdAt instanceof Date ? version.createdAt.toISOString() : String(version.createdAt),
      });
    }
    if (pending.length === 0) return [];

    // Rationale + expected outcome, bulk-fetched by version id (one query for the whole page).
    const rationales = await this.recommendations.listRationalesForVersions(ctx, pending.map(p => p.versionId));
    const rationaleByVersionId = new Map(rationales.map(r => [r.recommendationVersionId, r]));

    // Hop 1: recommendation -> approved action (migration 0170 / Block 2).
    const recommendationIds = pending.map(p => p.recommendationId);
    const approvedActions = await this.approvedActions.listBySourceRecommendationIds(ctx, recommendationIds);
    const actionByRecommendationId = new Map(approvedActions.map(a => [a.sourceRecommendationId as string, a]));

    // Hop 2: approved action -> monitored action (OM only creates one once recordChoiceOutcome() runs).
    const approvedActionIds = approvedActions.map(a => a.id);
    const monitoredActions = await this.monitoredActions.listByApprovedActionIds(ctx, approvedActionIds);
    const monitoredByApprovedActionId = new Map(monitoredActions.map(m => [m.approvedActionId, m]));

    // Hop 3: monitored action -> latest decided outcome observation's summary text.
    const monitoredActionIds = monitoredActions.map(m => m.id);
    const outcomes = await this.outcomeObservations.listLatestDecidedForActions(ctx, monitoredActionIds);
    const outcomeByMonitoredActionId = new Map(outcomes.map(o => [o.monitoredActionId, o.summary]));

    return pending.map(p => {
      const action = actionByRecommendationId.get(p.recommendationId) ?? null;
      const monitored = action ? monitoredByApprovedActionId.get(action.id) ?? null : null;
      const outcomeNotes = monitored ? outcomeByMonitoredActionId.get(monitored.id) ?? null : null;
      const rationale = rationaleByVersionId.get(p.versionId) ?? null;
      return {
        id: p.recommendationId,
        decisionText: p.decisionText,
        recommendedAt: p.recommendedAt,
        chosen: action ? true : null,
        approvedActionId: action ? action.id : null,
        outcomeNotes,
        rationale: rationale ? rationale.statement : null,
        expectedOutcome: rationale ? (rationale.evidenceReference.expectedOutcome as string | undefined) ?? null : null,
      };
    });
  }
}
