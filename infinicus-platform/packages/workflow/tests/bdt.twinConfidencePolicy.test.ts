/** NEW-BDT-SIM-01.SEC-01 (D1): the Twin Confidence gate. It encodes only what the frozen specs define; it computes no score. */
import { describe, expect, it } from 'vitest';
import { DT_TO_SIM_MIN_CONFIDENCE, TWIN_CONFIDENCE_FACTORS, UnratifiedTwinConfidencePolicy, evaluateConfidenceGate } from '../src/performance/twinConfidencePolicy.js';
import { testAssessment } from './helpers/performanceFixtures.js';

describe('what the frozen specifications fix', () => {
  it('has exactly the seven BDT section 15 factors and the section 29 default threshold of 0.75', () => {
    expect([...TWIN_CONFIDENCE_FACTORS]).toEqual(['DATA_COMPLETENESS', 'DATA_FRESHNESS', 'DATA_QUALITY', 'HISTORICAL_DEPTH', 'MODEL_CALIBRATION', 'DEPENDENCY_COVERAGE', 'SOURCE_RELIABILITY']);
    expect(DT_TO_SIM_MIN_CONFIDENCE).toBe(0.75);
  });
  it('the production policy assesses nothing: no methodology is ratified, so the gate is closed (default deny)', async () => {
    const a = await new UnratifiedTwinConfidencePolicy().assess();
    expect(a).toMatchObject({ status: 'UNAVAILABLE', reason: expect.stringContaining('no Twin Confidence methodology has been ratified') });
    expect(evaluateConfidenceGate(a)).toMatchObject({ ok: false, code: 'CONFIDENCE_UNAVAILABLE' });
  });
});

describe('the gate', () => {
  it('passes a complete, ratified, in-range assessment at or above the threshold and records its basis (methodology, score, all seven factors with evidence)', () => {
    const g = evaluateConfidenceGate(testAssessment(0.75));
    expect(g).toMatchObject({ ok: true, score: 0.75 });
    if (!g.ok) throw new Error('x');
    const basis = JSON.parse(g.basis);
    expect(basis).toMatchObject({ kind: 'twin-confidence', score: 0.75, methodology: { id: 'TEST-ONLY-NOT-A-METHODOLOGY' } });
    expect(basis.factors.map((f: { factor: string }) => f.factor)).toEqual([...TWIN_CONFIDENCE_FACTORS]);
    expect(evaluateConfidenceGate(testAssessment(0.75))).toEqual(g);             // deterministic
  });
  it('is below threshold just under 0.75, and honours a higher policy threshold but never a lower one', () => {
    expect(evaluateConfidenceGate(testAssessment(0.7499))).toMatchObject({ ok: false, code: 'CONFIDENCE_BELOW_THRESHOLD' });
    expect(evaluateConfidenceGate(testAssessment(0.8), 0.9)).toMatchObject({ ok: false, code: 'CONFIDENCE_BELOW_THRESHOLD' });
    expect(evaluateConfidenceGate(testAssessment(0.95), 0.9)).toMatchObject({ ok: true });
    for (const lower of [0.7, 0, -1, 1.5, Number.NaN]) expect(evaluateConfidenceGate(testAssessment(0.99), lower), String(lower)).toMatchObject({ ok: false, code: 'CONFIDENCE_UNSUPPORTED' });
  });
  it.each([
    ['NaN', Number.NaN], ['infinite', Number.POSITIVE_INFINITY], ['negative', -0.1], ['above one', 1.0001], ['more than four decimals', 0.81251],
  ])('rejects an unsupported score: %s', (_n, score) => {
    expect(evaluateConfidenceGate(testAssessment(score))).toMatchObject({ ok: false, code: 'CONFIDENCE_UNSUPPORTED' });
  });
  it('rejects a score that is not a number', () => {
    expect(evaluateConfidenceGate(testAssessment('0.9' as unknown as number))).toMatchObject({ ok: false, code: 'CONFIDENCE_UNSUPPORTED' });
  });
  it('never silently completes an unavailable factor: a missing, duplicated, unknown or evidence-less factor is an incomplete basis', () => {
    const base = testAssessment(0.9);
    if (base.status !== 'ASSESSED') throw new Error('x');
    const without = { ...base, factors: base.factors.filter((f) => f.factor !== 'HISTORICAL_DEPTH') };
    expect(evaluateConfidenceGate(without)).toMatchObject({ ok: false, code: 'CONFIDENCE_BASIS_INCOMPLETE', detail: expect.stringContaining('HISTORICAL_DEPTH') });
    expect(evaluateConfidenceGate({ ...base, factors: [...base.factors, base.factors[0]!] })).toMatchObject({ code: 'CONFIDENCE_BASIS_INCOMPLETE' });
    expect(evaluateConfidenceGate({ ...base, factors: [...base.factors.slice(1), { factor: 'VIBES' as never, evidenceRef: 'x' }] })).toMatchObject({ code: 'CONFIDENCE_BASIS_INCOMPLETE' });
    expect(evaluateConfidenceGate({ ...base, factors: base.factors.map((f) => (f.factor === 'DATA_QUALITY' ? { ...f, evidenceRef: '  ' } : f)) })).toMatchObject({ code: 'CONFIDENCE_BASIS_INCOMPLETE' });
  });
  it('requires a named, ratified methodology', () => {
    const base = testAssessment(0.9);
    if (base.status !== 'ASSESSED') throw new Error('x');
    for (const m of [{ id: '', version: '1', ratification: 'r' }, { id: 'm', version: '', ratification: 'r' }, { id: 'm', version: '1', ratification: ' ' }, undefined as never]) {
      expect(evaluateConfidenceGate({ ...base, methodology: m })).toMatchObject({ ok: false, code: 'CONFIDENCE_UNSUPPORTED' });
    }
  });
  it('an assessment that is not ASSESSED is unavailable, with its reason', () => {
    expect(evaluateConfidenceGate({ status: 'UNAVAILABLE', reason: 'no data' })).toMatchObject({ ok: false, code: 'CONFIDENCE_UNAVAILABLE', detail: 'no data' });
  });
});
