/**
 * Business Administration declared currency (migration 0185) - architecture guard (no database required).
 * Business Administration owns the write; BO and ABA never write it; the DAL never touches it; no second source of truth exists; and no
 * silent default is ever promoted into governed state.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const PLATFORM = resolve(__dirname, '../../..');
const SKIP = new Set(['node_modules', 'dist', '.turbo', '.next', 'coverage']);
function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) yield full;
  }
}
const isTest = (rel: string): boolean => /(^|\/)(tests?|__tests__)\//.test(rel) || /\.test\.[tj]sx?$/.test(rel);
const strip = (src: string): string => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const production: { rel: string; code: string }[] = [];
for (const root of ['apps', 'packages', 'layers']) {
  for (const file of walk(join(PLATFORM, root))) {
    const rel = relative(PLATFORM, file).split('\\').join('/');
    if (isTest(rel)) continue;
    production.push({ rel, code: strip(readFileSync(file, 'utf8')) });
  }
}
const read = (rel: string): string => production.find((f) => f.rel === rel)?.code ?? '';
const REPO = 'packages/database/src/repositories/onboarding/BusinessDeclaredCurrencyRepository.ts';
const SERVICE = 'packages/onboarding/src/BusinessDeclaredCurrencyService.ts';
const ROUTE = 'apps/api/src/routes/businessAdministration.ts';
const WRITER = /BusinessDeclaredCurrencyRepository|BusinessDeclaredCurrencyService|BusinessAdministrationAuditRepository/;
const inTree = (prefixes: string[]) => production.filter((f) => prefixes.some((p) => f.rel.startsWith(p)));
const BO_ABA_DAL = ['packages/business-operations-runtime/', 'packages/workflow/', 'packages/data-acquisition-runtime/', 'layers/'];

describe('business declared currency architecture (0185)', () => {
  it('scans the real production tree (not vacuous)', () => {
    expect(production.length).toBeGreaterThan(200);
    expect(read(REPO).length).toBeGreaterThan(1000);
    expect(read(SERVICE).length).toBeGreaterThan(500);
    expect(read(ROUTE).length).toBeGreaterThan(500);
  });

  it('Business Administration owns the write: the only INSERT into the declarations table is the BA repository, reached only through the BA service', () => {
    expect(production.filter((f) => /INTO\s+platform\.business_currency_declarations/.test(f.code)).map((f) => f.rel)).toEqual([REPO]);
    expect(production.filter((f) => /business_currency_declarations/.test(f.code)).map((f) => f.rel)).toEqual([REPO]);
    expect(production.filter((f) => /\.declare\(/.test(f.code) && /BusinessDeclaredCurrency/.test(f.code)).map((f) => f.rel).sort()).toEqual([ROUTE, SERVICE].sort()); // route -> service.declare -> repository.declare
    const writerUsers = production.filter((f) => WRITER.test(f.code) && f.rel !== REPO && !/\/index\.ts$/.test(f.rel)).map((f) => f.rel).sort();
    expect(writerUsers).toEqual([ROUTE, SERVICE].sort());
    expect(read(ROUTE)).not.toMatch(/BusinessDeclaredCurrencyRepository|BusinessAdministrationAuditRepository|\.declare\(\s*\{/);
  });

  it('BO, ABA (workflow), the DAL and the layers never write or even name the declaration writer, the service or the table', () => {
    for (const f of inTree(BO_ABA_DAL)) {
      expect(f.code, f.rel).not.toMatch(WRITER);
      expect(f.code, f.rel).not.toMatch(/business_currency_declarations|@infinicus\/onboarding/);
    }
  });

  it('BO and ABA may only read through the Reader, which has no mutation method', () => {
    const body = read(REPO).split('export class BusinessDeclaredCurrencyReader')[1]?.split('export interface DeclareCurrencyInput')[0] ?? '';
    expect(body.length).toBeGreaterThan(500);
    expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/);
    expect(body).toMatch(/async getCurrent/);
    expect(body).toMatch(/async history/);
    expect(body).not.toMatch(/default_currency|defaultCurrency|'USD'/);
  });

  it('nothing updates, deletes or truncates the declarations table', () => {
    expect(production.filter((f) => /(UPDATE|DELETE\s+FROM|TRUNCATE)\s+(TABLE\s+)?platform\.business_currency_declarations/i.test(f.code)).map((f) => f.rel)).toEqual([]);
  });

  it('no second source of truth: no other table, column or setting holds a business-scoped governance currency', () => {
    // Only the pre-existing tenant read model mentions a default currency column; it is read-only and unrelated to the declaration.
    const defaults = production.filter((f) => /default_currency|defaultCurrency/.test(f.code)).map((f) => f.rel);
    expect(defaults).toEqual(['packages/database/src/repositories/onboarding/TenantRepository.ts']);
    expect(production.filter((f) => /declared_currency|declaredCurrency|DECLARED_CURRENCY/.test(f.code)).map((f) => f.rel).sort()).toEqual([
      'apps/api/src/routes/businessAdministration.ts', 'apps/api/src/schemas/businessAdministration.ts',
      // B2b: the BO evaluator READS the declared currency (through the Reader); it never writes it.
      'packages/business-operations-runtime/src/inventory-policy/InventoryPolicyEvaluationService.ts', 'packages/business-operations-runtime/src/inventory-policy/evaluate.ts',
      'packages/database/src/index.ts', 'packages/database/src/repositories/onboarding/BusinessDeclaredCurrencyRepository.ts',
      'packages/database/src/repositories/onboarding/index.ts', 'packages/onboarding/src/BusinessDeclaredCurrencyService.ts', 'packages/onboarding/src/index.ts',
    ]);
  });

  it('no default-value promotion: the declaration code never reads a default, never names a currency literal and never falls back', () => {
    for (const rel of [REPO, SERVICE, ROUTE, 'apps/api/src/schemas/businessAdministration.ts']) {
      const code = read(rel);
      expect(code, rel).not.toMatch(/default_currency|defaultCurrency|business_profile_extensions|tenancy\.tenants|TenantRepository/);
      expect(code, rel).not.toMatch(/['"`](USD|EUR|GBP|JPY)['"`]/);
      expect(code, rel).not.toMatch(/process\.env|\bLANG\b|Intl\.|toLocale|navigator/);
      expect(code, rel).not.toMatch(/currency\s*(\?\?|\|\|)\s*['"`]/);
    }
  });

  it('the route uses the existing platform:admin permission for the write, requires an idempotency key and invents no permission', () => {
    const route = read(ROUTE);
    expect(route).toContain("DECLARE_CURRENCY_PERMISSION = 'platform:admin'");
    expect(route).toMatch(/server\.put\([\s\S]*?requirePermission\(DECLARE_CURRENCY_PERMISSION\)[\s\S]*?requireIdempotencyKey/);
    expect(route.match(/requirePermission\('([a-z_:]+)'\)/g)).toEqual(["requirePermission('bo:read')", "requirePermission('bo:read')"]);
    expect(route).not.toMatch(/bo:write|aba:|da:/);
  });

  it('the ABA->BO transport, the B2c verifier adapter and P0-6 are NOT implemented (the B2b evaluator exists and only READS the declaration)', () => {
    expect(production.filter((f) => /BoGovernanceEvidenceVerifier|inventory-policy-evaluator/.test(f.code)).map((f) => f.rel)).toEqual([]);
    expect(production.filter((f) => /ACTION_AUTHORIZED/.test(f.code) && /BusinessDeclaredCurrency/.test(f.code)).map((f) => f.rel)).toEqual([]);
  });
});
