/**
 * BI-09 registry rules (frozen block INFINICUS-BI-09): register a metric against a governed warehouse dataset, reject duplicate codes and circular or
 * unknown dependencies, version a change, record lineage, and prepare the BI-09 -> BI-10 calculation hand-off. These are pure functions over a registry
 * the CALLER supplies; nothing is stored here (the registry tables are not authorized yet) and nothing is calculated here (that is BI-10).
 * Ids and the clock are passed in so the same input always gives the same output.
 */
import { createHash } from 'node:crypto';
import { buildMetricDefinitionContent, canonicalJson, metricContentHash, type MetricDefinition, type MetricDefinitionContent, type MetricDefinitionInput, type MetricScope } from './metricDefinition.js';

export type MetricRegistryErrorCode =
  | 'METRIC_DEFINITION_INVALID'
  | 'METRIC_AGGREGATION_INVALID'
  | 'SCOPE_INVALID'
  | 'SCOPE_MISMATCH'
  | 'DATASET_NOT_FOUND'
  | 'DATASET_SCOPE_MISMATCH'
  | 'METRIC_DEPENDENCY_INVALID'
  | 'METRIC_CODE_DUPLICATE'
  | 'METRIC_NOT_FOUND'
  | 'METRIC_VERSION_INVALID'
  | 'METRIC_NOT_APPROVED'
  | 'NO_METRICS_SELECTED'
  | 'HANDOFF_INVALID';

export interface MetricRegistryFailure { ok: false; code: MetricRegistryErrorCode; detail: string }

/** A governed BI-08 warehouse dataset, as the caller resolved it. BI-09 only checks that it is the dataset named and in the same scope. */
export interface WarehouseDatasetRef { warehouseDatasetId: string; datasetContractId: string | null; scope: MetricScope }

export interface MetricLineage {
  metricId: string;
  metricCode: string;
  warehouseDatasetId: string;
  datasetContractId: string | null;
  sourceField: string | null;
  dependencies: string[];
  dimensions: string[];
  filters: unknown[];
  version: number;
}

export interface MetricDependencyCheck { valid: boolean; unknownDependencies: string[]; circular: boolean }

export type RegisterOutcome = { ok: true; metric: MetricDefinition; lineage: MetricLineage } | MetricRegistryFailure;

const fail = (code: MetricRegistryErrorCode, detail: string): MetricRegistryFailure => ({ ok: false, code, detail });
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const sameScope = (a: MetricScope, b: MetricScope): boolean => a.tenantId === b.tenantId && a.workspaceId === b.workspaceId && a.businessId === b.businessId;
const copy = <T>(v: T): T => structuredClone(v);

export function validateScope(scope: unknown): scope is MetricScope {
  const s = scope as Partial<MetricScope> | null;
  return typeof s === 'object' && s !== null && nonEmpty(s.tenantId) && nonEmpty(s.workspaceId) && nonEmpty(s.businessId);
}

/** The registry the caller holds, checked before any rule runs. A definition from another tenant, workspace or business makes the whole call fail. */
function checkRegistry(scope: MetricScope, registry: readonly MetricDefinition[]): MetricRegistryFailure | null {
  if (!validateScope(scope)) return fail('SCOPE_INVALID', 'tenantId, workspaceId and businessId are required.');
  const seen = new Set<string>();
  for (const m of registry) {
    if (!sameScope(m.scope, scope)) return fail('SCOPE_MISMATCH', 'the registry holds a definition outside the caller scope.');
    const key = `${m.metricId}@${m.version}`;
    if (seen.has(key)) return fail('METRIC_VERSION_INVALID', `the registry holds ${key} twice.`);
    seen.add(key);
  }
  return null;
}

/** Latest version of every metric id. */
export function latestVersions(registry: readonly MetricDefinition[]): Map<string, MetricDefinition> {
  const latest = new Map<string, MetricDefinition>();
  for (const m of registry) {
    const cur = latest.get(m.metricId);
    if (!cur || m.version > cur.version) latest.set(m.metricId, m);
  }
  return latest;
}

/** True when following dependencies from `start` ever returns to a metric already on the path. Iterative, so a deep chain cannot overflow the stack. */
export function hasDependencyCycle(graph: ReadonlyMap<string, readonly string[]>, start: string): boolean {
  const done = new Set<string>();
  const onPath = new Set<string>();
  const stack: Array<{ node: string; next: number }> = [{ node: start, next: 0 }];
  onPath.add(start);
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    const deps = graph.get(top.node) ?? [];
    if (top.next >= deps.length) {
      onPath.delete(top.node);
      done.add(top.node);
      stack.pop();
      continue;
    }
    const dep = deps[top.next]!;
    top.next += 1;
    if (onPath.has(dep)) return true;
    if (done.has(dep) || !graph.has(dep)) continue;
    onPath.add(dep);
    stack.push({ node: dep, next: 0 });
  }
  return false;
}

