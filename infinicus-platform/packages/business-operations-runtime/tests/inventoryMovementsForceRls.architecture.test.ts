/**
 * inventory_movements FORCE RLS (migration 0186) - architecture guard (no database required).
 * No production code weakens row-level security, grants a bypass, switches the privileged replica mode, or reaches the test-only cleanup.
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
    else if (/\.(ts|tsx|js|mjs|sh)$/.test(name)) yield full;
  }
}
const isTest = (rel: string): boolean => /(^|\/)(tests?|__tests__)\//.test(rel) || /\.test\.[tj]sx?$/.test(rel);
const strip = (src: string): string => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|#)/.test(l)).join('\n');
const production: { rel: string; code: string }[] = [];
for (const root of ['apps', 'packages', 'layers']) {
  for (const file of walk(join(PLATFORM, root))) {
    const rel = relative(PLATFORM, file).split('\\').join('/');
    if (!isTest(rel)) production.push({ rel, code: strip(readFileSync(file, 'utf8')) });
  }
}
const migrations = readdirSync(join(PLATFORM, 'infrastructure/database/migrations')).filter((f) => f.endsWith('.sql')).sort();
const sqlOf = (f: string): string => readFileSync(join(PLATFORM, 'infrastructure/database/migrations', f), 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

describe('inventory_movements FORCE RLS architecture (0186)', () => {
  it('scans the real production tree (not vacuous)', () => {
    expect(production.length).toBeGreaterThan(200);
    expect(migrations).toContain('0186_force_rls_inventory_movements.sql');
  });

  it('no production code weakens or bypasses row-level security', () => {
    const offenders = production.filter((f) => /NO\s+FORCE\s+ROW\s+LEVEL|DISABLE\s+ROW\s+LEVEL\s+SECURITY|BYPASSRLS|session_replication_role|ALTER\s+POLICY|DROP\s+POLICY/i.test(f.code)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('no SECURITY DEFINER helper exists to escape RLS on the movement table', () => {
    expect(production.filter((f) => /SECURITY\s+DEFINER/i.test(f.code) && /inventory_movements/.test(f.code)).map((f) => f.rel)).toEqual([]);
  });

  it('after 0186 no migration weakens RLS on the movement table, and 0186 forces it', () => {
    expect(sqlOf('0186_force_rls_inventory_movements.sql')).toMatch(/ALTER TABLE business_operations\.inventory_movements FORCE ROW LEVEL SECURITY;/);
    for (const f of migrations.filter((m) => m > '0186')) {
      expect(sqlOf(f), f).not.toMatch(/inventory_movements[^;]*(NO\s+FORCE|DISABLE\s+ROW)|(NO\s+FORCE|DISABLE\s+ROW)[^;]*inventory_movements|ALTER\s+POLICY\s+inventory_movements_isolation/i);
    }
  });

  it('the test-only privileged cleanup is not reachable from production', () => {
    expect(production.filter((f) => /movementCleanup|deleteMovementsForTenants/.test(f.code)).map((f) => f.rel)).toEqual([]);
  });
});
