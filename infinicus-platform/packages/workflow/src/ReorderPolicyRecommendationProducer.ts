/**
 * ADI producer of the structured recommendation for the first supported action, `inventory_reorder_policy_update@1` (AC-1).
 *
 * OWNERSHIP. This is Intelligence-domain (ADI) work: it authors a recommendation - action type, target, proposed parameters, evidence
 * references, rationale, confidence, risk and validity, provenance. It does NOT approve, authorize, build an AuthorizedActionPackage, write any
 * Business Operations row, write any ABA table, or execute anything. The only things it writes are ADI's own recommendation records (question,
 * case, recommendation version, rationales) through the existing ADI repositories, in one tenant transaction. ABA alone decides, may modify, and
 * owns the final parameters; BO alone executes an issued AuthorizedActionPackage.
 *
 * LOGIC (Block 4: A, deterministic / rule-driven). No LLM and no statistical model is involved, so no number can be invented. The proposal comes
 * from the injected {@link ReorderPolicyDeriverPort}, which applies the owner-approved rule set `inventory-reorder-policy/v1.1.0` (including its
 * PROPOSAL POLICY: unit, step, selection, cap priority - none of which is chosen here) to authoritative Business Operations facts and verifies the
 * candidate with the real evaluator. The same port then has Business Operations record the four evaluation facts of exactly the proposed
 * parameters against exactly those facts; the proposal cites them, so the authoritative baseline is bound to the proposal's lineage.
 * RISK. ADI is not the authoritative risk classifier for this action and no per-action classification exists in P0-2/P0-3 governance: the producer
 * supplies NO risk level, so the existing derivation leaves the recommendation UNCLASSIFIED, which P0-2 treats as high (owner-tier approval). ADI never imports Business Operations: the port is
 * joined at the composition root. If the evidence is missing, stale, ambiguous or inconsistent, or the policy is already compliant, there is NO
 * recommendation and NOTHING is persisted.
 *
 * SIMULATION (Block 5). For this action the governed simulation reference is NOT_APPLICABLE (`NO_APPLICABLE_SIMULATION_MODEL`, owner ruling C-1,
 * canonical contract). The producer neither creates nor attaches a simulation run; it records that applicability in its reasoning.
 *
 * SUPPORTS EXACTLY ONE ACTION. Any other action type is refused (`UNSUPPORTED_ACTION_TYPE`).
 */
import { randomUUID } from 'node:crypto';
import {
  DecisionCaseRepository, DecisionQuestionRepository, DecisionRecommendationRepository, withSharedTenantTransaction, type TenantContext,
} from '@infinicus/database';
import {
  ADI_PROPOSED_ACTION_CONTRACT, BO_EVALUATION_REFERENCE_KIND, BO_FACTS_REFERENCE_KIND, PROPOSED_ACTION_RATIONALE_CODE, SIMULATION_NOT_APPLICABLE_REASON_CODE,
  canonicalBaseRiskClass, proposalEvidenceProblems, validateProposedActionRecommendation, type ProposedActionRecommendation,
} from '@infinicus/handoff-contracts';
import { deriveRiskClass, determineTimeValidity } from './recommendationAuthoring.js';

export const REORDER_PRODUCER_NAME = 'adi-reorder-policy-recommendation-producer';
export const REORDER_PRODUCER_VERSION = '1.1.0';
export const REORDER_ACTION = Object.freeze({ code: 'inventory_reorder_policy_update', schemaVersion: '1' });
/** The one rule-set version this producer is written against (the first version that defines a proposal policy); the deriver refuses any version that is not approved. */
export const REORDER_PRODUCER_RULE_SET_VERSION = 'inventory-reorder-policy/v1.1.0';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ── the port the composition root joins to Business Operations (structural; no BO import) ────────────────────────────────────────────────────
export interface DeriverCandidate {
  outcome: 'CANDIDATE';
  ruleSetVersion: string;
  itemId: string;
  balanceId: string;
  current: { reorderPoint: string; reorderQuantity: string };
  proposed: { reorderPoint: number; reorderQuantity: number };
  bounds: Record<string, string>;
  verification: { dimension: string; result: string }[];
  demand: { count: number; sumOfMagnitudes: string; windowDays: number };
  method: string;
}
export interface DeriverRefusal { outcome: 'NONE'; code: string; detail: string; reasonCodes: string[] }
export interface ReorderPolicyDeriverPort {
  /** READ-ONLY: loads the authoritative facts and derives (or refuses). */
  derive(ctx: TenantContext, request: { businessId: string; itemId: string; ruleSetVersion: string }): Promise<{
    derivation: DeriverCandidate | DeriverRefusal;
    evidence: { snapshotDigest: string; capturedAt: string; windowStartsAt: string; ruleSetVersion: string; evidenceMaxAgeMs: number } | null;
  }>;
  /**
   * Has Business Operations record the evaluation facts of exactly these parameters and prove they were judged against the same snapshot
   * (`snapshotDigest`) and PASSED. The caller runs this inside its transaction and rolls back on a refusal.
   */
  recordBaselineEvidence(ctx: TenantContext, request: {
    businessId: string; itemId: string; ruleSetVersion: string; parameters: { reorderPoint: number; reorderQuantity: number }; snapshotDigest: string; permissionUsed: string;
  }): Promise<{ ok: true; snapshotDigest: string; references: { kind: string; id: string; dimension: string }[] } | { ok: false; code: string; detail: string }>;
}

