/**
 * BI-2-DEV-05 architecture guards (static): the BI-10 calculation is pure and exact (no clock, randomness, floating point, I/O or database), never truncates,
 * supports exactly what the frozen BI-10 block defines, stores nothing, and the service only reads. Each guard states what it protects.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const engine = strip(read('packages/workflow/src/bi10/metricCalculation.ts'));
const decimal = strip(read('packages/workflow/src/bi10/exactDecimal.ts'));
const service = strip(read('packages/workflow/src/BusinessIntelligenceMetricCalculationService.ts'));
const index = strip(read('packages/workflow/src/index.ts'));
const frozenDir = resolve(root, 'layers/business-intelligence/blocks', readdirSync(resolve(root, 'layers/business-intelligence/blocks')).find((d) => d.startsWith('INFINICUS-BI-10-'))!, 'src');
const frozen = (rel: string) => readFileSync(resolve(frozenDir, rel), 'utf8');
const literals = (src: string, re: RegExp) => [...src.matchAll(re)].map((m) => m[1]!);

describe('BI-10 calculation core - purity', () => {
  it('reads no clock and generates no random value: results depend on the inputs alone', () => {
    for (const src of [engine, decimal]) {
      expect(src).not.toMatch(/new Date\(\)|Date\.now|performance\.now|Math\.random|randomUUID|crypto\.getRandomValues|setTimeout|setInterval/);
    }
  });

  it('does floating-point arithmetic nowhere: no parseFloat, toFixed, Number() coercion, rounding helpers or exponent operator', () => {
    for (const src of [engine, decimal]) {
      expect(src).not.toMatch(/\bparseFloat\b|\btoFixed\b|\btoPrecision\b|\bNumber\(|Math\.(round|ceil|trunc|pow|sqrt|log|exp|sign|fround)|\*\*(?!\s*BigInt\()/);
    }
    expect(decimal).toMatch(/bigint/);
  });

  it('has no input or output and no database: no database package, driver, SQL, file system, network, environment or process access', () => {
    for (const src of [engine, decimal]) {
      expect(src).not.toMatch(/@infinicus\/database|from 'pg'|node:fs|node:net|node:http|node:child_process|\bfetch\(|process\.env|XMLHttpRequest|indexedDB|localStorage|require\(/);
      expect(src).not.toMatch(/\b(SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/);
    }
    const imports = [...engine.matchAll(/^import [\s\S]*?from '([^']+)';/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['../bi/metricDefinition.js', '../bi/metricRegistry.js', './exactDecimal.js', 'node:crypto']);
    expect([...decimal.matchAll(/^import [\s\S]*?from '([^']+)';/gm)]).toEqual([]);
  });

  it('never truncates or caps a metric set silently: no slicing from the front, splicing, length assignment or limit constant other than the frozen row limit', () => {
    expect(engine).not.toMatch(/\.splice\(|\.slice\(0\b|\.length\s*=[^=]|\.truncate|\.shift\(\)\.length|MAX_METRICS|maxMetrics/);
    expect(engine).toMatch(/export const MAX_DATASET_ROWS = 100_000;/);
    expect(engine).toMatch(/rows\.length > MAX_DATASET_ROWS\) return fail\('DATASET_TOO_LARGE'/);
  });

  it('records no calculation time: the run carries the hand-off\'s stored source timestamp only', () => {
    expect(engine).not.toMatch(/calculatedAt|calculated_at/);
    expect(engine).toMatch(/handoffSourceTimestamp: h\.createdAt/);
  });

  it('checks the hand-off identity against its content before calculating anything', () => {
    expect(engine).toMatch(/deriveCalculationHandoffId\(h\.scope, h\.warehouseSnapshotId, h\.metrics\) !== h\.calculationHandoffId/);
    expect(engine.indexOf('validateHandoff(h)')).toBeLessThan(engine.indexOf('dependencyOrder(h.metrics)'));
    expect(engine.indexOf('planMetric(m, byId)')).toBeLessThan(engine.indexOf('const computed = new Map'));
  });
});

describe('BI-10 calculation core - parity with the frozen BI-10 block', () => {
  it('supports exactly the aggregations of the frozen aggregation engine', () => {
    const frozenAggregations = literals(frozen('calculation/aggregation-engine.js'), /case "([a-z_]+)":/g).sort();
    const ours = ['sum', 'count', 'count_distinct', 'average', 'minimum', 'maximum', 'median', 'first', 'last'].sort();
    expect(frozenAggregations).toEqual(ours);
    for (const a of ours) expect(engine, a).toContain(`'${a}'`);
  });

  it('supports exactly the filter operators of the frozen filter engine', () => {
    const frozenOps = literals(frozen('calculation/filter-engine.js'), /case "([a-z_]+)":/g).sort();
    expect(frozenOps).toEqual([...literals(engine, /SUPPORTED_FILTER_OPERATORS = \[([^\]]*)\]/g).flatMap((l) => l.split(',').map((x) => x.trim().replace(/'/g, '')))].sort());
  });

  it('supports exactly the derived operators of the frozen derived-metric engine', () => {
    const frozenOps = literals(frozen('calculation/derived-metric-engine.js'), /case "([a-z_]+)":/g).sort();
    const ours = literals(engine, /SUPPORTED_DERIVED_OPERATORS = \[([^\]]*)\]/g).flatMap((l) => l.split(',').map((x) => x.trim().replace(/'/g, '')));
    expect(ours.sort()).toEqual(frozenOps);
  });

  it('supports exactly the time grains the frozen grouping engine buckets (day, month, year, all time) and refuses the rest', () => {
    const grouping = frozen('calculation/grouping-engine.js');
    const frozenGrains = literals(grouping, /grain === "([a-z_]+)"/g).sort();
    expect(frozenGrains).toEqual(['day', 'month', 'year']);
    expect(literals(engine, /SUPPORTED_TIME_GRAINS = \[([^\]]*)\]/g)[0]!.split(',').map((x) => x.trim().replace(/'/g, '')).sort()).toEqual(['all_time', 'day', 'month', 'year']);
  });

  it('keeps the frozen threshold keys and the frozen row limit', () => {
    const thresholds = frozen('scoring/threshold-evaluator.js');
    for (const key of ['criticalBelow', 'warningBelow', 'criticalAbove', 'warningAbove', 'goodAbove', 'targetDirection']) { expect(thresholds, key).toContain(key); expect(engine, key).toContain(key); }
    expect(frozen('engine/metric-calculation-engine.js')).toMatch(/limit: 100000/);
  });

  it('keeps the frozen order of precedence for thresholds (critical-below, warning-below, critical-above, warning-above, good)', () => {
    const order = (src: string) => ['criticalBelow', 'warningBelow', 'criticalAbove', 'warningAbove', 'goodAbove'].map((k) => src.indexOf(`${k}`, src.indexOf('function evaluate'))).every((v, i, a) => i === 0 || v > a[i - 1]!);
    expect(order(frozen('scoring/threshold-evaluator.js'))).toBe(true);
    expect(order(engine.slice(engine.indexOf('function evaluateThreshold')))).toBe(true);
  });
});

describe('BI-10 calculation service - read only, scoped', () => {
  it('only reads: it composes the scoped hand-off service with the calculation and imports no write repository, transaction, pool or SQL', () => {
    expect(service).not.toMatch(/BiMetricRegistryRepository\b|withTenantTransaction|withTransaction|getPool|\.query\(|\bINSERT\b|\bUPDATE\b|\bDELETE\b|@infinicus\/business-operations|business_operations/);
    expect(service).toMatch(/BusinessIntelligenceCalculationHandoffService/);
    expect(service).toMatch(/calculateMetrics\(\{ handoff, rows \}\)/);
  });

  it('asks the row source only for base-metric datasets named by the hand-off, with the hand-off\'s own scope, and hides the cause of a read failure', () => {
    expect(service).toMatch(/handoff\.metrics\.filter\(\(m\) => m\.metricType === 'base'\)\.map\(\(m\) => m\.warehouseDatasetId\)/);
    expect(service).toMatch(/source\.rows\(\{ \.\.\.handoff\.scope \}, id\)/);
    expect(service).toMatch(/catch \{ return \{ ok: false, code: 'DATASET_ROWS_UNAVAILABLE'/);
    expect(service).not.toMatch(/catch \((e|err|error)\)/);
  });

  it('generates no identity and reads no clock', () => {
    expect(service).not.toMatch(/randomUUID|new Date\(|Date\.now|Math\.random/);
  });

  it('is exported from the package index together with the pure engine', () => {
    for (const name of ['calculateMetrics', 'MAX_DATASET_ROWS', 'BusinessIntelligenceMetricCalculationService', 'WarehouseRowSource', 'CalculationRun']) expect(index, name).toContain(name);
  });
});

describe('BI-10 calculation - no persistence, no route, no schema (not authorised in this block)', () => {
  it('adds no result table, route or event: nothing in the new modules creates, stores or publishes results', () => {
    for (const src of [engine, decimal, service]) expect(src).not.toMatch(/CREATE TABLE|calculation_runs|metric_results|\.put\(|\.insert|publish|emit\(|server\.(get|post|put|patch|delete)/);
  });
});
