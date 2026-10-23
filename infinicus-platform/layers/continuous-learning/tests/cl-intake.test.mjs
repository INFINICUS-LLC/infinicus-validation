import assert from 'node:assert/strict';
import { OM_TO_CL_CONTRACT_VERSION } from '@infinicus/handoff-contracts';
import { test } from 'node:test';
import { CLIntakeService } from '../dist/index.js';
import { LearningReleaseBoundary } from '@infinicus/outcome-monitoring-runtime';

const T = '11111111-1111-4111-8111-111111111111';
const W = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';
const MA = '44444444-4444-4444-8444-444444444444';
const OBS = '66666666-6666-4666-8666-666666666666';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const ctx = { tenantId: T, workspaceId: W, userId: '77777777-7777-4777-8777-777777777777' };
const handoff = () => ({
  handoffId: 'h', sourceLayer: 'OM', sourceBlock: 'OM-09', targetLayer: 'CL', targetBlock: 'CL-01', correlationId: 'opaque-correlation', status: 'ready', createdAt: '2026-10-21T00:00:00.000Z',
  lineage: [{ layer: 'OM', block: 'OM-09', recordId: OBS, timestamp: '2026-10-21T00:00:00.000Z', action: 'observation_recorded' }],
  payload: { contractVersion: OM_TO_CL_CONTRACT_VERSION, tenantId: T, workspaceId: W, businessId: B, idempotencyKey: 'k', observationId: OBS, observationVersionId: 'v', observationVersion: 1,
    feedbackPackageId: 'fb', feedbackPackageVersionId: 'fbv', feedbackStatus: 'ready', summary: 's', findings: [{ findingCode: 'f', statement: 's' }], reviewActions: [], varianceSummary: [], evidenceReferences: ['om://x'], omPublicationPackageId: 'p', targetLayer: 'continuous_learning', targetBlock: 'CL-01', publishedAt: '2026-10-21T00:00:00.000Z' },
});
const sources = (outcomeState) => ({ learningSourcesForObservation: async () => ({
  observation: { businessId: B, monitoredActionId: MA, approvedActionId: null },
  facts: [{ source: 'om_execution_verification', tenantId: T, workspaceId: W, businessId: B, executionId: 'e1', evidenceDigest: DIGEST, monitoredActionId: MA, approvedActionId: null,
    executionState: 'EXECUTION_VERIFIED', outcomeState, executionOutcome: 'SUCCEEDED', mutationResult: 'APPLIED' }],
}) });
// Explicit test-only composition. CL receives an OM release capability, never OM's raw verification reader.
const releaseFactory = (reader) => (sink) => new LearningReleaseBoundary({ sources: reader, sink });

test('CL-01 records only a gated, verified OM handoff and forwards its lineage', async () => {
  const calls = [];
  const writer = { recordReleased: async (...args) => { calls.push(args); return { package: { id: 'intake-1' }, idempotentReplay: false }; } };
  const service = new CLIntakeService(releaseFactory(sources('OUTCOME_VERIFIED')), writer);
  assert.deepEqual(await service.receive(ctx, handoff()), { package: { id: 'intake-1' }, idempotentReplay: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], ctx);
  assert.deepEqual(calls[0][1].executions, [{ executionId: 'e1', evidenceDigest: DIGEST }]);
  assert.equal(calls[0][1].omPublicationPackageId, 'p');
  assert.equal(calls[0][1].observationId, OBS);
  assert.deepEqual(calls[0][1].cl02, { status: 'rejected', reasons: ['CL02_GOVERNED_PUBLICATION_MISSING'] });
});

