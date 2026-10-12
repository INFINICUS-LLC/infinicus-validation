/**
 * Business Operations' builder of the sealed `execution-evidence/1` document of one execution outcome (P0-6c; contract formalized in
 * P0-6d). BO OWNS and writes it; it is the projection of the `authorized_action_executions` fact that Outcome Monitoring verifies. The
 * shared contract (types, closed-shape validator, digest) lives in handoff-contracts; this module only maps the engine's facts onto it.
 * It states what BO DID - never whether it helped. Tamper evidence only - never authorization.
 *
 * Pure: no I/O, no clock (every time is a value the engine read from the database clock). No stack traces, secrets or payload bodies:
 * the package parameters appear only as the `requested` before/after values of the one balance.
 */
import {
  EXECUTION_EVIDENCE_CONTRACT_VERSION, EXECUTION_EVIDENCE_KIND, computeExecutionEvidenceDigest, sealExecutionEvidence as sealContractEvidence,
} from '@infinicus/handoff-contracts';
import type { EvidenceJson, EvidenceJsonObject, ExecutionEvidenceBody, JsonValue } from '@infinicus/handoff-contracts';

export { EXECUTION_EVIDENCE_CONTRACT_VERSION };

export interface ReorderValues {
  reorderPoint: string;
  reorderQuantity: string;
}

export interface ExecutionEvidenceInput {
  executionId: string;
  claim: { claimId: string; receiptId: string; claimedAt: string; packageId: string; packageVersion: number; digest: string; correlationId: string };
  scope: { tenantId: string; workspaceId: string; businessId: string };
  actionType: { code: string; schemaVersion: string };
  target: { kind: string; id: string };
  executionStartedAt: string;
  outcome: 'SUCCEEDED' | 'FAILED' | 'REFUSED';
  reasonCode: string | null;
  detail: string | null;
  attemptCount: number;
  authority: {
    verdict: 'CURRENT' | 'REVOKED' | 'UNVERIFIABLE' | 'NOT_CHECKED';
    statusVerifiedAt: string | null;
    authorityVerifiedAt: string | null;
    statusAnswerDigest: string | null;
    provider: string | null;
    judgedAt: string | null;
  };
  mutation: {
    result: 'APPLIED' | 'NO_CHANGE' | 'NOT_APPLICABLE';
    balanceId: string | null;
    balanceVersionBefore: number | null;
    balanceVersionAfter: number | null;
    before: ReorderValues | null;
    requested: ReorderValues | null;
    after: ReorderValues | null;
    baselineSource: 'BO_EVALUATION_EVIDENCE' | null;
  };
  preconditions: JsonValue;
  boundaries: { executionWindow: JsonValue; budget: JsonValue; rollback: JsonValue; monitoring: JsonValue };
  lineage: { actionId: string | null; decisionId: string | null; decisionVersionId: string | null; evaluationRefs: JsonValue; causationId: string | null };
  executor: { type: 'system'; id: string };
}

export interface SealedExecutionEvidence {
  document: { [key: string]: JsonValue };
  digest: string;
}

const asObject = (v: ReorderValues | null): EvidenceJsonObject | null => (v === null ? null : { reorderPoint: v.reorderPoint, reorderQuantity: v.reorderQuantity });

/** Maps the engine's facts onto the shared contract body (closed shape, no effectiveness vocabulary) and seals it. */
export function sealExecutionEvidence(i: ExecutionEvidenceInput): SealedExecutionEvidence {
  const body: ExecutionEvidenceBody = {
    contractVersion: EXECUTION_EVIDENCE_CONTRACT_VERSION,
    evidenceKind: EXECUTION_EVIDENCE_KIND,
    identity: {
      executionId: i.executionId, packageId: i.claim.packageId, packageVersion: i.claim.packageVersion, packageDigest: i.claim.digest,
      claimId: i.claim.claimId, receiptId: i.claim.receiptId, scope: i.scope, actionType: i.actionType, target: i.target,
    },
    timing: { claimedAt: i.claim.claimedAt, executionStartedAt: i.executionStartedAt, authorityJudgedAt: i.authority.judgedAt },
    authority: {
      verdict: i.authority.verdict, statusVerifiedAt: i.authority.statusVerifiedAt, authorityVerifiedAt: i.authority.authorityVerifiedAt,
      statusAnswerDigest: i.authority.statusAnswerDigest, provider: i.authority.provider,
    },
    mutation: {
      result: i.mutation.result, balanceId: i.mutation.balanceId, balanceVersionBefore: i.mutation.balanceVersionBefore, balanceVersionAfter: i.mutation.balanceVersionAfter,
      before: asObject(i.mutation.before), requested: asObject(i.mutation.requested), after: asObject(i.mutation.after), baselineSource: i.mutation.baselineSource,
    },
    preconditions: i.preconditions as unknown as readonly EvidenceJsonObject[],
    boundaries: i.boundaries as unknown as { executionWindow: EvidenceJson; budget: EvidenceJson; rollback: EvidenceJson; monitoring: EvidenceJson },
    outcome: { outcome: i.outcome, reasonCode: i.reasonCode, detail: i.detail, attemptCount: i.attemptCount },
    lineage: {
      correlationId: i.claim.correlationId, causationId: i.lineage.causationId, executor: i.executor,
      authorization: { actionId: i.lineage.actionId, decisionId: i.lineage.decisionId, decisionVersionId: i.lineage.decisionVersionId, evaluationRefs: i.lineage.evaluationRefs as unknown as readonly EvidenceJson[] },
    },
  };
  const sealed = sealContractEvidence(body);
  return { document: sealed as unknown as { [key: string]: JsonValue }, digest: sealed.integrity.digest };
}

/** Re-derives the digest of a stored evidence document (tamper check). */
export function evidenceDigestOf(document: { [key: string]: unknown }): string {
  const { integrity: _integrity, ...rest } = document;
  return computeExecutionEvidenceDigest(rest);
}
