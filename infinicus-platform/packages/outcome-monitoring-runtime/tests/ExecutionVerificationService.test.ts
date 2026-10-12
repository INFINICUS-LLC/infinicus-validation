/**
 * P0-6d - OM verification of BO execution evidence (no database): every reference defect is rejected before anything is recorded, a
 * verified execution is never promoted to a verified outcome, and OM neither reads nor writes a BO fact.
 */
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { RecordExecutionVerificationInput } from '@infinicus/database';
import { ExecutionVerificationRejectedError, ExecutionVerificationService, OM_VERIFIABLE_ACTION_TYPES, deriveInitialOutcomeState } from '../src/index.js';
import { fixture, hex, readerOf, type Fixture } from './helpers.js';

const ctxOf = (f: Fixture) => ({ tenantId: f.ids.tenantId, workspaceId: f.ids.workspaceId, userId: randomUUID() });
function service(f: Fixture, record = f.record as Fixture['record'] | null, over: { types?: typeof OM_VERIFIABLE_ACTION_TYPES } = {}) {
  const recorded: RecordExecutionVerificationInput[] = [];
  const reader = readerOf(record);
  const svc = new ExecutionVerificationService({
    evidence: reader, supportedActionTypes: over.types ?? OM_VERIFIABLE_ACTION_TYPES,
    verifications: { record: async (_c, input) => { recorded.push(input); return { created: true, verification: { ...input, id: randomUUID(), tenantId: f.ids.tenantId, workspaceId: f.ids.workspaceId, monitoredActionId: null, executionState: 'EXECUTION_VERIFIED', verifiedAt: f.payload.recordedAt } as never }; } },
  });
  return { svc, recorded, reader };
}
const req = (f: Fixture) => ({ payload: f.payload, sourceEventId: f.sourceEventId, correlationId: randomUUID(), causationId: null });
const rejects = async (p: Promise<unknown>, code: string, retryable = false) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(ExecutionVerificationRejectedError);
  expect(e).toMatchObject({ code, retryable });
};