test('CL-02 quarantines claimed governed detail until its OM source can be verified', async () => {
  const release = handoff();
  release.sourceBlock = 'OM-24';
  release.payload.governedPublication = {
    publicationReceiptId: 'receipt', outcomeVerdictId: 'verdict', monitoringContractId: 'contract',
    confidence: 0.8, reliability: 0.9, applicabilityScope: 'branch', limitations: [],
    lessons: [], successFactors: [], failureFactors: [], hypotheses: [], decisionRuleFeedback: [],
    modelCalibrationFeedback: [], dataQualityLearning: [], operationalLearning: [], riskLearning: [],
  };
  const calls = [];
  const writer = { recordReleased: async (_, input) => { calls.push(input); return { package: { status: input.cl02.status }, idempotentReplay: false }; } };
  const result = await new CLIntakeService(releaseFactory(sources('OUTCOME_VERIFIED')), writer).receive(ctx, release);
  assert.equal(result.package.status, 'rejected');
  assert.deepEqual(calls[0].cl02.reasons, ['CL02_GOVERNED_SOURCE_UNVERIFIED']);
  assert.match(calls[0].cl02.governedPublicationDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal('governedPublication' in calls[0].cl02, false);
});

test('CL-01 refuses unverified outcome and foreign tenant without writing', async () => {
  let writes = 0;
  const writer = { recordReleased: async () => { writes++; throw Error('should not write'); } };
  await assert.rejects(new CLIntakeService(releaseFactory(sources('OUTCOME_PENDING')), writer).receive(ctx, handoff()), { code: 'LEARNING_GATE_REFUSED' });
  const foreign = handoff(); foreign.payload.tenantId = '99999999-9999-4999-8999-999999999999';
  await assert.rejects(new CLIntakeService(releaseFactory(sources('OUTCOME_VERIFIED')), writer).receive(ctx, foreign), { code: 'LEARNING_GATE_REFUSED' });
  assert.equal(writes, 0);
});

test('malformed governed publication is refused before CL intake writes', async () => {
  const invalid = handoff();
  invalid.payload.governedPublication = { confidence: 4, lessons: 'not-an-array' };
  let writes = 0;
  const writer = { recordReleased: async () => { writes++; } };
  await assert.rejects(new CLIntakeService(releaseFactory(sources('OUTCOME_VERIFIED')), writer).receive(ctx, invalid), { code: 'LEARNING_GATE_REFUSED' });
  assert.equal(writes, 0);
});

test('CL-01 propagates persistence failures without claiming a successful intake', async () => {
  const writer = { recordReleased: async () => { throw Error('database unavailable'); } };
  await assert.rejects(new CLIntakeService(releaseFactory(sources('OUTCOME_VERIFIED')), writer).receive(ctx, handoff()), /database unavailable/);
});

test('CL intake requires both capabilities explicitly and rejects raw OM readers', () => {
  const gate = releaseFactory(sources('OUTCOME_VERIFIED'));
  const writer = { recordReleased: async () => { throw Error('must not be called'); } };
  assert.throws(() => new CLIntakeService(), /explicit OM release factory/);
  assert.throws(() => new CLIntakeService(gate), /explicit OM release factory/);
  assert.throws(() => new CLIntakeService(undefined, writer), /explicit OM release factory/);
  assert.throws(() => new CLIntakeService(sources('OUTCOME_VERIFIED'), writer), /explicit OM release factory/);
});

test('lookup failures and foreign workspace handoffs cannot reach the intake writer', async () => {
  let lookups = 0; let writes = 0;
  const reader = { learningSourcesForObservation: async () => { lookups++; throw Error('unavailable'); } };
  const writer = { recordReleased: async () => { writes++; } };
  const svc = new CLIntakeService(releaseFactory(reader), writer);
  const foreign = handoff(); foreign.payload.workspaceId = '99999999-9999-4999-8999-999999999999';
  await assert.rejects(svc.receive(ctx, foreign), { code: 'LEARNING_GATE_REFUSED' });
  assert.equal(lookups, 0);
  await assert.rejects(svc.receive(ctx, handoff()), (err) => err.code === 'LEARNING_GATE_REFUSED' && err.reasons.includes('SOURCE_LOOKUP_FAILED'));
  assert.equal(lookups, 1);
  assert.equal(writes, 0);
});

test('the intake never claims a release unless the OM gate actually calls its sink', async () => {
  let writes = 0;
  const silentGate = () => ({ release: async () => ({ released: true, executions: 1 }) });
  const writer = { recordReleased: async () => { writes++; } };
  await assert.rejects(new CLIntakeService(silentGate, writer).receive(ctx, handoff()), /CL intake writer did not complete/);
  assert.equal(writes, 0);
});
