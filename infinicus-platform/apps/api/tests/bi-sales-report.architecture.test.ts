/**
 * BI-SALES-1 - architecture guards (static, no database): BI is read-only over Business Operations truth, owns no second copy, never imports
 * Business Operations, and the route is a single permission-gated GET.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PLATFORM = resolve(__dirname, '../../..');
const read = (rel: string) => readFileSync(resolve(PLATFORM, rel), 'utf8');
/** Source without comments, so a rule is checked against code and not against the prose that explains it. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

const BI_SERVICE = 'packages/workflow/src/SalesReportService.ts';
const BO_FILES = [
  'packages/database/src/repositories/bo/SalesFactsRepository.ts',
  'packages/business-operations-runtime/src/sales/SalesFactsService.ts',
  'packages/business-operations-runtime/src/sales/decimalMinor.ts',
];
const ROUTE = 'apps/api/src/routes/biSalesReport.ts';
const WRITES = /\b(INSERT\s+INTO|UPDATE\s+[\w."]+\s+SET|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE|CREATE\s+(TABLE|INDEX|POLICY|TRIGGER)|DROP\s+(TABLE|POLICY|INDEX))\b/i;

describe('BI-SALES-1 architecture', () => {
  it('BI never imports Business Operations: it reads through a structural port composed at the API', () => {
    const src = code(BI_SERVICE);
    expect(src).not.toMatch(/business-operations-runtime/);
    expect(src).not.toMatch(/from\s+['"]\.\.?\/.*(bo|business-operations)/i);
    expect(code('apps/api/src/biSalesReportComposition.ts')).toMatch(/new SalesReportService\(new SalesFactsService\(\)\)/);
  });

  it('BI persists nothing: no repository, no SQL, no transaction, no write verb in the report service', () => {
    const src = code(BI_SERVICE);
    expect(src).not.toMatch(/Repository|withTenantTransaction|withSharedTenantTransaction|client\.query|\.query\(|randomUUID/);
    expect(src).not.toMatch(WRITES);
    // only types are taken from the database package
    const imports = [...src.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+'@infinicus\/database'/g)];
    expect(imports.length).toBeGreaterThan(0);
    for (const m of imports) expect(m[1] ?? m[2].split(',').every((n) => /^\s*type\s/.test(n) || n.trim() === ''), m[0]).toBeTruthy();
  });

  it('the Business Operations facts are read-only: no statement writes, and the only tables read are orders and order lines', () => {
    for (const f of BO_FILES) expect(code(f), f).not.toMatch(WRITES);
    const sql = code(BO_FILES[0]);
    const tables = [...sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+\.[a-z_]+)/gi)].map((m) => m[1]).sort();
    expect([...new Set(tables)]).toEqual(['business_operations.order_line_items', 'platform.orders']);
    expect(sql).toMatch(/withTenantTransaction\(ctx,/);          // RLS scope is always set from the authenticated context
    expect(sql).not.toMatch(/new Pool|createPool|process\.env/);
  });

  it('money never passes through a float: amounts leave the repository as decimal text and are parsed digit by digit', () => {
    const repo = code(BO_FILES[0]);
    expect(repo).toMatch(/::numeric\(18,4\)::text/g);
    expect(repo).not.toMatch(/parseFloat|Number\(r\.(gross|discount|net)_amount\)/);
    const conv = code(BO_FILES[2]);
    expect(conv).not.toMatch(/parseFloat|Math\.round|toFixed|\*\s*10\s*\*\*/);
  });

  it('the route is exactly one GET, gated by bi:read AND bo:read, the workspace guard and authentication; no idempotency key, no body', () => {
    const src = code(ROUTE);
    expect([...src.matchAll(/server\.(get|post|put|patch|delete)\(/g)].map((m) => m[1])).toEqual(['get']);
    expect(src).toMatch(/BI_SALES_REPORT_PERMISSIONS = \['bi:read', 'bo:read'\] as const/);
    expect(src).toMatch(/preHandler: \[app\.authenticate, app\.resolveTenantContext, \.\.\.BI_SALES_REPORT_PERMISSIONS\.map\(\(p\) => app\.requirePermission\(p\)\), requireBusinessWorkspace\]/);
    expect(src).not.toMatch(/requireIdempotencyKey|body:|Repository|query\(/);
    expect(code('apps/api/src/app.ts')).toMatch(/app\.register\(biSalesReportRoutes/);
  });

  it('introduces no table, schema change or permission', () => {
    for (const f of [BI_SERVICE, ...BO_FILES, ROUTE, 'apps/api/src/schemas/biSalesReport.ts']) expect(code(f), f).not.toMatch(/CREATE\s+TABLE|ALTER\s+TABLE|tenancy\.permissions/i);
  });
});