describe('P0-6d: OM execution verification', () => {
  it('verifies a genuine execution: EXECUTION_VERIFIED facts recorded, outcome only PENDING (never verified)', async () => {
    const f = fixture();
    const { svc, recorded } = service(f);
    const r = await svc.verify(ctxOf(f), req(f));
    expect(r.created).toBe(true);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      executionId: f.ids.executionId, evidenceDigest: f.payload.evidenceDigest, executionOutcome: 'SUCCEEDED', mutationResult: 'APPLIED', outcomeState: 'OUTCOME_PENDING',
      packageId: f.ids.packageId, claimId: f.ids.claimId, sourceEventId: f.sourceEventId,
    });
    expect(recorded[0].outcomeStateReason).toMatch(/NO_AUTHORITATIVE_MEASUREMENT_MODEL/);
    expect(['OUTCOME_OBSERVED', 'OUTCOME_VERIFIED', 'OUTCOME_FAILED']).not.toContain(recorded[0].outcomeState);
  });

  it.each([
    ['REFUSED', 'NOT_APPLICABLE'], ['FAILED', 'NOT_APPLICABLE'],
  ] as const)('a %s execution is verified as a refusal/failure and carries nothing positive (INCONCLUSIVE, nothing applied)', async (outcome, mutation) => {
    const f = fixture({ outcome, mutation });
    const { svc, recorded } = service(f);
    await svc.verify(ctxOf(f), req(f));
    expect(recorded[0]).toMatchObject({ executionOutcome: outcome, mutationResult: mutation, outcomeState: 'OUTCOME_INCONCLUSIVE' });
  });

  it('a SUCCEEDED NO_CHANGE execution is not pending an effect: nothing was applied', async () => {
    const f = fixture({ outcome: 'SUCCEEDED', mutation: 'NO_CHANGE' });
    const { svc, recorded } = service(f);
    await svc.verify(ctxOf(f), req(f));
    expect(recorded[0]).toMatchObject({ mutationResult: 'NO_CHANGE', outcomeState: 'OUTCOME_INCONCLUSIVE' });
  });

  it('rejects an unsupported evidence contract version before reading anything', async () => {
    const f = fixture();
    const { svc, reader, recorded } = service(f);
    await rejects(svc.verify(ctxOf(f), { ...req(f), payload: { ...f.payload, contractVersion: 'execution-evidence/2' } }), 'CONTRACT_VERSION_UNSUPPORTED');
    expect(reader.calls).toBe(0);
    expect(recorded).toHaveLength(0);
  });

  it('rejects when the evidence does not exist or is out of scope (retryable: it may not be readable yet) and records nothing', async () => {
    const f = fixture();
    const { svc, recorded } = service(f, null);
    await rejects(svc.verify(ctxOf(f), req(f)), 'EVIDENCE_UNAVAILABLE', true);
    expect(recorded).toHaveLength(0);
  });

  it('rejects a reader that throws as unavailable, never as verified', async () => {
    const f = fixture();
    const svc = new ExecutionVerificationService({ evidence: { get: async () => { throw new Error('db down'); } }, supportedActionTypes: OM_VERIFIABLE_ACTION_TYPES, verifications: { record: async () => { throw new Error('must not record'); } } });
    await rejects(svc.verify(ctxOf(f), req(f)), 'EVIDENCE_UNAVAILABLE', true);
  });

  it('rejects a digest in the event that is not the digest of the stored evidence', async () => {
    const f = fixture();
    const { svc, recorded } = service(f);
    await rejects(svc.verify(ctxOf(f), { ...req(f), payload: { ...f.payload, evidenceDigest: hex('f') } }), 'DIGEST_MISMATCH');
    expect(recorded).toHaveLength(0);
  });

  it('rejects when the digest stored beside the document is not the digest the event names, even if the document itself matches the event', async () => {
    const f = fixture();
    const { svc, recorded } = service(f, { ...f.record, digest: hex('e') });
    await rejects(svc.verify(ctxOf(f), req(f)), 'DIGEST_MISMATCH');
    expect(recorded).toHaveLength(0);
  });

  it('rejects tampered evidence (a field changed, digest left as stored)', async () => {
    const f = fixture();
    const doc = JSON.parse(JSON.stringify(f.record.document));
    doc.outcome.outcome = 'FAILED';
    const { svc, recorded } = service(f, { ...f.record, document: doc });
    await rejects(svc.verify(ctxOf(f), req(f)), 'EVIDENCE_INVALID');
    expect(recorded).toHaveLength(0);
  });

  it('rejects evidence that claims an effect (effectiveness vocabulary is not representable in execution-evidence/1)', async () => {
    const f = fixture();
    const doc = JSON.parse(JSON.stringify(f.record.document));
    doc.outcome.improvement = '12%';
    const { svc } = service(f, { ...f.record, document: doc });
    await rejects(svc.verify(ctxOf(f), req(f)), 'EVIDENCE_INVALID');
  });

  it('rejects a scope mismatch: event scope differs from the delivery scope, or evidence scope differs from the event scope', async () => {
    const f = fixture();
    const { svc } = service(f);
    await rejects(svc.verify({ ...ctxOf(f), tenantId: randomUUID() }, req(f)), 'SCOPE_MISMATCH');
    const g = fixture();
    const crossed = { ...f.record, document: g.record.document, digest: g.record.digest };
    const { svc: svc2 } = service(f, crossed);
    await rejects(svc2.verify(ctxOf(f), { ...req(f), payload: { ...f.payload, evidenceDigest: g.record.digest } }), 'SCOPE_MISMATCH');
  });

  it('rejects an unsupported action type/version, and an event whose type differs from the evidence', async () => {
    const f = fixture();
    await rejects(service(f, f.record, { types: [{ code: 'other_action', schemaVersion: '1' }] }).svc.verify(ctxOf(f), req(f)), 'ACTION_TYPE_MISMATCH');
    await rejects(service(f).svc.verify(ctxOf(f), { ...req(f), payload: { ...f.payload, actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '2' } } }), 'ACTION_TYPE_MISMATCH');
  });

  it.each([
    ['outcome', { outcome: 'REFUSED' as const }], ['mutationResult', { mutationResult: 'NO_CHANGE' as const }], ['packageId', { packageId: randomUUID() }],
    ['claimId', { claimId: randomUUID() }], ['executionId', { executionId: randomUUID() }], ['target', { target: { kind: 'inventory_item', id: 'other' } }], ['packageVersion', { packageVersion: 2 }],
  ])('rejects a reference whose %s differs from the evidence', async (_n, over) => {
    const f = fixture();
    const { svc, recorded } = service(f);
    await rejects(svc.verify(ctxOf(f), { ...req(f), payload: { ...f.payload, ...over } }), 'REFERENCE_MISMATCH');
    expect(recorded).toHaveLength(0);
  });

  it('the same execution again is the repository\'s idempotent replay; a different digest for it surfaces as DIGEST_CONFLICT', async () => {
    const f = fixture();
    const { ActionExecutionVerificationConflictError } = await import('@infinicus/database');
    const svc = new ExecutionVerificationService({ evidence: readerOf(f.record), supportedActionTypes: OM_VERIFIABLE_ACTION_TYPES, verifications: { record: async () => { throw new ActionExecutionVerificationConflictError('a different evidence digest is already verified for this execution'); } } });
    await rejects(svc.verify(ctxOf(f), req(f)), 'DIGEST_CONFLICT');
  });

  it('deriveInitialOutcomeState never returns an observed/verified/failed outcome for any execution fact', () => {
    for (const outcome of ['SUCCEEDED', 'REFUSED', 'FAILED']) for (const mutationResult of ['APPLIED', 'NO_CHANGE', 'NOT_APPLICABLE']) {
      expect(['OUTCOME_PENDING', 'OUTCOME_INCONCLUSIVE']).toContain(deriveInitialOutcomeState({ outcome, mutationResult }).state);
    }
    expect(deriveInitialOutcomeState({ outcome: 'SUCCEEDED', mutationResult: 'APPLIED' }).state).toBe('OUTCOME_PENDING');
  });
});
