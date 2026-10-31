/** BI-2-DEV-01: BI-09 metric and KPI registry rules (pure domain; nothing persisted, nothing calculated). */
import { describe, expect, it } from 'vitest';
import {
  METRIC_AGGREGATIONS, METRIC_TYPES, buildCalculationHandoff, buildMetricDefinitionContent, canonicalMetricContent, checkMetricDependencies, hasDependencyCycle,
  metricContentHash, normalizeMetricCode, registerMetric, reviseMetric, validateScope,
  type MetricDefinition, type MetricDefinitionInput, type MetricScope, type WarehouseDatasetRef,
} from '../src/index.js';

const scope: MetricScope = { tenantId: 't1', workspaceId: 'w1', businessId: 'b1' };
const other: MetricScope = { tenantId: 't2', workspaceId: 'w1', businessId: 'b1' };
const dataset: WarehouseDatasetRef = { warehouseDatasetId: 'ds-1', datasetContractId: 'contract-1', scope };
const now = new Date('2026-10-31T10:00:00.000Z');
const later = new Date('2026-11-01T10:00:00.000Z');
const base = (over: MetricDefinitionInput = {}): MetricDefinitionInput => ({ name: 'Revenue', code: 'Revenue', warehouseDatasetId: 'ds-1', metricType: 'base', aggregation: 'sum', sourceField: 'amount', ...over });

function reg(registry: MetricDefinition[], metricId: string, input: MetricDefinitionInput, ds: WarehouseDatasetRef | null = dataset): MetricDefinition {
  const r = registerMetric({ scope, registry, dataset: ds, input, metricId, now });
  if (!r.ok) throw new Error(`${r.code}: ${r.detail}`);
  return r.metric;
}

describe('definition validation', () => {
  it('exposes exactly the frozen metric types and aggregations', () => {
    expect([...METRIC_TYPES]).toEqual(['base', 'derived', 'ratio', 'rate', 'target']);
    expect([...METRIC_AGGREGATIONS]).toEqual(['sum', 'count', 'count_distinct', 'average', 'minimum', 'maximum', 'median', 'first', 'last']);
  });

  it('applies the frozen defaults and normalises the code the frozen way', () => {
    const r = buildMetricDefinitionContent(base({ code: ' Gross Margin % ' }));
    expect(r.ok && r.content).toMatchObject({ code: 'gross_margin__', timeGrain: 'all_time', unit: 'number', governanceStatus: 'draft', status: 'active', version: 1, currency: null, target: null, dependencies: [], dimensions: [], filters: [], thresholds: {}, formula: null });
    expect(normalizeMetricCode('Gross Margin %')).toBe('gross_margin__');
  });

  it.each([
    ['no name', { name: '' }], ['no code', { code: undefined }], ['no dataset', { warehouseDatasetId: ' ' }], ['unknown type', { metricType: 'median' }],
    ['non-string type', { metricType: 7 }], ['code of only symbols', { code: '%%' }],
  ])('rejects %s', (_n, over) => {
    const r = buildMetricDefinitionContent(base(over as MetricDefinitionInput));
    expect(r).toMatchObject({ ok: false, code: 'METRIC_DEFINITION_INVALID' });
  });

  it('requires a supported aggregation for a base metric and rejects an unsupported one for any type', () => {
    expect(buildMetricDefinitionContent(base({ aggregation: undefined }))).toMatchObject({ ok: false, code: 'METRIC_AGGREGATION_INVALID' });
    expect(buildMetricDefinitionContent(base({ aggregation: 'mode' }))).toMatchObject({ ok: false, code: 'METRIC_AGGREGATION_INVALID' });
    expect(buildMetricDefinitionContent(base({ metricType: 'ratio', aggregation: 'mode' }))).toMatchObject({ ok: false, code: 'METRIC_AGGREGATION_INVALID' });
    expect(buildMetricDefinitionContent(base({ metricType: 'ratio', aggregation: undefined })).ok).toBe(true);
  });

  it.each([
    ['dependencies not a list', { dependencies: 'a' }], ['empty dependency', { dependencies: [''] }], ['dimensions with a number', { dimensions: [1] }],
    ['filters not a list', { filters: {} }], ['thresholds a list', { thresholds: [] }], ['non-finite target', { target: Number.NaN }], ['string target', { target: '5' }],
    ['version 0', { version: 0 }], ['fractional version', { version: 1.5 }], ['string version', { version: '2' }], ['empty unit', { unit: '' }], ['numeric owner', { owner: 5 }],
    ['non-JSON filter', { filters: [() => 1] }], ['non-finite threshold', { thresholds: { low: Infinity } }],
  ])('refuses %s instead of coercing it', (_n, over) => {
    expect(buildMetricDefinitionContent(base(over as MetricDefinitionInput))).toMatchObject({ ok: false, code: 'METRIC_DEFINITION_INVALID' });
  });

  it('removes duplicate dependencies and copies nested input so later changes to the input cannot alter the definition', () => {
    const filters = [{ field: 'region', op: 'eq', value: ['north'] }];
    const r = buildMetricDefinitionContent(base({ metricType: 'derived', aggregation: undefined, dependencies: ['a', 'a', ' b '], filters }));
    expect(r.ok && r.content.dependencies).toEqual(['a', 'b']);
    (filters[0]!.value as string[]).push('south');
    expect(r.ok && (r.content.filters[0] as { value: string[] }).value).toEqual(['north']);
  });
});