export type ProduceReorderRecommendationResult =
  | { outcome: 'RECOMMENDED'; recommendationId: string; recommendationVersionId: string; proposal: ProposedActionRecommendation; riskClass: string | null; validUntil: string | null }
  | { outcome: 'NO_RECOMMENDATION'; code: string; detail: string; reasonCodes: string[] };

export interface ReorderPolicyRecommendationProducerDependencies {
  deriver: ReorderPolicyDeriverPort;
  questions: Pick<DecisionQuestionRepository, 'createQuestion'>;
  cases: Pick<DecisionCaseRepository, 'createCase' | 'createVersion' | 'transitionStatus'>;
  recommendations: Pick<DecisionRecommendationRepository, 'createRecommendation' | 'addRationale' | 'validateRecommendation' | 'publishRecommendation'>;
}

const none = (code: string, detail: string, reasonCodes: string[] = []): ProduceReorderRecommendationResult => ({ outcome: 'NO_RECOMMENDATION', code, detail, reasonCodes });

export class ReorderPolicyRecommendationProducer {
  private readonly d: ReorderPolicyRecommendationProducerDependencies;

  constructor(deps: Pick<ReorderPolicyRecommendationProducerDependencies, 'deriver'> & Partial<ReorderPolicyRecommendationProducerDependencies>) {
    this.d = {
      deriver: deps.deriver,
      questions: deps.questions ?? new DecisionQuestionRepository(),
      cases: deps.cases ?? new DecisionCaseRepository(),
      recommendations: deps.recommendations ?? new DecisionRecommendationRepository(),
    };
  }

