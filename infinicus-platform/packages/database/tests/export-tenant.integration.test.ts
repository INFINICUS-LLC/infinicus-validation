/**
 * Live PostgreSQL 16 test for BUILD-22's tenant data-export requirement
 * (infrastructure/database/scripts/export-tenant.sh). Actually invokes
 * the real script, not a reimplementation of its logic.
 *
 * Requires:
 *   DATABASE_URL       — app_test_user (RLS enforced)
 *   ADMIN_DATABASE_URL — infinicus_test_admin (BYPASSRLS), fixture setup only
 *
 * Guard pattern: describe.runIf(!!process.env.DATABASE_URL)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runScript } from './helpers/subprocessDiagnostics.js';
import { Pool } from 'pg';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const run = !!process.env.DATABASE_URL;

const EXPORT_SH = resolve(__dirname, '../../../infrastructure/database/scripts/export-tenant.sh');

const T1 = '99999999-a0a0-0000-0000-000000000001';
const WS1 = '99999999-a0a0-0000-0000-000000000002';
const T2 = '99999999-a0a0-0000-0000-000000000003';
const WS2 = '99999999-a0a0-0000-0000-000000000004';
const BIZ_CODE_T1 = 'export-test-biz-t1';
const BIZ_CODE_T2 = 'export-test-biz-t2';
const MODEL_CODE_T1 = 'export-test-model-t1';

describe.runIf(run)('export-tenant.sh — live PostgreSQL', () => {
  let adminPool: Pool;
  let outputDir: string;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
    await adminPool.query(
      `INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES
         ($1,'Export Test Tenant 1','export-t1','active','test'),
         ($2,'Export Test Tenant 2','export-t2','active','test')
       ON CONFLICT (id) DO NOTHING`,
      [T1, T2]
    );
    await adminPool.query(
      `INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES
         ($1,$2,'Export Test WS 1','export-ws1','active'),
         ($3,$4,'Export Test WS 2','export-ws2','active')
       ON CONFLICT (id) DO NOTHING`,
      [WS1, T1, WS2, T2]
    );
    await adminPool.query(
      `INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES
         (gen_random_uuid(),$1,$2,'Export Test Biz 1',$3,'active')
       ON CONFLICT (tenant_id, business_code) DO NOTHING`,
      [T1, WS1, BIZ_CODE_T1]
    );
    await adminPool.query(
      `INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES
         (gen_random_uuid(),$1,$2,'Export Test Biz 2',$3,'active')
       ON CONFLICT (tenant_id, business_code) DO NOTHING`,
      [T2, WS2, BIZ_CODE_T2]
    );
    // simulation.simulation_models' RLS policy requires BOTH tenant_id
    // AND workspace_id (unlike platform.businesses above, which only
    // requires tenant_id) — this is the regression case for the
    // BUILD-27-discovered gap where export-tenant.sh only ever set
    // app.tenant_id, so pg_dump silently produced zero rows for every
    // table whose RLS also ANDs a workspace_id predicate (the majority
    // of tenant-scoped tables in this schema).
    await adminPool.query(
      `INSERT INTO simulation.simulation_models (id, tenant_id, workspace_id, business_id, model_code, name, status)
       SELECT gen_random_uuid(), $1, $2, id, $3, 'Export Test Model', 'draft'
       FROM platform.businesses WHERE business_code = $4
       ON CONFLICT (business_id, model_code) DO NOTHING`,
      [T1, WS1, MODEL_CODE_T1, BIZ_CODE_T1]
    );
    outputDir = await mkdtemp(join(tmpdir(), 'infinicus-export-test-'));
  }, 30_000);

  afterAll(async () => {
    if (adminPool) await adminPool.end();
    if (outputDir) await rm(outputDir, { recursive: true, force: true });
  });

  /**
   * CI-STAB-02 R3: evaluated ONLY when the script fails. Table NAMES and counts only (never rows): which temporary fixture tables other suites have
   * in the shared database right now, how many sessions are waiting on a lock, and how many tenant-scoped policies the script's discovery query sees.
   */
  const catalogContext = async (): Promise<string> => {
    const q = async (sql: string) => (await adminPool.query(sql)).rows;
    const fixtures = (await q(`SELECT schemaname || '.' || tablename AS t FROM pg_tables WHERE tablename LIKE '%\\_fixture' ORDER BY 1`)).map((r) => r.t);
    const waiting = (await q(`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`))[0].n;
    const policies = (await q(`SELECT count(DISTINCT schemaname || '.' || tablename)::int AS n FROM pg_policies WHERE qual LIKE '%app.tenant_id%'`))[0].n;
    const policyFixtures = (await q(`SELECT count(*)::int AS n FROM pg_policies WHERE qual LIKE '%app.tenant_id%' AND tablename LIKE '%\\_fixture'`))[0].n;
    return `fixtureTables=[${fixtures.join(', ')}] ungrantedLocks=${waiting} tenantScopedTables=${policies} fixturePolicies=${policyFixtures}`;
  };

  it('exports only the target tenant\'s data, never another tenant\'s', async () => {
    const outputFile = join(outputDir, 'export.sql');
    await runScript(EXPORT_SH, { ...process.env, DATABASE_URL: process.env.DATABASE_URL, TENANT_ID: T1, OUTPUT_FILE: outputFile }, 'export-tenant.sh (target tenant export)', catalogContext);

    const contents = await readFile(outputFile, 'utf8');
    // The same five requirements as before, reported by NAME when one fails, with structural facts instead of the export's contents (customer data).
    // Regression coverage for the BUILD-27-discovered workspace-scoping gap: a table whose RLS policy requires app.workspace_id (not just
    // app.tenant_id) must still appear in the export.
    const checks: Record<string, boolean> = {
      'target business code present': contents.includes(BIZ_CODE_T1),
      'other tenant business code absent': !contents.includes(BIZ_CODE_T2),
      'target tenant id present': contents.includes(T1),
      'other tenant id absent': !contents.includes(T2),
      'workspace-scoped model code present': contents.includes(MODEL_CODE_T1),
    };
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
    const copyBlocks = (contents.match(/^COPY /gm) ?? []).length;
    expect(failed, `export-tenant isolation checks failed: ${failed.join('; ')} (bytes=${contents.length} copyBlocks=${copyBlocks})`).toEqual([]);
  }, 30_000);

  it('refuses to run against a superuser/BYPASSRLS connection', async () => {
    const adminUrl = process.env.ADMIN_DATABASE_URL;
    if (!adminUrl) return; // no separate admin credential configured in this environment

    const outputFile = join(outputDir, 'should-not-exist.sql');
    let caught: Error | undefined;
    try {
      await runScript(EXPORT_SH, { ...process.env, DATABASE_URL: adminUrl, TENANT_ID: T1, OUTPUT_FILE: outputFile }, 'export-tenant.sh (BYPASSRLS refusal)');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught, 'export-tenant.sh should have refused a BYPASSRLS connection').toBeDefined();
    expect(caught?.message).toMatch(/bypasses row-level security/);   // the script's stderr is carried by the diagnostic
  }, 30_000);

  it('CI-STAB-02 R3: a failing script rejects with its exit status and a redacted stderr tail, and never echoes the credential it was given', async () => {
    const secret = 'FAKE-PASSWORD-for-diagnostics-test';
    let caught: Error | undefined;
    try {
      await runScript(EXPORT_SH, { ...process.env, DATABASE_URL: `postgresql://nobody:${secret}@127.0.0.1:1/nodb`, TENANT_ID: T1, OUTPUT_FILE: join(outputDir, 'never.sql') },
        'export-tenant.sh (unreachable database)', async () => 'context-evaluated-on-failure');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught, 'a failing script must still reject').toBeDefined();
    expect(caught?.message).toMatch(/export-tenant\.sh \(unreachable database\) failed: exit=\d+ signal=none killed=false elapsedMs=\d+/);
    expect(caught?.message).toContain('stderr(tail):');
    expect(caught?.message).toContain('context: context-evaluated-on-failure');
    expect(caught?.message).not.toContain(secret);
    expect(caught?.message).not.toContain('postgresql://');
  }, 30_000);
});

describe.skipIf(run)('export-tenant.sh — live PostgreSQL (skipped, no DATABASE_URL)', () => {
  it('skips live tests when DATABASE_URL is not set', () => {
    expect(run).toBe(false);
  });
});
