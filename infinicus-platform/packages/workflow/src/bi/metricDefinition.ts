/**
 * BI-09 metric and KPI definition model (frozen block: layers/business-intelligence/blocks/INFINICUS-BI-09, docs/METRIC-MODEL.md). Pure domain code: no
 * database, no clock, no id generation, no calculation (metric evaluation is BI-10). The registry that stores definitions needs tables that do not exist
 * yet, so nothing here persists anything.
 */
import { createHash } from 'node:crypto';

export const METRIC_TYPES = ['base', 'derived', 'ratio', 'rate', 'target'] as const;
export type MetricType = (typeof METRIC_TYPES)[number];

export const METRIC_AGGREGATIONS = ['sum', 'count', 'count_distinct', 'average', 'minimum', 'maximum', 'median', 'first', 'last'] as const;
export type MetricAggregation = (typeof METRIC_AGGREGATIONS)[number];

export type MetricDefinitionErrorCode = 'METRIC_DEFINITION_INVALID' | 'METRIC_AGGREGATION_INVALID';

/** Where a registry lives. The registry is per business; every definition, dataset and dependency in one registry carries the same scope. */
export interface MetricScope { tenantId: string; workspaceId: string; businessId: string }

/** What a caller may submit. Everything past the four required fields is optional and defaulted exactly as the frozen model does. */
export interface MetricDefinitionInput {
  name?: unknown;
  code?: unknown;
  warehouseDatasetId?: unknown;
  metricType?: unknown;
  aggregation?: unknown;
  description?: unknown;
  sourceField?: unknown;
  dependencies?: unknown;
  formula?: unknown;
  filters?: unknown;
  dimensions?: unknown;
  timeGrain?: unknown;
  unit?: unknown;
  currency?: unknown;
  target?: unknown;
  thresholds?: unknown;
  owner?: unknown;
  governanceStatus?: unknown;
  version?: unknown;
  status?: unknown;
}

/** The identity-free, timestamp-free content of a definition. This is what the canonical form and its hash cover. */
export interface MetricDefinitionContent {
  name: string;
  code: string;
  description: string;
  metricType: MetricType;
  warehouseDatasetId: string;
  sourceField: string | null;
  aggregation: MetricAggregation | null;
  dependencies: string[];
  formula: unknown;
  filters: unknown[];
  dimensions: string[];
  timeGrain: string;
  unit: string;
  currency: string | null;
  target: number | null;
  thresholds: Record<string, unknown>;
  owner: string;
  governanceStatus: string;
  version: number;
  status: string;
}

export interface MetricDefinition extends MetricDefinitionContent {
  metricId: string;
  scope: MetricScope;
  createdAt: string;
  updatedAt: string;
}

export type MetricDefinitionResult =
  | { ok: true; content: MetricDefinitionContent }
  | { ok: false; code: MetricDefinitionErrorCode; detail: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** Same normalisation as the frozen model: trim, lower-case, every character outside a-z, 0-9 and _ becomes _ ("Gross Margin %" -> "gross_margin__"). */
export const normalizeMetricCode = (raw: string): string => raw.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');

const invalid = (detail: string): MetricDefinitionResult => ({ ok: false, code: 'METRIC_DEFINITION_INVALID', detail });

/** Deep copy of plain JSON data; anything that is not JSON (functions, undefined, NaN, cycles) is refused rather than silently dropped. */
function cloneJson(value: unknown, path: string, depth = 0): { ok: true; value: unknown } | { ok: false; detail: string } {
  if (depth > 12) return { ok: false, detail: `${path} is nested too deeply` };
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return { ok: true, value };
  if (typeof value === 'number') return Number.isFinite(value) ? { ok: true, value } : { ok: false, detail: `${path} must be a finite number` };
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i += 1) {
      const r = cloneJson(value[i], `${path}[${i}]`, depth + 1);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return { ok: true, value: out };
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value)) {
      const r = cloneJson(value[k], `${path}.${k}`, depth + 1);
      if (!r.ok) return r;
      out[k] = r.value;
    }
    return { ok: true, value: out };
  }
  return { ok: false, detail: `${path} must be plain JSON data` };
}

/**
 * Validate and normalise a submitted definition. Required: name, code, warehouseDatasetId, a supported metricType; a base metric also needs a supported
 * aggregation. Defaults are the frozen ones (timeGrain all_time, unit number, governanceStatus draft, status active, version 1). Nothing is guessed:
 * a field of the wrong type is refused, not coerced.
 */
