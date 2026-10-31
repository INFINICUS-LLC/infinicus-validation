/**
 * BI-2-DEV-04 architecture guards (static): the BI-09 -> BI-10 calculation hand-off API is one read-only bi:read GET, SQL-free in the route, derives its identity
 * from content (no generator, no clock), exposes no scope or storage fields, maps errors by a fixed table, and never reaches into other layers' internals.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const flat = (s: string) => s.replace(/\s+/g, ' ');
const route = strip(read('apps/api/src/routes/biMetricHandoff.ts'));
const schema = strip(read('apps/api/src/schemas/biMetricHandoff.ts'));
const service = strip(read('packages/workflow/src/BusinessIntelligenceCalculationHandoffService.ts'));
const rules = strip(read('packages/workflow/src/bi/metricRegistry.ts'));
const repo = strip(read('packages/database/src/repositories/bi/BiMetricRegistryReadRepository.ts'));
const writeService = strip(read('packages/workflow/src/BusinessIntelligenceMetricRegistryService.ts'));
const app = strip(read('apps/api/src/app.ts'));

describe('BI-2-DEV-04 hand-off API - route', () => {
  it('registers exactly one GET route and no mutation verb', () => {
    expect(route.match(/server\.get\(/g)?.length).toBe(1);
    expect(route).not.toMatch(/server\.(post|put|patch|delete|all|route)\(/);
    expect(route).not.toMatch(/app\.(post|put|patch|delete|all|route)\(/);
  });

  it('uses only the existing bi:read permission, behind authentication, tenant context, the permission check and the business-in-workspace guard, in that order', () => {
    expect(route).toMatch(/BI_HANDOFF_READ_PERMISSION = 'bi:read'/);
    expect(route.match(/'[a-z]{2,4}:[a-z]+'/g)).toEqual(["'bi:read'"]);
    expect(flat(route)).toMatch(/preHandler = \[app\.authenticate, app\.resolveTenantContext, app\.requirePermission\(BI_HANDOFF_READ_PERMISSION\), requireBusinessWorkspace\]/);
    expect(route.match(/preHandler,/g)?.length).toBe(1);
  });

  it('has no SQL, pool, transaction or write path, no identity generator, no clock, no calculation, and no other layer', () => {
    expect(route).not.toMatch(/\b(SELECT|INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM)\b/);
    expect(route).not.toMatch(/\b(getPool|withTenantTransaction|withTransaction|\.query\()/);
    expect(route).not.toMatch(/randomUUID|new Date\(|Date\.now|Math\.random|crypto/);
    expect(route).not.toMatch(/business-operations-runtime|business_digital_twin|simulation|BusinessIntelligenceMetricRegistryService|BiMetricRegistryRepository\b|registerMetric|reviseMetric/);
    expect(route).not.toMatch(/\b(parseFloat|toFixed|Math\.(round|floor|ceil)|reduce\()/);
  });

  it('takes tenant and workspace from the authenticated context only, and the correlation id from the request, never from the body or the query', () => {
    expect(route).toContain('request.ctx!');
    expect(route).toContain('request.correlationId');
    expect(route).not.toMatch(/request\.body|request\.headers|tenantId|workspaceId/);
  });

  it('maps every rule failure through one fixed table with fixed messages that never interpolate an id, a code or a detail; anything else is a generic error', () => {
    const table = /switch \(result\.code\) \{([\s\S]*?)\n\s*\}\n/.exec(route)![1]!;
    expect(table.match(/case '/g)?.length).toBe(4);
    expect(table).toMatch(/case 'METRIC_NOT_FOUND': throw new BiNotFoundError\(/);
    for (const code of ['METRIC_NOT_APPROVED', 'NO_METRICS_SELECTED', 'HANDOFF_INVALID']) expect(table).toMatch(new RegExp(`case '${code}': throw new BiConflictError\\(`));
    expect(table).toMatch(/default: throw new Error\('calculation hand-off could not be built'\)/);
    expect(table).not.toMatch(/\$\{|result\.detail|result\.code\s*\+|\+\s*result/);
  });

  it('does not expose the internal scope: the wire form drops tenant and workspace and keeps only the business id', () => {
    expect(route).toMatch(/businessId: h\.scope\.businessId/);
    expect(route).toMatch(/scope: _scope/);
    expect(route).not.toMatch(/h\.scope\.(tenantId|workspaceId)/);
  });

  it('is registered once in the application, through a test seam', () => {
    expect(app.match(/app\.register\(biMetricHandoffRoutes, options\.biMetricHandoff \?\? \{\}\)/g)?.length).toBe(1);
  });
});

describe('BI-2-DEV-04 hand-off API - schema', () => {
  it('validates the business id and every metric id as a canonicalized UUID, refuses unknown query parameters, and never accepts a scope or snapshot field', () => {
    expect(schema).toMatch(/const uuid = z\.string\(\)\.uuid\(\)\.transform\(\(value\) => value\.toLowerCase\(\)\)/);
    expect(schema).toMatch(/biHandoffParamsSchema = z\.object\(\{ businessId: uuid \}\)/);
    expect(schema).toMatch(/metricIds: z\.union\(\[uuid, z\.array\(uuid\)\]\)/);
    expect(schema.match(/\.strict\(\)/g)?.length).toBe(1);
    const query = /biHandoffQuerySchema = z\.object\(\{([\s\S]*?)\}\)\.strict/.exec(schema)![1]!;
    expect(query).not.toMatch(/tenant|workspace|snapshot|correlation|limit|offset/i);
  });

  it('declares the response as an allow-list with no tenant, workspace or storage fields', () => {
    expect(schema).not.toMatch(/tenantId|workspaceId|tenant_id|workspace_id|definition_content|content_hash/);
    expect(schema).toMatch(/targetBlock: z\.literal\('BI-10'\)/);
    expect(schema).toMatch(/status: z\.literal\('ready'\)/);
  });
});

describe('BI-2-DEV-04 hand-off - service and rules', () => {
  it('the read service reads through the SELECT-only read repository and writes nothing', () => {
    expect(service).toMatch(/BiMetricRegistryReadRepository/);
    expect(service).not.toMatch(/BiMetricRegistryRepository\b|\.(insert|update|delete)\w*\(|INSERT|UPDATE |DELETE |\.transaction\(/);
  });

  it('neither service generates an identity or reads a clock for the hand-off: the id is derived, the timestamp is the stored one', () => {
    expect(service).not.toMatch(/randomUUID|new Date\(|Date\.now|Math\.random/);
    const handoffMethod = /async calculationHandoff\([\s\S]*?\n  \}\n/.exec(writeService)![0];
    expect(handoffMethod).toContain('buildDeterministicCalculationHandoff');
    expect(handoffMethod).not.toMatch(/randomUUID|new Date\(|Date\.now|calculationHandoffId:/);
  });

  it('the deterministic builder derives the id from scope, target, snapshot and each metric id / version / content hash, and from nothing else', () => {
    const derive = /export function deriveCalculationHandoffId[\s\S]*?\n\}\n/.exec(rules)![0];
    expect(flat(derive)).toMatch(/kind: 'bi-calculation-handoff\/v1'/);
    for (const part of ['scope:', "targetBlock: 'BI-10'", 'warehouseSnapshotId,', 'metricId: m.metricId', 'version: m.version', 'contentHash: metricContentHash(']) expect(derive, part).toContain(part);
    expect(derive).not.toMatch(/correlationId|randomUUID|new Date|Date\.now|Math\.random|createdAt|updatedAt/);
    const builder = /export function buildDeterministicCalculationHandoff[\s\S]*$/.exec(rules)![0];
    expect(builder).not.toMatch(/randomUUID|new Date\(\)|Date\.now|Math\.random|req\.now/);
    expect(builder).toMatch(/Math\.max\(\.\.\.stamps\)/);
  });

  it('the snapshot id is null in the read service (D-A: no snapshot record exists), not taken from the caller', () => {
    expect(service).toMatch(/warehouseSnapshotId: null/);
  });

  it('the repository method that feeds it is SELECT-only, scoped through the same business check, and ordered totally; no cap is invented (D-F)', () => {
    const method = /async listAllLatest\([\s\S]*?\n  \}\n/.exec(repo)![0];
    expect(method).toContain('this.scoped(');
    expect(flat(method)).toContain('ORDER BY d.metric_code ASC, d.id ASC');
    expect(method).not.toMatch(/INSERT|UPDATE |DELETE |LIMIT|OFFSET|Math\./);
    expect(method).toMatch(/\bquery\(`\$\{LATEST\}/);
  });
});
