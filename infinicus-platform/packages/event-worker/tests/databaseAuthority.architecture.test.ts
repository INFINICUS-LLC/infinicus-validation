import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * Database-authority architecture guard (migration 0196, no database): activation rows and reorder fields are written ONLY through their governed
 * database entry points; no application path, route, ABA code or second writer exists; no new privileged role, table, seed or activation.
 */
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
const stripComments = (s: string): string => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const production: { rel: string; code: string }[] = [];
for (const root of ['apps', 'packages', 'layers']) {
  for (const file of walk(join(PLATFORM, root))) {
    const rel = relative(PLATFORM, file).split('\\').join('/');
    if (!isTest(rel)) production.push({ rel, code: stripComments(readFileSync(file, 'utf8')) });
  }
}
const read = (rel: string): string => production.find((f) => f.rel === rel)?.code ?? '';
const under = (prefix: string) => production.filter((f) => f.rel.startsWith(prefix));
const filesMatching = (re: RegExp) => production.filter((f) => re.test(f.code)).map((f) => f.rel).sort();

const BO = 'packages/business-operations-runtime/src/';
const MIGRATION = 'infrastructure/database/migrations/0196_harden_database_authority_activation_and_reorder.sql';
const GRANT_SCRIPT = 'infrastructure/database/scripts/grant-app-role.sh';
const ACTIVATION_REPO = 'packages/database/src/repositories/bo/ExecutionCapabilityActivationRepository.ts';
const EXECUTOR = `${BO}OperationalCommandExecutor.ts`;
const sql = (rel: string): string => readFileSync(join(PLATFORM, rel), 'utf8');