export function buildMetricDefinitionContent(input: MetricDefinitionInput): MetricDefinitionResult {
  if (!nonEmpty(input.name) || !nonEmpty(input.code) || !nonEmpty(input.warehouseDatasetId) || typeof input.metricType !== 'string'
    || !(METRIC_TYPES as readonly string[]).includes(input.metricType)) {
    return invalid('name, code, warehouseDatasetId, and a supported metricType are required.');
  }
  const metricType = input.metricType as MetricType;
  const code = normalizeMetricCode(input.code);
  if (code.replace(/_/g, '').length === 0) return invalid('code must contain at least one letter or digit.');

  let aggregation: MetricAggregation | null = null;
  if (input.aggregation !== undefined && input.aggregation !== null && input.aggregation !== '') {
    if (typeof input.aggregation !== 'string' || !(METRIC_AGGREGATIONS as readonly string[]).includes(input.aggregation)) {
      return { ok: false, code: 'METRIC_AGGREGATION_INVALID', detail: 'aggregation must be a supported aggregation.' };
    }
    aggregation = input.aggregation as MetricAggregation;
  }
  if (metricType === 'base' && aggregation === null) {
    return { ok: false, code: 'METRIC_AGGREGATION_INVALID', detail: 'Base metrics require a supported aggregation.' };
  }

  const optionalString = (v: unknown, field: string, fallback: string): string | null => (v === undefined || v === null ? fallback : typeof v === 'string' ? v : (void field, null));
  const description = optionalString(input.description, 'description', '');
  const timeGrain = optionalString(input.timeGrain, 'timeGrain', 'all_time');
  const unit = optionalString(input.unit, 'unit', 'number');
  const owner = optionalString(input.owner, 'owner', '');
  const governanceStatus = optionalString(input.governanceStatus, 'governanceStatus', 'draft');
  const status = optionalString(input.status, 'status', 'active');
  if (description === null || timeGrain === null || unit === null || owner === null || governanceStatus === null || status === null) {
    return invalid('description, timeGrain, unit, owner, governanceStatus and status must be strings.');
  }
  if (!nonEmpty(timeGrain) || !nonEmpty(unit) || !nonEmpty(governanceStatus) || !nonEmpty(status)) {
    return invalid('timeGrain, unit, governanceStatus and status must not be empty.');
  }

  const sourceField = input.sourceField === undefined || input.sourceField === null ? null : input.sourceField;
  if (sourceField !== null && !nonEmpty(sourceField)) return invalid('sourceField must be a non-empty string or absent.');
  const currency = input.currency === undefined || input.currency === null ? null : input.currency;
  if (currency !== null && !nonEmpty(currency)) return invalid('currency must be a non-empty string or absent.');
  const target = input.target === undefined || input.target === null ? null : input.target;
  if (target !== null && (typeof target !== 'number' || !Number.isFinite(target))) return invalid('target must be a finite number or absent.');

  const stringList = (v: unknown, field: string): string[] | string => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || !v.every(nonEmpty)) return `${field} must be a list of non-empty strings.`;
    return v.map((s) => s.trim());
  };
  const deps = stringList(input.dependencies, 'dependencies');
  const dims = stringList(input.dimensions, 'dimensions');
  if (typeof deps === 'string') return invalid(deps);
  if (typeof dims === 'string') return invalid(dims);

  if (input.filters !== undefined && input.filters !== null && !Array.isArray(input.filters)) return invalid('filters must be a list.');
  if (input.thresholds !== undefined && input.thresholds !== null && !isRecord(input.thresholds)) return invalid('thresholds must be an object.');
  const filters = cloneJson(input.filters ?? [], 'filters');
  if (!filters.ok) return invalid(filters.detail);
  const thresholds = cloneJson(input.thresholds ?? {}, 'thresholds');
  if (!thresholds.ok) return invalid(thresholds.detail);
  const formula = cloneJson(input.formula ?? null, 'formula');
  if (!formula.ok) return invalid(formula.detail);

  const versionRaw = input.version === undefined || input.version === null ? 1 : input.version;
  if (typeof versionRaw !== 'number' || !Number.isInteger(versionRaw) || versionRaw < 1) return invalid('version must be an integer of at least 1.');

  return {
    ok: true,
    content: {
      name: input.name.trim(),
      code,
      description,
      metricType,
      warehouseDatasetId: input.warehouseDatasetId.trim(),
      sourceField: sourceField as string | null,
      aggregation,
      dependencies: [...new Set(deps)],
      formula: formula.value,
      filters: filters.value as unknown[],
      dimensions: dims,
      timeGrain,
      unit,
      currency: currency as string | null,
      target: target as number | null,
      thresholds: thresholds.value as Record<string, unknown>,
      owner,
      governanceStatus,
      version: versionRaw,
      status,
    },
  };
}

/** Deterministic JSON: object keys sorted at every depth, arrays kept in order, no whitespace. Equal content always gives equal text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

/**
 * Canonical form of a definition's content. Dependencies and dimensions are sorted (their order carries no meaning); filters keep their order.
 * Ids, scope and timestamps are not content, so the same definition submitted twice has the same form.
 */
export function canonicalMetricContent(content: MetricDefinitionContent): string {
  return canonicalJson({ ...content, dependencies: [...content.dependencies].sort(), dimensions: [...content.dimensions].sort() });
}

export const metricContentHash = (content: MetricDefinitionContent): string => createHash('sha256').update(canonicalMetricContent(content)).digest('hex');
