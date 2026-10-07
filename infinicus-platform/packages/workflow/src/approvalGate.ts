/**
 * Persisted-fact approval gate (P0-3 Block 3; locked ABA §§11-12, owner rulings Q3-Q5).
 *
 * Pure and database-free. It judges an APPROVING outcome (approve / approve_with_modifications) from the facts
 * persisted on the ABA review version, the database clock, and the Digital Twin freshness assessment. Rejecting is
 * never gated. Nothing here accepts caller-supplied risk or validity facts.
 *
 *   valid_until present and <= now        -> EXPIRED      (enforced regardless of is_time_sensitive)
 *   is_time_sensitive NULL (unknown)      -> BLOCK until recalculated (never read as false)
 *   is_time_sensitive true, no valid_until -> BLOCK
 *   is_time_sensitive false, no valid_until -> allowed
 *   a newer PUBLISHED Twin snapshot exists -> STALE       (drafts/unpublished do not count)
 *   twin reference present but unverifiable -> BLOCK (not assumed fresh)
 * Recovery path for every block: RECALCULATE DECISION. No override exists in P0-3.
 */

export type GateBlockCode =
  | 'REVIEW_FACTS_MISSING'
  | 'TIME_SENSITIVITY_UNKNOWN'
  | 'TIME_SENSITIVE_WITHOUT_VALIDITY'
  | 'EXPIRED'
  | 'TWIN_SNAPSHOT_UNVERIFIABLE'
  | 'STALE';

export interface GateFacts {
  isTimeSensitive: boolean | null;
  validUntil: Date | null;
  twinSnapshotId: string | null;
}

export interface TwinFreshness {
  usable: boolean;
  newerPublishedExists: boolean;
}

export type ApprovalGateVerdict =
  | { allowed: true }
  | { allowed: false; codes: GateBlockCode[]; reasons: string[]; recovery: 'RECALCULATE_DECISION' };

const REASON: Record<GateBlockCode, string> = {
  REVIEW_FACTS_MISSING: 'the review has no persisted decision facts',
  TIME_SENSITIVITY_UNKNOWN: 'time-sensitivity is unknown and must be recalculated before approval',
  TIME_SENSITIVE_WITHOUT_VALIDITY: 'the recommendation is time-sensitive but carries no valid_until',
  EXPIRED: 'the recommendation has expired (valid_until has passed)',
  TWIN_SNAPSHOT_UNVERIFIABLE: 'the Digital Twin snapshot the recommendation used cannot be verified as published for this business',
  STALE: 'a newer published Digital Twin snapshot exists; the recommendation is stale',
};

export function evaluateApprovalGate(input: {
  facts: GateFacts | null;
  /** Database clock. */
  now: Date;
  /** Required when `facts.twinSnapshotId` is set; null means the lookup was not performed. */
  twin: TwinFreshness | null;
}): ApprovalGateVerdict {
  const codes: GateBlockCode[] = [];
  const { facts, now, twin } = input;

  if (facts === null) {
    codes.push('REVIEW_FACTS_MISSING');
  } else {
    if (facts.validUntil !== null) {
      if (!(facts.validUntil instanceof Date) || !Number.isFinite(facts.validUntil.getTime()) || facts.validUntil.getTime() <= now.getTime()) {
        codes.push('EXPIRED');
      }
    }
    if (facts.isTimeSensitive === null) {
      codes.push('TIME_SENSITIVITY_UNKNOWN');
    } else if (facts.isTimeSensitive === true && facts.validUntil === null) {
      codes.push('TIME_SENSITIVE_WITHOUT_VALIDITY');
    }
    if (facts.twinSnapshotId !== null) {
      if (twin === null || !twin.usable) codes.push('TWIN_SNAPSHOT_UNVERIFIABLE');
      else if (twin.newerPublishedExists) codes.push('STALE');
    }
  }

  if (codes.length === 0) return { allowed: true };
  return { allowed: false, codes, reasons: codes.map((c) => REASON[c]), recovery: 'RECALCULATE_DECISION' };
}