describe('canonical form and identity', () => {
  it('is the same for key order and for dependency/dimension order, and changes with any real change', () => {
    const a = buildMetricDefinitionContent(base({ metricType: 'derived', aggregation: undefined, dependencies: ['b', 'a'], dimensions: ['y', 'x'], thresholds: { hi: 2, lo: 1 } }));
    const b = buildMetricDefinitionContent({ thresholds: { lo: 1, hi: 2 }, dimensions: ['x', 'y'], dependencies: ['a', 'b'], aggregation: undefined, metricType: 'derived', warehouseDatasetId: 'ds-1', code: 'revenue', name: 'Revenue', sourceField: 'amount' });
    if (!a.ok || !b.ok) throw new Error('setup');
    expect(canonicalMetricContent(a.content)).toBe(canonicalMetricContent(b.content));
    expect(metricContentHash(a.content)).toBe(metricContentHash(b.content));
    expect(metricContentHash(a.content)).toMatch(/^[0-9a-f]{64}$/);
    for (const change of [{ unit: 'usd' }, { target: 5 }, { owner: 'cfo' }, { timeGrain: 'month' }, { filters: [{ f: 1 }] }]) {
      const c = buildMetricDefinitionContent({ ...base({ metricType: 'derived', aggregation: undefined, dependencies: ['a', 'b'], dimensions: ['x', 'y'], thresholds: { hi: 2, lo: 1 } }), ...change });
      expect(c.ok && metricContentHash(c.content)).not.toBe(metricContentHash(a.content));
    }
  });

  it('keeps the filter order, since it is part of the definition', () => {
    const f1 = buildMetricDefinitionContent(base({ filters: [{ a: 1 }, { b: 2 }] }));
    const f2 = buildMetricDefinitionContent(base({ filters: [{ b: 2 }, { a: 1 }] }));
    expect(f1.ok && f2.ok && metricContentHash(f1.content) !== metricContentHash(f2.content)).toBe(true);
  });
});

