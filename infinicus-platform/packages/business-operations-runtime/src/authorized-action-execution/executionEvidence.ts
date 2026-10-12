/**
 * The sealed evidence document of one execution outcome (P0-6c; planning section 11A). Business Operations OWNS and writes it; it is the
 * projection of the `authorized_action_executions` fact that Outcome Monitoring will later verify (P0-6d standardizes the shared
 * contract type and validator for exactly this shape). Tamper evidence only - never authorization: the digest is SHA-256 over the
 * canonical JSON of everything except `integrity`.
 *
 * Pure: no I/O, no clock (every time is a value the engine read from the database clock). No stack traces, secrets or payload bodies:
 * the package parameters appear only as the `requested` before/after values of the one balance.
 */
import { AAP_CANONICAL_VERSION, canonicalize, sha256HexOfText } from '@infinicus/handoff-contracts';
import type { JsonValue } from '@infinicus/handoff-contracts';

export const EXECUTION_EVIDENCE_CONTRACT_VERSION = 'execution-evidence/1';

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
    result: 'APPLIED' | 'NO_CHANGE' | 'NOT_APPLIED';
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
  lineage: { decisionId: string | null; decisionVersionId: string | null; evaluationRefs: JsonValue; causationId: string | null };
  executor: { type: 'system'; id: string };
}

export interface SealedExecutionEvidence {
  document: { [key: string]: JsonValue };
  digest: string;
}

/** Builds the evidence document and its digest. Deterministic: the same input always yields the same bytes. */
export function sealExecutionEvidence(i: ExecutionEvidenceInput): SealedExecutionEvidence {
  const body = {
    contractVersion: EXECUTION_EVIDENCE_CONTRACT_VERSION,
    identity: {
      executionId: i.executionId, packageId: i.claim.packageId, packageVersion: i.claim.packageVersion, packageDigest: i.claim.digest,
      claimId: i.claim.claimId, receiptId: i.claim.receiptId, scope: i.scope, actionType: i.actionType, target: i.target,
    },
    timing: { claimedAt: i.claim.claimedAt, executionStartedAt: i.executionStartedAt, authorityJudgedAt: i.authority.judgedAt },
    authority: {
      verdict: i.authority.verdict, statusVerifiedAt: i.authority.statusVerifiedAt, authorityVerifiedAt: i.authority.authorityVerifiedAt,
      statusAnswerDigest: i.authority.statusAnswerDigest, provider: i.authority.provider,
    },
    mutation: i.mutation,
    preconditions: i.preconditions,
    boundaries: i.boundaries,
    outcome: { outcome: i.outcome, reasonCode: i.reasonCode, detail: i.detail, attemptCount: i.attemptCount },
    lineage: { correlationId: i.claim.correlationId, causationId: i.lineage.causationId, executor: i.executor, authorization: { decisionId: i.lineage.decisionId, decisionVersionId: i.lineage.decisionVersionId, evaluationRefs: i.lineage.evaluationRefs } },
  } as unknown as { [key: string]: JsonValue };
  const digest = `sha256:${sha256HexOfText(canonicalize(body as JsonValue))}`;
  return { document: { ...body, integrity: { algorithm: 'sha256', canonicalVersion: AAP_CANONICAL_VERSION, digest } }, digest };
}

/** Re-derives the digest of a stored evidence document (tamper check). */
export function evidenceDigestOf(document: { [key: string]: unknown }): string {
  const { integrity: _integrity, ...rest } = document;
  return `sha256:${sha256HexOfText(canonicalize(rest as JsonValue))}`;
}
