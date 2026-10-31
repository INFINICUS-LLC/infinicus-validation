/** BI-2-DEV-03 architecture guards (static): the governed metric registry read API is read-only, bi:read only, scoped, SQL-free in the route, and computes nothing. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const route = strip(read('apps/api/src/routes/biMetrics.ts'));
const schema = strip(read('apps/api/src/schemas/biMetrics.ts'));
const repo = strip(read('packages/database/src/repositories/bi/BiMetricRegistryReadRepository.ts'));
const app = strip(read('apps/api/src/app.ts'));
const flat = (s: string) => s.replace(/\s+/g, ' ');

/** Every SQL text in the repository: the shared LATEST constant and each literal passed to query(...) / client.query(...). */
const latest = flat(/const LATEST = `([^`]*)`/.exec(repo)![1]!);
const literals = [...repo.matchAll(/(?:query|client\.query(?:<[^(]*>)?)\(\s*(`[^`]*`|'[^']*')/g)].map((m) => flat(m[1]!.slice(1, -1)));
const statements = [latest, ...literals.map((l) => l.replace('${LATEST}', latest))];

describe('BI-09 registry read API - route', () => {
  it('registers exactly two GET routes and no mutation verb', () => {
    expect(route.match(/server\.get\(/g)?.length).toBe(2);
    expect(route).not.toMatch(/server\.(post|put|patch|delete|all|route)\(/);
    expect(route).not.toMatch(/app\.(post|put|patch|delete|all|route)\(/);
  });

  it('uses only the existing bi:read permission, behind authentication, tenant context, the permission check and the business-in-workspace guard, in that order', () => {
    expect(route).toMatch(/BI_METRIC_READ_PERMISSION = 'bi:read'/);
    expect(route.match(/'[a-z]{2,4}:[a-z]+'/g)).toEqual(["'bi:read'"]);
    expect(flat(route)).toMatch(/preHandler = \[app\.authenticate, app\.resolveTenantContext, app\.requirePermission\(BI_METRIC_READ_PERMISSION\), requireBusinessWorkspace\]/);
    expect(route.match(/preHandler,/g)?.length).toBe(2);
  });

  it('has no SQL, pool or transaction, no Business Operations / Digital Twin / Simulation access, and computes nothing', () => {
    expect(route).not.toMatch(/\b(SELECT|INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM)\b/);
    expect(route).not.toMatch(/\b(getPool|withTenantTransaction|withTransaction|\.query\()/);
    expect(route).not.toMatch(/business-operations-runtime|business_digital_twin|simulation|BusinessIntelligenceMetricRegistryService|registerMetric|reviseMetric|buildCalculationHandoff/);
    expect(route).not.toMatch(/\b(parseFloat|toFixed|Math\.(round|floor|ceil)|reduce\()/);
  });

  it('takes the tenant and workspace from the authenticated context only; no scope field is read from the request body, query or params', () => {
    expect(route).toContain('request.ctx!');
    expect(route).not.toMatch(/request\.body|request\.headers|tenantId|workspaceId/);
  });

  it('is registered once in the application, through a test seam, and nothing else is changed in the registration order of other routes', () => {
    expect(app.match(/app\.register\(biMetricRoutes, options\.biMetrics \?\? \{\}\)/g)?.length).toBe(1);
  });
});

describe('BI-09 registry read API - schemas', () => {
  it('validates ids as UUIDs, refuses unknown query parameters, bounds paging, and derives its enums from the persisted vocabularies', () => {
    expect(schema.match(/\.strict\(\)/g)?.length).toBe(2);
    // request ids: one canonicalizing definition (either case in, lower case out) used by every request-side id; no raw .uuid() on a request schema
    expect(schema).toMatch(/const uuid = z\.string\(\)\.uuid\(\)\.transform\(\(value\) => value\.toLowerCase\(\)\)/);
    expect(schema).toMatch(/biMetricBusinessParamsSchema = z\.object\(\{ businessId: uuid \}\)/);
    expect(schema).toMatch(/biMetricParamsSchema = z\.object\(\{ businessId: uuid, metricId: uuid \}\)/);
    expect(schema).toMatch(/datasetId: uuid\.optional\(\)/);
    for (const line of schema.split('\n').filter((l) => /^export const bi\w*(Params|Query)Schema\b/.test(l))) expect(line, line).not.toMatch(/z\.string\(\)\.uuid\(\)/);
    expect(schema).toMatch(/limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)/);
    expect(schema).toMatch(/offset: z\.coerce\.number\(\)\.int\(\)\.min\(0\)\.max\(100_000\)/);
    expect(schema).toMatch(/z\.enum\(PERSISTABLE_STATUSES\)/); expect(schema).toMatch(/z\.enum\(PERSISTABLE_TIME_GRAINS\)/);
    expect(schema).toMatch(/z\.enum\(METRIC_TYPES\)/); expect(schema).toMatch(/z\.enum\(METRIC_AGGREGATIONS\)/);
  });

  it('never exposes scope, correlation or storage fields', () => {
    expect(schema).not.toMatch(/tenant|workspace|correlation|definition_content|createdBy|created_by/i);
  });
});

describe('BI-09 registry read API - read repository', () => {
  it('found the statements it is about to judge (guards against a pattern that matches nothing)', () => {
    expect(latest.length).toBeGreaterThan(200);
    expect(literals.length).toBe(4);
  });

  it('is SELECT-only: it never inserts, updates, deletes, locks or alters anything', () => {
    for (const s of statements) {
      expect(s, s).toMatch(/^SELECT /);
      expect(s, s).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|pg_advisory|FOR UPDATE)\b/i);
    }
    expect(repo).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i);
  });

  it('reads only the registry tables, the metric\'s own dataset and the business check', () => {
    const tables = new Set(statements.flatMap((s) => [...s.matchAll(/\b(?:FROM|JOIN)\s+([a-z_.]+)/gi)].map((m) => m[1])));
    expect([...tables].sort()).toEqual(['business_intelligence.analytical_datasets', 'business_intelligence.metric_definition_versions', 'business_intelligence.metric_definitions', 'platform.businesses']);
    expect(repo).not.toMatch(/business_operations|business_digital_twin|metric_calculated_values|metric_time_series_values/);
  });

  it('pins every registry statement to the caller\'s tenant, workspace and one business, and joins dataset and version inside the same scope', () => {
    expect(latest).toMatch(/d\.tenant_id = \$1 AND d\.workspace_id = \$2 AND d\.business_id = \$3/);
    expect(latest).toMatch(/v\.tenant_id = d\.tenant_id AND v\.workspace_id = d\.workspace_id AND v\.business_id = d\.business_id/);
    expect(latest).toMatch(/ds\.tenant_id = d\.tenant_id AND ds\.workspace_id = d\.workspace_id AND ds\.business_id = d\.business_id/);
    const versions = statements.find((s) => /FROM business_intelligence\.metric_definition_versions v WHERE/.test(s))!;
    expect(versions).toMatch(/v\.tenant_id = \$1 AND v\.workspace_id = \$2 AND v\.business_id = \$3 AND v\.metric_definition_id = \$4::uuid/);
    const business = statements.find((s) => /FROM platform\.businesses/.test(s))!;
    expect(business).toMatch(/tenant_id = \$2 AND workspace_id = \$3 AND deleted_at IS NULL/);
  });

  it('shows only governed definitions and takes the domain from the dataset relationship, never a copy', () => {
    expect(latest).toMatch(/v\.definition_content IS NOT NULL/);
    expect(latest).toMatch(/ds\.domain AS dataset_domain/);
    expect(latest).not.toMatch(/\bd\.domain\b/);
    expect(latest).toMatch(/v\.version_number = d\.latest_version/);
  });

  it('builds no SQL from user values: the only interpolation is the constant statement, and filters, ids and paging are bound parameters', () => {
    expect([...repo.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]).filter((x) => x !== 'LATEST')).toEqual([]);
    const list = statements.find((s) => /LIMIT \$7 OFFSET \$8/.test(s))!;
    expect(list).toMatch(/\$4::uuid IS NULL OR v\.warehouse_dataset_id = \$4::uuid/);
    expect(list).toMatch(/\$5::text IS NULL OR d\.status = \$5::text/);
    expect(list).toMatch(/\$6::text IS NULL OR v\.time_grain = \$6::text/);
  });

  it('orders totally (code, then id) so pages are deterministic, and bounds the version history', () => {
    expect(statements.find((s) => /LIMIT \$7/.test(s))).toMatch(/ORDER BY d\.metric_code ASC, d\.id ASC LIMIT/);
    expect(statements.find((s) => /ORDER BY v\.version_number DESC LIMIT \$5/.test(s))).toBeTruthy();
  });

  it('checks the business belongs to the caller before reading, and rejects malformed ids before any query', () => {
    expect(repo.indexOf('FROM platform.businesses')).toBeLessThan(repo.indexOf('fn(async'));
    expect(repo).toMatch(/if \(id === null\) throw new NotFoundError\('Business', businessId\)/);
    expect(repo).toMatch(/if \(id === null\) throw new NotFoundError\('MetricDefinition', metricId\)/);
    expect(repo).toMatch(/throw new ValidationError\('MetricListFilter', \['datasetId must be a UUID'\]\)/);
    // every identifier is validated before the first database call of its method
    for (const marker of ['const id = canonicalUuid(businessId)', 'const id = canonicalUuid(metricId)', 'const datasetId = filter.datasetId === undefined']) {
      expect(repo.indexOf(marker), marker).toBeGreaterThan(-1);
    }
    expect(repo.indexOf('const id = canonicalUuid(businessId)')).toBeLessThan(repo.indexOf('withTenantTransaction(ctx'));
    expect(repo.indexOf('const id = canonicalUuid(metricId)')).toBeLessThan(repo.indexOf('this.scoped(ctx, businessId, async (query, scope) => {\n      const latest'));
  });

  it('accepts either letter case and binds only the canonical lower-case value: the pattern is case-insensitive, and no raw caller identifier reaches a statement', () => {
    expect(repo).toMatch(/const UUID = \/\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$\/i;/);
    expect(repo).toMatch(/value\.toLowerCase\(\)/);
    expect(repo).not.toMatch(/\[businessId,|, businessId\]|\[\.\.\.scope, metricId|, metricId\]|filter\.datasetId \?\?/);
    expect(repo).toMatch(/\[id, ctx\.tenantId, ctx\.workspaceId\]/); expect(repo).toMatch(/\[ctx\.tenantId, ctx\.workspaceId, id\]/);
    expect(repo).toMatch(/\[\.\.\.scope, datasetId, filter\.status/);
  });

  it('is not the write path: the write repository and the registry service are not imported', () => {
    expect(repo).not.toMatch(/BiMetricRegistryRepository|BusinessIntelligenceMetricRegistryService|workflow/);
  });
});
