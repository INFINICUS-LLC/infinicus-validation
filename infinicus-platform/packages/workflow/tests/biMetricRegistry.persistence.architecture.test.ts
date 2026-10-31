/** BI-2-DEV-02 architecture guards (static): the registry persistence is additive, scoped, writes only the two registry tables, and calculates nothing. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const sqlStrip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');
const repo = strip(read('packages/database/src/repositories/bi/BiMetricRegistryRepository.ts'));
const service = strip(read('packages/workflow/src/BusinessIntelligenceMetricRegistryService.ts'));
const migration = sqlStrip(read('infrastructure/database/migrations/0222_extend_bi_metric_registry.sql'));

/** Every SQL text literal passed to client.query in the repository. */
const statements = [...repo.matchAll(/client\.query(?:<[^(]*>)?\(\s*(`[^`]*`|'[^']*')/g)].map((m) => m[1]!.slice(1, -1).replace(/\s+/g, ' ').trim());

describe('BI-09 registry persistence - repository', () => {
  it('finds the statements it is about to judge (guards against a regex that matches nothing)', () => {
    expect(statements.length).toBe(11);
  });

  it('writes only the two registry tables and never deletes or truncates', () => {
    const targets = statements.flatMap((s) => [...s.matchAll(/\b(?:INSERT INTO|UPDATE)\s+([a-z_.]+)/gi)].map((m) => m[1]));
    expect([...new Set(targets)].sort()).toEqual(['business_intelligence.metric_definition_versions', 'business_intelligence.metric_definitions']);
    for (const s of statements) expect(s, s).not.toMatch(/\b(DELETE|TRUNCATE|DROP|ALTER)\b/i);
    expect(repo).not.toMatch(/business_operations|business_digital_twin|metric_calculated_values|metric_time_series_values/);
  });

  it('reads only the registry tables, analytical datasets (to resolve a definition\'s dataset) and the business (to check it belongs to the caller)', () => {
    const tables = new Set(statements.flatMap((s) => [...s.matchAll(/\b(?:FROM|JOIN)\s+([a-z_.]+)/gi)].map((m) => m[1])));
    expect([...tables].sort()).toEqual(['business_intelligence.analytical_datasets', 'business_intelligence.metric_definition_versions', 'business_intelligence.metric_definitions', 'platform.businesses']);
  });

  it('pins every statement to the caller\'s tenant and workspace, and registry statements to one business', () => {
    for (const s of statements) {
      if (/^SELECT pg_advisory_xact_lock/.test(s)) continue;
      expect(s, s).toMatch(/tenant_id\s*(=|,)|\(tenant_id|tenant_id, workspace_id|v\.tenant_id = \$1|d\.tenant_id = \$1/);
      expect(s, s).toMatch(/workspace_id/);
    }
    for (const s of statements.filter((x) => /metric_definition/.test(x))) expect(s, s).toMatch(/business_id/);
  });

  it('serializes registry writers per business with a transaction-scoped advisory lock, and checks the business belongs to the caller before anything else', () => {
    expect(repo).toMatch(/pg_advisory_xact_lock\(hashtextextended/);
    expect(repo.indexOf('FROM platform.businesses')).toBeLessThan(repo.indexOf('pg_advisory_xact_lock'));
    expect(repo).toMatch(/deleted_at IS NULL/);
  });
});

describe('BI-09 registry persistence - service', () => {
  it('has no SQL, no pool and no Business Operations, and runs every write inside the repository\'s locked transaction', () => {
    expect(service).not.toMatch(/\b(SELECT|INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM)\b/);
    expect(service).not.toMatch(/\b(getPool|withTenantTransaction|\.query\()/);
    expect(service).not.toMatch(/business-operations-runtime/);
    expect(service.match(/this\.repository\.transaction\(/g)?.length).toBe(2);
  });

  it('calculates nothing: no float parsing, rounding or numeric folding', () => {
    expect(service).not.toMatch(/\b(parseFloat|toFixed|toPrecision|Math\.(round|floor|ceil|trunc)|reduce\()/);
  });

  it('refuses before writing: persistability is checked ahead of both inserts', () => {
    expect(service.indexOf('notPersistable(content)')).toBeLessThan(service.indexOf('tx.insertFirstVersion'));
    expect(service.indexOf('notPersistable(content)')).toBeLessThan(service.indexOf('tx.insertNextVersion'));
  });
});

describe('migration 0222 - additive and forward-only', () => {
  it('creates no table and drops nothing but the one CHECK it widens', () => {
    expect(migration).not.toMatch(/\bCREATE TABLE\b/i);
    expect(migration).not.toMatch(/\b(DROP TABLE|DROP COLUMN|DROP SCHEMA|TRUNCATE|DELETE FROM|RENAME)\b/i);
    expect([...migration.matchAll(/\bDROP\s+(?:CONSTRAINT|NOT NULL)\s*([a-z_]*)/gi)].map((m) => m[0].replace(/\s+/g, ' ')).sort()).toEqual([
      'DROP CONSTRAINT metric_definition_versions_time_grain_check', 'DROP NOT NULL',
    ]);
  });

  it('changes no existing row and touches only the two registry tables', () => {
    expect(migration).not.toMatch(/^\s*UPDATE\s/im);
    expect(migration).not.toMatch(/^\s*INSERT INTO\s+(?!_migrations)/im);
    const alters = [...migration.matchAll(/ALTER TABLE\s+([a-z_.]+)/gi)].map((m) => m[1]);
    expect([...new Set(alters)]).toEqual(['business_intelligence.metric_definition_versions']);
    expect(migration).toMatch(/CREATE TRIGGER forbid_metric_definition_identity_change\s+BEFORE UPDATE ON business_intelligence\.metric_definitions/);
  });

  it('keeps every value the old time_grain CHECK accepted', () => {
    const grains = /time_grain IN \(([^)]*)\)/.exec(migration)![1]!;
    for (const g of ['day', 'week', 'month', 'quarter', 'year']) expect(grains).toContain(`'${g}'`);
  });

  it('records itself in _migrations', () => {
    expect(migration).toMatch(/INSERT INTO _migrations \(filename\) VALUES \('0222_extend_bi_metric_registry\.sql'\)/);
  });
});
