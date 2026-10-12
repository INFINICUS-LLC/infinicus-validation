/**
 * Outcome Monitoring's verification of one Business Operations execution (P0-6d, Block 4).
 *
 * Input: the reference-only `operations.action.executed@1` payload. The service trusts nothing in it beyond the reference: it pulls the sealed
 * evidence through the BO-owned read port, re-validates the document under the contract (closed shape, digest recomputed), and requires
 * that the document, the stored digest and the payload agree on contract version, digest, scope, action type/version, target, package,
 * claim, outcome and mutation result. Only then does it record OM's OWN verification row - EXECUTION_VERIFIED plus an initial outcome
 * verdict that is never better than PENDING / INCONCLUSIVE.
 *
 * It reads no Business Operations table, rewrites no execution fact, claims no effectiveness, emits no event and informs no learning.
 */
import { ActionExecutionVerificationConflictError, ActionExecutionVerificationRepository } from '@infinicus/database';
import type { ActionExecutionVerification, TenantContext } from '@infinicus/database';
import type { ActionExecutedPayload } from '@infinicus/event-contracts';
import { EXECUTION_EVIDENCE_CONTRACT_VERSION, SUPPORTED_EXECUTION_EVIDENCE_CONTRACT_VERSIONS, validateExecutionEvidence } from '@infinicus/handoff-contracts';
import type { ExecutionEvidenceReader } from '@infinicus/handoff-contracts';
import { deriveInitialOutcomeState } from './initialOutcome.js';

export type VerificationRejectionCode =
  | 'CONTRACT_VERSION_UNSUPPORTED' | 'EVIDENCE_UNAVAILABLE' | 'EVIDENCE_INVALID' | 'DIGEST_MISMATCH' | 'SCOPE_MISMATCH'
  | 'REFERENCE_MISMATCH' | 'ACTION_TYPE_MISMATCH' | 'DIGEST_CONFLICT';

/** A rejected reference. `retryable` is true only for "the evidence is not obtainable (yet)"; every other rejection is final. */
export class ExecutionVerificationRejectedError extends Error {
  constructor(readonly code: VerificationRejectionCode, message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'ExecutionVerificationRejectedError';
  }
}

export interface ExecutionVerificationServiceDependencies {
  evidence: ExecutionEvidenceReader;
  /** Action type/version pairs OM can verify. Required: there is no default list. */
  supportedActionTypes: readonly { code: string; schemaVersion: string }[];
  verifications?: Pick<ActionExecutionVerificationRepository, 'record'>;
}

export interface VerifyExecutionRequest {
  payload: ActionExecutedPayload;
  sourceEventId: string;
  correlationId: string;
  causationId: string | null;
}