/** Dependencies name other metric ids in the same registry. A candidate replaces its own earlier version in the graph. */
export function checkMetricDependencies(registry: readonly MetricDefinition[], candidate: Pick<MetricDefinition, 'metricId' | 'dependencies'>): MetricDependencyCheck {
  const graph = new Map<string, readonly string[]>();
  for (const [id, m] of latestVersions(registry)) graph.set(id, m.dependencies);
  const known = new Set(graph.keys());
  graph.set(candidate.metricId, candidate.dependencies);
  const unknownDependencies = candidate.dependencies.filter((d) => d !== candidate.metricId && !known.has(d));
  const circular = hasDependencyCycle(graph, candidate.metricId);
  return { valid: unknownDependencies.length === 0 && !circular, unknownDependencies, circular };
}

export function buildMetricLineage(metric: MetricDefinition, dataset: WarehouseDatasetRef): MetricLineage {
  return {
    metricId: metric.metricId,
    metricCode: metric.code,
    warehouseDatasetId: metric.warehouseDatasetId,
    datasetContractId: dataset.datasetContractId,
    sourceField: metric.sourceField,
    dependencies: [...metric.dependencies],
    dimensions: [...metric.dimensions],
    filters: copy(metric.filters),
    version: metric.version,
  };
}

function checkDataset(scope: MetricScope, warehouseDatasetId: string, dataset: WarehouseDatasetRef | null): MetricRegistryFailure | null {
  if (!dataset || dataset.warehouseDatasetId !== warehouseDatasetId) return fail('DATASET_NOT_FOUND', 'the metric must reference a governed warehouse dataset that was resolved for it.');
  if (!validateScope(dataset.scope) || !sameScope(dataset.scope, scope)) return fail('DATASET_SCOPE_MISMATCH', 'the warehouse dataset belongs to another tenant, workspace or business.');
  return null;
}

export interface RegisterMetricRequest {
  scope: MetricScope;
  /** Every stored version of every metric in this scope. */
  registry: readonly MetricDefinition[];
  /** The warehouse dataset the submitted definition names, resolved by the caller from governed BI-08 data; null when it could not be resolved. */
  dataset: WarehouseDatasetRef | null;
  input: MetricDefinitionInput;
  metricId: string;
  now: Date;
}

/** Register a new metric at its first version. Rejects an invalid definition, an unresolved or foreign dataset, a duplicate code, and bad dependencies. */
export function registerMetric(req: RegisterMetricRequest): RegisterOutcome {
  const registryProblem = checkRegistry(req.scope, req.registry);
  if (registryProblem) return registryProblem;
  if (!nonEmpty(req.metricId)) return fail('METRIC_DEFINITION_INVALID', 'a metric id is required.');
  const built = buildMetricDefinitionContent(req.input);
  if (!built.ok) return built;
  const content = built.content;
  if (content.version !== 1) return fail('METRIC_VERSION_INVALID', 'a new metric starts at version 1; use reviseMetric for a later version.');
  const datasetProblem = checkDataset(req.scope, content.warehouseDatasetId, req.dataset);
  if (datasetProblem) return datasetProblem;
  if (req.registry.some((m) => m.metricId === req.metricId)) return fail('METRIC_VERSION_INVALID', 'this metric id is already registered.');
  if (req.registry.some((m) => m.code === content.code)) return fail('METRIC_CODE_DUPLICATE', `Metric code already exists: ${content.code}`);
  const deps = checkMetricDependencies(req.registry, { metricId: req.metricId, dependencies: content.dependencies });
  if (!deps.valid) return fail('METRIC_DEPENDENCY_INVALID', deps.circular ? 'metric dependencies are circular.' : `unknown dependencies: ${deps.unknownDependencies.join(', ')}`);
  const at = req.now.toISOString();
  const metric: MetricDefinition = { ...content, metricId: req.metricId, scope: { ...req.scope }, createdAt: at, updatedAt: at };
  return { ok: true, metric, lineage: buildMetricLineage(metric, req.dataset!) };
}

export interface ReviseMetricRequest extends Omit<RegisterMetricRequest, 'metricId'> {
  /** The metric being changed. Its code never changes: the code is the identity other layers use. */
  metricId: string;
}

