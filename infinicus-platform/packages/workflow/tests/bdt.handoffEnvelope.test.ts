/** NEW-BDT-SIM-01.SEC-01 (D2): reconstruction and independent verification of a persisted hand-off (pure; rows are synthesized). */
import { describe, expect, it } from 'vitest';
import { DT_TO_SIM_CONTRACT_VERSION, type DTToSIMHandoff } from '@infinicus/handoff-contracts';
import type { DTHandoffEnvelopeRecord, TwinConfidenceScore } from '@infinicus/database';
import { handoffDigest, PERFORMANCE_HANDOFF_SCHEMA_VERSION, verifyPersistedHandoff } from '../src/performance/handoffEnvelope.js';
import { evaluateConfidenceGate } from '../src/performance/twinConfidencePolicy.js';
import { testAssessment } from './helpers/performanceFixtures.js';

const T = '11111111-1111-4111-8111-111111111111'; const W = '22222222-2222-4222-8222-222222222222'; const B = '33333333-3333-4333-8333-333333333333';
const PKG = '44444444-4444-4444-8444-444444444444'; const SV = '55555555-5555-4555-8555-555555555555'; const SC = '66666666-6666-4666-8666-666666666666';
const gate = evaluateConfidenceGate(testAssessment(0.8125));
if (!gate.ok) throw new Error('fixture');

const handoff = (): DTToSIMHandoff => ({
  handoffId: PKG, sourceLayer: 'DT', sourceBlock: 'BDT-PERFORMANCE-01', targetLayer: 'SIM', targetBlock: 'SIM-01', correlationId: 'c1', lineage: [], status: 'ready', createdAt: '2026-11-02T10:00:00.000Z',
  payload: {
    contractVersion: DT_TO_SIM_CONTRACT_VERSION, tenantId: T, workspaceId: W, businessId: B, digitalTwinInstanceId: 'i', snapshotId: 's', snapshotVersion: 1, scenarioBaselineId: 'b', scenarioBaselineVersion: 1,
    objective: 'o', variables: [{ variableCode: 'financial.USD.revenue', value: '1.00', unit: 'USD' }], assumptions: ['a'], constraints: [], uncertaintyAssignments: [],
    evidenceReferences: ['twin-snapshot:s'], quality: { confidence: 0.8125, freshnessSeconds: 5 }, effectiveAt: '2026-11-02T10:00:00.000Z', idempotencyKey: 'bdt-performance-sim:x',
  },
});
const record = (h = handoff()): DTHandoffEnvelopeRecord => ({
  id: 'r', tenantId: T, workspaceId: W, businessId: B, dtPublicationPackageId: PKG, snapshotVersionId: SV, confidenceScoreId: SC, contractVersion: DT_TO_SIM_CONTRACT_VERSION,
  schemaVersion: PERFORMANCE_HANDOFF_SCHEMA_VERSION, correlationId: 'c1', causationId: SV, envelope: h, envelopeDigest: handoffDigest(h), sourceEvidenceDigest: 'a'.repeat(64),
  sourceRevalidatedAt: new Date(), createdAt: new Date(),
});
const score = (over: Partial<TwinConfidenceScore> = {}): TwinConfidenceScore => ({
  id: SC, tenantId: T, workspaceId: W, businessId: B, instanceId: 'i', snapshotVersionId: SV, confidence: 0.8125, basis: gate.basis, createdAt: new Date(), ...over,
});
const expected = { tenantId: T, workspaceId: W, businessId: B };