describe('registration', () => {
  it('registers at version 1 with lineage, deterministic timestamps and the caller scope', () => {
    const r = registerMetric({ scope, registry: [], dataset, input: base(), metricId: 'm1', now });
    expect(r).toMatchObject({ ok: true, metric: { metricId: 'm1', code: 'revenue', version: 1, scope, createdAt: now.toISOString(), updatedAt: now.toISOString() }, lineage: { metricId: 'm1', metricCode: 'revenue', warehouseDatasetId: 'ds-1', datasetContractId: 'contract-1', sourceField: 'amount', version: 1 } });
    expect(registerMetric({ scope, registry: [], dataset, input: base(), metricId: 'm1', now })).toEqual(r);
  });

  it('does not alias the caller scope', () => {
    const s = { ...scope };
    const r = registerMetric({ scope: s, registry: [], dataset, input: base(), metricId: 'm1', now });
    s.tenantId = 'x';
    expect(r.ok && r.metric.scope.tenantId).toBe('t1');
  });

  it('rejects a duplicate code (after normalisation) and a reused metric id', () => {
    const m1 = reg([], 'm1', base());
    expect(registerMetric({ scope, registry: [m1], dataset, input: base({ code: 'REVENUE' }), metricId: 'm2', now })).toMatchObject({ ok: false, code: 'METRIC_CODE_DUPLICATE' });
    expect(registerMetric({ scope, registry: [m1], dataset, input: base({ code: 'other' }), metricId: 'm1', now })).toMatchObject({ ok: false, code: 'METRIC_VERSION_INVALID' });
  });

  it('rejects an unresolved, mismatched or foreign-scope dataset', () => {
    for (const ds of [null, { ...dataset, warehouseDatasetId: 'ds-2' }]) {
      expect(registerMetric({ scope, registry: [], dataset: ds, input: base(), metricId: 'm1', now })).toMatchObject({ ok: false, code: 'DATASET_NOT_FOUND' });
    }
    for (const s of [other, { ...scope, workspaceId: 'w9' }, { ...scope, businessId: 'b9' }]) {
      expect(registerMetric({ scope, registry: [], dataset: { ...dataset, scope: s }, input: base(), metricId: 'm1', now })).toMatchObject({ ok: false, code: 'DATASET_SCOPE_MISMATCH' });
    }
  });

  it('rejects an invalid or incomplete scope, a missing id and a first version other than 1', () => {
    expect(validateScope({ tenantId: 't', workspaceId: '', businessId: 'b' })).toBe(false);
    expect(validateScope(null)).toBe(false);
    expect(registerMetric({ scope: { tenantId: 't', workspaceId: 'w', businessId: '' }, registry: [], dataset, input: base(), metricId: 'm1', now })).toMatchObject({ ok: false, code: 'SCOPE_INVALID' });
    expect(registerMetric({ scope, registry: [], dataset, input: base(), metricId: ' ', now })).toMatchObject({ ok: false, code: 'METRIC_DEFINITION_INVALID' });
    expect(registerMetric({ scope, registry: [], dataset, input: base({ version: 3 }), metricId: 'm1', now })).toMatchObject({ ok: false, code: 'METRIC_VERSION_INVALID' });
  });

  it('fails closed when the registry holds a definition from another tenant, workspace or business', () => {
    const foreign: MetricDefinition = { ...reg([], 'mx', base({ code: 'foreign' })), scope: other };
    expect(registerMetric({ scope, registry: [foreign], dataset, input: base(), metricId: 'm1', now })).toMatchObject({ ok: false, code: 'SCOPE_MISMATCH' });
    expect(buildCalculationHandoff({ scope, registry: [foreign], warehouseSnapshotId: null, correlationId: 'c', calculationHandoffId: 'h', now })).toMatchObject({ ok: false, code: 'SCOPE_MISMATCH' });
    expect(reviseMetric({ scope, registry: [foreign], dataset, input: base(), metricId: 'mx', now })).toMatchObject({ ok: false, code: 'SCOPE_MISMATCH' });
  });

  it('accepts dependencies on registered metrics and refuses unknown or self dependencies', () => {
    const rev = reg([], 'rev', base({ code: 'revenue' }));
    const cost = reg([rev], 'cost', base({ code: 'cost' }));
    const profit = registerMetric({ scope, registry: [rev, cost], dataset, input: base({ code: 'profit', metricType: 'derived', aggregation: undefined, dependencies: ['rev', 'cost'], formula: { op: 'subtract', args: ['rev', 'cost'] } }), metricId: 'p', now });
    expect(profit).toMatchObject({ ok: true, lineage: { dependencies: ['rev', 'cost'] } });
    expect(registerMetric({ scope, registry: [rev], dataset, input: base({ code: 'p2', metricType: 'derived', aggregation: undefined, dependencies: ['nope'] }), metricId: 'p2', now })).toMatchObject({ ok: false, code: 'METRIC_DEPENDENCY_INVALID' });
    expect(registerMetric({ scope, registry: [], dataset, input: base({ code: 'p3', metricType: 'derived', aggregation: undefined, dependencies: ['p3id'] }), metricId: 'p3id', now })).toMatchObject({ ok: false, code: 'METRIC_DEPENDENCY_INVALID' });
  });
});

