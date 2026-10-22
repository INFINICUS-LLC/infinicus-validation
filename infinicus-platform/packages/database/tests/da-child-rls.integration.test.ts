/**
 * V-18 / migration 0211: the six Data Acquisition child tables inherit their parent's tenant isolation through row-level security.
 * Requires DATABASE_URL (app role, RLS enforced) and ADMIN_DATABASE_URL (fixtures, BYPASSRLS/superuser).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { withTenantTransaction } from '../src/client.js';
import { setupIntegration, teardownIntegration, ctx1, ctx2, T1, WS1, UID } from './helpers/integration.js';

const RUN = !!process.env.DATABASE_URL;
const MIGRATION = '0211_enable_rls_da_child_tables.sql';
const TABLES = ['publication_deliveries', 'api_collection_runs', 'database_collection_runs', 'duplicate_group_members', 'entity_match_candidates', 'transformation_records'] as const;

describe.runIf(RUN)('migration 0211: Data Acquisition child tables are tenant-isolated (V-18)', () => {
  let admin: Pool;
  const id: Record<string, string> = {};
  const owned: Array<[string, string]> = [];

  const q = (ctx: typeof ctx1, sql: string, params: unknown[] = []) => withTenantTransaction(ctx, (c) => c.query(sql, params));
  const count = async (ctx: typeof ctx1, table: string) => (await q(ctx, `SELECT count(*)::int AS n FROM data_acquisition.${table}`)).rows[0].n as number;

  beforeAll(async () => {
    await setupIntegration();
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
    const ins = async (table: string, cols: string, vals: unknown[]) => {
      const ph = vals.map((_, i) => `$${i + 1}`).join(',');
      const r = await admin.query(`INSERT INTO data_acquisition.${table} (${cols}) VALUES (${ph}) RETURNING id`, vals);
      owned.unshift([table, r.rows[0].id]);
      return r.rows[0].id as string;
    };
    const source = await ins('data_sources', 'tenant_id,workspace_id,name,source_code,source_type', [T1, WS1, 'rls src', `rls-${randomUUID().slice(0, 8)}`, 'api']);
    const run = await ins('collection_runs', 'tenant_id,workspace_id,data_source_id,collection_type', [T1, WS1, source, 'api']);
    const resolution = await ins('entity_resolution_results', 'tenant_id,workspace_id,collection_run_id,source_record_reference,candidate_entity_type,match_method,match_score', [T1, WS1, run, 'r1', 'customer', 'exact', 0.9]);
    const group = await ins('duplicate_groups', 'tenant_id,workspace_id,entity_type,duplicate_type', [T1, WS1, 'customer', 'exact']);
    const prov = await ins('provenance_records', 'tenant_id,workspace_id,data_source_id,record_reference,source_reference', [T1, WS1, source, 'rec', 'src']);
    const pkg = randomUUID();
    await admin.query(`INSERT INTO data_acquisition.publication_packages (id,tenant_id,workspace_id,package_type,target_layer,target_block,status,published_at)
                       VALUES ($1,$2,$3,'operations_data','business_operations','BO-1','published',now())`, [pkg, T1, WS1]);
    owned.unshift(['publication_packages', pkg]);
    id.publication_deliveries = await ins('publication_deliveries', 'publication_package_id,destination_type,destination_reference', [pkg, 'layer', 'business_operations']);
    id.api_collection_runs = await ins('api_collection_runs', 'collection_run_id,http_method,endpoint_reference', [run, 'GET', 'ep']);
    id.database_collection_runs = await ins('database_collection_runs', 'collection_run_id,database_type,query_reference', [run, 'postgres', 'q']);
    id.duplicate_group_members = await ins('duplicate_group_members', 'duplicate_group_id,record_reference,similarity_score', [group, 'm', 0.9]);
    id.entity_match_candidates = await ins('entity_match_candidates', 'entity_resolution_result_id,candidate_entity_id,candidate_entity_type,match_score,rank', [resolution, randomUUID(), 'customer', 0.9, 1]);
    id.transformation_records = await ins('transformation_records', 'provenance_record_id,transformation_type,performed_by_type', [prov, 'normalise', 'system']);
    id.parent_package = pkg; id.parent_run = run; id.parent_group = group; id.parent_prov = prov; id.parent_resolution = resolution;
  });

  afterAll(async () => {
    for (const [table, rowId] of owned) await admin.query(`DELETE FROM data_acquisition.${table} WHERE id = $1`, [rowId]).catch(() => undefined);
    await admin.end();
    await teardownIntegration();
  });

  it('every child table has RLS enabled and forced, with one isolation policy', async () => {
    const r = await admin.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'data_acquisition' AND p.tablename = c.relname AND p.policyname = c.relname || '_isolation') AS policies
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'data_acquisition' AND c.relname = ANY($1) ORDER BY c.relname`, [[...TABLES]]);
    expect(r.rows).toHaveLength(TABLES.length);
    for (const row of r.rows) expect(row, row.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true, policies: 1 });
  });

  for (const table of TABLES) {
    it(`${table}: the owning tenant sees its row; another tenant sees nothing and cannot change it`, async () => {
      expect(await count(ctx1, table)).toBeGreaterThanOrEqual(1);
      expect(await count(ctx2, table)).toBe(0);
      const upd = await q(ctx2, `UPDATE data_acquisition.${table} SET created_at = created_at WHERE id = $1`, [id[table]]);
      expect(upd.rowCount).toBe(0);
      const del = await q(ctx2, `DELETE FROM data_acquisition.${table} WHERE id = $1`, [id[table]]);
      expect(del.rowCount).toBe(0);
      expect((await admin.query(`SELECT 1 FROM data_acquisition.${table} WHERE id = $1`, [id[table]])).rowCount).toBe(1);
    });
  }

  it('fails closed: with no usable tenant context nothing is visible', async () => {
    const stranger = { tenantId: randomUUID(), workspaceId: randomUUID(), userId: UID };
    for (const table of TABLES) expect(await count(stranger, table), table).toBe(0);
  });

  it('the owning tenant can still update its child rows (writes keep working)', async () => {
    const r = await q(ctx1, `UPDATE data_acquisition.transformation_records SET transformation_type = 'normalise' WHERE id = $1`, [id.transformation_records]);
    expect(r.rowCount).toBe(1);
  });

  it('another tenant cannot attach a child row to a parent it cannot see (WITH CHECK)', async () => {
    const attempts: Array<[string, string, unknown[]]> = [
      ['publication_deliveries', `INSERT INTO data_acquisition.publication_deliveries (publication_package_id,destination_type,destination_reference) VALUES ($1,'layer','simulation')`, [id.parent_package]],
      ['transformation_records', `INSERT INTO data_acquisition.transformation_records (provenance_record_id,transformation_type,performed_by_type) VALUES ($1,'x','system')`, [id.parent_prov]],
      ['duplicate_group_members', `INSERT INTO data_acquisition.duplicate_group_members (duplicate_group_id,record_reference,similarity_score) VALUES ($1,'x',0.5)`, [id.parent_group]],
      ['entity_match_candidates', `INSERT INTO data_acquisition.entity_match_candidates (entity_resolution_result_id,candidate_entity_id,candidate_entity_type,match_score,rank) VALUES ($1,$2,'customer',0.5,2)`, [id.parent_resolution, randomUUID()]],
    ];
    for (const [table, sql, params] of attempts) await expect(q(ctx2, sql, params), table).rejects.toMatchObject({ code: '42501' });
  });

  it('the documented rollback removes exactly the policies and RLS flags, proven inside a transaction that is rolled back', async () => {
    const sql = readFileSync(resolve(__dirname, '../../../infrastructure/database/migrations', MIGRATION), 'utf8');
    const block = sql.split('\n').filter((l) => l.startsWith('--   ')).map((l) => l.slice(5));
    const statements = block.filter((l) => l.startsWith('DROP POLICY'));
    expect(statements).toHaveLength(TABLES.length);
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      for (const s of statements) await c.query(s);
      for (const t of TABLES) await c.query(`ALTER TABLE data_acquisition.${t} NO FORCE ROW LEVEL SECURITY, DISABLE ROW LEVEL SECURITY`);
      const flags = await c.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'data_acquisition' AND c.relname = ANY($1) AND (c.relrowsecurity OR c.relforcerowsecurity)`, [[...TABLES]]);
      const pols = await c.query(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'data_acquisition' AND tablename = ANY($1)`, [[...TABLES]]);
      expect(flags.rows[0].n).toBe(0);
      expect(pols.rows[0].n).toBe(0);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    const after = await admin.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'data_acquisition' AND c.relname = ANY($1) AND c.relforcerowsecurity`, [[...TABLES]]);
    expect(after.rows[0].n).toBe(TABLES.length);
  });
});
