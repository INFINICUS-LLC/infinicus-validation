import { randomUUID } from 'node:crypto';
import { sealExecutionEvidence } from '@infinicus/handoff-contracts';
import type { ExecutionEvidenceBody, ExecutionEvidenceReader, ExecutionEvidenceRecord } from '@infinicus/handoff-contracts';
import { actionExecutedEventId } from '@infinicus/event-contracts';
import type { ActionExecutedPayload } from '@infinicus/event-contracts';

export const T0 = '2026-01-01T10:00:00.000Z';
export const T1 = '2026-01-01T10:00:01.000Z';
export const T2 = '2026-01-01T10:00:02.000Z';
export const hex = (c: string): string => `sha256:${c.repeat(64)}`;

export interface Ids { tenantId: string; workspaceId: string; businessId: string; executionId: string; packageId: string; claimId: string; receiptId: string; itemId: string }
export const newIds = (): Ids => ({ tenantId: randomUUID(), workspaceId: randomUUID(), businessId: randomUUID(), executionId: randomUUID(), packageId: randomUUID(), claimId: randomUUID(), receiptId: randomUUID(), itemId: randomUUID() });

export function evidenceBody(ids: Ids, over: { outcome?: 'SUCCEEDED' | 'REFUSED' | 'FAILED'; mutation?: 'APPLIED' | 'NO_CHANGE' | 'NOT_APPLICABLE' } = {}): ExecutionEvidenceBody {
  const outcome = over.outcome ?? 'SUCCEEDED';
  const mutationResult = over.mutation ?? (outcome === 'SUCCEEDED' ? 'APPLIED' : 'NOT_APPLICABLE');
  const applied = mutationResult === 'APPLIED';
  const touched = mutationResult !== 'NOT_APPLICABLE';
  const ok = outcome === 'SUCCEEDED';
  return {
    contractVersion: 'execution-evidence/1', evidenceKind: 'EXECUTION_FACT',
    identity: {
      executionId: ids.executionId, packageId: ids.packageId, packageVersion: 1, packageDigest: hex('a'), claimId: ids.claimId, receiptId: ids.receiptId,
      scope: { tenantId: ids.tenantId, workspaceId: ids.workspaceId, businessId: ids.businessId },
      actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '1' }, target: { kind: 'inventory_item', id: ids.itemId },
    },
    timing: { claimedAt: T0, executionStartedAt: T1, authorityJudgedAt: ok ? T2 : null },
    authority: ok
      ? { verdict: 'CURRENT', statusVerifiedAt: T1, authorityVerifiedAt: T1, statusAnswerDigest: hex('b'), provider: 'aba.package-status-provider' }
      : { verdict: 'NOT_CHECKED', statusVerifiedAt: null, authorityVerifiedAt: null, statusAnswerDigest: null, provider: null },
    mutation: {
      result: mutationResult, balanceId: touched ? randomUUID() : null, balanceVersionBefore: touched ? 1 : null, balanceVersionAfter: applied ? 2 : null,
      before: touched ? { reorderPoint: '100', reorderQuantity: '200' } : null, requested: touched ? { reorderPoint: '150', reorderQuantity: '250' } : null,
      after: applied ? { reorderPoint: '150', reorderQuantity: '250' } : null, baselineSource: touched ? 'BO_EVALUATION_EVIDENCE' : null,
    },
    preconditions: [], boundaries: { executionWindow: null, budget: null, rollback: null, monitoring: null },
    outcome: { outcome, reasonCode: ok ? null : 'AUTHORITY_REVOKED', detail: null, attemptCount: 1 },
    lineage: { correlationId: randomUUID(), causationId: ids.claimId, executor: { type: 'system', id: 'bo.authorized-action-execution' }, authorization: { actionId: randomUUID(), decisionId: null, decisionVersionId: null, evaluationRefs: [] } },
  } as ExecutionEvidenceBody;
}

export interface Fixture { ids: Ids; record: ExecutionEvidenceRecord; payload: ActionExecutedPayload; sourceEventId: string }
export function fixture(over: Parameters<typeof evidenceBody>[1] = {}): Fixture {
  const ids = newIds();
  const sealed = sealExecutionEvidence(evidenceBody(ids, over));
  const record: ExecutionEvidenceRecord = { document: sealed as unknown as Record<string, unknown>, digest: sealed.integrity.digest, recordedAt: T2, executionCompletedAt: T2 };
  const body = sealed;
  const payload: ActionExecutedPayload = {
    executionId: ids.executionId, contractVersion: 'execution-evidence/1', evidenceDigest: sealed.integrity.digest,
    scope: { tenantId: ids.tenantId, workspaceId: ids.workspaceId, businessId: ids.businessId },
    actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '1' }, target: { kind: 'inventory_item', id: ids.itemId },
    packageId: ids.packageId, packageVersion: 1, claimId: ids.claimId, outcome: body.outcome.outcome, mutationResult: body.mutation.result, recordedAt: T2,
  };
  return { ids, record, payload, sourceEventId: actionExecutedEventId(ids.executionId) };
}

export const readerOf = (record: ExecutionEvidenceRecord | null): ExecutionEvidenceReader & { calls: number } => {
  const r = { calls: 0, get: async () => { r.calls += 1; return record; } };
  return r;
};
