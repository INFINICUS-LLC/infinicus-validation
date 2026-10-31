/**
 * BI-2-DEV-08 architecture guards (static): execution is never authorised by read alone and takes no data; retrieval is read-only; no permission and no migration were
 * added; results are queried by one static, scoped, bounded statement; errors come from a closed vocabulary; nothing is invented or fixture-fed in application code.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const flat = (s: string) => s.replace(/\s+/g, ' ');
const route = strip(read('apps/api/src/routes/biCalculations.ts'));
const schema = strip(read('apps/api/src/schemas/biCalculations.ts'));
const resultsRepo = strip(read('packages/database/src/repositories/bi/BiMetricResultReadRepository.ts'));
const app = strip(read('apps/api/src/app.ts'));
const calcService = strip(read('packages/workflow/src/BusinessIntelligenceMetricCalculationService.ts'));

describe('BI-10 calculation API - route authority', () => {
  it('registers exactly one POST (execute) and two GETs (run, results); no put, patch, delete or other verb', () => {
    expect(route.match(/server\.post\(/g)?.length).toBe(1);
    expect(route.match(/server\.get\(/g)?.length).toBe(2);
    expect(route).not.toMatch(/server\.(put|patch|delete|all|route)\(/);
    expect(route).not.toMatch(/app\.(post|put|patch|delete|all|route)\(/);
  });

  it('execution requires bi:write AND bi:read, then the business guard, an active subscription and an Idempotency-Key - in that order - so bi:read alone never authorises a write', () => {
    expect(route).toMatch(/BI_CALCULATION_EXECUTE_PERMISSIONS = \['bi:write', 'bi:read'\] as const/);
    expect(flat(route)).toMatch(/preHandler: \[app\.authenticate, app\.resolveTenantContext, app\.requireAllPermissions\(BI_CALCULATION_EXECUTE_PERMISSIONS\), requireBusinessWorkspace, app\.requireActiveSubscription\(\), app\.requireIdempotencyKey\]/);
    const post = route.slice(route.indexOf('server.post('), route.indexOf('server.get('));
    expect(post).not.toMatch(/requirePermission\(/);
  });

  it('retrieval and querying require bi:read only, behind authentication, tenant context, the permission and the business-in-workspace guard', () => {
    expect(route).toMatch(/BI_CALCULATION_READ_PERMISSION = 'bi:read'/);
    expect(flat(route)).toMatch(/readGuards = \[app\.authenticate, app\.resolveTenantContext, app\.requirePermission\(BI_CALCULATION_READ_PERMISSION\), requireBusinessWorkspace\]/);
    expect(route.match(/preHandler: readGuards/g)?.length).toBe(2);
  });

  it('adds no permission: the only codes in the route are bi:read and bi:write, and both are seeded by the existing authorization migration', () => {
    expect([...new Set(route.match(/'[a-z]{2,4}:[a-z]+'/g))].sort()).toEqual(["'bi:read'", "'bi:write'"]);
    const seed = read('infrastructure/database/migrations/0137_seed_auth_roles_permissions.sql');
    expect(seed).toMatch(/\('bi:write',\s+'business_intelligence',\s+'write', 'Manage business intelligence analyses and metrics'\)/);
    expect(seed).toMatch(/\('bi:read'/);
    const migrations = readdirSync(resolve(root, 'infrastructure/database/migrations')).filter((f) => /^0(22[3-9]|2[3-9]\d)_/.test(f));
    expect(migrations).toEqual(['0223_bi10_warehouse_rows_and_calculation_persistence.sql']); // BI-2-DEV-08 added no migration
  });

  it('takes tenant and workspace from the authenticated context and the correlation id from the request, never from the body, query or headers', () => {
    expect(route).toContain('request.ctx!');
    expect(route).toContain('correlationId: request.correlationId');
    expect(route).not.toMatch(/request\.headers|tenantId|workspaceId/);
    expect(route.match(/request\.body/g)?.length).toBe(1); // only the optional selection
  });

  it('has no SQL, pool, transaction, identity generator or clock; writes only through the persistence-verified service; touches no other layer', () => {
    expect(route).not.toMatch(/\b(SELECT|INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM)\b/);
    expect(route).not.toMatch(/\b(getPool|withTenantTransaction|withTransaction|\.query\()/);
    expect(route).not.toMatch(/randomUUID|new Date\(|Date\.now|Math\.random|crypto/);
    expect(route).not.toMatch(/business-operations-runtime|business_operations|business_digital_twin|simulation|BiWarehouseRowRepository|BiCalculationRunRepository|PostgresWarehouseRowSource|registerMetric|reviseMetric/);
    expect(route.match(/calculateAndPersist\(/g)?.length).toBe(1);
  });

  it('is registered once in the application, through a test seam', () => {
    expect(app.match(/app\.register\(biCalculationRoutes, options\.biCalculations \?\? \{\}\)/g)?.length).toBe(1);
  });
});

describe('BI-10 calculation API - no data in, no fixtures, closed errors', () => {
  it('the execute body is strict and can hold nothing but a metric selection and an expected hand-off id: no rows, records, data, scope or snapshot', () => {
    const body = /biCalcExecuteBodySchema = z\.object\(\{([\s\S]*?)\}\)\.strict\(\)\.optional\(\)/.exec(schema)![1]!;
    expect([...body.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]).sort()).toEqual(['calculationHandoffId', 'metricIds']);
    expect(schema.match(/\.strict\(\)/g)?.length).toBe(2); // the body and the results query
    expect(body).not.toMatch(/rows|records|data|warehouse|tenant|workspace|snapshot|correlation/i);
  });

  it('application code takes rows from nothing but the sealed BI warehouse: no fixture, test helper or inline data in the route, schema or service', () => {
    for (const src of [route, schema, calcService]) expect(src).not.toMatch(/fixture|tests\/|boPublicationFixtures|publishBoPackage|generate_series|INSERT INTO business_intelligence\.warehouse/i);
    expect(calcService).toMatch(/new PostgresWarehouseRowSource\(ctx\)/);
  });

  it('every refusal draws its text from a closed vocabulary: a fixed shape plus a code from one fixed set, never the cause or the detail of a failure', () => {
    expect(route).toMatch(/new BiConflictError\('CalculationRun', 'cannot be executed \(' \+ code \+ '\)'\)/);
    expect(route).toMatch(/if \(code === 'METRIC_NOT_FOUND'\) return new BiNotFoundError\('Metric', 'in this business'\)/);
    expect(route).toMatch(/return new Error\('calculation could not be completed'\)/);
    expect(route).not.toMatch(/\.detail\b|\.message\b|String\(error\)|JSON\.stringify\(error/);
    const set = /CONFLICT_CODES = new Set\(\[([\s\S]*?)\]\)/.exec(route)![1]!;
    for (const code of [...set.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!)) expect(code).toMatch(/^[A-Z][A-Z_]+$/);
    for (const mustBeConflict of ['RUN_NOT_REPRODUCIBLE', 'HANDOFF_CHANGED', 'DATASET_ROWS_UNAVAILABLE', 'DATASET_TOO_LARGE', 'RUN_CONFLICT', 'METRIC_NOT_APPROVED']) expect(set).toContain(mustBeConflict);
    for (const mustBeServerSide of ['STORED_RUN_INTEGRITY', 'RUN_IDENTITY_MISMATCH', 'RESULT_INVALID', 'RUN_INVALID', 'SCOPE_MISMATCH']) expect(set).not.toContain(mustBeServerSide);
  });

  it('the response schemas expose no tenant, workspace or storage field', () => {
    expect(schema).not.toMatch(/tenantId|workspaceId|tenant_id|workspace_id|run_digest|definition_content/);
  });
});

describe('BI-10 result querying - one static, scoped, bounded statement', () => {
  const statement = flat(/const LIST = `([^`]*)`/.exec(resultsRepo)![1]!);

  it('is SELECT-only over the result tables, pinned to the caller\'s tenant, workspace and business, and joins the inputs inside the same scope', () => {
    expect(statement).toMatch(/^SELECT /);
    expect(statement).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT)\b/i);
    expect(statement).toMatch(/WHERE r\.tenant_id = \$1 AND r\.workspace_id = \$2 AND r\.business_id = \$3/);
    expect(statement).toMatch(/i\.tenant_id = r\.tenant_id AND i\.workspace_id = r\.workspace_id AND i\.business_id = r\.business_id/);
    const tables = [...statement.matchAll(/\b(?:FROM|JOIN)\s+([a-z_.]+)/gi)].map((m) => m[1]).sort();
    expect(tables).toEqual(['business_intelligence.metric_calculation_run_inputs', 'business_intelligence.metric_results']);
    expect(resultsRepo).not.toMatch(/business_operations|getPool|\bpool\./);
  });

  it('binds every filter and the page: no interpolation of any value into the statement', () => {
    expect(resultsRepo).not.toMatch(/\$\{/);
    for (const n of [4, 5, 6, 7, 8, 9]) expect(statement).toContain(`$${n}::`);
    expect([...statement.matchAll(/\$\d+::(?:uuid|text) IS NULL OR/g)]).toHaveLength(6);
    expect(statement).toMatch(/LIMIT \$10 OFFSET \$11$/);
    expect(resultsRepo.match(/inBusinessScope\(/g)?.length).toBe(1);
  });

  it('orders totally (newest run first, then run, code, group key, id) so pages are deterministic', () => {
    expect(statement).toContain('ORDER BY r.persisted_at DESC, r.run_id ASC, r.metric_code COLLATE "C" ASC, r.group_key COLLATE "C" ASC, r.id ASC');
  });

  it('enforces the paging bounds itself, before any connection, and never clamps; the API schema and the repository agree on every bound', () => {
    expect(resultsRepo).toMatch(/RESULT_QUERY_BOUNDS = \{ minLimit: 1, maxLimit: 100, minOffset: 0, maxOffset: 100_000 \} as const/);
    expect(resultsRepo.indexOf('boundedInteger(\'limit\'')).toBeLessThan(resultsRepo.indexOf('inBusinessScope('));
    expect(resultsRepo).not.toMatch(/Math\.(min|max|trunc|floor|round|ceil)|\.slice\(|\.splice\(/);
    expect(schema).toMatch(/limit: z\.coerce\.number\(\)\.int\(\)\.min\(RESULT_QUERY_BOUNDS\.minLimit\)\.max\(RESULT_QUERY_BOUNDS\.maxLimit\)\.default\(20\)/);
    expect(schema).toMatch(/offset: z\.coerce\.number\(\)\.int\(\)\.min\(RESULT_QUERY_BOUNDS\.minOffset\)\.max\(RESULT_QUERY_BOUNDS\.maxOffset\)\.default\(0\)/);
  });

  it('refuses a filter the contract does not carry: every accepted filter is validated against a closed set or a fixed pattern, in the repository as well as the schema', () => {
    for (const filter of ['calculationRunId', 'metricId', 'metricCode', 'calculationStatus', 'thresholdStatus', 'timeBucket']) { expect(schema, filter).toContain(`${filter}:`); expect(resultsRepo, filter).toContain(`filter.${filter}`); }
    expect(resultsRepo).toMatch(/METRIC_CODE = \/\^\[a-z0-9_\]\{1,128\}\$\//);
  });
});