export interface VerifyExecutionResult {
  verification: ActionExecutionVerification;
  /** False when this execution had already been verified (an idempotent replay). */
  created: boolean;
}

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export class ExecutionVerificationService {
  private readonly verifications: Pick<ActionExecutionVerificationRepository, 'record'>;

  constructor(private readonly deps: ExecutionVerificationServiceDependencies) {
    this.verifications = deps.verifications ?? new ActionExecutionVerificationRepository();
  }

  async verify(ctx: TenantContext, request: VerifyExecutionRequest): Promise<VerifyExecutionResult> {
    const { payload } = request;
    const { scope } = payload;
    if (scope.tenantId !== ctx.tenantId || scope.workspaceId !== ctx.workspaceId) throw new ExecutionVerificationRejectedError('SCOPE_MISMATCH', 'the event scope is not the delivery scope', false);
    if (payload.contractVersion !== EXECUTION_EVIDENCE_CONTRACT_VERSION || !SUPPORTED_EXECUTION_EVIDENCE_CONTRACT_VERSIONS.includes(payload.contractVersion)) {
      throw new ExecutionVerificationRejectedError('CONTRACT_VERSION_UNSUPPORTED', `evidence contract ${payload.contractVersion} is not supported`, false);
    }
    if (!this.deps.supportedActionTypes.some((a) => a.code === payload.actionType.code && a.schemaVersion === payload.actionType.schemaVersion)) {
      throw new ExecutionVerificationRejectedError('ACTION_TYPE_MISMATCH', 'the action type and version are not verifiable by Outcome Monitoring', false);
    }

    const pulled = await this.deps.evidence.get({ executionId: payload.executionId, scope }).catch(() => null);
    if (!pulled) throw new ExecutionVerificationRejectedError('EVIDENCE_UNAVAILABLE', 'the execution evidence could not be read for this scope', true);
    if (pulled.digest !== payload.evidenceDigest) throw new ExecutionVerificationRejectedError('DIGEST_MISMATCH', 'the stored evidence is not the evidence the event names', false);

    const check = validateExecutionEvidence(pulled.document);
    if (!check.valid) throw new ExecutionVerificationRejectedError('EVIDENCE_INVALID', `the evidence is not a valid ${EXECUTION_EVIDENCE_CONTRACT_VERSION} document`, false);
    const doc = pulled.document;
    const integrity = isRec(doc.integrity) ? doc.integrity : {};
    if (integrity.digest !== payload.evidenceDigest) throw new ExecutionVerificationRejectedError('DIGEST_MISMATCH', 'the document digest is not the digest the event names', false);
    if (doc.contractVersion !== payload.contractVersion) throw new ExecutionVerificationRejectedError('CONTRACT_VERSION_UNSUPPORTED', 'the document contract is not the contract the event names', false);

    const id = (isRec(doc.identity) ? doc.identity : {}) as Record<string, unknown>;
    const idScope = (isRec(id.scope) ? id.scope : {}) as Record<string, unknown>;
    if (idScope.tenantId !== scope.tenantId || idScope.workspaceId !== scope.workspaceId || idScope.businessId !== scope.businessId) {
      throw new ExecutionVerificationRejectedError('SCOPE_MISMATCH', 'the evidence belongs to a different scope than the event', false);
    }
    const idAction = (isRec(id.actionType) ? id.actionType : {}) as Record<string, unknown>;
    const idTarget = (isRec(id.target) ? id.target : {}) as Record<string, unknown>;
    if (idAction.code !== payload.actionType.code || idAction.schemaVersion !== payload.actionType.schemaVersion) {
      throw new ExecutionVerificationRejectedError('ACTION_TYPE_MISMATCH', 'the evidence action type differs from the event', false);
    }
    const oc = (isRec(doc.outcome) ? doc.outcome : {}) as Record<string, unknown>;
    const mu = (isRec(doc.mutation) ? doc.mutation : {}) as Record<string, unknown>;
    if (id.executionId !== payload.executionId || id.packageId !== payload.packageId || id.packageVersion !== payload.packageVersion || id.claimId !== payload.claimId
      || idTarget.kind !== payload.target.kind || idTarget.id !== payload.target.id || oc.outcome !== payload.outcome || mu.result !== payload.mutationResult
      || pulled.recordedAt !== payload.recordedAt) {
      throw new ExecutionVerificationRejectedError('REFERENCE_MISMATCH', 'the evidence does not match the reference in the event', false);
    }

    const initial = deriveInitialOutcomeState({ outcome: payload.outcome, mutationResult: payload.mutationResult });
    const lineage = (isRec(doc.lineage) ? doc.lineage : {}) as Record<string, unknown>;
    const authorization = (isRec(lineage.authorization) ? lineage.authorization : {}) as Record<string, unknown>;
    try {
      return await this.verifications.record(ctx, {
        businessId: scope.businessId, executionId: payload.executionId, sourceEventId: request.sourceEventId, contractVersion: payload.contractVersion,
        evidenceDigest: payload.evidenceDigest, packageId: payload.packageId, packageVersion: payload.packageVersion, claimId: payload.claimId,
        approvedActionId: typeof authorization.actionId === 'string' ? authorization.actionId : null,
        actionType: payload.actionType, target: payload.target, executionOutcome: payload.outcome, mutationResult: payload.mutationResult,
        executionRecordedAt: pulled.recordedAt, outcomeState: initial.state, outcomeStateReason: initial.reason,
        correlationId: request.correlationId, causationId: request.causationId,
      });
    } catch (error) {
      if (error instanceof ActionExecutionVerificationConflictError) throw new ExecutionVerificationRejectedError('DIGEST_CONFLICT', 'a different evidence digest is already verified for this execution', false);
      throw error;
    }
  }
}
