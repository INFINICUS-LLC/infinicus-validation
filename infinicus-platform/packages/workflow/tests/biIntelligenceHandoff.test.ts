/**
 * BI-2-DEV-06: the BI-10 -> BI-11..BI-18 intelligence hand-off (pure). Runs come from the real calculation over a real deterministic BI-09 hand-off, so run and result
 * identities are genuine. Covers the frozen contract fields, deterministic identity, tamper detection (every field a downstream block would trust), and refusals.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  INTELLIGENCE_TARGET_BLOCKS, buildDeterministicCalculationHandoff, buildIntelligenceHandoff, calculateMetrics, deriveCalculationRunId, deriveMetricResultId, type CalculationRun,
  type MetricDefinition, type MetricScope, type WarehouseRow,
} from '../src/index.js';

afterEach(() => { vi.useRealTimers(); });

const scope: MetricScope = { tenantId: 't1', workspaceId: 'w1', businessId: 'b1' };
const DS = '11111111-1111-4111-8111-111111111111';
const metric = (over: Partial<MetricDefinition> & { metricId: string; code: string }): MetricDefinition => ({
  name: over.code, description: '', metricType: 'base', warehouseDatasetId: DS, sourceField: 'amount', aggregation: 'sum', dependencies: [], formula: null, filters: [], dimensions: [],
  timeGrain: 'month', unit: 'usd', currency: null, target: null, thresholds: {}, owner: 'cfo', governanceStatus: 'approved', version: 1, status: 'active', scope,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z', ...over,
});
const rows: WarehouseRow[] = [
  { amount: '1200.50', cost: '400.20', date: '2026-01-15T09:00:00Z' }, { amount: '800.25', cost: '350.10', date: '2026-01-20T09:00:00Z' }, { amount: '300.10', cost: '100.05', date: '2026-02-02T09:00:00Z' },
];
const registry = (): MetricDefinition[] => [
  metric({ metricId: 'rev', code: 'revenue', target: 2000, thresholds: { warningBelow: 1000 } }),
  metric({ metricId: 'cost', code: 'cost', sourceField: 'cost' }),
  metric({ metricId: 'margin', code: 'margin', metricType: 'derived', aggregation: null, sourceField: null, dependencies: ['rev', 'cost'], formula: { operator: 'subtract' } }),
];
const makeRun = (reg = registry(), data: readonly WarehouseRow[] = rows, correlationId = 'corr-1'): CalculationRun => {
  const h = buildDeterministicCalculationHandoff({ scope, registry: reg, warehouseSnapshotId: null, correlationId });
  if (!h.ok) throw new Error(h.code);
  const r = calculateMetrics({ handoff: h.handoff, rows: new Map([[DS, data]]) });
  if (!r.ok) throw new Error(r.code);
  return r.run;
};
const handoffOf = (run: CalculationRun) => { const o = buildIntelligenceHandoff(run); expect(o.ok, JSON.stringify(o)).toBe(true); return (o as Extract<typeof o, { ok: true }>).handoff; };
const code = (run: unknown) => { const o = buildIntelligenceHandoff(run as CalculationRun); return o.ok ? 'ok' : o.code; };
const mutate = (fn: (r: CalculationRun) => void): CalculationRun => { const run = structuredClone(makeRun()); fn(run); return run; };

describe('contract content', () => {
  it('carries the frozen BI-10 -> BI-11..BI-18 contract: run id, result ids, values, groups, time buckets, units, target and threshold status, source row counts, correlation id', () => {
    const run = makeRun(); const h = handoffOf(run);
    expect(h).toMatchObject({ sourceBlock: 'BI-10', status: 'ready', calculationRunId: run.calculationRunId, calculationHandoffId: run.calculationHandoffId, correlationId: 'corr-1', warehouseSnapshotId: null, handoffSourceTimestamp: '2026-02-01T00:00:00.000Z' });
    expect(h.targetBlocks).toEqual(['BI-11', 'BI-12', 'BI-13', 'BI-14', 'BI-15', 'BI-16', 'BI-17', 'BI-18']);
    expect(h.metricResultIds).toEqual(run.results.map((r) => r.metricResultId));
    const revenueJan = h.metricResults.find((r) => r.metricCode === 'revenue' && r.group.timeBucket === '2026-01')!;
    expect(revenueJan).toMatchObject({ value: '2000.75', unit: 'usd', sourceRowCount: 2, threshold: { status: 'normal', targetMet: true }, target: '2000' });
    const revenueFeb = h.metricResults.find((r) => r.metricCode === 'revenue' && r.group.timeBucket === '2026-02')!;
    expect(revenueFeb).toMatchObject({ value: '300.1', threshold: { status: 'warning', targetMet: false } });
    expect(h.metricResults.find((r) => r.metricCode === 'margin' && r.group.timeBucket === '2026-01')).toMatchObject({ value: '1250.45', sourceRowCount: null });
    expect(Object.keys(h)).not.toContain('createdAt');
  });

  it('every result is passed on unchanged, in order; the package holds copies, not the run\'s own objects', () => {
    const run = makeRun(); const h = handoffOf(run);
    expect(h.metricResults).toEqual(run.results);
    expect(h.metricResults[0]).not.toBe(run.results[0]);
    h.metricResults[0]!.value = '0'; h.metricResultIds.push('x');
    expect(run.results[0]!.value).not.toBe('0');
    expect(handoffOf(run).metricResultIds).toHaveLength(run.results.length);
  });

  it('the target blocks are exactly BI-11..BI-18', () => { expect([...INTELLIGENCE_TARGET_BLOCKS]).toEqual(Array.from({ length: 8 }, (_, i) => `BI-${11 + i}`)); });
});

describe('deterministic identity', () => {
  it('is a version-5-style UUID, identical on every replay (also when the clock moves) and independent of the request correlation id', () => {
    const a = handoffOf(makeRun());
    expect(a.intelligenceHandoffId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    vi.useFakeTimers(); vi.setSystemTime(new Date('2042-01-01T00:00:00Z'));
    const b = handoffOf(makeRun());
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    const c = handoffOf(makeRun(registry(), rows, 'another-correlation-id'));
    expect(c.intelligenceHandoffId).toBe(a.intelligenceHandoffId);
    expect({ ...c, correlationId: '' }).toEqual({ ...a, correlationId: '' });
    expect(c.correlationId).toBe('another-correlation-id');
  });

  it('changes with the rows, the definitions and therefore the results', () => {
    const base = handoffOf(makeRun()).intelligenceHandoffId;
    expect(handoffOf(makeRun(registry(), [...rows, { amount: '1', cost: '1', date: '2026-02-03T00:00:00Z' }])).intelligenceHandoffId).not.toBe(base);
    const revised = registry(); revised[1] = { ...revised[1]!, version: 2, unit: 'usd', description: 'v2' };
    expect(handoffOf(makeRun(revised)).intelligenceHandoffId).not.toBe(base);
  });

  it('the fingerprint covers the results: it is the SHA-256 of their canonical form and changes with any value', () => {
    const run = makeRun(); const h = handoffOf(run);
    expect(h.resultsFingerprint).toMatch(/^[0-9a-f]{64}$/);
    const other = makeRun(registry(), [{ amount: '1', cost: '1', date: '2026-01-01T00:00:00Z' }]);
    expect(handoffOf(other).resultsFingerprint).not.toBe(h.resultsFingerprint);
  });
});

describe('what the package identity can and cannot attest', () => {
  it('a value changed to another valid number is a different package (same run, different results): the identity names the results, not just the run', () => {
    const genuine = makeRun(); const altered = structuredClone(genuine); altered.results[0]!.value = '1';
    const a = handoffOf(genuine); const b = handoffOf(altered);
    expect(b.calculationRunId).toBe(a.calculationRunId);
    expect(b.resultsFingerprint).not.toBe(a.resultsFingerprint);
    expect(b.intelligenceHandoffId).not.toBe(a.intelligenceHandoffId);
  });
});

describe('a run that does not account for itself is refused (nothing is handed on)', () => {
  it('accepts what the calculation produces', () => { expect(code(makeRun())).toBe('ok'); });

  it.each([
    ['a forged run id', (r: CalculationRun) => { r.calculationRunId = 'f0f0f0f0-f0f0-50f0-80f0-f0f0f0f0f0f0'; }, 'RUN_IDENTITY_MISMATCH'],
    ['a changed hand-off id', (r: CalculationRun) => { r.calculationHandoffId = 'forged'; }, 'RUN_IDENTITY_MISMATCH'],
    ['altered dataset fingerprint', (r: CalculationRun) => { r.datasets[0]!.rowsFingerprint = '0'.repeat(64); }, 'RUN_IDENTITY_MISMATCH'],
    ['altered dataset row count', (r: CalculationRun) => { r.datasets[0]!.rowCount += 1; }, 'RUN_IDENTITY_MISMATCH'],
    ['a dropped dataset', (r: CalculationRun) => { r.datasets = []; }, 'RUN_IDENTITY_MISMATCH'],
    ['a missing correlation id', (r: CalculationRun) => { r.correlationId = ''; }, 'RUN_INVALID'],
    ['a malformed timestamp', (r: CalculationRun) => { r.handoffSourceTimestamp = 'yesterday'; }, 'RUN_INVALID'],
    ['a zero metric count', (r: CalculationRun) => { r.metricCount = 0; }, 'RUN_INVALID'],
    ['more result metrics than calculated metrics', (r: CalculationRun) => { r.metricCount = 1; }, 'RUN_INVALID'],
    ['a blank snapshot id', (r: CalculationRun) => { r.warehouseSnapshotId = ' '; }, 'RUN_INVALID'],
    ['no results', (r: CalculationRun) => { r.results = []; }, 'RUN_HAS_NO_RESULTS'],
    ['a result of another run', (r: CalculationRun) => { r.results[0]!.calculationRunId = 'other'; }, 'RESULT_INVALID'],
    ['a result id that does not match', (r: CalculationRun) => { r.results[0]!.metricResultId = 'f0f0f0f0-f0f0-50f0-80f0-f0f0f0f0f0f0'; }, 'RESULT_INVALID'],
    ['a result whose metric version was changed', (r: CalculationRun) => { r.results[0]!.metricVersion = 9; }, 'RESULT_INVALID'],
    ['a result whose group was changed', (r: CalculationRun) => { r.results[0]!.group = { dimensions: {}, timeBucket: '1999-01' }; }, 'RESULT_INVALID'],
    ['a value that is not canonical decimal text', (r: CalculationRun) => { r.results[0]!.value = '1e3'; }, 'RESULT_INVALID'],
    ['a value with a trailing zero', (r: CalculationRun) => { r.results[0]!.value = '2000.750'; }, 'RESULT_INVALID'],
    ['a value that is not a number', (r: CalculationRun) => { r.results[0]!.value = 'NaN'; }, 'RESULT_INVALID'],
    ['a null value that is marked completed', (r: CalculationRun) => { r.results[0]!.value = null; }, 'RESULT_INVALID'],
    ['a value that is marked no_data', (r: CalculationRun) => { r.results[0]!.calculationStatus = 'no_data'; }, 'RESULT_INVALID'],
    ['a threshold status that is not in the vocabulary', (r: CalculationRun) => { (r.results[0]!.threshold as { status: string }).status = 'great'; }, 'RESULT_INVALID'],
    ['no_data threshold on a real value', (r: CalculationRun) => { r.results[0]!.threshold.status = 'no_data'; }, 'RESULT_INVALID'],
    ['a non-boolean target status', (r: CalculationRun) => { (r.results[0]!.threshold as { targetMet: unknown }).targetMet = 'yes'; }, 'RESULT_INVALID'],
    ['a negative source row count', (r: CalculationRun) => { r.results[0]!.sourceRowCount = -1; }, 'RESULT_INVALID'],
    ['a fractional source row count', (r: CalculationRun) => { r.results[0]!.sourceRowCount = 1.5; }, 'RESULT_INVALID'],
    ['a missing unit', (r: CalculationRun) => { r.results[0]!.unit = ''; }, 'RESULT_INVALID'],
    ['a duplicated result', (r: CalculationRun) => { r.results.push(structuredClone(r.results[0]!)); }, 'RESULT_INVALID'],
    ['a malformed target', (r: CalculationRun) => { r.results[0]!.target = '2000.0'; }, 'RESULT_INVALID'],
  ])('refuses %s', (_label, change, expected) => { expect(code(mutate(change))).toBe(expected); });

  it('refuses a value or id that is not a run at all', () => {
    for (const bad of [null, undefined, 5, 'run', [], {}]) expect(code(bad)).toBe('RUN_INVALID');
  });

  it('id helpers are the ones the calculation used: a result id is a function of run, metric, version and group only', () => {
    const run = makeRun(); const r = run.results[0]!;
    expect(deriveMetricResultId(run.calculationRunId, r.metricId, r.metricVersion, r.groupKey)).toBe(r.metricResultId);
    expect(deriveMetricResultId(run.calculationRunId, r.metricId, r.metricVersion + 1, r.groupKey)).not.toBe(r.metricResultId);
    expect(deriveCalculationRunId(run.calculationHandoffId, run.datasets)).toBe(run.calculationRunId);
  });

  it('a run with no results is the calculation of a metric whose rows were all filtered out: refused, not published empty', () => {
    const none = makeRun([metric({ metricId: 'x', code: 'x', filters: [{ field: 'amount', operator: 'gt', value: 1_000_000 }] })]);
    expect(none.results).toEqual([]);
    expect(code(none)).toBe('RUN_HAS_NO_RESULTS');
  });
});
