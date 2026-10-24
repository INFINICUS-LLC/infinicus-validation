/**
 * CL-BOUNDARY-1 - the OM -> Control Loop learning boundary (no database): the sink is reached only through the one learning gate, the caller cannot
 * supply evidence, and every refusal, lookup failure or doubt leaves the sink uncalled.
 */
import { describe, expect, it } from 'vitest';
import type { LearningSourceLookup, TenantContext } from '@infinicus/database';
import { CL_REQUIRED_TARGET_LAYER, OM_TO_CL_CONTRACT_VERSION, type OMToCLHandoff } from '@infinicus/handoff-contracts';
import { LearningGateRefusedError, LearningReleaseBoundary, type LearningSourceReader } from '../src/LearningReleaseBoundary.js';

const T = '11111111-1111-4111-8111-111111111111';
const W = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';
const MA = '44444444-4444-4444-8444-444444444444';
const OBS = '66666666-6666-4666-8666-666666666666';
const OTHER = '99999999-9999-4999-8999-999999999999';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const ctx: TenantContext = { tenantId: T, workspaceId: W, userId: '77777777-7777-4777-8777-777777777777' };

const handoff = (over: Record<string, unknown> = {}): OMToCLHandoff => ({
  handoffId: 'h', sourceLayer: 'OM', sourceBlock: 'OM-09', targetLayer: 'CL', targetBlock: 'CL-01', correlationId: 'c', status: 'ready', createdAt: '2026-10-21T00:00:00.000Z',
  lineage: [{ layer: 'OM', block: 'OM-09', recordId: OBS, timestamp: '2026-10-21T00:00:00.000Z', action: 'observation_recorded' }],
  payload: {
    contractVersion: OM_TO_CL_CONTRACT_VERSION, tenantId: T, workspaceId: W, businessId: B, idempotencyKey: 'k', observationId: OBS, observationVersionId: 'v', observationVersion: 1,
    feedbackPackageId: 'fb', feedbackPackageVersionId: 'fbv', feedbackStatus: 'ready', summary: 's', findings: [{ findingCode: 'f', statement: 's' }], reviewActions: [], varianceSummary: [],
    evidenceReferences: ['om://x'], omPublicationPackageId: 'p', targetLayer: CL_REQUIRED_TARGET_LAYER, targetBlock: 'CL-01', publishedAt: '2026-10-21T00:00:00.000Z', ...over,
  },
}) as OMToCLHandoff;

const fact = (over: Record<string, unknown> = {}): LearningSourceLookup['facts'][number] => ({
  source: 'om_execution_verification', tenantId: T, workspaceId: W, businessId: B, executionId: 'e1', evidenceDigest: DIGEST, monitoredActionId: MA, approvedActionId: null,
  executionState: 'EXECUTION_VERIFIED', outcomeState: 'OUTCOME_VERIFIED', executionOutcome: 'SUCCEEDED', mutationResult: 'APPLIED', ...over,
}) as LearningSourceLookup['facts'][number];
const lookup = (facts: LearningSourceLookup['facts'], observation: LearningSourceLookup['observation'] = { businessId: B, monitoredActionId: MA, approvedActionId: null }): LearningSourceLookup => ({ observation, facts });

function harness(result: LearningSourceLookup | Error) {
  const calls: { reader: unknown[][]; sink: unknown[][] } = { reader: [], sink: [] };
  const reader: LearningSourceReader = {
    async learningSourcesForObservation(...args) { calls.reader.push(args); if (result instanceof Error) throw result; return result; },
  };
  const boundary = new LearningReleaseBoundary({ sources: reader, sink: async (...args) => { calls.sink.push(args); } });
  return { boundary, calls };
}
const refusal = async (p: Promise<unknown>): Promise<LearningGateRefusedError> => {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(LearningGateRefusedError); return e as LearningGateRefusedError; }
  throw new Error('expected a refusal');
};