/**
 * Add the next version of an existing metric. The version must be exactly one more than the latest (it defaults to that when the input has none), the
 * code must be unchanged, and the content must actually differ: a revision that changes nothing is refused, so every version is a real change.
 */
export function reviseMetric(req: ReviseMetricRequest): RegisterOutcome {
  const registryProblem = checkRegistry(req.scope, req.registry);
  if (registryProblem) return registryProblem;
  const latest = latestVersions(req.registry).get(req.metricId);
  if (!latest) return fail('METRIC_NOT_FOUND', 'no metric with this id is registered in this scope.');
  const built = buildMetricDefinitionContent({ ...req.input, version: req.input.version ?? latest.version + 1 });
  if (!built.ok) return built;
  const content = built.content;
  if (content.version !== latest.version + 1) return fail('METRIC_VERSION_INVALID', `the next version must be ${latest.version + 1}.`);
  if (content.code !== latest.code) return fail('METRIC_VERSION_INVALID', 'a metric code cannot change between versions.');
  const datasetProblem = checkDataset(req.scope, content.warehouseDatasetId, req.dataset);
  if (datasetProblem) return datasetProblem;
  const { metricId: _id, scope: _scope, createdAt: _c, updatedAt: _u, ...latestContent } = latest;
  if (metricContentHash({ ...content, version: latest.version }) === metricContentHash(latestContent)) return fail('METRIC_VERSION_INVALID', 'the revision changes nothing.');
  const deps = checkMetricDependencies(req.registry, { metricId: req.metricId, dependencies: content.dependencies });
  if (!deps.valid) return fail('METRIC_DEPENDENCY_INVALID', deps.circular ? 'metric dependencies are circular.' : `unknown dependencies: ${deps.unknownDependencies.join(', ')}`);
  const at = req.now.toISOString();
  const metric: MetricDefinition = { ...content, metricId: req.metricId, scope: { ...req.scope }, createdAt: latest.createdAt, updatedAt: at };
  return { ok: true, metric, lineage: buildMetricLineage(metric, req.dataset!) };
}

export interface CalculationHandoff {
  calculationHandoffId: string;
  targetBlock: 'BI-10';
  scope: MetricScope;
  warehouseSnapshotId: string | null;
  correlationId: string;
  metrics: MetricDefinition[];
  metricVersions: Array<{ metricId: string; version: number }>;
  status: 'ready';
  createdAt: string;
}

export interface CalculationHandoffRequest {
  scope: MetricScope;
  registry: readonly MetricDefinition[];
  /** Metric ids to hand over; absent or empty means every approved active metric. */
  metricIds?: readonly string[];
  warehouseSnapshotId: string | null;
  correlationId: string;
  calculationHandoffId: string;
  now: Date;
}

export type CalculationHandoffOutcome = { ok: true; handoff: CalculationHandoff } | MetricRegistryFailure;

const isHandoffReady = (m: MetricDefinition): boolean => m.status === 'active' && m.governanceStatus === 'approved';

type HandoffSelection = { ok: true; selected: MetricDefinition[] } | MetricRegistryFailure;

/** The shared selection rules of both builders: scope check, approved + active only, latest versions, dependencies inside the hand-off, ordered by code. */
function selectForHandoff(req: { scope: MetricScope; registry: readonly MetricDefinition[]; metricIds?: readonly string[]; warehouseSnapshotId: string | null; correlationId: string; calculationHandoffId?: string }): HandoffSelection {
  const registryProblem = checkRegistry(req.scope, req.registry);
  if (registryProblem) return registryProblem;
  if (!nonEmpty(req.correlationId) || (req.calculationHandoffId !== undefined && !nonEmpty(req.calculationHandoffId))) return fail('HANDOFF_INVALID', 'a correlation id and a hand-off id are required.');
  if (req.warehouseSnapshotId !== null && !nonEmpty(req.warehouseSnapshotId)) return fail('HANDOFF_INVALID', 'warehouseSnapshotId must be a non-empty string or null.');
  const latest = latestVersions(req.registry);
  let selected: MetricDefinition[];
  if (req.metricIds && req.metricIds.length > 0) {
    selected = [];
    for (const id of new Set(req.metricIds)) {
      const m = latest.get(id);
      if (!m) return fail('METRIC_NOT_FOUND', `no metric ${id} is registered in this scope.`);
      if (!isHandoffReady(m)) return fail('METRIC_NOT_APPROVED', `metric ${m.code} is not an approved active metric.`);
      selected.push(m);
    }
  } else {
    selected = [...latest.values()].filter(isHandoffReady);
  }
  if (selected.length === 0) return fail('NO_METRICS_SELECTED', 'No approved active metrics were selected.');
  const handed = new Set(selected.map((m) => m.metricId));
  for (const m of selected) {
    const missing = m.dependencies.filter((d) => !handed.has(d));
    if (missing.length > 0) return fail('HANDOFF_INVALID', `metric ${m.code} depends on metrics that are not part of the hand-off: ${missing.join(', ')}.`);
  }
  selected.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return { ok: true, selected };
}