describe('database authority architecture (migration 0196)', () => {
  it('scans the real production tree (not vacuous)', () => {
    expect(production.length).toBeGreaterThan(200);
    for (const rel of [ACTIVATION_REPO, EXECUTOR]) expect(read(rel).length, rel).toBeGreaterThan(400);
    expect(sql(MIGRATION).length).toBeGreaterThan(4000);
  });

  it('F1: activation rows are appended ONLY through the governed function - no application SQL inserts, updates or deletes them, and one repository calls the function', () => {
    expect(filesMatching(/INSERT\s+INTO\s+\S*execution_capability_activations/i)).toEqual([]);
    expect(filesMatching(/(UPDATE|DELETE\s+FROM)\s+\S*execution_capability_activations/i)).toEqual([]);
    expect(filesMatching(/record_execution_capability_activation\(/)).toEqual([ACTIVATION_REPO]);
    expect(filesMatching(/app\.bo_activation_writer/)).toEqual([]);           // no application code sets the marker
    // the service still enforces bo:admin before the database is asked (defence in depth, not replacement)
    expect(read(`${BO}execution-activation/ExecutionActivationService.ts`)).toMatch(/permissionCode !== EXECUTION_ACTIVATION_PERMISSION/);
  });

  it('F3: reorder fields are written ONLY through the governed function - no application SQL assigns them, the BO executor alone calls it, and no marker is set by application code', () => {
    expect(filesMatching(/SET\s+reorder_point\s*=|reorder_quantity\s*=\s*\$\d/i)).toEqual([]);
    expect(filesMatching(/apply_inventory_reorder_policy\(/)).toEqual([EXECUTOR]);
    expect(filesMatching(/bo_reorder_policy_writer/)).toEqual([]);
  });

  it('no API route, ABA code, event-worker code or other layer writes reorder fields or activation rows or names the governed functions', () => {
    const re = /apply_inventory_reorder_policy|record_execution_capability_activation|UPDATE\s+\S*inventory_balances|execution_capability_activations/i;
    const allowed = new Set([EXECUTOR, ACTIVATION_REPO, `${BO}execution-activation/GovernedExecutionGate.ts`, `${BO}execution-activation/ExecutionActivationService.ts`,
      'packages/database/src/repositories/bo/InventoryBalanceRepository.ts', 'packages/database/src/repositories/bo/index.ts', 'packages/database/src/index.ts']);
    for (const prefix of ['apps/api/src/routes/', 'packages/workflow/', 'layers/', 'packages/event-worker/src/', 'packages/outcome-monitoring-runtime/']) {
      for (const f of under(prefix)) expect(f.code, f.rel).not.toMatch(re);
    }
    // outside the BO/database owners, nothing at all in production code touches them
    expect(filesMatching(re).filter((rel) => !allowed.has(rel) && !rel.startsWith(`${BO}`) && !rel.startsWith('packages/database/'))).toEqual([]);
  });

  it('no second inventory writer: the quantity path (movements, balance adjust) is untouched and cannot assign the protected columns', () => {
    for (const f of under('packages/database/src/repositories/bo/')) expect(f.code, f.rel).not.toMatch(/SET[^;`]*reorder_(point|quantity|policy)/i);
    expect(read(EXECUTOR).match(/inventory_balances\s+SET reorder/gi) ?? []).toEqual([]);
  });

  it('the migration: two SECURITY DEFINER functions with a pinned search_path and no dynamic SQL; EXECUTE revoked from PUBLIC; triggers pin owner + marker; no table, role, grant, seed or backfill', () => {
    const m = sql(MIGRATION);
    const body = m.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(body.match(/^SECURITY DEFINER$/gm)).toHaveLength(2);
    expect(body.match(/SET search_path = pg_catalog, pg_temp/g)).toHaveLength(4);      // both definer functions and both guard-trigger functions
    expect(body).not.toMatch(/\bEXECUTE\s+(format|'|\$)|\bEXECUTE\s+[a-z_]+\s*\|\|/i);
    expect(body.match(/REVOKE ALL ON FUNCTION[^;]*FROM PUBLIC;/g)).toHaveLength(2);
    expect(body.match(/current_user IS (NOT )?DISTINCT FROM/g)).toHaveLength(2);       // both table guards require the function owner
    expect(body).not.toMatch(/CREATE\s+(TABLE|ROLE|USER)|ALTER\s+(ROLE|USER)|BYPASSRLS|SUPERUSER|\bGRANT\b|CREATE\s+POLICY|DISABLE\s+ROW\s+LEVEL/i);
    expect(body).not.toMatch(/INSERT\s+INTO\s+business_operations\.execution_capability_activations\s*\([^)]*\)\s*SELECT|UPDATE\s+business_operations\.inventory_balances\s+SET[^;]*WHERE\s+true/i); // no seed, no backfill
    // the only activation INSERT is inside the governed function (after it set its marker)
    expect(body.match(/INSERT INTO business_operations\.execution_capability_activations/g)).toHaveLength(1);
    expect(body).toMatch(/set_config\('app\.bo_activation_writer', 'record_execution_capability_activation', true\)[\s\S]*INSERT INTO business_operations\.execution_capability_activations/);
  });

  it('the provisioning script withholds the direct privileges and creates no privileged role', () => {
    const g = sql(GRANT_SCRIPT);
    expect(g).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON business_operations\.execution_capability_activations/);
    expect(g).toMatch(/REVOKE UPDATE ON business_operations\.inventory_balances/);
    expect(g).toMatch(/'reorder_point','reorder_quantity','reorder_policy_state','reorder_policy_configured_at','reorder_policy_configured_source'/);
    expect(g).not.toMatch(/CREATE\s+ROLE|ALTER\s+ROLE|BYPASSRLS|SUPERUSER/i);
  });

  it('exactly one migration follows 0195 (0196); production activation stays OFF - no activation row is created by any migration or script', () => {
    const migrations = readdirSync(join(PLATFORM, 'infrastructure/database/migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(migrations.slice(migrations.findIndex((m) => m.startsWith('0195_')))).toEqual([migrations.find((m) => m.startsWith('0195_')), '0196_harden_database_authority_activation_and_reorder.sql']);
    for (const f of migrations) {
      const t = sql(`infrastructure/database/migrations/${f}`);
      if (f.startsWith('0195_') || f.startsWith('0196_')) expect(t, f).not.toMatch(/INSERT\s+INTO\s+business_operations\.execution_capability_activations\s*\(?[^;]*?(SELECT|VALUES\s*\(\s*'[0-9a-f-]{36}')/i);
    }
    expect(filesMatching(/state:\s*'ENABLED'/).filter((rel) => rel.startsWith('apps/') || rel.startsWith('packages/event-worker/src/'))).toEqual([]); // no default-enabled path in code
  });
});
