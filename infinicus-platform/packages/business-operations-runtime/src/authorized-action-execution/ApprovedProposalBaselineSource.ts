/**
 * Port (AC-1 corrections, owner ruling 1): where BO finds the AUTHORITATIVE BASELINE of a PLAIN approval - an approval of an ADI proposal
 * without modification. A modified approval carries BO's own evaluation records in its governed lineage; a plain approval cannot (the capture
 * contract allows no evaluation on it), so the baseline is bound through the proposal instead: the ADI proposal the approval accepted cites the BO
 * evaluation records that were recorded for exactly its parameters, against exactly the facts it was derived from.
 *
 * The source only returns REFERENCES. Business Operations then reads those records itself, verifies that each is BO's own immutable record bound
 * to this target and to exactly these parameters (subject digest), PASSED, produced under an approved rule set, and that all of them agree on one
 * balance snapshot - and only then uses that snapshot as the compare-and-set baseline. A missing, unreadable or inconsistent answer is
 * NO_BASELINE_EVIDENCE; the baseline is never taken from the caller, the approval text or the live balance. BO imports no ADI or ABA code: the
 * implementation is joined at the composition roots.
 */
import type { TenantContext } from '@infinicus/database';
import type { JsonValue } from '@infinicus/handoff-contracts';

export interface ApprovedProposalBaselineRequest {
  businessId: string;
  /** The ADI recommendation the approved proposal came from (`lineage.proposedParameters.source.recordId`). */
  recommendationId: string;
  actionType: { code: string; schemaVersion: string };
  target: { kind: string; id: string };
  /** The parameters the plain approval authorizes (equal to the ADI proposal's). */
  parameters: Record<string, JsonValue>;
}

export interface ApprovedProposalBaselineSource {
  /** BO evaluation record references cited by the ADI proposal, or an empty list when there is none. Never throws for "not found". */
  evaluationReferencesFor(ctx: TenantContext, request: ApprovedProposalBaselineRequest): Promise<{ kind: string; id: string; dimension: string }[]>;
}
