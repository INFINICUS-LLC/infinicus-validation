/**
 * BI-2-DEV-07 architecture guards (static): the migration is additive and complete, the repositories are scoped, parameterised and write only what they should, no
 * execution route or permission exists yet, the calculation core is untouched, and the persistence service verifies before it writes.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const flat = (s: string) => s.replace(/\s+/g, ' ');
const migrationName = readdirSync(resolve(root, 'infrastructure/database/migrations')).find((f) => f.startsWith('0223_'))!;
const migration = read(`infrastructure/database/migrations/${migrationName}`);
const sql = strip(migration.replace(/^--.*$/gm, ''));
const rowsRepo = strip(read('packages/database/src/repositories/bi/BiWarehouseRowRepository.ts'));
const runsRepo = strip(read('packages/database/src/repositories/bi/BiCalculationRunRepository.ts'));
const scopeHelper = strip(read('packages/database/src/repositories/bi/businessScope.ts'));
const persistence = strip(read('packages/workflow/src/BusinessIntelligenceCalculationPersistenceService.ts'));
const rowSource = strip(read('packages/workflow/src/PostgresWarehouseRowSource.ts'));
const calcService = strip(read('packages/workflow/src/BusinessIntelligenceMetricCalculationService.ts'));
const NEW_TABLES = ['warehouse_dataset_rows', 'warehouse_dataset_version_seals', 'metric_calculation_runs', 'metric_calculation_run_inputs', 'metric_results'];

/** Every SQL text in a repository: each template or string literal passed to client.query(...). */
function statements(src: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf('client.query', from);
    if (at < 0) break;
    from = at + 'client.query'.length;
    const open = src.indexOf('(', from);
    const rest = src.slice(open + 1).trimStart();
    const quote = rest[0];
    if (quote !== '`' && quote !== "'") continue;
    const close = rest.indexOf(quote, 1);
    out.push(flat(rest.slice(1, close)));
  }
  return out;
}