describe('dependency cycles', () => {
  it('finds direct, indirect and self cycles and passes acyclic graphs, including a diamond', () => {
    const g = (o: Record<string, string[]>) => new Map(Object.entries(o));
    expect(hasDependencyCycle(g({ a: ['b'], b: ['a'] }), 'a')).toBe(true);
    expect(hasDependencyCycle(g({ a: ['b'], b: ['c'], c: ['a'] }), 'a')).toBe(true);
    expect(hasDependencyCycle(g({ a: ['a'] }), 'a')).toBe(true);
    expect(hasDependencyCycle(g({ revenue: [], cost: [], profit: ['revenue', 'cost'] }), 'profit')).toBe(false);
    expect(hasDependencyCycle(g({ a: ['b', 'c'], b: ['d'], c: ['d'], d: [] }), 'a')).toBe(false);
  });

  it('survives a very long chain without overflowing the stack', () => {
    const graph = new Map<string, string[]>();
    for (let i = 0; i < 20000; i += 1) graph.set(`n${i}`, i === 19999 ? [] : [`n${i + 1}`]);
    expect(hasDependencyCycle(graph, 'n0')).toBe(false);
    graph.set('n19999', ['n0']);
    expect(hasDependencyCycle(graph, 'n0')).toBe(true);
  });

  it('rejects a revision that closes a cycle through an existing metric', () => {
    const a = reg([], 'a', base({ code: 'a' }));
    const b = reg([a], 'b', base({ code: 'b', metricType: 'derived', aggregation: undefined, dependencies: ['a'] }));
    const r = reviseMetric({ scope, registry: [a, b], dataset, input: base({ code: 'a', metricType: 'derived', aggregation: undefined, dependencies: ['b'] }), metricId: 'a', now: later });
    expect(r).toMatchObject({ ok: false, code: 'METRIC_DEPENDENCY_INVALID', detail: 'metric dependencies are circular.' });
    expect(checkMetricDependencies([a, b], { metricId: 'a', dependencies: ['b'] })).toMatchObject({ valid: false, circular: true });
  });
});

describe('versioning', () => {
  it('adds exactly the next version, keeps the code and creation time, and changes the update time', () => {
    const v1 = reg([], 'm1', base());
    const r = reviseMetric({ scope, registry: [v1], dataset, input: base({ unit: 'usd' }), metricId: 'm1', now: later });
    expect(r).toMatchObject({ ok: true, metric: { metricId: 'm1', version: 2, unit: 'usd', code: 'revenue', createdAt: now.toISOString(), updatedAt: later.toISOString() }, lineage: { version: 2 } });
  });

  it.each([
    ['skipping a version', { version: 3, unit: 'usd' }], ['repeating the version', { version: 1, unit: 'usd' }], ['changing the code', { code: 'renamed', unit: 'usd' }], ['changing nothing', {}],
  ])('rejects %s', (_n, over) => {
    const v1 = reg([], 'm1', base());
    expect(reviseMetric({ scope, registry: [v1], dataset, input: base(over as MetricDefinitionInput), metricId: 'm1', now: later })).toMatchObject({ ok: false, code: 'METRIC_VERSION_INVALID' });
  });

  it('rejects a revision of an unknown metric, and compares with the latest version only', () => {
    expect(reviseMetric({ scope, registry: [], dataset, input: base(), metricId: 'zz', now })).toMatchObject({ ok: false, code: 'METRIC_NOT_FOUND' });
    const v1 = reg([], 'm1', base());
    const v2 = (reviseMetric({ scope, registry: [v1], dataset, input: base({ unit: 'usd' }), metricId: 'm1', now: later }) as { metric: MetricDefinition }).metric;
    expect(reviseMetric({ scope, registry: [v1, v2], dataset, input: base(), metricId: 'm1', now: later })).toMatchObject({ ok: true, metric: { version: 3 } });
    expect(reviseMetric({ scope, registry: [v1, v2], dataset, input: base({ unit: 'usd', version: 2 }), metricId: 'm1', now: later })).toMatchObject({ ok: false, code: 'METRIC_VERSION_INVALID' });
  });

  it('rejects a registry holding the same version twice', () => {
    const v1 = reg([], 'm1', base());
    expect(reviseMetric({ scope, registry: [v1, v1], dataset, input: base({ unit: 'usd' }), metricId: 'm1', now })).toMatchObject({ ok: false, code: 'METRIC_VERSION_INVALID' });
  });

  it('a duplicate code is still refused when only an older version of another metric holds it', () => {
    const v1 = reg([], 'm1', base());
    expect(registerMetric({ scope, registry: [v1], dataset, input: base({ code: 'revenue' }), metricId: 'm2', now })).toMatchObject({ ok: false, code: 'METRIC_CODE_DUPLICATE' });
  });
});

