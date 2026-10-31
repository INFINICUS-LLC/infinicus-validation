/**
 * BI-10 metric calculation (BI-2-DEV-05), frozen block INFINICUS-BI-10 (CALCULATION-MODEL.md, ARCHITECTURE.md). Pure and deterministic: it takes a BI-09 hand-off
 * (BI-2-DEV-04) and the warehouse rows of the datasets the hand-off names, and returns the calculation run. It reads no clock, generates no random id, touches no
 * database and stores nothing; persistence of results is a later, separately authorised block. All arithmetic is exact (exactDecimal.ts); values are canonical
 * decimal text. Nothing is guessed: an input the frozen model cannot calculate (unsupported grain, operator or aggregation, a non-numeric value, mismatching
 * units or dimensions, a dataset without rows, an oversize dataset) is refused with a typed code and NO partial result.
 *
 * Deliberate differences from the frozen JavaScript (each makes the result more exact or refuses what the frozen code silently guessed):
 *  - exact decimals, not IEEE doubles; division is to 10 places, round-half-to-even;
 *  - a missing or null dependency value gives a null result ("no_data"), not 0; a filter with an unknown operator is refused, not ignored;
 *  - an unsupported time grain (week, quarter) is refused, not silently treated as all-time; a base metric without a source field is refused unless it counts rows;
 *  - results carry the hand-off's stored source timestamp, not a calculation time (the calculation time belongs to persistence).
 */
import { canonicalJson, metricContentHash, type MetricDefinition, type MetricDefinitionContent, type MetricScope } from '../bi/metricDefinition.js';
import { createHash } from 'node:crypto';
import { deriveCalculationHandoffId, deterministicUuid, type CalculationHandoff } from '../bi/metricRegistry.js';
import {
  add, compare, decimalToString, divide, fromInteger, half, isZero, multiply, subtract, toDecimal, ZERO, type Decimal,
} from './exactDecimal.js';

/** The frozen engine reads at most 100000 rows of a dataset per query. A larger dataset is refused, never truncated. */
export const MAX_DATASET_ROWS = 100_000;
export const SUPPORTED_TIME_GRAINS = ['day', 'month', 'year', 'all_time'] as const;
export const SUPPORTED_FILTER_OPERATORS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'contains'] as const;
export const SUPPORTED_DERIVED_OPERATORS = ['add', 'subtract', 'multiply', 'divide'] as const;

export type WarehouseRow = Readonly<Record<string, unknown>>;
/** The rows of each warehouse dataset the hand-off names, in the dataset's stable order. */
export type WarehouseRows = ReadonlyMap<string, readonly WarehouseRow[]>;

export type CalculationErrorCode =
  | 'HANDOFF_INVALID' | 'HANDOFF_NOT_APPROVED' | 'SCOPE_MISMATCH' | 'DEPENDENCY_UNKNOWN' | 'DEPENDENCY_CYCLE' | 'METRIC_UNSUPPORTED' | 'FORMULA_INVALID'
  | 'UNIT_MISMATCH' | 'DIMENSION_MISMATCH' | 'FILTER_INVALID' | 'THRESHOLD_INVALID' | 'TIME_GRAIN_UNSUPPORTED' | 'SOURCE_FIELD_REQUIRED'
  | 'DATASET_ROWS_UNAVAILABLE' | 'DATASET_TOO_LARGE' | 'ROWS_INVALID' | 'VALUE_NOT_NUMERIC';
export interface CalculationFailure { ok: false; code: CalculationErrorCode; detail: string }

export type DimensionValue = string | number | boolean;
export interface MetricGroup { dimensions: Record<string, DimensionValue>; timeBucket: string | null }
export interface ThresholdOutcome { status: 'no_data' | 'normal' | 'warning' | 'critical' | 'good'; targetMet: boolean | null }

