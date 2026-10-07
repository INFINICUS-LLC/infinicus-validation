/**
 * Approval audit contract (P0-4 Block 1; locked ABA §25 "Audit record").
 *
 * Pure and database-free. Builds the `detail` document stored in the append-only
 * `approved_business_action.approval_audit_events` table for every approval event: approved,
 * approved with modifications, rejected, denied (authority / risk policy) and blocked (persisted-fact gate:
 * expired, stale, unknown time-sensitivity, ...). Versioned so a later change is explicit.
 *
 * Fields follow §25: action ID, decision ID, approver, approval type, prior state, new state, timestamp (the row's
 * `occurred_at`), reason, modified parameters, permission used, Twin snapshot, Simulation run, model/version.
 * Anything the data model cannot supply today is recorded as null AND named in `unavailable`; nothing is fabricated.
 */

export const APPROVAL_AUDIT_SCHEMA = 'approval-audit/1';

export type ApprovalAuditEventType =
  | 'approval.approved'
  | 'approval.approved_with_modifications'
  | 'approval.rejected'
  | 'approval.denied'
  | 'approval.blocked';

export type ApprovalAuditReasonCode =
  | 'AUTHORITY_NOT_ESTABLISHED'
  | 'RISK_POLICY'
  | 'EXPIRED'
  | 'STALE'
  | 'TIME_SENSITIVITY_UNKNOWN'
  | 'TIME_SENSITIVE_WITHOUT_VALIDITY'
  | 'TWIN_SNAPSHOT_UNVERIFIABLE'
  | 'REVIEW_FACTS_MISSING';

export interface ApprovalAuditInput {
  eventType: ApprovalAuditEventType;
  businessId: string;
  reviewPackageId: string;
  decisionId: string | null;
  decisionVersionId: string | null;
  /** The authenticated principal; never a caller-supplied identity. */
  approverUserId: string;
  assignment: { id: string; code: string; roleCode: string | null } | null;
  /** The outcome the approver asked for. */
  requestedOutcome: 'approve' | 'approve_with_modifications' | 'reject';
  priorState: string | null;
  newState: string | null;
  reason: string | null;
  reasonCodes: readonly ApprovalAuditReasonCode[];
  permissionUsed: string | null;
  correlationId: string | null;
  /** Persisted review-version facts (never caller input). */
  facts: {
    reviewVersionId: string;
    sourceRecommendationVersionId: string | null;
    riskClass: string | null;
    isTimeSensitive: boolean | null;
    validUntil: Date | null;
    twinSnapshotId: string | null;
  } | null;
}

const MAX_REASON_LENGTH = 2000;

function cleanText(value: string | null): string | null {
  if (value === null) return null;
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return stripped.length > MAX_REASON_LENGTH ? `${stripped.slice(0, MAX_REASON_LENGTH)}…` : stripped;
}

export function buildApprovalAuditDetail(input: ApprovalAuditInput): Record<string, unknown> {
  return {
    schema: APPROVAL_AUDIT_SCHEMA,
    eventType: input.eventType,
    approvalType: input.requestedOutcome,
    decisionId: input.decisionId,
    decisionVersionId: input.decisionVersionId,
    reviewPackageId: input.reviewPackageId,
    businessId: input.businessId,
    approver: {
      userId: input.approverUserId,
      assignmentId: input.assignment?.id ?? null,
      assignmentCode: input.assignment?.code ?? null,
      roleCode: input.assignment?.roleCode ?? null,
    },
    priorState: input.priorState,
    newState: input.newState,
    reason: cleanText(input.reason),
    reasonCodes: [...input.reasonCodes],
    permissionUsed: input.permissionUsed,
    correlationId: input.correlationId,
    facts: input.facts && {
      reviewVersionId: input.facts.reviewVersionId,
      sourceRecommendationVersionId: input.facts.sourceRecommendationVersionId,
      riskClass: input.facts.riskClass,
      isTimeSensitive: input.facts.isTimeSensitive,
      validUntil: input.facts.validUntil ? input.facts.validUntil.toISOString() : null,
      twinSnapshotId: input.facts.twinSnapshotId,
    },
    // §25 fields the data model cannot supply at decision time. Recorded as absent, never invented.
    actionId: null,
    modifiedParameters: null,
    simulationRunId: null,
    modelVersion: null,
    unavailable: ['actionId', 'modifiedParameters', 'simulationRunId', 'modelVersion'],
  };
}

export function auditEventTypeFor(outcome: ApprovalAuditInput['requestedOutcome']): ApprovalAuditEventType {
  switch (outcome) {
    case 'approve': return 'approval.approved';
    case 'approve_with_modifications': return 'approval.approved_with_modifications';
    case 'reject': return 'approval.rejected';
  }
}