describe('BI-09 -> BI-10 calculation hand-off', () => {
  const approved = (registry: MetricDefinition[], id: string, code: string, extra: MetricDefinitionInput = {}) => reg(registry, id, base({ code, governanceStatus: 'approved', ...extra }));
  const ask = (registry: MetricDefinition[], over: Partial<Parameters<typeof buildCalculationHandoff>[0]> = {}) =>
    buildCalculationHandoff({ scope, registry, warehouseSnapshotId: 'snap-1', correlationId: 'corr-1', calculationHandoffId: 'h1', now, ...over });

  it('hands over approved active metrics at their latest version, ordered by code, with versions and the frozen fields', () => {
    const z = approved([], 'z', 'zeta');
    const a = approved([z], 'a', 'alpha');
    const draft = reg([z, a], 'd', base({ code: 'draftish' }));
    const r = ask([z, a, draft]);
    expect(r).toMatchObject({ ok: true, handoff: { calculationHandoffId: 'h1', targetBlock: 'BI-10', warehouseSnapshotId: 'snap-1', correlationId: 'corr-1', status: 'ready', scope, createdAt: now.toISOString(), metricVersions: [{ metricId: 'a', version: 1 }, { metricId: 'z', version: 1 }] } });
    expect(r.ok && r.handoff.metrics.map((m) => m.code)).toEqual(['alpha', 'zeta']);
  });

  it('uses the latest version of a revised metric only', () => {
    const v1 = approved([], 'm', 'revenue');
    const v2 = (reviseMetric({ scope, registry: [v1], dataset, input: base({ governanceStatus: 'approved', unit: 'usd' }), metricId: 'm', now: later }) as { metric: MetricDefinition }).metric;
    const r = ask([v1, v2]);
    expect(r.ok && r.handoff.metricVersions).toEqual([{ metricId: 'm', version: 2 }]);
  });

  it('refuses an unapproved, inactive or unknown metric named explicitly, and an empty selection', () => {
    const ok = approved([], 'a', 'alpha');
    const draft = reg([ok], 'd', base({ code: 'draftish' }));
    const retired = approved([ok, draft], 'r', 'retired', { status: 'retired' });
    expect(ask([ok, draft, retired], { metricIds: ['d'] })).toMatchObject({ ok: false, code: 'METRIC_NOT_APPROVED' });
    expect(ask([ok, draft, retired], { metricIds: ['r'] })).toMatchObject({ ok: false, code: 'METRIC_NOT_APPROVED' });
    expect(ask([ok], { metricIds: ['nope'] })).toMatchObject({ ok: false, code: 'METRIC_NOT_FOUND' });
    expect(ask([draft])).toMatchObject({ ok: false, code: 'NO_METRICS_SELECTED' });
    expect(ask([])).toMatchObject({ ok: false, code: 'NO_METRICS_SELECTED' });
  });

  it('requires every dependency of a handed-over metric to be handed over too', () => {
    const rev = reg([], 'rev', base({ code: 'revenue' }));
    const derived = approved([rev], 'der', 'margin', { metricType: 'derived', aggregation: undefined, dependencies: ['rev'] });
    expect(ask([rev, derived])).toMatchObject({ ok: false, code: 'HANDOFF_INVALID' });
    const revApproved = approved([], 'rev', 'revenue');
    const derived2 = approved([revApproved], 'der', 'margin', { metricType: 'derived', aggregation: undefined, dependencies: ['rev'] });
    expect(ask([revApproved, derived2])).toMatchObject({ ok: true });
  });

  it('requires a hand-off id and correlation id, and does not alias the registry', () => {
    const m = approved([], 'a', 'alpha');
    expect(ask([m], { correlationId: '' })).toMatchObject({ ok: false, code: 'HANDOFF_INVALID' });
    expect(ask([m], { calculationHandoffId: ' ' })).toMatchObject({ ok: false, code: 'HANDOFF_INVALID' });
    expect(ask([m], { warehouseSnapshotId: '' })).toMatchObject({ ok: false, code: 'HANDOFF_INVALID' });
    expect(ask([m], { warehouseSnapshotId: null })).toMatchObject({ ok: true });
    const r = ask([m]);
    if (!r.ok) throw new Error('setup');
    r.handoff.metrics[0]!.unit = 'changed';
    expect(m.unit).toBe('number');
  });

  it('is deterministic for the same input', () => {
    const m = approved([], 'a', 'alpha');
    expect(ask([m])).toEqual(ask([m]));
  });
});