export interface MetricResult {
  metricResultId: string;
  calculationRunId: string;
  calculationHandoffId: string;
  metricId: string;
  metricCode: string;
  metricVersion: number;
  /** SHA-256 of the definition content this result was calculated from. */
  metricContentHash: string;
  warehouseDatasetId: string;
  metricType: string;
  group: MetricGroup;
  groupKey: string;
  /** Canonical decimal text, or null when there is nothing to calculate ("no_data"). */
  value: string | null;
  unit: string;
  currency: string | null;
  target: string | null;
  threshold: ThresholdOutcome;
  /** Rows of the group after the metric's filters (base metrics); null for derived, ratio, rate and target metrics. */
  sourceRowCount: number | null;
  calculationStatus: 'completed' | 'no_data';
}

export interface CalculationDatasetInput { warehouseDatasetId: string; rowCount: number; rowsFingerprint: string }

export interface CalculationRun {
  calculationRunId: string;
  calculationHandoffId: string;
  warehouseSnapshotId: string | null;
  correlationId: string;
  /** The stored creation time of the newest handed-over metric version (the hand-off's createdAt). Not a calculation time and not a persisted time. */
  handoffSourceTimestamp: string;
  metricCount: number;
  datasets: CalculationDatasetInput[];
  results: MetricResult[];
}
export type CalculationOutcome = { ok: true; run: CalculationRun } | CalculationFailure;

/** The run identity: the hand-off it calculates and the exact datasets (row count and fingerprint) it read. */
export function deriveCalculationRunId(calculationHandoffId: string, datasets: readonly CalculationDatasetInput[]): string {
  return deterministicUuid(canonicalJson({ kind: 'bi-calculation-run/v1', calculationHandoffId, datasets }));
}

/** The result identity: the run, the metric and its version, and the group. */
export function deriveMetricResultId(calculationRunId: string, metricId: string, metricVersion: number, groupKey: string): string {
  return deterministicUuid(canonicalJson({ kind: 'bi-metric-result/v1', calculationRunId, metricId, metricVersion, groupKey }));
}

const fail = (code: CalculationErrorCode, detail: string): CalculationFailure => ({ ok: false, code, detail });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const sameScope = (a: MetricScope, b: MetricScope): boolean => a.tenantId === b.tenantId && a.workspaceId === b.workspaceId && a.businessId === b.businessId;

// ---------------------------------------------------------------- validation of the hand-off and of every definition (before any calculation)

interface Plan { metric: MetricDefinition; deps: MetricDefinition[]; timeField: string; dimensions: string[]; thresholds: Thresholds; target: Decimal | null }
interface Thresholds { criticalBelow?: Decimal; warningBelow?: Decimal; criticalAbove?: Decimal; warningAbove?: Decimal; goodAbove?: Decimal; targetDirection: 'above' | 'below' }

function validateHandoff(h: CalculationHandoff): CalculationFailure | null {
  if (!isRecord(h) || h.targetBlock !== 'BI-10' || h.status !== 'ready') return fail('HANDOFF_INVALID', 'the hand-off is not a ready BI-10 hand-off.');
  const s = h.scope as Partial<MetricScope> | undefined;
  if (!s || !nonEmpty(s.tenantId) || !nonEmpty(s.workspaceId) || !nonEmpty(s.businessId)) return fail('HANDOFF_INVALID', 'the hand-off has no complete tenant, workspace and business scope.');
  if (!nonEmpty(h.calculationHandoffId) || !nonEmpty(h.correlationId) || !nonEmpty(h.createdAt) || Number.isNaN(Date.parse(h.createdAt))) return fail('HANDOFF_INVALID', 'the hand-off lacks its id, correlation id or source timestamp.');
  if (h.warehouseSnapshotId !== null && !nonEmpty(h.warehouseSnapshotId)) return fail('HANDOFF_INVALID', 'warehouseSnapshotId must be a non-empty string or null.');
  if (!Array.isArray(h.metrics) || h.metrics.length === 0 || !Array.isArray(h.metricVersions) || h.metricVersions.length !== h.metrics.length) return fail('HANDOFF_INVALID', 'the hand-off has no metrics, or its version list does not match them.');
  const seen = new Set<string>();
  for (let i = 0; i < h.metrics.length; i += 1) {
    const m = h.metrics[i]!; const v = h.metricVersions[i];
    if (!isRecord(m) || !nonEmpty(m.metricId) || seen.has(m.metricId)) return fail('HANDOFF_INVALID', 'the hand-off holds a malformed or duplicate metric.');
    seen.add(m.metricId);
    if (!v || v.metricId !== m.metricId || v.version !== m.version) return fail('HANDOFF_INVALID', `the hand-off version list does not match metric ${String(m.code)}.`);
    if (!isRecord(m.scope) || !sameScope(m.scope as unknown as MetricScope, h.scope)) return fail('SCOPE_MISMATCH', 'a handed-over metric belongs to another scope than the hand-off.');
    if (m.governanceStatus !== 'approved' || m.status !== 'active') return fail('HANDOFF_NOT_APPROVED', `metric ${String(m.code)} is not an approved active metric.`);
  }
  // Integrity: the id is derived from the content, so a hand-off whose content was altered no longer carries its own id.
  if (deriveCalculationHandoffId(h.scope, h.warehouseSnapshotId, h.metrics) !== h.calculationHandoffId) return fail('HANDOFF_INVALID', 'the hand-off identity does not match its content.');
  return null;
}

