/**
 * BI-1-DEV-03 - architecture guards (static, no database): the BI read API is four permission-gated GETs over business_intelligence only; the repository
 * issues SELECT statements pinned to tenant, workspace and business; no BO import, no write, no raw jsonb pass-through of provenance.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PLATFORM = resolve(__dirname, '../../..');
const code = (rel: string) => readFileSync(resolve(PLATFORM, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
const ROUTE = 'apps/api/src/routes/biDatasets.ts';
const SCHEMA = 'apps/api/src/schemas/biDatasets.ts';
const REPO = 'packages/database/src/repositories/bi/BiIntakeDatasetReadRepository.ts';
const WRITES = /\b(INSERT\s+INTO|UPDATE\s+[\w."]+\s+SET|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE|CREATE\s+(TABLE|INDEX|POLICY|TRIGGER)|DROP\s+(TABLE|POLICY|INDEX)|FOR\s+UPDATE)\b/i;

describe('BI-1 read API architecture', () => {
  it('the route file registers exactly four GETs and no other verb', () => {
    const src = code(ROUTE);
    expect([...src.matchAll(/server\.(get|post|put|patch|delete|head|options|route|all)\(/g)].map((m) => m[1])).toEqual(['get', 'get', 'get', 'get']);
    expect([...src.matchAll(/server\.get\('([^']+)'/g)].map((m) => m[1])).toEqual([
      '/v1/businesses/:businessId/bi/intake-packages', '/v1/businesses/:businessId/bi/intake-packages/:intakePackageId',
      '/v1/businesses/:businessId/bi/datasets', '/v1/businesses/:businessId/bi/datasets/:datasetId',
    ]);
  });
  it('every route is authenticated, resolves the tenant context, requires the existing bi:read permission and checks the business belongs to the caller workspace, in that order', () => {
    const src = code(ROUTE);
    expect(src).toMatch(/BI_DATASET_READ_PERMISSION = 'bi:read'/);
    expect(src).toMatch(/const preHandler = \[app\.authenticate, app\.resolveTenantContext, app\.requirePermission\(BI_DATASET_READ_PERMISSION\), requireBusinessWorkspace\]/);
    expect([...src.matchAll(/^\s*preHandler,\s*$/gm)]).toHaveLength(4);
    expect(src).not.toMatch(/requireIdempotencyKey|requireActiveSubscription/);
  });
  it('the route reads business_intelligence only through the read repository: no SQL, no BO or DAL import, no write', () => {
    const src = code(ROUTE);
    expect(src).not.toMatch(/business_operations|business-operations-runtime|data-acquisition-runtime|\.query\(|withTenantTransaction/);
    expect(src).not.toMatch(WRITES);
    expect(src).toMatch(/new BiIntakeDatasetReadRepository\(\)/);
  });
  it('the read repository is SELECT only, touches no business_operations table, and pins EVERY statement to tenant, workspace and business from the caller', () => {
    const src = code(REPO);
    expect(src).not.toMatch(WRITES);
    expect(src).not.toMatch(/business_operations/);
    // every SELECT template literal, with the parameter list that follows it (inline, or the shared `scope` array defined from the caller context)
    const statements = [...src.matchAll(/`(SELECT[\s\S]*?)`,\s*(\[[^\]]*\]|scope)\s*\)/g)];
    expect(statements.length).toBe([...src.matchAll(/`SELECT/g)].length);
    expect(statements.length).toBe(12);
    const scopeDef = /const scope = \[([^\]]*)\]/.exec(src);
    expect(scopeDef).not.toBeNull();
    expect(scopeDef![1]).toMatch(/businessId/); expect(scopeDef![1]).toMatch(/ctx\.tenantId/); expect(scopeDef![1]).toMatch(/ctx\.workspaceId/);
    for (const [, sql, params] of statements) {
      expect(sql, sql.slice(0, 60)).toMatch(/business_id = \$\d/);
      expect(sql, sql.slice(0, 60)).toMatch(/tenant_id = \$\d/);
      expect(sql, sql.slice(0, 60)).toMatch(/workspace_id = \$\d/);
      if (params !== 'scope') { expect(params, sql.slice(0, 60)).toMatch(/ctx\.tenantId/); expect(params, sql.slice(0, 60)).toMatch(/ctx\.workspaceId/); expect(params, sql.slice(0, 60)).toMatch(/businessId/); }
    }
  });
  it('provenance is exposed through a whitelist, never as the raw source-reference jsonb, and no scope or internal column is selected', () => {
    const src = code(REPO);
    expect(src).toMatch(/Only a whitelist of what BI recorded/.test(readFileSync(resolve(PLATFORM, REPO), 'utf8')) ? /./ : /never-matches-/);
    expect(src).not.toMatch(/SELECT[^`]*\b(idempotency_key|causation_id|created_by|actor_id)\b/);
    expect(src).not.toMatch(/sourceReference:\s*s\.source_reference/);
    const schema = code(SCHEMA);
    for (const forbidden of ['tenantId', 'workspaceId', 'idempotencyKey', 'causationId', 'createdBy', 'actorId']) expect(schema, forbidden).not.toContain(forbidden);
  });
  it('the scores are nullable in the response contract: unassessed is null, never a default of zero', () => {
    const schema = code(SCHEMA);
    expect(schema).toMatch(/const score = z\.number\(\)\.min\(0\)\.max\(1\)\.nullable\(\)/);
    expect(code(REPO)).toMatch(/const score = \(v: unknown\): number \| null => \(v === null \|\| v === undefined \? null/);
    expect(code(REPO)).not.toMatch(/\?\?\s*0\b/);
  });
});
