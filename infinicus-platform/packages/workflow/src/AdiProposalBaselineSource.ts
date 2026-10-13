/**
 * The ADI side of the PLAIN-approval baseline port that Business Operations defines (`ApprovedProposalBaselineSource`; owner ruling 1 of the
 * AC-1 corrections). Given the recommendation an unchanged approval accepted, it returns the BO evaluation record REFERENCES that the stored ADI
 * proposal cites - and only if that proposal is in the same business and is exactly the action, target and parameters being executed. It returns
 * references only; Business Operations reads and judges the records itself. Read-only. Satisfies the BO interface STRUCTURALLY, so this package
 * never imports Business Operations; the two are joined at the composition roots.
 */
import type { TenantContext } from '@infinicus/database';
import { boEvaluationReferences, proposalMatchesCapture, type JsonValue } from '@infinicus/handoff-contracts';
import { AdiProposedActionSource, type ProposedActionSource } from './ProposedActionSource.js';

export class AdiProposalBaselineSource {
  constructor(private readonly proposals: ProposedActionSource = new AdiProposedActionSource()) {}

  async evaluationReferencesFor(ctx: TenantContext, request: {
    businessId: string; recommendationId: string; actionType: { code: string; schemaVersion: string }; target: { kind: string; id: string }; parameters: Record<string, JsonValue>;
  }): Promise<{ kind: string; id: string; dimension: string }[]> {
    const stored = await this.proposals.getForRecommendation(ctx, request.recommendationId);
    if (stored === null) return [];
    if (stored.tenantId !== ctx.tenantId || stored.workspaceId !== ctx.workspaceId || stored.businessId !== request.businessId) return [];
    if (proposalMatchesCapture(stored.proposal, { actionType: request.actionType, target: request.target, proposedParameters: request.parameters }).length > 0) return [];
    return boEvaluationReferences(stored.proposal);
  }
}