/** Dependency order (Kahn): dependencies first, ties by code, so the order is a function of the definitions alone. Unknown dependency and cycle are refused. */
function dependencyOrder(metrics: readonly MetricDefinition[]): MetricDefinition[] | CalculationFailure {
  const byId = new Map(metrics.map((m) => [m.metricId, m]));
  const remaining = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const m of metrics) {
    if (!Array.isArray(m.dependencies) || m.dependencies.some((d) => typeof d !== 'string')) return fail('FORMULA_INVALID', `metric ${m.code} has malformed dependencies.`);
    const unique = new Set(m.dependencies);
    if (unique.size !== m.dependencies.length) return fail('FORMULA_INVALID', `metric ${m.code} lists a dependency twice.`);
    for (const d of unique) {
      if (!byId.has(d)) return fail('DEPENDENCY_UNKNOWN', `metric ${m.code} depends on a metric that is not part of the hand-off.`);
      dependents.set(d, [...(dependents.get(d) ?? []), m.metricId]);
    }
    remaining.set(m.metricId, unique.size);
  }
  const ready = metrics.filter((m) => remaining.get(m.metricId) === 0).sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  const order: MetricDefinition[] = [];
  while (ready.length > 0) {
    const next = ready.shift()!; order.push(next);
    for (const id of dependents.get(next.metricId) ?? []) {
      const left = (remaining.get(id) ?? 0) - 1; remaining.set(id, left);
      if (left === 0) { ready.push(byId.get(id)!); ready.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)); }
    }
  }
  return order.length === metrics.length ? order : fail('DEPENDENCY_CYCLE', 'metric dependencies are circular.');
}

function readThresholds(m: MetricDefinition): Thresholds | CalculationFailure {
  const t = m.thresholds;
  if (!isRecord(t)) return fail('THRESHOLD_INVALID', `metric ${m.code} has malformed thresholds.`);
  const out: Thresholds = { targetDirection: 'above' };
  for (const key of ['criticalBelow', 'warningBelow', 'criticalAbove', 'warningAbove', 'goodAbove'] as const) {
    const raw = t[key];
    if (raw === undefined || raw === null) continue;
    const d = typeof raw === 'number' ? toDecimal(raw) : null;
    if (d === null) return fail('THRESHOLD_INVALID', `metric ${m.code} threshold ${key} must be a finite number.`);
    out[key] = d;
  }
  if (t.targetDirection !== undefined && t.targetDirection !== null) {
    if (t.targetDirection !== 'above' && t.targetDirection !== 'below') return fail('THRESHOLD_INVALID', `metric ${m.code} targetDirection must be above or below.`);
    out.targetDirection = t.targetDirection;
  }
  return out;
}

