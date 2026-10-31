/**
 * BI-08-DEV-01 architecture guards (static): the warehouse write boundary is DISABLED, the load module is pure, the target repository is SELECT-only and reads only the
 * BO publication package header, no migration, route, permission or fixture path was added, and nothing here can reach the existing write repositories.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const pure = strip(read('packages/workflow/src/bi08/warehouseLoad.ts'));
const service = strip(read('packages/workflow/src/BusinessIntelligenceWarehouseLoadPreparationService.ts'));
const repo = strip(read('packages/database/src/repositories/bi/BiWarehouseLoadTargetReadRepository.ts'));
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' || e.name === 'dist' ? [] : walk(join(dir, e.name))) : [join(dir, e.name)]));

describe('BI-08-DEV-01 - the load module is pure and deterministic', () => {
  it('imports nothing but node:crypto and has no clock, randomness, I/O, database or network', () => {
    expect([...pure.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])).toEqual(['node:crypto']);
    expect(pure).not.toMatch(/Date\.now|new Date\(\)|Math\.random|randomUUID|process\.|fetch\(|require\(|from '@infinicus|readFile|writeFile|setTimeout/);
    // the only Date use is calendar arithmetic on parsed numbers (Date.UTC), never a parse of caller text
    expect([...pure.matchAll(/\bDate\.[A-Za-z]+/g)].map((m) => m[0])).toEqual(['Date.UTC']);
    expect(pure).not.toMatch(/Date\.parse|new Date\((?!Date\.UTC)/);
  });
  it('does not coerce or default values: no Number(), parseFloat, String() of a value into the data, `??` default into a row, or rounding', () => {
    expect(pure).not.toMatch(/parseFloat|parseInt|Number\(|Math\.(round|floor|ceil|trunc|fround)|toFixed/);
    expect(pure).toMatch(/\.\.\.data, \[SOURCE_RECORD_ID_KEY\]/);
  });
  it('supports only append and refuses everything else (no pattern/regex built from caller input)', () => {
    expect(pure).toMatch(/c\.loadMode !== 'append'/);
    expect(pure).not.toMatch(/new RegExp/);
  });
});

describe('BI-08-DEV-01 - the warehouse write boundary stays DISABLED', () => {
  it('the preparation service never calls the write repositories: no appendRows, sealVersion, persist, INSERT/UPDATE/DELETE', () => {
    expect(service).not.toMatch(/appendRows\(|sealVersion\(|BiWarehouseRowRepository|BiCalculationRunRepository|\.persist\(/);
    expect(service).not.toMatch(/\b(INSERT INTO|UPDATE\s+[a-z_.]+\s+SET|DELETE FROM|TRUNCATE)\b/i);
    expect(service).not.toMatch(/\.query\(|withTenantTransaction|getPool/);
    expect(service).toMatch(/import \{ BiWarehouseLoadTargetReadRepository, WAREHOUSE_APPEND_BATCH_MAX, type AppendRowsInput/);
    // the service constructor accepts only the read repository
    expect(service).toMatch(/constructor\(private readonly targets: BiWarehouseLoadTargetReadRepository/);
  });
  it('no source file outside the repository itself and the BI-10 persistence path references appendRows or sealVersion (production has no caller)', () => {
    const callers = [...walk(resolve(root, 'packages')), ...walk(resolve(root, 'apps'))]
      .filter((f) => /[\\/]src[\\/].*\.(ts|tsx|js|mjs)$/.test(f))
      .filter((f) => /\b(appendRows|sealVersion)\b/.test(strip(readFileSync(f, 'utf8'))))
      .map((f) => f.slice(root.length + 1).replace(/\\/g, '/'));
    expect(callers).toEqual(['packages/database/src/repositories/bi/BiWarehouseRowRepository.ts']);
  });
  it('no route, handler or event publisher exposes preparation; no API source mentions it', () => {
    const api = walk(resolve(root, 'apps/api/src')).filter((f) => /\.ts$/.test(f)).map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(api).not.toMatch(/WarehouseLoadPreparation|prepareWarehouseRows|BiWarehouseLoadTarget|warehouse-load|warehouse_load/);
  });
  it('adds no migration (the newest remains 0223), no permission, and no fixture or sample-data path in src', () => {
    const migrations = readdirSync(resolve(root, 'infrastructure/database/migrations')).filter((f) => f.endsWith('.sql')).sort();
    expect(migrations[migrations.length - 1]).toMatch(/^0223_/);
    for (const s of [pure, service, repo]) expect(s).not.toMatch(/permission|requirePermission|fixture|sample|demo|faker/i);
  });
});

describe('BI-08-DEV-01 - the target repository is SELECT-only, scoped and reads only the BO package header', () => {
  const statement = repo.slice(repo.indexOf('const STATEMENT = `') + 'const STATEMENT = `'.length, repo.indexOf('`;', repo.indexOf('const STATEMENT')));
  it('is one SELECT with no write keyword, parameterised, pinned to tenant, workspace and business', () => {
    expect(statement.trimStart()).toMatch(/^SELECT /);
    expect(statement).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT)\b/i);
    expect(statement).toMatch(/WHERE v\.id = \$1 AND v\.tenant_id = \$2 AND v\.workspace_id = \$3 AND v\.business_id = \$4/);
    expect(repo).not.toMatch(/\$\{/);
    expect(repo.match(/inBusinessScope\(/g)?.length).toBe(1);
    expect(repo.match(/client\.query/g)?.length).toBe(1);
  });
  it('every joined table is matched on tenant, workspace and business, and the only BO table is bo_publication_packages', () => {
    for (const alias of ['d', 'i', 'b', 's', 'r', 'w']) expect(statement).toContain(`${alias}.tenant_id = v.tenant_id`);
    expect(statement).toContain('z.dataset_version_id = v.id AND z.tenant_id = v.tenant_id AND z.workspace_id = v.workspace_id AND z.business_id = v.business_id');
    for (const alias of ['d', 'i', 'b']) expect(statement).toContain(`${alias}.tenant_id = v.tenant_id AND ${alias}.workspace_id = v.workspace_id AND ${alias}.business_id = v.business_id`);
    expect([...new Set(statement.match(/business_operations\.[a-z_]+/g))]).toEqual(['business_operations.bo_publication_packages']);
    expect(existsSync(resolve(root, 'packages/database/src/repositories/bi/BiWarehouseLoadTargetReadRepository.ts'))).toBe(true);
  });
  it('the refusals of the service are a closed vocabulary of codes; none interpolates a value', () => {
    const codes = [...service.matchAll(/'([A-Z][A-Z_]+)'/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThan(8);
    expect(service).not.toMatch(/\.message|\.detail|String\(error|JSON\.stringify\(/);
    expect(service).not.toMatch(/refuse\([^)]*\+/);
  });
});
