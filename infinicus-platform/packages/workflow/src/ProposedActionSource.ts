/**
 * Reads the structured ADI proposal (AC-1) of a recommendation, for ABA's capture check. A narrow ADI-owned read; it writes nothing.
 * `null` means the recommendation carries no structured proposal (a narrative-only or legacy recommendation). A proposal that exists but is
 * malformed, or that appears more than once, is an ERROR: it is never silently ignored (fail closed).
 */
import { DecisionRecommendationNotFoundError, DecisionRecommendationRepository, type TenantContext } from '@infinicus/database';
import { PROPOSED_ACTION_RATIONALE_CODE, validateProposedActionRecommendation, type ProposedActionRecommendation } from '@infinicus/handoff-contracts';

export class ProposedActionIntegrityError extends Error {
  constructor(readonly recommendationId: string, detail: string) {
    super(`ADI proposed action of recommendation ${recommendationId} is unusable: ${detail}`);
    this.name = 'ValidationError';
  }
}

export interface ProposedActionSource {
  getForRecommendation(ctx: TenantContext, recommendationId: string): Promise<ProposedActionRecommendation | null>;
}

export class AdiProposedActionSource implements ProposedActionSource {
  constructor(private readonly recommendations: Pick<DecisionRecommendationRepository, 'getPublishedVersion' | 'listRationalesByCode'> = new DecisionRecommendationRepository()) {}

  async getForRecommendation(ctx: TenantContext, recommendationId: string): Promise<ProposedActionRecommendation | null> {
    let version: Awaited<ReturnType<DecisionRecommendationRepository['getPublishedVersion']>>;
    try { version = await this.recommendations.getPublishedVersion(ctx, recommendationId); }
    catch (e) { if (e instanceof DecisionRecommendationNotFoundError) return null; throw e; } // no published version: no structured proposal exists to compare
    const rows = await this.recommendations.listRationalesByCode(ctx, version.id, PROPOSED_ACTION_RATIONALE_CODE);
    if (rows.length === 0) return null;
    if (rows.length > 1) throw new ProposedActionIntegrityError(recommendationId, 'more than one structured proposal is recorded');
    const problems = validateProposedActionRecommendation(rows[0].evidenceReference);
    if (problems.length > 0) throw new ProposedActionIntegrityError(recommendationId, problems.join('; '));
    return rows[0].evidenceReference as unknown as ProposedActionRecommendation;
  }
}