function planMetric(m: MetricDefinition, byId: ReadonlyMap<string, MetricDefinition>): Plan | CalculationFailure {
  if (!['base', 'derived', 'ratio', 'rate', 'target'].includes(m.metricType)) return fail('METRIC_UNSUPPORTED', `metric ${m.code} has an unsupported type.`);
  if (!(SUPPORTED_TIME_GRAINS as readonly string[]).includes(m.timeGrain)) return fail('TIME_GRAIN_UNSUPPORTED', `metric ${m.code}: time grain ${m.timeGrain} is not supported by the frozen BI-10 grouping (day, month, year, all_time).`);
  if (!Array.isArray(m.dimensions) || m.dimensions.some((d) => !nonEmpty(d)) || new Set(m.dimensions).size !== m.dimensions.length) return fail('DIMENSION_MISMATCH', `metric ${m.code} has malformed dimensions.`);
  if (!Array.isArray(m.filters)) return fail('FILTER_INVALID', `metric ${m.code} has malformed filters.`);
  const thresholds = readThresholds(m);
  if ('ok' in thresholds) return thresholds;
  const target = m.target === null || m.target === undefined ? null : typeof m.target === 'number' ? toDecimal(m.target) : null;
  if (m.target !== null && m.target !== undefined && target === null) return fail('THRESHOLD_INVALID', `metric ${m.code} target must be a finite number.`);
  const formula = isRecord(m.formula) ? m.formula : null;
  const timeField = formula && nonEmpty(formula.timeField) ? formula.timeField : 'date';
  const deps = m.dependencies.map((d) => byId.get(d)!);
  const dimensions = [...m.dimensions].sort();
  const plan: Plan = { metric: m, deps, timeField, dimensions, thresholds, target };

  if (m.metricType === 'base') {
    if (deps.length > 0) return fail('FORMULA_INVALID', `base metric ${m.code} must not have dependencies.`);
    if (m.aggregation === null || !['sum', 'count', 'count_distinct', 'average', 'minimum', 'maximum', 'median', 'first', 'last'].includes(m.aggregation)) return fail('METRIC_UNSUPPORTED', `base metric ${m.code} needs a supported aggregation.`);
    if (m.aggregation !== 'count' && !nonEmpty(m.sourceField)) return fail('SOURCE_FIELD_REQUIRED', `base metric ${m.code} needs a source field for ${m.aggregation}.`);
    for (const f of m.filters) {
      if (!isRecord(f) || !nonEmpty(f.field) || typeof f.operator !== 'string' || !(SUPPORTED_FILTER_OPERATORS as readonly string[]).includes(f.operator)) return fail('FILTER_INVALID', `metric ${m.code} has a filter with an unsupported or missing operator.`);
      const list = f.operator === 'in' || f.operator === 'not_in';
      if (list ? !Array.isArray(f.value) : Array.isArray(f.value) || isRecord(f.value) || f.value === undefined) return fail('FILTER_INVALID', `metric ${m.code} has a filter whose value does not fit operator ${f.operator}.`);
    }
    return plan;
  }

  if (m.filters.length > 0) return fail('FILTER_INVALID', `metric ${m.code}: filters apply to base metrics only.`);
  if (m.metricType === 'target') {
    if (deps.length > 0) return fail('FORMULA_INVALID', `target metric ${m.code} must not have dependencies.`);
    if (target === null) return fail('FORMULA_INVALID', `target metric ${m.code} has no target value.`);
    return plan;
  }
  if (m.metricType === 'derived') {
    const op = formula?.operator;
    if (typeof op !== 'string' || !(SUPPORTED_DERIVED_OPERATORS as readonly string[]).includes(op)) return fail('FORMULA_INVALID', `derived metric ${m.code} needs formula.operator of add, subtract, multiply or divide.`);
    if (deps.length < 2 || (op === 'divide' && deps.length !== 2)) return fail('FORMULA_INVALID', `derived metric ${m.code}: operator ${op} needs ${op === 'divide' ? 'exactly two' : 'at least two'} dependencies.`);
    if (op === 'add' || op === 'subtract') {
      for (const d of deps) if (d.unit !== m.unit || (d.currency ?? null) !== (m.currency ?? null)) return fail('UNIT_MISMATCH', `derived metric ${m.code}: ${op} needs every dependency in the metric's own unit and currency.`);
    }
  } else if (deps.length !== 2) {
    return fail('FORMULA_INVALID', `${m.metricType} metric ${m.code} needs exactly two dependencies (numerator, denominator).`);
  }
  for (const d of deps) {
    if (d.metricType === 'target') continue; // a target is a constant: it applies to every group
    if (d.timeGrain !== m.timeGrain || canonicalJson([...d.dimensions].sort()) !== canonicalJson(dimensions)) return fail('DIMENSION_MISMATCH', `metric ${m.code} must group exactly like its dependency ${d.code} (same dimensions and time grain).`);
  }
  return plan;
}

