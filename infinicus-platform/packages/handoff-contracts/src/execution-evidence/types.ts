// execution-evidence/1 (P0-6d) - the canonical, immutable, versioned record of what Business Operations DID with one authorized-action claim.
//
// It states an EXECUTION FACT and nothing more: the authorized action was APPLIED, was a NO_CHANGE, or was REFUSED / FAILED (nothing applied).
// It never states whether the action HELPED: no effectiveness, improvement, success-rate or "expected result occurred" claim can be
// represented (the shape is closed and the validator rejects effectiveness vocabulary anywhere). Measuring outcomes belongs to Outcome
// Monitoring; Business Operations is the sole author of this document.
//
// Pure data. No database, no I/O, no clock. Times are millisecond UTC values the producer read from the DATABASE clock.

export const EXECUTION_EVIDENCE_CONTRACT_VERSION = 'execution-evidence/1' as const;
export const SUPPORTED_EXECUTION_EVIDENCE_CONTRACT_VERSIONS: readonly string[] = [EXECUTION_EVIDENCE_CONTRACT_VERSION];
/** Discriminator: this document is an execution FACT, never an outcome-effectiveness claim. */
export const EXECUTION_EVIDENCE_KIND = 'EXECUTION_FACT' as const;
export const EXECUTION_EVIDENCE_DIGEST_ALGORITHM = 'sha256' as const;

export const EXECUTION_OUTCOMES = ['SUCCEEDED', 'REFUSED', 'FAILED'] as const;
export type ExecutionOutcomeValue = (typeof EXECUTION_OUTCOMES)[number];

/** NOT_APPLICABLE = no mutation was applied (the action was refused or failed before changing anything). */
export const EXECUTION_MUTATION_RESULTS = ['APPLIED', 'NO_CHANGE', 'NOT_APPLICABLE'] as const;
export type ExecutionMutationResult = (typeof EXECUTION_MUTATION_RESULTS)[number];

export const EXECUTION_AUTHORITY_VERDICTS = ['CURRENT', 'REVOKED', 'UNVERIFIABLE', 'NOT_CHECKED'] as const;
export type ExecutionAuthorityVerdict = (typeof EXECUTION_AUTHORITY_VERDICTS)[number];

export type EvidenceJson = string | number | boolean | null | readonly EvidenceJson[] | { readonly [key: string]: EvidenceJson };
export type EvidenceJsonObject = { readonly [key: string]: EvidenceJson };

export interface ExecutionEvidenceScope {
  tenantId: string;
  workspaceId: string;
  businessId: string;
}

export interface ExecutionEvidenceBody {
  contractVersion: typeof EXECUTION_EVIDENCE_CONTRACT_VERSION;
  evidenceKind: typeof EXECUTION_EVIDENCE_KIND;
  identity: {
    executionId: string;
    packageId: string;
    packageVersion: number;
    packageDigest: string;
    claimId: string;
    receiptId: string;
    scope: ExecutionEvidenceScope;
    actionType: { code: string; schemaVersion: string };
    target: { kind: string; id: string };
  };
  timing: {
    /** When Business Operations claimed the package (database time). */
    claimedAt: string;
    /** Start of the execution transaction (database time). */
    executionStartedAt: string;
    /** When the authority answer was judged against the database clock; null when execution stopped before authority was asked. */
    authorityJudgedAt: string | null;
  };
  authority: {
    /** The authority verdict the execution relied on (or NOT_CHECKED when it stopped earlier). */
    verdict: ExecutionAuthorityVerdict;
    /** ABA database time of the status/authority answers judged. */
    statusVerifiedAt: string | null;
    authorityVerifiedAt: string | null;
    statusAnswerDigest: string | null;
    provider: string | null;
  };
  mutation: {
    result: ExecutionMutationResult;
    balanceId: string | null;
    balanceVersionBefore: number | null;
    balanceVersionAfter: number | null;
    /** Operational state before / the exact effective values requested by the package / state after (decimal text, never floats). */
    before: EvidenceJsonObject | null;
    requested: EvidenceJsonObject | null;
    after: EvidenceJsonObject | null;
    baselineSource: 'BO_EVALUATION_EVIDENCE' | null;
  };
  preconditions: readonly EvidenceJsonObject[];
  /** Record-only copies of the package's execution boundaries (never enforced here, never an outcome claim). */
  boundaries: { executionWindow: EvidenceJson; budget: EvidenceJson; rollback: EvidenceJson; monitoring: EvidenceJson };
  outcome: {
    outcome: ExecutionOutcomeValue;
    /** Stable machine-readable refusal/failure reason; null exactly when the outcome is SUCCEEDED. */
    reasonCode: string | null;
    detail: string | null;
    attemptCount: number;
  };
  lineage: {
    correlationId: string;
    causationId: string | null;
    executor: { type: 'system'; id: string };
    authorization: {
      /** The ABA approved-action record the package derives from (reference only). */
      actionId: string | null;
      decisionId: string | null;
      decisionVersionId: string | null;
      evaluationRefs: readonly EvidenceJson[];
    };
  };
}

export interface ExecutionEvidenceV1 extends ExecutionEvidenceBody {
  integrity: { algorithm: typeof EXECUTION_EVIDENCE_DIGEST_ALGORITHM; canonicalVersion: string; digest: string };
}

/** What a reader returns: the sealed document, its digest, and the database times Business Operations recorded around it. */
export interface ExecutionEvidenceRecord {
  document: Record<string, unknown>;
  digest: string;
  /** Business Operations database time at which the execution row (and so this evidence) was recorded. */
  recordedAt: string;
  executionCompletedAt: string;
}