describe('migration 0223 - additive, complete, isolated', () => {
  it('is the next migration, records itself and runs in one transaction', () => {
    expect(migrationName).toBe('0223_bi10_warehouse_rows_and_calculation_persistence.sql');
    expect(sql.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(migration).toContain("INSERT INTO _migrations (filename) VALUES ('0223_bi10_warehouse_rows_and_calculation_persistence.sql')");
  });

  it('only adds: it alters four existing tables by one scope key each and drops, renames or rewrites nothing that exists', () => {
    const alters = [...sql.matchAll(/ALTER TABLE ([a-z_.]+)\s+ADD CONSTRAINT ([a-z_]+)/g)].map((m) => `${m[1]}:${m[2]}`);
    expect(alters.sort()).toEqual([
      'business_intelligence.analytical_dataset_versions:analytical_dataset_versions_dataset_scope_key', 'business_intelligence.analytical_datasets:analytical_datasets_scope_key',
      'business_intelligence.intelligence_source_references:intelligence_source_references_scope_key', 'business_intelligence.metric_definition_versions:metric_definition_versions_scope_key',
    ]);
    // the four static scope keys, plus the ENABLE and FORCE ROW LEVEL SECURITY statements of the loop over the five NEW tables
    expect(sql.match(/\bALTER TABLE\b/g)?.length).toBe(4 + 2);
  });

  it('never drops, deletes, updates, truncates or grants anything (grants are environment-specific and live in the grant script)', () => {
    expect(sql).not.toMatch(/\b(DROP|GRANT|REVOKE)\b|(?<!BEFORE )TRUNCATE\b/i); // BEFORE TRUNCATE is the append-only trigger, not a truncate
    expect(sql).not.toMatch(/\b(DELETE\s+FROM|UPDATE\s+[a-z_.]+\s+SET)\b/i);
    expect(sql).not.toMatch(/ALTER TABLE [a-z_.]+\s+(DROP|RENAME|ALTER COLUMN)/i);
  });

  it('creates exactly the five tables, each with a primary key, scope columns referencing tenant, workspace and business, forced RLS, a tenant/workspace policy and append-only triggers', () => {
    expect([...sql.matchAll(/CREATE TABLE ([a-z_.]+)/g)].map((m) => m[1]!.replace('business_intelligence.', '')).sort()).toEqual([...NEW_TABLES].sort());
    for (const t of NEW_TABLES) {
      const head = sql.indexOf(`CREATE TABLE business_intelligence.${t} (`);
      const block = sql.slice(head, sql.indexOf('\n);', head));
      expect(block, t).toMatch(/PRIMARY KEY/);
      expect(block, t).toMatch(/tenant_id\s+uuid\s+NOT NULL REFERENCES tenancy\.tenants\(id\)\s+ON DELETE RESTRICT/);
      expect(block, t).toMatch(/workspace_id\s+uuid\s+NOT NULL REFERENCES tenancy\.workspaces\(id\)\s+ON DELETE RESTRICT/);
      expect(block, t).toMatch(/business_id\s+uuid\s+NOT NULL REFERENCES platform\.businesses\(id\)\s+ON DELETE RESTRICT/);
      expect(block, t).not.toMatch(/ON DELETE (CASCADE|SET NULL|SET DEFAULT)/);
    }
    const loop = /FOREACH t IN ARRAY ARRAY\[([^\]]*)\] LOOP([\s\S]*?)END LOOP/.exec(sql)!;
    expect([...loop[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual([...NEW_TABLES].sort());
    for (const needle of ['BEFORE UPDATE OR DELETE', 'BEFORE TRUNCATE', 'business_intelligence.forbid_mutation()', 'ENABLE ROW LEVEL SECURITY', 'FORCE ROW LEVEL SECURITY', "current_setting('app.tenant_id', true)::uuid", "current_setting('app.workspace_id', true)::uuid"]) expect(loop[2], needle).toContain(needle);
  });

  it('every reference to a scoped parent is a composite foreign key that carries the tenant, workspace and business', () => {
    const fks = [...sql.matchAll(/FOREIGN KEY \(([^)]*)\)\s+REFERENCES ([a-z_.]+) \(([^)]*)\)/g)];
    expect(fks.length).toBe(8);
    for (const fk of fks) {
      for (const col of ['tenant_id', 'workspace_id', 'business_id']) { expect(fk[1], `${fk[2]} child`).toContain(col); expect(fk[3], `${fk[2]} parent`).toContain(col); }
    }
  });

  it('the database computes what the caller must not supply: fingerprint, seal values and persisted times are set by triggers', () => {
    expect(sql).toMatch(/NEW\.row_fingerprint := encode\(sha256\(convert_to\(NEW\.row_data::text, 'UTF8'\)\), 'hex'\)/);
    expect(sql).toMatch(/NEW\.row_count := c; NEW\.declared_record_count := declared; NEW\.rows_digest := digest/);
    expect(sql.match(/NEW\.persisted_at := now\(\)/g)?.length).toBe(1);
    expect(sql.match(/CREATE TRIGGER stamp_persisted_at/g)?.length).toBe(2);
    expect(sql).toMatch(/CREATE CONSTRAINT TRIGGER check_metric_calculation_run_complete AFTER INSERT ON business_intelligence\.metric_calculation_runs\s+DEFERRABLE INITIALLY DEFERRED/);
  });

  it('seals only against the record count Business Operations declared, and rows must cite the source reference of their version\'s own intake package', () => {
    expect(sql).toMatch(/FROM business_intelligence\.dataset_data_references r/);
    expect(sql).toMatch(/IF c <> declared THEN/);
    expect(sql).toMatch(/sr\.intake_package_id IS DISTINCT FROM v\.intake_package_id/);
    expect(sql).toMatch(/v\.publication_status <> 'published'/);
    expect(sql).not.toMatch(/business_operations/);
  });

  it('the result table carries the exact-decimal columns as numeric and keeps source and persisted time apart', () => {
    const results = /CREATE TABLE business_intelligence\.metric_results \(([\s\S]*?)\n\);/.exec(sql)![1]!;
    expect(results).toMatch(/value\s+numeric,/); expect(results).toMatch(/target\s+numeric,/);
    expect(results).not.toMatch(/\b(real|double precision|float)/i);
    const runs = /CREATE TABLE business_intelligence\.metric_calculation_runs \(([\s\S]*?)\n\);/.exec(sql)![1]!;
    expect(runs).toMatch(/handoff_source_timestamp\s+timestamptz NOT NULL/); expect(runs).toMatch(/persisted_at\s+timestamptz NOT NULL DEFAULT now\(\)/);
    expect(runs).not.toMatch(/calculated_at|created_at/);
  });
});

describe('repositories - scoped, parameterised, write only their own tables', () => {
  const all = [...statements(rowsRepo), ...statements(runsRepo)];

  it('found the statements it judges (guards against a pattern that matches nothing)', () => {
    expect(statements(rowsRepo).length).toBeGreaterThanOrEqual(12);
    expect(statements(runsRepo).length).toBeGreaterThanOrEqual(6);
  });

  it('every statement is pinned to the caller\'s tenant, workspace and business', () => {
    for (const s of all) {
      if (/FROM platform\.businesses/.test(s)) continue; // the business check itself, in businessScope.ts
      if (/^INSERT INTO/.test(s)) { expect(s, s).toMatch(/\(.*\btenant_id, workspace_id, business_id\b|\(id, tenant_id, workspace_id, business_id/); continue; } // an insert carries the scope in its own columns
      if (/^SET CONSTRAINTS/.test(s)) continue;
      expect(s, s).toMatch(/tenant_id = \$\d/); expect(s, s).toMatch(/workspace_id = \$\d/); expect(s, s).toMatch(/business_id = \$\d/);
    }
    expect(flat(scopeHelper)).toMatch(/FROM platform\.businesses WHERE id = \$1 AND tenant_id = \$2 AND workspace_id = \$3 AND deleted_at IS NULL/);
    expect(rowsRepo.match(/inBusinessScope\(/g)?.length).toBe(4); expect(runsRepo.match(/inBusinessScope\(/g)?.length).toBe(2);
  });

  it('only SELECT and INSERT: no update, delete, truncate or DDL, and inserts touch only the new tables', () => {
    for (const s of all) {
      if (s === 'SET CONSTRAINTS ALL IMMEDIATE') continue; // the commit-time completeness check made immediate
      expect(s, s).toMatch(/^(SELECT|INSERT INTO)\b/);
      expect(s, s).not.toMatch(/\b(UPDATE\s+[a-z_.]+\s+SET|DELETE\s+FROM|TRUNCATE|DROP|ALTER|CREATE|GRANT)\b/i);
    }
    const inserted = [...new Set(all.filter((s) => s.startsWith('INSERT INTO')).map((s) => /^INSERT INTO ([a-z_.]+)/.exec(s)![1]))].sort();
    expect(inserted).toEqual(['business_intelligence.metric_calculation_run_inputs', 'business_intelligence.metric_calculation_runs', 'business_intelligence.metric_results',
      'business_intelligence.warehouse_dataset_rows', 'business_intelligence.warehouse_dataset_version_seals']);
    expect(rowsRepo + runsRepo).not.toMatch(/business_operations|getPool|\bpool\./);
  });

  it('builds no SQL from values: the only interpolations are the two fixed fingerprint expressions, everything else is a bound parameter', () => {
    const interpolations = [...(rowsRepo + runsRepo).matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]);
    for (const i of interpolations) expect(['FINGERPRINT_SQL', 'DIGEST_FROM_ROWS']).toContain(i);
    expect(rowsRepo).toMatch(/const FINGERPRINT_SQL = "encode\(sha256\(convert_to\(x\.row_data::text, 'UTF8'\)\), 'hex'\)"/);
  });

  it('validates identifiers, JSON and bounds before it writes, and never clamps or truncates', () => {
    expect(rowsRepo).toMatch(/WAREHOUSE_APPEND_BATCH_MAX = 10_000/);
    expect(rowsRepo).toMatch(/rows\.length > WAREHOUSE_APPEND_BATCH_MAX\) throw new ValidationError/);
    expect(rowsRepo).toMatch(/isPlainJson\(r\.data\)/);
    expect(rowsRepo + runsRepo).not.toMatch(/Math\.(min|max|trunc|floor|round|ceil)|\.slice\(0|\.splice\(/);
    expect(rowsRepo).toMatch(/truncated: seal\.rows\[0\]!\.row_count > rows\.rowCount!/);
  });

  it('re-checks the seal against the stored rows on every read, before it returns any row, and recomputes the digest from the row data', () => {
    const read = rowsRepo.slice(rowsRepo.indexOf('private async readSealedWithin'));
    const check = read.indexOf('actual.rows[0]!.digest !== seal.rows[0]!.rows_digest');
    const fetch = read.indexOf('ORDER BY row_number LIMIT $5');
    expect(check).toBeGreaterThan(0); expect(fetch).toBeGreaterThan(check);
    expect(rowsRepo).toMatch(/DIGEST_FROM_ROWS = "encode\(sha256\(convert_to\(coalesce\(string_agg\(encode\(sha256\(convert_to\(row_data::text/);
  });

  it('writes a run in one transaction and checks completeness before it returns (constraints made immediate), mapping database failures to sanitized errors', () => {
    expect(runsRepo).toMatch(/SET CONSTRAINTS ALL IMMEDIATE/);
    expect(runsRepo).toMatch(/ON CONFLICT \(id\) DO NOTHING RETURNING persisted_at/);
    expect(runsRepo).not.toMatch(/\.message|String\(error\)|JSON\.stringify\(error/);
    expect(rowsRepo).not.toMatch(/error\.message|String\(error\)/);
    expect(runsRepo.match(/new ValidationError\('CalculationRun', \['[^'$]+'\]\)/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

describe('workflow layer - verify, then write; no route, no permission, no event', () => {
  it('the persistence service checks the run, its sealed inputs and a recalculation BEFORE any write, and reads back what it stored', () => {
    const body = persistence.slice(persistence.indexOf('async persist('), persistence.indexOf('/** A stored run'));
    const order = ['buildIntelligenceHandoff(run)', 'readSealedVersion(', 'fingerprintRows(sealed.rows)', 'this.reproduces(', 'this.runs.persist(', 'this.get('].map((n) => body.indexOf(n));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(persistence).toMatch(/runDigest\(again\.run\) === runDigest\(run\)/);
  });

  it('reads back through the same verification: ids re-derived, digest compared, and an altered store is reported, not returned', () => {
    expect(persistence).toMatch(/!verified\.ok \|\| runDigest\(run\) !== stored\.runDigest/);
    expect(persistence).toMatch(/code: 'STORED_RUN_INTEGRITY'/);
  });

  it('uses no clock and no randomness: identities come from the calculation, times from the database', () => {
    for (const src of [persistence, rowSource]) expect(src).not.toMatch(/new Date\(|Date\.now|Math\.random|randomUUID/);
  });

  it('the warehouse row source fetches at most the frozen limit plus one (so an oversize dataset is refused, not cut), in the caller\'s own scope', () => {
    expect(rowSource).toMatch(/MAX_DATASET_ROWS \+ 1\)/);
    expect(rowSource).toMatch(/scope\.tenantId !== this\.ctx\.tenantId \|\| scope\.workspaceId !== this\.ctx\.workspaceId\) throw/);
  });

  it('calculateAndPersist takes its rows only from the BI warehouse and persists only what calculateMetrics produced', () => {
    const body = calcService.slice(calcService.indexOf('async calculateAndPersist'));
    expect(body).toMatch(/new PostgresWarehouseRowSource\(ctx\)/);
    expect(body).toMatch(/this\.persistence\.persist\(ctx, businessId, calculated\.run, source\.inputs\)/);
  });

  it('adds no route, no permission and no event: nothing under apps/api references the new repositories, tables or services', () => {
    const files: string[] = [];
    const walk = (dir: string) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = resolve(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.ts$/.test(e.name)) files.push(p); } };
    walk(resolve(root, 'apps/api/src'));
    const needle = /BiWarehouseRowRepository|BiCalculationRunRepository|PostgresWarehouseRowSource|BusinessIntelligenceCalculationPersistenceService|calculateAndPersist|metric_calculation_runs|metric_results|warehouse_dataset_rows/;
    expect(files.filter((f) => needle.test(readFileSync(f, 'utf8'))).map((f) => f.replace(root, ''))).toEqual([]);
    expect(persistence + rowSource + rowsRepo + runsRepo).not.toMatch(/emit\(|publish\(|outbox|registerRoute|requirePermission|server\.(get|post)/);
  });

  it('leaves the BI-10 calculation core and the BI-09 registry rules as they were: the persistence modules import them, none of them changes them', () => {
    const core = strip(read('packages/workflow/src/bi10/metricCalculation.ts'));
    expect(core).not.toMatch(/BiWarehouseRowRepository|BiCalculationRunRepository|@infinicus\/database|persist/i);
    expect(read('packages/workflow/src/bi10/exactDecimal.ts')).not.toMatch(/@infinicus\/database/);
  });
});