// ---------------------------------------------------------------- base metrics

function timeBucket(value: unknown, grain: string): string {
  if (grain === 'all_time') return 'all_time';
  const ms = typeof value === 'string' ? Date.parse(value) : typeof value === 'number' ? value : Number.NaN;
  const date = new Date(ms);
  if (!Number.isFinite(ms) || Number.isNaN(date.getTime())) return 'unknown';
  const year = String(date.getUTCFullYear()); const month = String(date.getUTCMonth() + 1).padStart(2, '0'); const day = String(date.getUTCDate()).padStart(2, '0');
  return grain === 'year' ? year : grain === 'month' ? `${year}-${month}` : `${year}-${month}-${day}`;
}

function filterMatches(row: WarehouseRow, f: Record<string, unknown>): boolean {
  const value = row[f.field as string]; const operand = f.value;
  const cmp = (a: unknown, b: unknown): number | null => {
    if (typeof a === 'number' && typeof b === 'number') return compare(toDecimal(a) ?? ZERO, toDecimal(b) ?? ZERO);
    if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
    return null;
  };
  const same = (a: unknown, b: unknown): boolean => (typeof a === 'number' && typeof b === 'number' ? cmp(a, b) === 0 : a === b);
  switch (f.operator) {
    case 'eq': return same(value, operand);
    case 'neq': return !same(value, operand);
    case 'gt': { const c = cmp(value, operand); return c !== null && c > 0; }
    case 'gte': { const c = cmp(value, operand); return c !== null && c >= 0; }
    case 'lt': { const c = cmp(value, operand); return c !== null && c < 0; }
    case 'lte': { const c = cmp(value, operand); return c !== null && c <= 0; }
    case 'in': return (operand as unknown[]).some((o) => same(value, o));
    case 'not_in': return !(operand as unknown[]).some((o) => same(value, o));
    default: return typeof value === 'string' && typeof operand === 'string' && value.includes(operand); // contains
  }
}

const dimensionValue = (v: unknown): DimensionValue | null => (v === undefined || v === null ? 'unknown' : typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : null);

interface GroupedRows { group: MetricGroup; key: string; rows: WarehouseRow[] }