describe('a persisted hand-off verifies independently of the service that wrote it', () => {
  it('a consistent record, score and basis verify', () => {
    expect(verifyPersistedHandoff(record(), score(), expected)).toEqual({ valid: true, reasons: [] });
  });
  it('detects any change to the stored envelope (digest), including a figure inside a variable', () => {
    const r = record(); (r.envelope as DTToSIMHandoff).payload.variables[0]!.value = '999.00';
    expect(verifyPersistedHandoff(r, score(), expected).reasons).toContain('envelope_digest_mismatch');
  });
  it('detects an envelope that violates the frozen contract even when its digest was re-sealed', () => {
    const h = handoff(); (h as { status: string }).status = 'blocked';
    expect(verifyPersistedHandoff(record(h), score(), expected).reasons).toContain('frozen_contract:handoff_status_must_be_ready');
  });
  it('detects cross-tenant, cross-workspace and cross-business records', () => {
    for (const other of [{ ...expected, tenantId: 'x' }, { ...expected, workspaceId: 'x' }, { ...expected, businessId: 'x' }]) {
      expect(verifyPersistedHandoff(record(), score(), other).reasons).toContain('record_scope_mismatch');
    }
    const h = handoff(); h.payload = { ...h.payload, businessId: 'other-business' };
    expect(verifyPersistedHandoff(record(h), score(), expected).reasons).toContain('envelope_scope_mismatch');
  });
  it('detects an envelope whose tenant, workspace or business differs from the record - each field on its own', () => {
    for (const field of ['tenantId', 'workspaceId', 'businessId'] as const) {
      const h = handoff(); h.payload = { ...h.payload, [field]: 'someone-else' };
      expect(verifyPersistedHandoff(record(h), score(), expected).reasons, field).toContain('envelope_scope_mismatch');
    }
  });
  it('detects a hand-off id that is not its package, and unsupported contract or schema versions', () => {
    const h = handoff(); h.handoffId = 'not-the-package';
    expect(verifyPersistedHandoff(record(h), score(), expected).reasons).toContain('handoff_id_is_not_the_package');
    const r = record(); r.contractVersion = '9.9.9';
    expect(verifyPersistedHandoff(r, score(), expected).reasons).toContain('contract_version_mismatch');
    const s = record(); s.schemaVersion = 'other/9';
    expect(verifyPersistedHandoff(s, score(), expected).reasons).toContain('schema_version_unsupported');
  });
  it('requires the recorded confidence score, in the same scope and snapshot version, equal to the envelope\'s confidence', () => {
    expect(verifyPersistedHandoff(record(), null, expected).reasons).toContain('confidence_score_missing');
    expect(verifyPersistedHandoff(record(), score({ confidence: 0.9 }), expected).reasons).toContain('envelope_confidence_differs_from_recorded_score');
    expect(verifyPersistedHandoff(record(), score({ businessId: 'x' }), expected).reasons).toContain('confidence_score_scope_mismatch');
    expect(verifyPersistedHandoff(record(), score({ snapshotVersionId: 'x' }), expected).reasons).toContain('confidence_score_scope_mismatch');
  });
  it('requires the stored basis to name its methodology and account for all seven factors with evidence', () => {
    const noMethod = JSON.stringify({ ...JSON.parse(gate.basis), methodology: { id: '', version: '', ratification: '' } });
    expect(verifyPersistedHandoff(record(), score({ basis: noMethod }), expected).reasons).toContain('confidence_methodology_missing');
    const six = JSON.stringify({ ...JSON.parse(gate.basis), factors: JSON.parse(gate.basis).factors.slice(1) });
    expect(verifyPersistedHandoff(record(), score({ basis: six }), expected).reasons).toContain('confidence_basis_incomplete');
    const blank = JSON.stringify({ ...JSON.parse(gate.basis), factors: JSON.parse(gate.basis).factors.map((f: object, i: number) => (i === 0 ? { ...f, evidenceRef: '' } : f)) });
    expect(verifyPersistedHandoff(record(), score({ basis: blank }), expected).reasons).toContain('confidence_basis_incomplete');
    const duplicated = JSON.stringify({ ...JSON.parse(gate.basis), factors: [...JSON.parse(gate.basis).factors, JSON.parse(gate.basis).factors[0]] });      // all seven present, one repeated
    expect(verifyPersistedHandoff(record(), score({ basis: duplicated }), expected).reasons).toContain('confidence_basis_incomplete');
    const differentScore = JSON.stringify({ ...JSON.parse(gate.basis), score: 0.99 });
    expect(verifyPersistedHandoff(record(), score({ basis: differentScore }), expected).reasons).toContain('confidence_basis_mismatch');
    expect(verifyPersistedHandoff(record(), score({ basis: 'not json' }), expected).reasons).toContain('confidence_basis_unreadable');
  });
});