const toHandoff = (req: { scope: MetricScope; warehouseSnapshotId: string | null; correlationId: string }, selected: MetricDefinition[], calculationHandoffId: string, createdAt: string): CalculationHandoff => ({
  calculationHandoffId,
  targetBlock: 'BI-10',
  scope: { ...req.scope },
  warehouseSnapshotId: req.warehouseSnapshotId,
  correlationId: req.correlationId,
  metrics: selected.map(copy),
  metricVersions: selected.map((m) => ({ metricId: m.metricId, version: m.version })),
  status: 'ready',
  createdAt,
});

/**
 * The BI-09 -> BI-10 hand-off: only approved, active metrics, at their latest version, ordered by code. The frozen engine let an explicit id list skip
 * the approval check; the frozen architecture says only approved metrics are published to BI-10, so an unapproved metric named explicitly is refused.
 */
export function buildCalculationHandoff(req: CalculationHandoffRequest): CalculationHandoffOutcome {
  const picked = selectForHandoff({ ...req, calculationHandoffId: req.calculationHandoffId ?? '' });
  if (!picked.ok) return picked;
  return { ok: true, handoff: toHandoff(req, picked.selected, req.calculationHandoffId, req.now.toISOString()) };
}

/**
 * The hand-off identity (BI-2-DEV-04, D-B): a UUID derived (SHA-256, RFC 4122 version/variant bits set) from what the hand-off IS - the business scope, the
 * target block, the snapshot id and, for every handed-over metric, its id, version and content hash. The same registry state gives the same id on every
 * replay; any change to a handed-over definition (a new version, a different content, a different set, a different snapshot) gives a different one. The
 * correlation id and the clock are deliberately NOT part of it: they describe a request, not the hand-off.
 */
export function deriveCalculationHandoffId(scope: MetricScope, warehouseSnapshotId: string | null, selected: readonly MetricDefinition[]): string {
  const ordered = [...selected].sort((a, b) => (a.metricId < b.metricId ? -1 : a.metricId > b.metricId ? 1 : a.version - b.version));
  const material = canonicalJson({
    kind: 'bi-calculation-handoff/v1',
    scope: { tenantId: scope.tenantId, workspaceId: scope.workspaceId, businessId: scope.businessId },
    targetBlock: 'BI-10',
    warehouseSnapshotId,
    metrics: ordered.map((m) => ({ metricId: m.metricId, version: m.version, contentHash: metricContentHash(contentOfDefinition(m)) })),
  });
  const bytes = createHash('sha256').update(material).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function contentOfDefinition(m: MetricDefinition): MetricDefinitionContent {
  const { metricId: _id, scope: _scope, createdAt: _created, updatedAt: _updated, ...content } = m;
  return content;
}

export type DeterministicHandoffRequest = Omit<CalculationHandoffRequest, 'calculationHandoffId' | 'now'>;

/**
 * The deterministic hand-off (BI-2-DEV-04): same selection rules as buildCalculationHandoff, but the identity is derived (deriveCalculationHandoffId) and
 * `createdAt` is taken from the stored, immutable creation time of the newest handed-over version (D-C) - never from a clock - so a replay over unchanged
 * registry state returns an identical hand-off (apart from the request's own correlation id).
 */
export function buildDeterministicCalculationHandoff(req: DeterministicHandoffRequest): CalculationHandoffOutcome {
  const picked = selectForHandoff(req);
  if (!picked.ok) return picked;
  const stamps = picked.selected.map((m) => Date.parse(m.updatedAt));
  if (stamps.some((t) => Number.isNaN(t))) return fail('HANDOFF_INVALID', 'a handed-over metric has no valid stored timestamp.');
  const createdAt = new Date(Math.max(...stamps)).toISOString();
  return { ok: true, handoff: toHandoff(req, picked.selected, deriveCalculationHandoffId(req.scope, req.warehouseSnapshotId, picked.selected), createdAt) };
}