function groupRows(plan: Plan, rows: readonly WarehouseRow[]): GroupedRows[] | CalculationFailure {
  const groups = new Map<string, GroupedRows>();
  for (const row of rows) {
    const dimensions: Record<string, DimensionValue> = {};
    for (const d of plan.dimensions) {
      const v = dimensionValue(row[d]);
      if (v === null) return fail('ROWS_INVALID', `metric ${plan.metric.code}: dimension ${d} holds a non-scalar value.`);
      dimensions[d] = v;
    }
    const bucket = plan.metric.timeGrain === 'all_time' ? null : timeBucket(row[plan.timeField], plan.metric.timeGrain);
    const group: MetricGroup = { dimensions, timeBucket: bucket };
    const key = canonicalJson(group);
    const g = groups.get(key) ?? { group, key, rows: [] };
    g.rows.push(row); groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function aggregate(plan: Plan, rows: readonly WarehouseRow[]): Decimal | null | CalculationFailure {
  const m = plan.metric; const field = m.sourceField;
  if (m.aggregation === 'count') return fromInteger(rows.length);
  const present = rows.map((r) => r[field!]).filter((v) => v !== undefined && v !== null);
  if (m.aggregation === 'count_distinct') {
    const keys = new Set<string>();
    for (const v of present) {
      if (typeof v === 'number') { const d = toDecimal(v); if (d === null) return fail('VALUE_NOT_NUMERIC', `metric ${m.code}: ${field} holds a non-finite number.`); keys.add(`n:${decimalToString(d)}`); }
      else if (typeof v === 'string') keys.add(`s:${v}`);
      else if (typeof v === 'boolean') keys.add(`b:${v}`);
      else return fail('ROWS_INVALID', `metric ${m.code}: ${field} holds a non-scalar value.`);
    }
    return fromInteger(keys.size);
  }
  const numbers: Decimal[] = [];
  for (const v of present) {
    const d = typeof v === 'boolean' ? null : toDecimal(v);
    if (d === null) return fail('VALUE_NOT_NUMERIC', `metric ${m.code}: ${field} holds a value that is not a number.`);
    numbers.push(d);
  }
  if (m.aggregation === 'sum') return numbers.reduce(add, ZERO);
  if (numbers.length === 0) return null;
  switch (m.aggregation) {
    case 'average': return divide(numbers.reduce(add, ZERO), fromInteger(numbers.length));
    case 'minimum': return numbers.reduce((a, b) => (compare(b, a) < 0 ? b : a));
    case 'maximum': return numbers.reduce((a, b) => (compare(b, a) > 0 ? b : a));
    case 'median': {
      const sorted = [...numbers].sort(compare); const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 1 ? sorted[mid]! : half(add(sorted[mid - 1]!, sorted[mid]!));
    }
    case 'first': return numbers[0]!;
    default: return numbers[numbers.length - 1]!; // last
  }
}

// ---------------------------------------------------------------- targets, thresholds, derived metrics

function evaluateThreshold(value: Decimal | null, plan: Plan): ThresholdOutcome {
  if (value === null) return { status: 'no_data', targetMet: false };
  const t = plan.thresholds;
  let status: ThresholdOutcome['status'] = 'normal';
  if (t.criticalBelow && compare(value, t.criticalBelow) < 0) status = 'critical';
  else if (t.warningBelow && compare(value, t.warningBelow) < 0) status = 'warning';
  else if (t.criticalAbove && compare(value, t.criticalAbove) > 0) status = 'critical';
  else if (t.warningAbove && compare(value, t.warningAbove) > 0) status = 'warning';
  else if (t.goodAbove && compare(value, t.goodAbove) >= 0) status = 'good';
  const targetMet = plan.target === null ? null : t.targetDirection === 'below' ? compare(value, plan.target) <= 0 : compare(value, plan.target) >= 0;
  return { status, targetMet };
}

function deriveValue(plan: Plan, values: ReadonlyArray<Decimal | null>): Decimal | null {
  if (values.some((v) => v === null)) return null;
  const v = values as Decimal[];
  switch (plan.metric.metricType) {
    case 'ratio': return divide(v[0]!, v[1]!);
    case 'rate': return divide(multiply(v[0]!, fromInteger(100)), v[1]!);
    default: break;
  }
  switch ((plan.metric.formula as Record<string, unknown>).operator) {
    case 'add': return v.reduce(add, ZERO);
    case 'subtract': return v.slice(1).reduce(subtract, v[0]!);
    case 'multiply': return v.reduce(multiply, fromInteger(1));
    default: return isZero(v[1]!) ? null : divide(v[0]!, v[1]!); // divide
  }
}

// ---------------------------------------------------------------- the calculation

export interface CalculationRequest { handoff: CalculationHandoff; rows: WarehouseRows }

interface Computed { group: MetricGroup; key: string; value: Decimal | null; sourceRowCount: number | null }

export function calculateMetrics(req: CalculationRequest): CalculationOutcome {
  const h = req.handoff;
  const invalid = validateHandoff(h);
  if (invalid) return invalid;
  const ordered = dependencyOrder(h.metrics);
  if (!Array.isArray(ordered)) return ordered;
  const byId = new Map(h.metrics.map((m) => [m.metricId, m]));
  const plans = new Map<string, Plan>();
  for (const m of ordered) {
    const plan = planMetric(m, byId);
    if ('ok' in plan) return plan;
    plans.set(m.metricId, plan);
  }

  // Source rows: every dataset a base metric reads must be present, bounded and made of plain rows. Fingerprints bind the run to exactly these inputs.
  const datasets: CalculationDatasetInput[] = [];
  for (const id of [...new Set(ordered.filter((m) => m.metricType === 'base').map((m) => m.warehouseDatasetId))].sort()) {
    const rows = req.rows.get(id);
    if (rows === undefined) return fail('DATASET_ROWS_UNAVAILABLE', 'a dataset named by the hand-off has no rows supplied.');
    if (!Array.isArray(rows)) return fail('ROWS_INVALID', 'dataset rows must be an array.');
    if (rows.length > MAX_DATASET_ROWS) return fail('DATASET_TOO_LARGE', `a dataset has more than ${MAX_DATASET_ROWS} rows; it is refused, not truncated.`);
    if (rows.some((r) => !isRecord(r))) return fail('ROWS_INVALID', 'every dataset row must be a plain object.');
    let text: string;
    try { text = canonicalJson(rows); } catch { return fail('ROWS_INVALID', 'dataset rows must be plain JSON data.'); }
    datasets.push({ warehouseDatasetId: id, rowCount: rows.length, rowsFingerprint: createHash('sha256').update(text).digest('hex') });
  }
  const calculationRunId = deriveCalculationRunId(h.calculationHandoffId, datasets);

  const computed = new Map<string, Computed[]>();
  for (const m of ordered) {
    const plan = plans.get(m.metricId)!;
    const out: Computed[] = [];
    if (m.metricType === 'base') {
      const rows = req.rows.get(m.warehouseDatasetId)!;
      const kept = rows.filter((r) => m.filters.every((f) => filterMatches(r, f as Record<string, unknown>)));
      const groups = groupRows(plan, kept);
      if (!Array.isArray(groups)) return groups;
      for (const g of groups) {
        const value = aggregate(plan, g.rows);
        if (value !== null && typeof value === 'object' && 'ok' in value) return value;
        out.push({ group: g.group, key: g.key, value: value as Decimal | null, sourceRowCount: g.rows.length });
      }
    } else if (m.metricType === 'target') {
      const group: MetricGroup = { dimensions: {}, timeBucket: null };
      out.push({ group, key: canonicalJson(group), value: plan.target, sourceRowCount: null });
    } else {
      const grouped = plan.deps.filter((d) => d.metricType !== 'target');
      const keys = new Map<string, MetricGroup>();
      for (const d of grouped) for (const c of computed.get(d.metricId)!) keys.set(c.key, c.group);
      if (grouped.length === 0) { const g: MetricGroup = { dimensions: {}, timeBucket: null }; keys.set(canonicalJson(g), g); }
      for (const key of [...keys.keys()].sort()) {
        const values = plan.deps.map((d) => {
          const list = computed.get(d.metricId)!;
          return d.metricType === 'target' ? list[0]!.value : (list.find((c) => c.key === key)?.value ?? null);
        });
        out.push({ group: keys.get(key)!, key, value: deriveValue(plan, values), sourceRowCount: null });
      }
    }
    computed.set(m.metricId, out);
  }

  const results: MetricResult[] = [];
  for (const m of [...ordered].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))) {
    const plan = plans.get(m.metricId)!; const hash = metricContentHash(contentOf(m));
    for (const c of computed.get(m.metricId)!) {
      results.push({
        metricResultId: deriveMetricResultId(calculationRunId, m.metricId, m.version, c.key),
        calculationRunId, calculationHandoffId: h.calculationHandoffId, metricId: m.metricId, metricCode: m.code, metricVersion: m.version, metricContentHash: hash,
        warehouseDatasetId: m.warehouseDatasetId, metricType: m.metricType, group: c.group, groupKey: c.key,
        value: c.value === null ? null : decimalToString(c.value), unit: m.unit, currency: m.currency ?? null, target: plan.target === null ? null : decimalToString(plan.target),
        threshold: evaluateThreshold(c.value, plan), sourceRowCount: c.sourceRowCount, calculationStatus: c.value === null ? 'no_data' : 'completed',
      });
    }
  }
  return {
    ok: true,
    run: { calculationRunId, calculationHandoffId: h.calculationHandoffId, warehouseSnapshotId: h.warehouseSnapshotId, correlationId: h.correlationId, handoffSourceTimestamp: h.createdAt, metricCount: ordered.length, datasets, results },
  };
}

function contentOf(m: MetricDefinition): MetricDefinitionContent {
  const { metricId: _id, scope: _scope, createdAt: _created, updatedAt: _updated, ...content } = m;
  return content;
}
