/**
 * BI-2-DEV-04: the deterministic BI-09 -> BI-10 calculation hand-off (pure rules, no database). Identity is derived from what the hand-off IS (scope, snapshot,
 * metric ids + versions + content hashes) and never from a request correlation id, a clock or a generator; createdAt is the newest handed-over version's stored
 * time; selection and failure rules are exactly those of the frozen hand-off.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCalculationHandoff, buildDeterministicCalculationHandoff, deriveCalculationHandoffId, type MetricDefinition, type MetricScope,
} from '../src/index.js';

const scope: MetricScope = { tenantId: 't1', workspaceId: 'w1', businessId: 'b1' };
const DS = '11111111-1111-4111-8111-111111111111';
const def = (over: Partial<MetricDefinition> & { metricId: string; code: string }): MetricDefinition => ({
  name: over.code, description: '', metricType: 'base', warehouseDatasetId: DS, sourceField: 'amount', aggregation: 'sum', dependencies: [], formula: null, filters: [], dimensions: [],
  timeGrain: 'month', unit: 'usd', currency: null, target: null, thresholds: {}, owner: 'cfo', governanceStatus: 'approved', version: 1, status: 'active', scope,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...over,
});
const alpha = def({ metricId: 'a', code: 'alpha', updatedAt: '2026-01-02T00:00:00.000Z' });
const zeta = def({ metricId: 'z', code: 'zeta', updatedAt: '2026-03-04T05:06:07.890Z' });
const derived = def({ metricId: 'd', code: 'derived', metricType: 'derived', aggregation: null, dependencies: ['a'], updatedAt: '2026-02-01T00:00:00.000Z' });
const ask = (registry: MetricDefinition[], over: Record<string, unknown> = {}) =>
  buildDeterministicCalculationHandoff({ scope, registry, warehouseSnapshotId: null, correlationId: 'corr-1', ...over });
const idOf = (r: ReturnType<typeof ask>) => { expect(r.ok, JSON.stringify(r)).toBe(true); return (r as Extract<typeof r, { ok: true }>).handoff.calculationHandoffId; };

afterEach(() => { vi.useRealTimers(); });

describe('deterministic hand-off identity (D-B)', () => {
  it('is an RFC 4122 version-5-style UUID', () => {
    expect(idOf(ask([alpha, zeta]))).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('is identical on every replay and does not depend on registry order, request order, duplicates or the clock', () => {
    const first = idOf(ask([alpha, zeta]));
    expect(idOf(ask([alpha, zeta]))).toBe(first);
    expect(idOf(ask([zeta, alpha]))).toBe(first);
    expect(idOf(ask([alpha, zeta], { metricIds: ['z', 'a'] }))).toBe(first);
    expect(idOf(ask([alpha, zeta], { metricIds: ['a', 'z', 'a', 'z'] }))).toBe(first);
    vi.useFakeTimers(); vi.setSystemTime(new Date('2031-01-01T00:00:00Z'));
    expect(idOf(ask([alpha, zeta]))).toBe(first);
  });

  it('a whole-registry hand-off and an explicit selection of the same metrics are the same hand-off', () => {
    expect(idOf(ask([alpha, zeta], { metricIds: ['a', 'z'] }))).toBe(idOf(ask([alpha, zeta])));
  });

  it('does not include the request correlation id (the id names the hand-off, the correlation id names the request)', () => {
    expect(idOf(ask([alpha, zeta], { correlationId: 'other' }))).toBe(idOf(ask([alpha, zeta])));
  });

  it.each([
    ['a new version of a handed-over metric', () => ask([{ ...alpha, version: 2 }, zeta])],
    ['a changed definition at the same version', () => ask([{ ...alpha, unit: 'eur' }, zeta])],
    ['a changed dimension', () => ask([{ ...alpha, dimensions: ['region'] }, zeta])],
    ['a changed filter', () => ask([{ ...alpha, filters: [{ f: 1 }] }, zeta])],
    ['a changed target', () => ask([{ ...alpha, target: 5 }, zeta])],
    ['a different metric set', () => ask([alpha, zeta], { metricIds: ['a'] })],
    ['a different warehouse snapshot', () => ask([alpha, zeta], { warehouseSnapshotId: 'snap-1' })],
    ['another tenant', () => buildDeterministicCalculationHandoff({ scope: { ...scope, tenantId: 't2' }, registry: [alpha, zeta].map((m) => ({ ...m, scope: { ...scope, tenantId: 't2' } })), warehouseSnapshotId: null, correlationId: 'c' })],
    ['another workspace', () => buildDeterministicCalculationHandoff({ scope: { ...scope, workspaceId: 'w2' }, registry: [alpha, zeta].map((m) => ({ ...m, scope: { ...scope, workspaceId: 'w2' } })), warehouseSnapshotId: null, correlationId: 'c' })],
    ['another business', () => buildDeterministicCalculationHandoff({ scope: { ...scope, businessId: 'b2' }, registry: [alpha, zeta].map((m) => ({ ...m, scope: { ...scope, businessId: 'b2' } })), warehouseSnapshotId: null, correlationId: 'c' })],
  ])('changes with %s', (_label, change) => {
    expect(idOf(change())).not.toBe(idOf(ask([alpha, zeta])));
  });

  it('is not changed by data that is not part of the definition content (stored timestamps of an older, superseded version, or metric ids outside the selection)', () => {
    const noise = def({ metricId: 'n', code: 'noise', governanceStatus: 'draft' });
    expect(idOf(ask([alpha, zeta, noise]))).toBe(idOf(ask([alpha, zeta])));
    expect(idOf(ask([{ ...alpha, createdAt: '2020-01-01T00:00:00.000Z' }, zeta]))).toBe(idOf(ask([alpha, zeta])));
  });

  it('deriveCalculationHandoffId is a pure function of its three inputs', () => {
    expect(deriveCalculationHandoffId(scope, null, [alpha, zeta])).toBe(deriveCalculationHandoffId(scope, null, [zeta, alpha]));
    expect(deriveCalculationHandoffId(scope, null, [alpha])).not.toBe(deriveCalculationHandoffId(scope, null, [alpha, zeta]));
  });
});

describe('createdAt (D-C) and correlation (D-D)', () => {
  it('createdAt is the newest handed-over version\'s stored time in UTC, taken from the data and not from the clock', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2031-01-01T00:00:00Z'));
    const r = ask([alpha, zeta]);
    expect(r.ok && r.handoff.createdAt).toBe('2026-03-04T05:06:07.890Z');
    vi.setSystemTime(new Date('2040-01-01T00:00:00Z'));
    expect(ask([alpha, zeta]).ok && (ask([alpha, zeta]) as { handoff: { createdAt: string } }).handoff.createdAt).toBe('2026-03-04T05:06:07.890Z');
  });

  it('only the handed-over metrics count: a newer metric outside the selection does not move createdAt', () => {
    const late = def({ metricId: 'l', code: 'late', updatedAt: '2030-01-01T00:00:00.000Z' });
    expect(ask([alpha, zeta, late], { metricIds: ['a', 'z'] }).ok).toBe(true);
    const r = ask([alpha, zeta, late], { metricIds: ['a', 'z'] });
    expect(r.ok && r.handoff.createdAt).toBe('2026-03-04T05:06:07.890Z');
  });

  it('the request correlation id is carried unchanged (any caller-supplied value, not rewritten)', () => {
    const r = ask([alpha], { correlationId: ' Req-Id/42 ' });
    expect(r.ok && r.handoff.correlationId).toBe(' Req-Id/42 ');
  });

  it('a replay differs from the first call only in the correlation id', () => {
    const a = ask([alpha, zeta], { correlationId: 'one' }); const b = ask([alpha, zeta], { correlationId: 'two' });
    expect(a.ok && b.ok && { ...a.handoff, correlationId: '' }).toEqual(a.ok && b.ok && { ...b.handoff, correlationId: '' });
  });
});

describe('contract content and selection', () => {
  it('carries the BI-10 contract: definitions, versions, dependencies, dimensions, filters, units, targets, snapshot (null, D-A) and correlation', () => {
    const r = ask([alpha, derived, zeta], { metricIds: ['a', 'd'] });
    expect(r).toMatchObject({ ok: true, handoff: { targetBlock: 'BI-10', status: 'ready', warehouseSnapshotId: null, correlationId: 'corr-1', scope } });
    expect(r.ok && r.handoff.metricVersions).toEqual([{ metricId: 'a', version: 1 }, { metricId: 'd', version: 1 }]);
    expect(r.ok && r.handoff.metrics.map((m) => [m.code, m.dependencies, m.unit, m.target, m.dimensions, m.filters, m.version])).toEqual([['alpha', [], 'usd', null, [], [], 1], ['derived', ['a'], 'usd', null, [], [], 1]]);
  });

  it('uses the same selection as the frozen hand-off builder (same metrics, versions, order, failures)', () => {
    const registry = [zeta, alpha, derived, def({ metricId: 'x', code: 'xdraft', governanceStatus: 'draft' }), def({ metricId: 'y', code: 'yold', status: 'deprecated' })];
    const old = buildCalculationHandoff({ scope, registry, warehouseSnapshotId: null, correlationId: 'c', calculationHandoffId: 'h', now: new Date('2026-01-01T00:00:00Z') });
    const now = ask(registry, { correlationId: 'c' });
    expect(now.ok && old.ok && now.handoff.metrics).toEqual(old.ok && old.handoff.metrics);
    for (const metricIds of [['x'], ['y'], ['missing'], ['d'], ['a', 'x']]) {
      const a = buildCalculationHandoff({ scope, registry, metricIds, warehouseSnapshotId: null, correlationId: 'c', calculationHandoffId: 'h', now: new Date() });
      const b = ask(registry, { metricIds, correlationId: 'c' });
      expect(b, metricIds.join()).toEqual(a.ok ? expect.objectContaining({ ok: true }) : a);
    }
  });

  it.each([
    ['an unapproved metric named explicitly', { metricIds: ['x'] }, [alpha, def({ metricId: 'x', code: 'x', governanceStatus: 'draft' })], 'METRIC_NOT_APPROVED'],
    ['a deprecated metric named explicitly', { metricIds: ['y'] }, [alpha, def({ metricId: 'y', code: 'y', status: 'deprecated' })], 'METRIC_NOT_APPROVED'],
    ['an unknown metric', { metricIds: ['nope'] }, [alpha], 'METRIC_NOT_FOUND'],
    ['nothing approved', {}, [def({ metricId: 'x', code: 'x', governanceStatus: 'draft' })], 'NO_METRICS_SELECTED'],
    ['an empty registry', {}, [], 'NO_METRICS_SELECTED'],
    ['a dependency outside the hand-off', { metricIds: ['d'] }, [alpha, derived], 'HANDOFF_INVALID'],
    ['an empty correlation id', { correlationId: '  ' }, [alpha], 'HANDOFF_INVALID'],
    ['a blank snapshot id', { warehouseSnapshotId: ' ' }, [alpha], 'HANDOFF_INVALID'],
    ['a definition of another business in the registry', {}, [alpha, def({ metricId: 'f', code: 'f', scope: { ...scope, businessId: 'other' } })], 'SCOPE_MISMATCH'],
    ['an invalid caller scope', { scope: { tenantId: '', workspaceId: 'w', businessId: 'b' } }, [alpha], 'SCOPE_INVALID'],
  ])('refuses %s', (_label, over, registry, code) => {
    expect(ask(registry, over)).toMatchObject({ ok: false, code });
  });

  it('refuses a handed-over metric without a valid stored timestamp instead of inventing one', () => {
    expect(ask([{ ...alpha, updatedAt: 'not-a-date' }])).toMatchObject({ ok: false, code: 'HANDOFF_INVALID' });
  });

  it('returns copies: changing the hand-off changes neither the registry nor a later hand-off', () => {
    const registry = [{ ...alpha, dimensions: ['region'] }];
    const r = ask(registry);
    if (r.ok) { r.handoff.metrics[0]!.unit = 'changed'; r.handoff.metrics[0]!.dimensions.push('x'); }
    expect(registry[0]!.unit).toBe('usd'); expect(registry[0]!.dimensions).toEqual(['region']);
    expect(ask(registry).ok && (ask(registry) as { handoff: { metrics: MetricDefinition[] } }).handoff.metrics[0]!.unit).toBe('usd');
  });

  it('keeps the frozen builder behaviour for a caller-supplied id and clock', () => {
    const r = buildCalculationHandoff({ scope, registry: [alpha], warehouseSnapshotId: 'snap', correlationId: 'c', calculationHandoffId: 'h1', now: new Date('2026-05-05T00:00:00Z') });
    expect(r).toMatchObject({ ok: true, handoff: { calculationHandoffId: 'h1', createdAt: '2026-05-05T00:00:00.000Z', warehouseSnapshotId: 'snap' } });
  });
});