  /**
   * Produces and publishes the structured recommendation for ONE inventory item, or returns NO_RECOMMENDATION and persists NOTHING (the BO
   * evaluation facts and the ADI records commit together or not at all). `actionType` exists only so an unsupported request is refused explicitly;
   * the producer supports exactly one action. `rc.permissionUsed` is the permission the authenticated route authorized the BO evaluation under.
   */
  async produce(
    ctx: TenantContext,
    request: { businessId: string; itemId: string; actionType?: { code: string; schemaVersion: string } },
    rc: { permissionUsed: string },
  ): Promise<ProduceReorderRecommendationResult> {
    if (typeof request.businessId !== 'string' || !UUID.test(request.businessId)) return none('INVALID_REQUEST', 'businessId must be a lowercase UUID');
    if (typeof request.itemId !== 'string' || !UUID.test(request.itemId)) return none('INVALID_REQUEST', 'itemId must be the inventory item UUID (lowercase)');
    if (typeof rc?.permissionUsed !== 'string' || rc.permissionUsed.length === 0) return none('INVALID_REQUEST', 'the authorizing permission is required for the BO evaluation audit record');
    if (request.actionType !== undefined && (request.actionType.code !== REORDER_ACTION.code || request.actionType.schemaVersion !== REORDER_ACTION.schemaVersion)) {
      return none('UNSUPPORTED_ACTION_TYPE', `this producer supports only ${REORDER_ACTION.code}@${REORDER_ACTION.schemaVersion}`);
    }

    // One tenant transaction around everything that is read for, or written because of, the proposal. A refusal found after BO has appended its
    // evaluation facts is thrown out of the callback so those facts roll back with it.
    try {
      return await withSharedTenantTransaction(ctx, async () => {
        // 1. authoritative evidence + deterministic derivation (read-only, tenant scoped by ctx).
        const result = await this.d.deriver.derive(ctx, { businessId: request.businessId, itemId: request.itemId, ruleSetVersion: REORDER_PRODUCER_RULE_SET_VERSION });
        const derivation = result.derivation;
        if (derivation.outcome !== 'CANDIDATE') return none(derivation.code, derivation.detail, derivation.reasonCodes);
        const evidence = result.evidence;
        if (evidence === null || evidence.ruleSetVersion !== REORDER_PRODUCER_RULE_SET_VERSION || derivation.ruleSetVersion !== REORDER_PRODUCER_RULE_SET_VERSION) {
          return none('EVIDENCE_UNAVAILABLE', 'the derivation carries no evidence digest for the approved rule set');
        }
        if (derivation.itemId !== request.itemId) return none('TARGET_MISMATCH', 'the derivation is for a different target than the one requested');
        if (derivation.verification.length === 0 || derivation.verification.some((v) => v.result !== 'PASSED')) return none('DERIVATION_UNVERIFIED', 'the candidate is not verified against every governance dimension');

        // 2. BO records the evaluation facts of EXACTLY these parameters against EXACTLY these facts: the authoritative baseline, bound to the proposal.
        const recorded = await this.d.deriver.recordBaselineEvidence(ctx, {
          businessId: request.businessId, itemId: request.itemId, ruleSetVersion: REORDER_PRODUCER_RULE_SET_VERSION,
          parameters: { reorderPoint: derivation.proposed.reorderPoint, reorderQuantity: derivation.proposed.reorderQuantity },
          snapshotDigest: evidence.snapshotDigest, permissionUsed: rc.permissionUsed,
        });
        if (!recorded.ok) throw new RefusedAfterWrites(none(recorded.code, recorded.detail));
        if (recorded.snapshotDigest !== evidence.snapshotDigest) throw new RefusedAfterWrites(none('EVIDENCE_CHANGED', 'the recorded evaluation used different facts than the derivation'));

        // 3. the structured, contract-validated proposal.
        const producedAt = new Date().toISOString();
        const proposal: ProposedActionRecommendation = {
          contract: ADI_PROPOSED_ACTION_CONTRACT,
          actionType: { code: REORDER_ACTION.code, schemaVersion: REORDER_ACTION.schemaVersion },
          target: { kind: 'inventory_item', id: request.itemId },
          proposedParameters: { reorderPoint: derivation.proposed.reorderPoint, reorderQuantity: derivation.proposed.reorderQuantity },
          currentState: {
            reference: { kind: 'bo_inventory_balance', id: derivation.balanceId },
            parameters: { reorderPoint: derivation.current.reorderPoint, reorderQuantity: derivation.current.reorderQuantity },
          },
          evidenceReferences: [
            { kind: BO_FACTS_REFERENCE_KIND, id: derivation.balanceId, digest: evidence.snapshotDigest },
            ...recorded.references.map((r) => ({ kind: BO_EVALUATION_REFERENCE_KIND, id: r.id, dimension: r.dimension, digest: recorded.snapshotDigest })),
          ],
          reasoning: {
            summary: `The current reorder policy (${derivation.current.reorderPoint} / ${derivation.current.reorderQuantity}) does not satisfy rule set ${evidence.ruleSetVersion}; the proposal is the smallest whole-unit single step that does.`,
            basis: [
              `Average daily demand uses ${derivation.demand.count} issue movement(s) totalling ${derivation.demand.sumOfMagnitudes} over ${derivation.demand.windowDays} days (database clock ${evidence.capturedAt}).`,
              `The proposal was chosen within these whole-unit bounds: ${JSON.stringify(derivation.bounds)}, using the proposal policy of rule set ${evidence.ruleSetVersion}.`,
              `Business Operations recorded its evaluation of exactly these parameters against exactly these facts (cited as evidence): ${derivation.verification.map((v) => `${v.dimension}=${v.result}`).join(', ')}.`,
              `Simulation is NOT_APPLICABLE for this action (${SIMULATION_NOT_APPLICABLE_REASON_CODE}); no simulation was fabricated.`,
              'The rule-set values are owner-defined pre-launch policy values, not data-derived; Approved Business Action decides whether to approve, modify or reject.',
            ],
          },
          confidence: {
            kind: 'RULE_COMPLIANCE', value: null,
            statement: 'Deterministic satisfaction of the owner-approved rule set on the cited facts. This is not a statistical forecast of business benefit.',
          },
          constraints: { ruleSetVersion: evidence.ruleSetVersion, bounds: derivation.bounds, method: derivation.method, windowDays: derivation.demand.windowDays },
          provenance: { producer: REORDER_PRODUCER_NAME, producerVersion: REORDER_PRODUCER_VERSION, method: 'DETERMINISTIC_RULE', ruleSetVersion: evidence.ruleSetVersion, producedAt },
        };
        const problems = [...validateProposedActionRecommendation(proposal), ...proposalEvidenceProblems(proposal)];
        if (problems.length > 0) throw new RefusedAfterWrites(none('PRODUCER_CONTRACT_VIOLATION', problems.join('; ')));

        // 4. risk and validity. ADI is not a risk classifier: the base class is read from the canonical action-type governance (owner ruling, AC-2)
        // and enters the existing P0-3 derivation as a deterministic floor; ADI supplies no level of its own. Validity follows the evidence.
        const risk = deriveRiskClass({ canonicalBaseRisk: canonicalBaseRiskClass(REORDER_ACTION.code, REORDER_ACTION.schemaVersion) });
        const validity = determineTimeValidity({
          evaluated: { evidenceExpiry: true, forecastHorizon: true, actionWindow: true, policy: true, otherAuthoritativePeriod: true },
          evidenceExpiries: [new Date(Date.parse(evidence.capturedAt) + evidence.evidenceMaxAgeMs)],
        });
        if (validity.error) throw new RefusedAfterWrites(none('VALIDITY_UNDETERMINED', validity.error));

        // 5. ADI's own records, in the same transaction: nothing is published unless everything succeeded.
        const stamp = randomUUID().slice(0, 12);
        const summary = `Set reorder point to ${proposal.proposedParameters.reorderPoint} and reorder quantity to ${proposal.proposedParameters.reorderQuantity} for inventory item ${request.itemId}`;
        const question = await this.d.questions.createQuestion(ctx, request.businessId, `adi-reorder-q-${stamp}`, `Should the reorder policy of inventory item ${request.itemId} change?`);
        const decisionCase = await this.d.cases.createCase(ctx, request.businessId, question.id, `adi-reorder-case-${stamp}`);
        await this.d.cases.createVersion(ctx, decisionCase.id, request.businessId, proposal.reasoning.summary);
        await this.d.cases.transitionStatus(ctx, decisionCase.id, 'recommended', 'rule-derived recommendation (AC-1)');
        const { recommendation, version } = await this.d.recommendations.createRecommendation(
          ctx, request.businessId, decisionCase.id, `adi-reorder-rec-${stamp}`, summary, undefined,
          { riskClass: risk.riskClass, isTimeSensitive: validity.isTimeSensitive, validUntil: validity.validUntil },
        );
        // First rationale = the human-readable basis the decision-history view shows (it reads the earliest rationale: statement + expectedOutcome).
        await this.d.recommendations.addRationale(ctx, version.id, request.businessId, 'reorder_policy_basis', proposal.reasoning.summary, {
          expectedOutcome: 'The reorder policy satisfies the owner-approved rule set for stock-out protection, cover, order value and change size.',
        });
        await this.d.recommendations.addRationale(ctx, version.id, request.businessId, PROPOSED_ACTION_RATIONALE_CODE, proposal.reasoning.summary, proposal as unknown as Record<string, unknown>);
        await this.d.recommendations.addRationale(ctx, version.id, request.businessId, 'risk_validity_basis', 'How the risk class and time-sensitivity were determined', {
          riskClass: risk.riskClass, riskBasis: risk.basis, isTimeSensitive: validity.isTimeSensitive, validityBasis: validity.basis,
          riskAuthority: 'The base risk class is canonical action-type governance (handoff-contracts canonical-actions); ADI is not a risk classifier. P0-2/P0-3 contextual evidence can only raise it.',
        });
        await this.d.recommendations.validateRecommendation(ctx, recommendation.id, version.id);
        await this.d.recommendations.publishRecommendation(ctx, recommendation.id, version.id);
        return {
          outcome: 'RECOMMENDED' as const, recommendationId: recommendation.id, recommendationVersionId: version.id, proposal,
          riskClass: risk.riskClass, validUntil: validity.validUntil ? validity.validUntil.toISOString() : null,
        };
      });
    } catch (e) {
      if (e instanceof RefusedAfterWrites) return e.result;
      throw e;
    }
  }
}

/** Thrown inside the transaction callback to roll back BO's evaluation facts together with a refusal found after they were written. */
class RefusedAfterWrites extends Error {
  constructor(readonly result: ProduceReorderRecommendationResult) { super('rolled back'); }
}