describe('the boundary forwards only what the learning gate allows', () => {
  it('forwards once, with references only, when every check passes (a verified outcome cannot exist yet; this proves the path is not simply closed)', async () => {
    const { boundary, calls } = harness(lookup([fact()]));
    await expect(boundary.release(ctx, handoff())).resolves.toEqual({ released: true, executions: 1 });
    expect(calls.sink).toHaveLength(1);
    expect(calls.sink[0][1]).toEqual({ executions: [{ executionId: 'e1', evidenceDigest: DIGEST }] });
    expect(calls.reader[0]).toEqual([ctx, B, OBS]); // the reader is asked under the caller's scope for the hand-off's own observation
  });

  it('SUCCEEDED + APPLIED is not enough: PENDING and INCONCLUSIVE refuse and the sink is never called', async () => {
    for (const outcomeState of ['OUTCOME_PENDING', 'OUTCOME_INCONCLUSIVE']) {
      const { boundary, calls } = harness(lookup([fact({ outcomeState })]));
      const err = await refusal(boundary.release(ctx, handoff()));
      expect(err.reasons).toContain('LEARNING_GATE_CLOSED');
      expect(calls.sink).toHaveLength(0);
    }
  });

  it('unsupported outcome states and failed or refused executions refuse', async () => {
    for (const over of [{ outcomeState: 'OUTCOME_OBSERVED' }, { outcomeState: 'OUTCOME_FAILED' }, { outcomeState: 'unknown' }, { executionOutcome: 'FAILED', mutationResult: 'NOT_APPLICABLE' }, { executionState: 'EXECUTION_PENDING' }]) {
      const { boundary, calls } = harness(lookup([fact(over)]));
      await refusal(boundary.release(ctx, handoff()));
      expect(calls.sink).toHaveLength(0);
    }
  });

  it('a human-entered observation with no OM-verified execution is refused (improperly sourced)', async () => {
    const { boundary, calls } = harness(lookup([]));
    expect((await refusal(boundary.release(ctx, handoff()))).reasons).toContain('NO_VERIFIED_EXECUTION_SOURCE');
    expect(calls.sink).toHaveLength(0);
  });

  it('the caller cannot supply evidence: verdicts, sources or facts smuggled into the hand-off are ignored', async () => {
    const smuggled = handoff({ executionState: 'EXECUTION_VERIFIED', outcomeState: 'OUTCOME_VERIFIED', sources: [fact()], verified: true, learningEligible: true });
    const { boundary, calls } = harness(lookup([fact({ outcomeState: 'OUTCOME_PENDING' })]));
    await refusal(boundary.release(ctx, smuggled));
    expect(calls.sink).toHaveLength(0);
  });

  it('does not reclassify a reader-supplied unsupported source as OM-owned evidence', async () => {
    const { boundary, calls } = harness(lookup([fact({ source: 'caller_supplied' })]));
    const err = await refusal(boundary.release(ctx, handoff()));
    expect(err.reasons).toContain('SOURCE_KIND_UNSUPPORTED');
    expect(calls.sink).toHaveLength(0);
  });

  it('conflicting facts for one execution are refused', async () => {
    const { boundary, calls } = harness(lookup([fact(), fact({ evidenceDigest: `sha256:${'b'.repeat(64)}` })]));
    expect((await refusal(boundary.release(ctx, handoff()))).reasons).toContain('SOURCE_CONFLICT');
    expect(calls.sink).toHaveLength(0);
  });
});

describe('tenant isolation', () => {
  it('a hand-off for another tenant or workspace is refused WITHOUT any lookup', async () => {
    for (const over of [{ tenantId: OTHER }, { workspaceId: OTHER }]) {
      const { boundary, calls } = harness(lookup([fact()]));
      expect((await refusal(boundary.release(ctx, handoff(over)))).reasons).toContain('SCOPE_MISMATCH');
      expect(calls.reader).toHaveLength(0);
      expect(calls.sink).toHaveLength(0);
    }
  });

  it('even if the reader returned another tenant\'s facts (a substitution), they are refused on their own scope', async () => {
    for (const over of [{ tenantId: OTHER }, { workspaceId: OTHER }, { businessId: OTHER }]) {
      const { boundary, calls } = harness(lookup([fact(over)]));
      expect((await refusal(boundary.release(ctx, handoff()))).reasons).toContain('SOURCE_SCOPE_MISMATCH');
      expect(calls.sink).toHaveLength(0);
    }
  });

  it('an observation that is not visible in the scope (another tenant\'s, or unknown) is refused', async () => {
    const { boundary, calls } = harness(lookup([], null));
    expect((await refusal(boundary.release(ctx, handoff()))).reasons).toContain('OBSERVATION_NOT_FOUND');
    expect(calls.sink).toHaveLength(0);
  });

  it('facts of a different action than the observation\'s are refused', async () => {
    const { boundary, calls } = harness(lookup([fact({ monitoredActionId: OTHER })]));
    expect((await refusal(boundary.release(ctx, handoff()))).reasons).toContain('SOURCE_NOT_LINKED_TO_OBSERVATION');
    expect(calls.sink).toHaveLength(0);
  });
});

describe('incomplete input and failures fail closed', () => {
  it('an incomplete or invalid hand-off is refused and nothing is read', async () => {
    for (const bad of [null, undefined, 'x', {}, { payload: null }, { payload: { tenantId: T, workspaceId: W } }, handoff({ businessId: undefined, observationId: undefined })]) {
      const { boundary, calls } = harness(lookup([fact()]));
      await refusal(boundary.release(ctx, bad));
      expect(calls.sink).toHaveLength(0);
    }
    const { boundary, calls } = harness(lookup([fact()]));
    await refusal(boundary.release(ctx, { payload: { tenantId: T, workspaceId: W } }));
    expect(calls.reader).toHaveLength(0);
  });

  it('a failing lookup refuses (never "no evidence needed") and the sink is not called', async () => {
    const { boundary, calls } = harness(new Error('database unavailable'));
    const err = await refusal(boundary.release(ctx, handoff()));
    expect(err.reasons).toContain('SOURCE_LOOKUP_FAILED');
    expect(calls.sink).toHaveLength(0);
  });

  it('refusals carry codes only: no identifiers, digests or error text', async () => {
    const { boundary } = harness(lookup([fact({ tenantId: OTHER, outcomeState: 'OUTCOME_PENDING' })]));
    const err = await refusal(boundary.release(ctx, handoff()));
    const text = `${err.message} ${JSON.stringify(err.reasons)}`;
    for (const secret of [T, W, B, MA, OBS, OTHER, DIGEST, 'e1']) expect(text).not.toContain(secret);
  });

  it('a sink failure is not reported as a release and is not swallowed', async () => {
    const reader: LearningSourceReader = { learningSourcesForObservation: async () => lookup([fact()]) };
    const boundary = new LearningReleaseBoundary({ sources: reader, sink: async () => { throw new Error('downstream down'); } });
    await expect(boundary.release(ctx, handoff())).rejects.toThrow('downstream down');
  });
});
