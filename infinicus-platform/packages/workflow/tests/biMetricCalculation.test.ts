/**
 * BI-2-DEV-05: BI-10 metric calculation (pure rules, no database). Hand-offs are built by the real deterministic builder (BI-2-DEV-04) so their identity is genuine.
 * Expected numbers were computed independently (Python decimal). Covers: every aggregation, filters, grouping, derived / ratio / rate / target metrics, thresholds,
 * exact arithmetic, dependency order, unit and dimension validation, refusal of everything the frozen model cannot calculate, determinism, and input integrity.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_DATASET_ROWS, buildDeterministicCalculationHandoff, calculateMetrics, deriveCalculationHandoffId, type CalculationHandoff, type MetricDefinition, type MetricScope,
  type WarehouseRow, type CalculationRun,
} from '../src/index.js';

afterEach(() => { vi.useRealTimers(); });

const scope: MetricScope = { tenantId: 't1', workspaceId: 'w1', businessId: 'b1' };
const DS = '11111111-1111-4111-8111-111111111111';
const metric = (over: Partial<MetricDefinition> & { metricId: string; code: string }): MetricDefinition => ({
  name: over.code, description: '', metricType: 'base', warehouseDatasetId: DS, sourceField: 'amount', aggregation: 'sum', dependencies: [], formula: null, filters: [], dimensions: [],
  timeGrain: 'all_time', unit: 'usd', currency: null, target: null, thresholds: {}, owner: 'cfo', governanceStatus: 'approved', version: 1, status: 'active', scope,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z', ...over,
});
const rows: WarehouseRow[] = [
  { amount: '10.10', region: 'north', date: '2026-01-05T10:00:00Z', cust: 'a', status: 'paid' },
  { amount: 0.2, region: 'north', date: '2026-01-20T00:00:00Z', cust: 'b', status: 'paid' },
  { amount: 0.1, region: 'south', date: '2026-02-03T00:00:00Z', cust: 'a', status: 'refunded' },
  { amount: 100, region: 'south', date: '2026-02-10T00:00:00Z', cust: 'c', status: 'paid' },
  { amount: null, region: 'north', date: '2026-02-11T00:00:00Z', cust: 'a', status: 'paid' },
  { amount: 5, cust: 'd', status: 'paid' },
];
const handoff = (registry: MetricDefinition[], over: Record<string, unknown> = {}): CalculationHandoff => {
  const r = buildDeterministicCalculationHandoff({ scope, registry, warehouseSnapshotId: null, correlationId: 'corr-1', ...over });
  if (!r.ok) throw new Error(`fixture hand-off refused: ${r.code} ${r.detail}`);
  return r.handoff;
};
const run = (registry: MetricDefinition[], data: readonly WarehouseRow[] = rows, over: Record<string, unknown> = {}) => calculateMetrics({ handoff: handoff(registry, over), rows: new Map([[DS, data]]) });
const ok = (o: ReturnType<typeof calculateMetrics>): CalculationRun => { expect(o.ok, JSON.stringify(o)).toBe(true); return (o as { run: CalculationRun }).run; };
const values = (r: CalculationRun, code?: string) => r.results.filter((x) => !code || x.metricCode === code).map((x) => x.value);
const refused = (o: ReturnType<typeof calculateMetrics>) => (o.ok ? 'ok' : o.code);

describe('base metrics: every aggregation, calculated exactly', () => {
  const one = (aggregation: string, field = 'amount') => values(ok(run([metric({ metricId: 'm', code: 'm', aggregation: aggregation as never, sourceField: field })])));
  it.each([
    ['sum', ['115.4']], ['count', ['6']], ['average', ['23.08']], ['minimum', ['0.1']], ['maximum', ['100']], ['median', ['5']], ['first', ['10.1']], ['last', ['5']],
  ])('%s of amount', (aggregation, expected) => { expect(one(aggregation)).toEqual(expected); });

  it('counts distinct non-null values (a, b, c, d) and counts every row for count', () => {
    expect(one('count_distinct', 'cust')).toEqual(['4']);
    expect(one('count_distinct', 'status')).toEqual(['2']);
  });

  it('the median of an even number of values is the exact mean of the two middle values', () => {
    expect(values(ok(run([metric({ metricId: 'm', code: 'm', aggregation: 'median' })], [{ amount: 1 }, { amount: 2 }, { amount: '3.3' }, { amount: 10 }])))).toEqual(['2.65']);
  });

  it('null and absent values are skipped by value aggregations; an all-null group has no value (no_data), except sum, which is 0, and count, which counts rows', () => {
    const nulls = [{ amount: null }, {}];
    expect(values(ok(run([metric({ metricId: 'm', code: 'm', aggregation: 'sum' })], nulls)))).toEqual(['0']);
    expect(values(ok(run([metric({ metricId: 'm', code: 'm', aggregation: 'average' })], nulls)))).toEqual([null]);
    expect(ok(run([metric({ metricId: 'm', code: 'm', aggregation: 'maximum' })], nulls)).results[0]).toMatchObject({ value: null, calculationStatus: 'no_data', threshold: { status: 'no_data', targetMet: false } });
    expect(values(ok(run([metric({ metricId: 'm', code: 'm', aggregation: 'count', sourceField: null })], nulls)))).toEqual(['2']);
  });

  it('is exact where doubles are not: 0.1+0.2 sums to 0.3, and large integer sums do not lose digits', () => {
    expect(values(ok(run([metric({ metricId: 'm', code: 'm' })], [{ amount: 0.1 }, { amount: 0.2 }])))).toEqual(['0.3']);
    expect(values(ok(run([metric({ metricId: 'm', code: 'm' })], [{ amount: '9007199254740993' }, { amount: 1 }])))).toEqual(['9007199254740994']);
  });

  it('a metric with no row left after its filters has no result group (nothing is fabricated)', () => {
    expect(ok(run([metric({ metricId: 'm', code: 'm', filters: [{ field: 'status', operator: 'eq', value: 'cancelled' }] })])).results).toEqual([]);
  });
});

describe('filters', () => {
  const sum = (filters: unknown[]) => values(ok(run([metric({ metricId: 'm', code: 'm', filters })])));
  it.each([
    [[{ field: 'status', operator: 'eq', value: 'paid' }], ['115.3']],
    [[{ field: 'status', operator: 'neq', value: 'paid' }], ['0.1']],
    [[{ field: 'amount', operator: 'gt', value: 5 }], ['100']], // the string "10.10" is not compared with the number 5
    [[{ field: 'amount', operator: 'gte', value: 5 }], ['105']],
    [[{ field: 'amount', operator: 'lt', value: 1 }], ['0.3']],
    [[{ field: 'amount', operator: 'lte', value: 0.2 }], ['0.3']],
    [[{ field: 'region', operator: 'in', value: ['north', 'south'] }], ['110.4']],
    [[{ field: 'region', operator: 'not_in', value: ['north'] }], ['105.1']],
    [[{ field: 'cust', operator: 'contains', value: 'a' }], ['10.2']],
    [[{ field: 'status', operator: 'eq', value: 'paid' }, { field: 'region', operator: 'eq', value: 'north' }], ['10.3']],
  ])('%j -> %j', (filters, expected) => { expect(sum(filters)).toEqual(expected); });

  it('compares numbers exactly and never across types (a string "5" is not the number 5)', () => {
    expect(values(ok(run([metric({ metricId: 'm', code: 'm', filters: [{ field: 'v', operator: 'eq', value: 0.3 }] })], [{ amount: 1, v: 0.3 }, { amount: 2, v: '0.3' }])))).toEqual(['1']);
    expect(values(ok(run([metric({ metricId: 'm', code: 'm', filters: [{ field: 'v', operator: 'gt', value: 5 }] })], [{ amount: 1, v: '9' }, { amount: 2, v: 9 }])))).toEqual(['2']);
  });

  it.each([
    ['an unknown operator (the frozen engine ignored it)', [{ field: 'status', operator: 'regex', value: 'x' }]],
    ['a missing operator', [{ field: 'status', value: 'x' }]],
    ['the non-frozen "op" spelling', [{ field: 'status', op: 'eq', value: 'x' }]],
    ['a missing field', [{ operator: 'eq', value: 'x' }]],
    ['in without a list', [{ field: 'status', operator: 'in', value: 'x' }]],
    ['eq with a list', [{ field: 'status', operator: 'eq', value: ['x'] }]],
    ['a missing value', [{ field: 'status', operator: 'eq' }]],
    ['a non-object filter', ['status=paid']],
  ])('refuses %s', (_label, filters) => { expect(refused(run([metric({ metricId: 'm', code: 'm', filters })]))).toBe('FILTER_INVALID'); });
});

describe('grouping by dimensions and time grain', () => {
  it('groups by a dimension; a missing value is the group "unknown"; groups are ordered by key', () => {
    const r = ok(run([metric({ metricId: 'm', code: 'm', dimensions: ['region'] })]));
    expect(r.results.map((x) => [x.group.dimensions, x.value, x.sourceRowCount])).toEqual([[{ region: 'north' }, '10.3', 3], [{ region: 'south' }, '100.1', 2], [{ region: 'unknown' }, '5', 1]]);
  });

  it('groups by month (UTC); an absent date is the bucket "unknown"', () => {
    const r = ok(run([metric({ metricId: 'm', code: 'm', timeGrain: 'month' })]));
    expect(r.results.map((x) => [x.group.timeBucket, x.value])).toEqual([['2026-01', '10.3'], ['2026-02', '100.1'], ['unknown', '5']]);
  });

  it('supports day and year, and a custom time field named by formula.timeField', () => {
    expect(ok(run([metric({ metricId: 'm', code: 'm', timeGrain: 'year' })])).results.map((x) => [x.group.timeBucket, x.value])).toEqual([['2026', '110.4'], ['unknown', '5']]);
    expect(ok(run([metric({ metricId: 'm', code: 'm', timeGrain: 'day' })])).results.map((x) => x.group.timeBucket)).toEqual(['2026-01-05', '2026-01-20', '2026-02-03', '2026-02-10', '2026-02-11', 'unknown']);
    const r = ok(run([metric({ metricId: 'm', code: 'm', timeGrain: 'month', formula: { timeField: 'booked' } })], [{ amount: 1, booked: '2025-12-31T23:59:59Z', date: '2030-01-01' }, { amount: 2, booked: 1767225600000 }]));
    expect(r.results.map((x) => [x.group.timeBucket, x.value])).toEqual([['2025-12', '1'], ['2026-01', '2']]);
  });

  it('combines dimensions and time; the dimension order in the definition does not matter', () => {
    const a = ok(run([metric({ metricId: 'm', code: 'm', dimensions: ['region', 'status'], timeGrain: 'month' })]));
    const b = ok(run([metric({ metricId: 'm', code: 'm', dimensions: ['status', 'region'], timeGrain: 'month' })]));
    expect(a.results.map((x) => [x.groupKey, x.value])).toEqual(b.results.map((x) => [x.groupKey, x.value]));
    expect(a.results.length).toBeGreaterThan(3);
  });

  it('refuses the grains the frozen BI-10 does not define instead of treating them as all-time', () => {
    for (const grain of ['week', 'quarter', 'hour', '']) expect(refused(run([metric({ metricId: 'm', code: 'm', timeGrain: grain })]))).toBe('TIME_GRAIN_UNSUPPORTED');
  });

  it('refuses a non-scalar dimension value', () => {
    expect(refused(run([metric({ metricId: 'm', code: 'm', dimensions: ['region'] })], [{ amount: 1, region: { x: 1 } }]))).toBe('ROWS_INVALID');
  });
});

describe('derived, ratio, rate and target metrics', () => {
  const paid = metric({ metricId: 'paid', code: 'paid', filters: [{ field: 'status', operator: 'eq', value: 'paid' }] });
  const all = metric({ metricId: 'all', code: 'all' });
  const derived = (operator: string, deps: string[], over: Partial<MetricDefinition> = {}) => metric({ metricId: 'd', code: 'd', metricType: 'derived', aggregation: null, sourceField: null, dependencies: deps, formula: { operator }, ...over });

  it('subtract is exact: all - paid = 0.1 (doubles give 0.10000000000000853)', () => {
    expect(values(ok(run([all, paid, derived('subtract', ['all', 'paid'])])), 'd')).toEqual(['0.1']);
  });
  it('add, multiply and divide', () => {
    expect(values(ok(run([all, paid, derived('add', ['all', 'paid'])])), 'd')).toEqual(['230.7']);
    expect(values(ok(run([all, paid, derived('multiply', ['all', 'paid'])])), 'd')).toEqual(['13305.62']);
    expect(values(ok(run([all, paid, derived('divide', ['paid', 'all'])])), 'd')).toEqual(['0.9991334489']);
  });
  it('subtract takes the first dependency minus every following one', () => {
    const third = metric({ metricId: 'third', code: 'third', filters: [{ field: 'status', operator: 'eq', value: 'refunded' }] });
    expect(values(ok(run([all, paid, third, derived('subtract', ['all', 'paid', 'third'])])), 'd')).toEqual(['0']);
  });
  it('ratio is numerator / denominator and rate is x 100, each divided once (no double rounding)', () => {
    expect(values(ok(run([all, paid, derived('', ['paid', 'all'], { metricType: 'ratio', formula: null, unit: 'ratio' })])), 'd')).toEqual(['0.9991334489']);
    expect(values(ok(run([all, paid, derived('', ['paid', 'all'], { metricType: 'rate', formula: null, unit: 'percent' })])), 'd')).toEqual(['99.9133448873']);
  });
  it('a zero or missing denominator gives no value, never an error and never 0', () => {
    const zero = metric({ metricId: 'zero', code: 'zero', filters: [{ field: 'status', operator: 'eq', value: 'cancelled' }], sourceField: 'amount' });
    const r = ok(run([all, zero, derived('', ['all', 'zero'], { metricType: 'ratio', formula: null })], [...rows, { amount: 0, status: 'cancelled' }]));
    expect(r.results.find((x) => x.metricCode === 'd')).toMatchObject({ value: null, calculationStatus: 'no_data' });
    const least = metric({ metricId: 'least', code: 'least', aggregation: 'minimum' });
    expect(ok(run([all, least, derived('divide', ['all', 'least'])], [{ amount: 0 }])).results.find((x) => x.metricCode === 'd')).toMatchObject({ value: null });
  });
  it('a dependency without a value for a group makes that group no_data (the frozen engine treated it as 0)', () => {
    const north = metric({ metricId: 'n', code: 'n', dimensions: ['region'], filters: [{ field: 'region', operator: 'eq', value: 'north' }] });
    const everyone = metric({ metricId: 'e', code: 'e', dimensions: ['region'] });
    const r = ok(run([north, everyone, derived('subtract', ['e', 'n'], { dimensions: ['region'] })]));
    expect(r.results.filter((x) => x.metricCode === 'd').map((x) => [x.group.dimensions, x.value])).toEqual([[{ region: 'north' }, '0'], [{ region: 'south' }, null], [{ region: 'unknown' }, null]]);
  });
  it('a target metric returns its governed target and applies to every group of a metric that compares with it', () => {
    const goal = metric({ metricId: 'goal', code: 'goal', metricType: 'target', aggregation: null, sourceField: null, target: 120.5 });
    expect(values(ok(run([goal])))).toEqual(['120.5']);
    const monthly = metric({ metricId: 'rev', code: 'rev', timeGrain: 'month' });
    const attainment = derived('', ['rev', 'goal'], { metricType: 'ratio', formula: null, timeGrain: 'month', unit: 'ratio' });
    expect(ok(run([monthly, goal, attainment])).results.filter((x) => x.metricCode === 'd').map((x) => [x.group.timeBucket, x.value])).toEqual([['2026-01', '0.0854771784'], ['2026-02', '0.8307053942'], ['unknown', '0.0414937759']]);
  });
  it('derived metrics group like their dependencies and carry no source row count', () => {
    const r = ok(run([metric({ metricId: 'a', code: 'a', dimensions: ['region'] }), metric({ metricId: 'b', code: 'b', dimensions: ['region'], filters: [{ field: 'status', operator: 'eq', value: 'paid' }] }), derived('subtract', ['a', 'b'], { dimensions: ['region'] })]));
    expect(r.results.filter((x) => x.metricCode === 'd').map((x) => [x.group.dimensions.region, x.value, x.sourceRowCount])).toEqual([['north', '0', null], ['south', '0.1', null], ['unknown', '0', null]]);
  });
  it('is calculated in dependency order whatever the order of the hand-off, with dependencies that depend on dependencies', () => {
    const a = metric({ metricId: 'a', code: 'zz_a' });
    const b = derived('add', ['a', 'a2'], { metricId: 'b', code: 'aa_b' });
    const a2 = metric({ metricId: 'a2', code: 'mm_a2', filters: [{ field: 'status', operator: 'eq', value: 'paid' }] });
    const c = derived('subtract', ['b', 'a2'], { metricId: 'c', code: 'bb_c' });
    expect(values(ok(run([c, b, a2, a])), 'bb_c')).toEqual(['115.4']);
  });
});

describe('thresholds and targets', () => {
  const t = (value: number, thresholds: Record<string, unknown>, target: number | null = null) =>
    ok(run([metric({ metricId: 'm', code: 'm', thresholds, target })], [{ amount: value }])).results[0]!.threshold;
  it.each([
    [10, { criticalBelow: 20, warningBelow: 50 }, 'critical'], [30, { criticalBelow: 20, warningBelow: 50 }, 'warning'], [60, { criticalBelow: 20, warningBelow: 50 }, 'normal'],
    [200, { criticalAbove: 150, warningAbove: 100 }, 'critical'], [120, { criticalAbove: 150, warningAbove: 100 }, 'warning'], [90, { criticalAbove: 150, warningAbove: 100 }, 'normal'],
    [100, { goodAbove: 100 }, 'good'], [99.99, { goodAbove: 100 }, 'normal'], [50, {}, 'normal'], [50, { unrelatedKey: 'x' }, 'normal'],
  ])('value %s with %j is %s', (value, thresholds, status) => { expect(t(value, thresholds).status).toBe(status); });

  it('compares exactly at the boundary (0.1 + 0.2 is not below 0.3)', () => {
    expect(ok(run([metric({ metricId: 'm', code: 'm', thresholds: { warningBelow: 0.3 } })], [{ amount: 0.1 }, { amount: 0.2 }])).results[0]!.threshold.status).toBe('normal');
  });
  it('evaluates the target: at or above by default, at or below when targetDirection is below, and null without a target', () => {
    expect(t(100, {}, 100).targetMet).toBe(true); expect(t(99.9, {}, 100).targetMet).toBe(false);
    expect(t(100, { targetDirection: 'below' }, 100).targetMet).toBe(true); expect(t(100.1, { targetDirection: 'below' }, 100).targetMet).toBe(false);
    expect(t(100, {}).targetMet).toBeNull();
  });
  it('reports the governed target as exact text on the result', () => {
    expect(ok(run([metric({ metricId: 'm', code: 'm', target: 0.1 })])).results[0]!.target).toBe('0.1');
  });
  it.each([
    ['a non-numeric threshold', { warningBelow: '50' }], ['a non-finite threshold', { criticalAbove: Number.POSITIVE_INFINITY }], ['an unknown direction', { targetDirection: 'sideways' }], ['malformed thresholds', null],
  ])('refuses %s', (_label, thresholds) => { expect(refused(run([metric({ metricId: 'm', code: 'm', thresholds: thresholds as never })]))).toBe('THRESHOLD_INVALID'); });
});

describe('validation: unit, dimension, formula, dependency and input refusals (nothing partial is returned)', () => {
  const a = metric({ metricId: 'a', code: 'a' }); const b = metric({ metricId: 'b', code: 'b' });
  const derived = (over: Partial<MetricDefinition>) => metric({ metricId: 'd', code: 'd', metricType: 'derived', aggregation: null, sourceField: null, dependencies: ['a', 'b'], formula: { operator: 'add' }, ...over });

  it.each([
    ['add of different units', [a, metric({ metricId: 'b', code: 'b', unit: 'eur' }), derived({})], 'UNIT_MISMATCH'],
    ['subtract of different currencies', [metric({ metricId: 'a', code: 'a', currency: 'USD' }), metric({ metricId: 'b', code: 'b', currency: 'EUR' }), derived({ formula: { operator: 'subtract' }, currency: 'USD' })], 'UNIT_MISMATCH'],
    ['add whose own unit differs from its dependencies', [a, b, derived({ unit: 'eur' })], 'UNIT_MISMATCH'],
    ['dimensions that differ from a dependency', [a, metric({ metricId: 'b', code: 'b', dimensions: ['region'] }), derived({})], 'DIMENSION_MISMATCH'],
    ['a time grain that differs from a dependency', [a, metric({ metricId: 'b', code: 'b', timeGrain: 'month' }), derived({})], 'DIMENSION_MISMATCH'],
    ['an unknown operator', [a, b, derived({ formula: { operator: 'power' } })], 'FORMULA_INVALID'],
    ['no operator', [a, b, derived({ formula: null })], 'FORMULA_INVALID'],
    ['divide with three dependencies', [a, b, metric({ metricId: 'c', code: 'c' }), derived({ dependencies: ['a', 'b', 'c'], formula: { operator: 'divide' } })], 'FORMULA_INVALID'],
    ['derived with one dependency', [a, derived({ dependencies: ['a'] })], 'FORMULA_INVALID'],
    ['ratio with three dependencies', [a, b, metric({ metricId: 'c', code: 'c' }), derived({ metricType: 'ratio', dependencies: ['a', 'b', 'c'] })], 'FORMULA_INVALID'],
    ['a base metric with dependencies', [a, metric({ metricId: 'x', code: 'x', dependencies: ['a'] })], 'FORMULA_INVALID'],
    ['a target metric without a target', [metric({ metricId: 'g', code: 'g', metricType: 'target', aggregation: null, sourceField: null, target: null })], 'FORMULA_INVALID'],
    ['a target metric with dependencies', [a, metric({ metricId: 'g', code: 'g', metricType: 'target', aggregation: null, sourceField: null, target: 1, dependencies: ['a'] })], 'FORMULA_INVALID'],
    ['a derived metric with filters', [a, b, derived({ filters: [{ field: 'x', operator: 'eq', value: 1 }] })], 'FILTER_INVALID'],
    ['a base metric without an aggregation', [metric({ metricId: 'x', code: 'x', aggregation: null })], 'METRIC_UNSUPPORTED'],
    ['an unsupported type', [metric({ metricId: 'x', code: 'x', metricType: 'kpi' as never })], 'METRIC_UNSUPPORTED'],
    ['sum without a source field', [metric({ metricId: 'x', code: 'x', sourceField: null })], 'SOURCE_FIELD_REQUIRED'],
    ['malformed dimensions', [metric({ metricId: 'x', code: 'x', dimensions: ['a', 'a'] })], 'DIMENSION_MISMATCH'],
  ])('refuses %s', (_label, registry, code) => { expect(refused(run(registry as MetricDefinition[]))).toBe(code); });

  it('refuses a dependency cycle and an unknown dependency in a tampered hand-off, by name of the rule, without recursion limits', () => {
    const x = derived({ metricId: 'x', code: 'x', dependencies: ['y', 'a'] }); const y = derived({ metricId: 'y', code: 'y', dependencies: ['x', 'a'] });
    const build = (metrics: MetricDefinition[]): CalculationHandoff => ({
      calculationHandoffId: deriveCalculationHandoffId(scope, null, metrics), targetBlock: 'BI-10', scope, warehouseSnapshotId: null, correlationId: 'c', metrics,
      metricVersions: metrics.map((m) => ({ metricId: m.metricId, version: m.version })), status: 'ready', createdAt: '2026-02-01T00:00:00.000Z',
    });
    expect(refused(calculateMetrics({ handoff: build([a, x, y]), rows: new Map([[DS, rows]]) }))).toBe('DEPENDENCY_CYCLE');
    expect(refused(calculateMetrics({ handoff: build([metric({ metricId: 's', code: 's', metricType: 'derived', aggregation: null, sourceField: null, dependencies: ['s', 'a'], formula: { operator: 'add' } }), a]), rows: new Map([[DS, rows]]) }))).toBe('DEPENDENCY_CYCLE');
    expect(refused(calculateMetrics({ handoff: build([a, derived({ dependencies: ['a', 'ghost'] })]), rows: new Map([[DS, rows]]) }))).toBe('DEPENDENCY_UNKNOWN');
    expect(refused(calculateMetrics({ handoff: build([a, derived({ dependencies: ['a', 'a'] })]), rows: new Map([[DS, rows]]) }))).toBe('FORMULA_INVALID');
  });

  it('handles a long dependency chain', () => {
    const chain = [metric({ metricId: 'c0', code: 'c000' }), metric({ metricId: 'b0', code: 'b000' })];
    for (let i = 1; i < 300; i += 1) chain.push(metric({ metricId: `c${i}`, code: `c${String(i).padStart(3, '0')}`, metricType: 'derived', aggregation: null, sourceField: null, dependencies: [`c${i - 1}`, 'b0'], formula: { operator: 'add' } }));
    const out = ok(run(chain, [{ amount: 1 }]));
    expect(out.results.find((x) => x.metricCode === 'c299')!.value).toBe('300');
  });

  it('refuses rows it cannot calculate: non-numeric values, booleans, non-finite numbers, non-object rows, oversize and missing datasets', () => {
    const sum = [metric({ metricId: 'm', code: 'm' })];
    expect(refused(run(sum, [{ amount: 'abc' }]))).toBe('VALUE_NOT_NUMERIC');
    expect(refused(run(sum, [{ amount: true }]))).toBe('VALUE_NOT_NUMERIC');
    expect(refused(run(sum, [{ amount: Number.NaN }]))).toBe('VALUE_NOT_NUMERIC');
    expect(refused(run(sum, [{ amount: ' 1' }]))).toBe('VALUE_NOT_NUMERIC');
    expect(refused(run(sum, [{ amount: { x: 1 } }]))).toBe('VALUE_NOT_NUMERIC');
    expect(refused(run(sum, [5 as never]))).toBe('ROWS_INVALID');
    expect(refused(run(sum, 'rows' as never))).toBe('ROWS_INVALID');
    expect(refused(calculateMetrics({ handoff: handoff(sum), rows: new Map() }))).toBe('DATASET_ROWS_UNAVAILABLE');
    expect(refused(calculateMetrics({ handoff: handoff(sum), rows: new Map([['other-dataset', rows]]) }))).toBe('DATASET_ROWS_UNAVAILABLE');
  });

  it('the dataset size limit is the frozen 100000 rows: exactly that many calculate, one more is refused whole - never truncated', () => {
    expect(MAX_DATASET_ROWS).toBe(100_000);
    const sum = [metric({ metricId: 'm', code: 'm' })];
    const full = Array.from({ length: MAX_DATASET_ROWS }, () => ({ amount: 1 }));
    expect(values(ok(run(sum, full)))).toEqual(['100000']);
    const out = run(sum, [...full, { amount: 1 }]);
    expect(out).toMatchObject({ ok: false, code: 'DATASET_TOO_LARGE' });
    expect(out.ok).toBe(false);
  });

  it('only datasets read by base metrics are needed: a target metric needs no rows', () => {
    expect(ok(calculateMetrics({ handoff: handoff([metric({ metricId: 'g', code: 'g', metricType: 'target', aggregation: null, sourceField: null, target: 7 })]), rows: new Map() })).results[0]!.value).toBe('7');
  });
});

describe('the hand-off is checked before anything is calculated', () => {
  const base = metric({ metricId: 'a', code: 'a' });
  const good = () => handoff([base]);
  const attempt = (h: unknown) => refused(calculateMetrics({ handoff: h as CalculationHandoff, rows: new Map([[DS, rows]]) }));

  it('accepts what the real builder produces', () => { expect(attempt(good())).toBe('ok'); });
  it('refuses a hand-off whose content no longer matches its identity (any altered definition, snapshot or metric set)', () => {
    const h = good(); h.metrics[0] = { ...h.metrics[0]!, unit: 'eur' }; expect(attempt(h)).toBe('HANDOFF_INVALID');
    const s = good(); s.warehouseSnapshotId = 'snap'; expect(attempt(s)).toBe('HANDOFF_INVALID');
    const f = good(); f.metrics[0] = { ...f.metrics[0]!, filters: [{ field: 'status', operator: 'eq', value: 'paid' }] }; expect(attempt(f)).toBe('HANDOFF_INVALID');
    const id = good(); id.calculationHandoffId = 'forged'; expect(attempt(id)).toBe('HANDOFF_INVALID');
  });
  it('refuses a hand-off that is not ready, not for BI-10, incomplete or inconsistent', () => {
    expect(attempt({ ...good(), status: 'blocked' })).toBe('HANDOFF_INVALID');
    expect(attempt({ ...good(), targetBlock: 'BI-11' })).toBe('HANDOFF_INVALID');
    expect(attempt({ ...good(), metrics: [], metricVersions: [] })).toBe('HANDOFF_INVALID');
    expect(attempt({ ...good(), metricVersions: [] })).toBe('HANDOFF_INVALID');
    expect(attempt({ ...good(), metricVersions: [{ metricId: 'a', version: 9 }] })).toBe('HANDOFF_INVALID');
    expect(attempt({ ...good(), correlationId: '' })).toBe('HANDOFF_INVALID');
    expect(attempt({ ...good(), createdAt: 'not a date' })).toBe('HANDOFF_INVALID');
    expect(attempt({ ...good(), scope: { tenantId: 't1', workspaceId: '', businessId: 'b1' } })).toBe('HANDOFF_INVALID');
    expect(attempt(null)).toBe('HANDOFF_INVALID');
  });
  it('refuses a metric of another scope or one that is not approved and active, even when the identity was computed over it', () => {
    const forge = (metrics: MetricDefinition[]): CalculationHandoff => ({ ...good(), calculationHandoffId: deriveCalculationHandoffId(scope, null, metrics), metrics, metricVersions: metrics.map((m) => ({ metricId: m.metricId, version: m.version })) });
    expect(attempt(forge([metric({ metricId: 'a', code: 'a', scope: { ...scope, businessId: 'other' } })]))).toBe('SCOPE_MISMATCH');
    expect(attempt(forge([metric({ metricId: 'a', code: 'a', scope: { ...scope, tenantId: 'other' } })]))).toBe('SCOPE_MISMATCH');
    expect(attempt(forge([metric({ metricId: 'a', code: 'a', governanceStatus: 'draft' })]))).toBe('HANDOFF_NOT_APPROVED');
    expect(attempt(forge([metric({ metricId: 'a', code: 'a', status: 'deprecated' })]))).toBe('HANDOFF_NOT_APPROVED');
    expect(attempt(forge([base, base]))).toBe('HANDOFF_INVALID');
  });
});

describe('determinism, provenance and integrity', () => {
  const registry = () => [
    metric({ metricId: 'all', code: 'all', dimensions: ['region'], timeGrain: 'month', target: 100, thresholds: { warningBelow: 50 } }),
    metric({ metricId: 'paid', code: 'paid', dimensions: ['region'], timeGrain: 'month', filters: [{ field: 'status', operator: 'eq', value: 'paid' }] }),
    metric({ metricId: 'gap', code: 'gap', metricType: 'derived', aggregation: null, sourceField: null, dependencies: ['all', 'paid'], formula: { operator: 'subtract' }, dimensions: ['region'], timeGrain: 'month' }),
  ];

  it('the same hand-off and rows give a byte-identical run, also when the clock moves', () => {
    const first = JSON.stringify(ok(run(registry())));
    vi.useFakeTimers(); vi.setSystemTime(new Date('2041-05-05T00:00:00Z'));
    expect(JSON.stringify(ok(run(registry())))).toBe(first);
  });

  it('is independent of the order the registry lists metrics in', () => {
    const forward = ok(run(registry())); const reversed = ok(run([...registry()].reverse()));
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });

  it('ids are derived: run id from the hand-off and the exact rows, result id from run, metric version and group', () => {
    const a = ok(run(registry())); const b = ok(run(registry()));
    expect(a.calculationRunId).toBe(b.calculationRunId);
    expect(a.calculationRunId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Set(a.results.map((r) => r.metricResultId)).size).toBe(a.results.length);
    expect(a.results.every((r) => r.calculationRunId === a.calculationRunId)).toBe(true);
    expect(ok(run(registry(), [...rows, { amount: 1, status: 'paid' }])).calculationRunId).not.toBe(a.calculationRunId);
    const bumped = registry(); bumped[0] = { ...bumped[0]!, version: 2 };
    expect(ok(run(bumped)).results[0]!.metricResultId).not.toBe(a.results[0]!.metricResultId);
  });

  it('a different correlation id changes only the correlation id: values, ids and fingerprints are the same', () => {
    const a = ok(run(registry(), rows, { correlationId: 'one' })); const b = ok(run(registry(), rows, { correlationId: 'two' }));
    expect({ ...a, correlationId: '' }).toEqual({ ...b, correlationId: '' });
  });

  it('records what was calculated from: the hand-off, the snapshot, the source timestamp, each dataset with its row count and fingerprint, and each definition version and content hash', () => {
    const r = ok(run(registry()));
    expect(r).toMatchObject({ calculationHandoffId: expect.any(String), warehouseSnapshotId: null, correlationId: 'corr-1', handoffSourceTimestamp: '2026-02-01T00:00:00.000Z', metricCount: 3 });
    expect(r.datasets).toEqual([{ warehouseDatasetId: DS, rowCount: 6, rowsFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    for (const x of r.results) expect(x).toMatchObject({ metricVersion: 1, metricContentHash: expect.stringMatching(/^[0-9a-f]{64}$/), warehouseDatasetId: DS, calculationHandoffId: r.calculationHandoffId });
    expect(Object.keys(r)).not.toContain('calculatedAt'); expect(Object.keys(r.results[0]!)).not.toContain('calculatedAt');
  });

  it('the fingerprint changes with any row, field value, row order or row count, and not with key order', () => {
    const fp = (data: WarehouseRow[]) => ok(run([metric({ metricId: 'm', code: 'm' })], data)).datasets[0]!.rowsFingerprint;
    const base = fp([{ amount: 1, x: 'a' }, { amount: 2, x: 'b' }]);
    expect(fp([{ x: 'a', amount: 1 }, { x: 'b', amount: 2 }])).toBe(base);
    expect(fp([{ amount: 2, x: 'b' }, { amount: 1, x: 'a' }])).not.toBe(base);
    expect(fp([{ amount: 1, x: 'a' }, { amount: 2, x: 'c' }])).not.toBe(base);
    expect(fp([{ amount: 1, x: 'a' }])).not.toBe(base);
  });

  it('sums are independent of row order (only first and last depend on it, and the fingerprint records the order)', () => {
    const reversed = [...rows].reverse();
    const a = ok(run([metric({ metricId: 'm', code: 'm' })], rows)); const b = ok(run([metric({ metricId: 'm', code: 'm' })], reversed));
    expect(values(a)).toEqual(values(b)); expect(a.calculationRunId).not.toBe(b.calculationRunId);
    expect(values(ok(run([metric({ metricId: 'm', code: 'm', aggregation: 'first' })], reversed)))).toEqual(['5']);
  });

  it('never modifies the hand-off or the rows it is given (deep-frozen inputs are accepted)', () => {
    const deepFreeze = <T,>(v: T): T => { if (typeof v === 'object' && v !== null) { Object.values(v).forEach(deepFreeze); Object.freeze(v); } return v; };
    const h = deepFreeze(handoff(registry())); const data = deepFreeze(rows.map((r) => ({ ...r })));
    const before = JSON.stringify([h, data]);
    ok(calculateMetrics({ handoff: h, rows: new Map([[DS, data]]) }));
    expect(JSON.stringify([h, data])).toBe(before);
  });

  it('every number in a result is canonical decimal text (no exponent, no float noise)', () => {
    const r = ok(run(registry()));
    for (const x of r.results) for (const v of [x.value, x.target]) if (v !== null) expect(v).toMatch(/^-?(0|[1-9]\d*)(\.\d*[1-9])?$/);
  });
});
