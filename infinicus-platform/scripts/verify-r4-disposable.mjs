#!/usr/bin/env node
/** R4 only: creates its own labelled PostgreSQL container; never accepts a database URL or an existing container. No production migration is changed. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert.equal(process.argv.length, 2, 'R4 rehearsal accepts no arguments, target URLs or existing container names');
const require = createRequire(join(root, 'packages/database/package.json'));
const { Pool } = require('pg');
const db = require(join(root, 'packages/database/dist/index.js'));
const suffix = randomBytes(6).toString('hex');
const name = `codex-r4-${suffix}`; const database = `infinicus_r4_disposable_${suffix}`;
const adminPass = randomBytes(20).toString('hex'); const appPass = randomBytes(20).toString('hex');
const context = execFileSync('docker', ['context', 'show'], { encoding: 'utf8' }).trim();
const endpoint = JSON.parse(execFileSync('docker', ['context', 'inspect', context], { encoding: 'utf8' }))[0].Endpoints.docker.Host;
assert.match(endpoint, /^(?:npipe|unix):/, 'R4 requires a local Docker socket; remote Docker contexts are refused');
const work = mkdtempSync(join(tmpdir(), 'infinicus-r4-'));
const docker = (args, options = {}) => execFileSync('docker', ['--context', context, ...args], { encoding: 'utf8', ...options }).trim();
let container; let admin; let app; let succeeded = false;
const results = {};
function tests(args, label, env) {
  const report = join(work, `${label}.json`);
  const cwd = join(root, 'packages/business-operations-runtime');
  const run = spawnSync(process.execPath, [join(cwd, 'node_modules/vitest/vitest.mjs'), 'run', ...args, '--reporter=json', `--outputFile=${report}`], {
    cwd, env, encoding: 'utf8', timeout: 300000,
  });
  if (run.error || run.signal) throw new Error(`R4 test runner failed: ${run.error?.message ?? run.signal}`);
  const data = JSON.parse(readFileSync(report, 'utf8'));
  assert(data.numTotalTests > 0, 'no tests executed');
  results[label] = { passed: data.numPassedTests, failed: data.numFailedTests, skipped: data.numPendingTests };
  console.log(`${label}: ${JSON.stringify(results[label])}`);
  const failures = data.testResults.flatMap((r) => r.assertionResults).filter((r) => r.status === 'failed');
  for (const f of failures.slice(0, 6)) {
    console.log(`${f.fullName}: ${f.failureMessages.join('\n').slice(0, 1000)}`);
  }
  if (failures.length > 6) console.log(`${failures.length - 6} additional failures are recorded in the retained JSON report`);
  return { run, data };
}
try {
  container = docker(['run', '--detach', '--name', name, '--label', `infinicus.r4.disposable=${suffix}`, '--publish', '127.0.0.1::5432',
    '--env', 'POSTGRES_USER=r4_fixture_admin', '--env', `POSTGRES_PASSWORD=${adminPass}`, '--env', `POSTGRES_DB=${database}`,
    '--tmpfs', '/var/lib/postgresql/data:rw,size=512m', 'postgres:16-bookworm', '-c', `cluster_name=${name}`]);
  const inspect = JSON.parse(docker(['inspect', container]))[0];
  assert.equal(inspect.Config.Labels['infinicus.r4.disposable'], suffix);
  const binding = inspect.NetworkSettings.Ports['5432/tcp'][0];
  assert.equal(binding.HostIp, '127.0.0.1');
  const adminUrl = `postgresql://r4_fixture_admin:${adminPass}@127.0.0.1:${binding.HostPort}/${database}`;
  const appUrl = `postgresql://r4_application:${appPass}@127.0.0.1:${binding.HostPort}/${database}`;
  admin = new Pool({ connectionString: adminUrl, connectionTimeoutMillis: 1000 });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { await admin.query('SELECT 1'); ready = true; break; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  assert(ready, 'disposable PostgreSQL did not become ready');
  const identity = (await admin.query("SELECT current_database() AS db, current_setting('cluster_name') AS cluster")).rows[0];
  assert.deepEqual(identity, { db: database, cluster: name });
  await admin.query(`CREATE ROLE r4_application LOGIN PASSWORD '${appPass}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`);
  db.createPool({ connectionString: adminUrl });
  try { await db.runMigrations(); } finally { await db.closePool(); }
  // The existing fixture-admin setup is used only inside this new container. Application verification never uses that role.
  docker(['exec', '-i', '--env', `ADMIN_DATABASE_URL=postgresql://r4_fixture_admin:${adminPass}@127.0.0.1/${database}`,
    '--env', 'APP_ROLE=r4_application', container, 'bash'], {
    input: readFileSync(join(root, 'infrastructure/database/scripts/grant-app-role.sh'), 'utf8').replace(/\r\n/g, '\n'),
  });
  app = new Pool({ connectionString: appUrl });
  const role = (await app.query(`SELECT current_user AS name, rolsuper, rolbypassrls,
    pg_get_userbyid(h.relowner) = current_user AS owner, pg_get_userbyid(h.relowner) AS table_owner, h.relrowsecurity AS enabled, h.relforcerowsecurity AS forced
    FROM pg_roles r CROSS JOIN pg_class h WHERE r.rolname = current_user AND h.oid = 'business_operations.bo_publication_packages'::regclass`)).rows[0];
  assert.deepEqual(role, { name: 'r4_application', rolsuper: false, rolbypassrls: false, owner: false, table_owner: 'r4_fixture_admin', enabled: true, forced: false });
  console.log(`baseline application role: ${JSON.stringify(role)}`);
  const env = { ...process.env, NODE_ENV: 'test', DB_SSL: 'false', DATABASE_URL: appUrl, ADMIN_DATABASE_URL: adminUrl };
  const baseline = tests(['tests/InventoryMovementEvidenceExtractor.integration.test.ts', '--testNamePattern=certifies that evidence extraction'], 'baseline-gate', env);
  assert.notEqual(baseline.run.status, 0, 'unremediated gate unexpectedly passed');
  assert.equal(baseline.data.numFailedTests, 1);
  const failure = baseline.data.testResults.flatMap((r) => r.assertionResults).filter((r) => r.status === 'failed');
  assert.equal(failure.length, 1);
  assert.match(failure[0].fullName, /non-owner, non-bypass PostgreSQL application role with forced RLS/);
  assert.match(failure[0].failureMessages.join('\n'), /expected false to be true/);
  // Observe unrelated failures on the unmodified database too; never suppress them or claim a green regression run.
  const comparison = tests([
    'tests/AuthorizedActionExecution.integration.test.ts', 'tests/AuthorizedActionIntake.integration.test.ts',
    'tests/p0-5-b2c-verifier.architecture.test.ts', 'tests/PurchaseOrderLineItemLinkage.integration.test.ts', '--maxWorkers=2',
  ], 'baseline-comparison', env);
  const policies = async () => (await admin.query("SELECT * FROM pg_policies WHERE schemaname='business_operations' AND tablename='bo_publication_packages' ORDER BY policyname")).rows;
  const before = await policies();
  const sql = readFileSync(join(root, 'docs/production-readiness/BO_PUB_DEV_02A_R4_T3_DISPOSABLE_FORCE_RLS.sql'), 'utf8');
  const client = await admin.connect();
  try {
    await assert.rejects(client.query(sql), /requires a newly provisioned disposable/);
    await client.query('ROLLBACK');
    assert.equal((await client.query("SELECT relforcerowsecurity FROM pg_class WHERE oid='business_operations.bo_publication_packages'::regclass")).rows[0].relforcerowsecurity, false);
    await client.query("SELECT set_config('infinicus.r4_disposable', 'BO-PUB-DEV-02A-R4', false)");
    await client.query(sql); await client.query(sql); // idempotent, without changing policies or owners
  } finally { client.release(); }
  assert.deepEqual(await policies(), before);
  const after = (await app.query("SELECT pg_get_userbyid(relowner) = current_user AS owner, pg_get_userbyid(relowner) AS table_owner, relforcerowsecurity AS forced FROM pg_class WHERE oid='business_operations.bo_publication_packages'::regclass")).rows[0];
  assert.deepEqual(after, { owner: false, table_owner: role.table_owner, forced: true });
  console.log('remediation: missing opt-in refused; FORCE RLS enabled twice; policies and ownership preserved');
  const regression = tests(['--maxWorkers=2'], 'bo-regression', env);
  const focused = regression.data.testResults.filter((f) => /InventoryMovementEvidence|BusinessIntakeService\.integration/.test(f.name));
  assert.equal(focused.length, 7, 'missing R4 evidence/replay/conservation/dispatch suites');
  assert(focused.every((f) => f.status === 'passed' && f.assertionResults.every((t) => t.status === 'passed')), 'R4 focused suite failed or skipped');
  console.log(`R4 focused verification: ${focused.flatMap((f) => f.assertionResults).length} passed, 0 failed, 0 skipped`);
  const failedFiles = (data) => data.testResults.filter((f) => f.status === 'failed').map((f) => basename(f.name)).sort();
  console.log(`unremediated failure files: ${JSON.stringify(failedFiles(comparison.data))}`);
  console.log(`post-remediation failure files: ${JSON.stringify(failedFiles(regression.data))}`);
  // Failure counts can vary (including freshness-sensitive authority tests). Matching file names do not waive any failure.
  assert.equal(regression.run.status, 0, 'BO regression failed; inspect the failed assertions before certification');
  succeeded = true;
  console.log('R4_DISPOSABLE_VERIFICATION=PASS (development only; not independent approval or durable-publisher certification)');
} finally {
  await app?.end(); await admin?.end();
  if (container) {
    const info = JSON.parse(docker(['inspect', container]))[0];
    assert.equal(info.Config.Labels['infinicus.r4.disposable'], suffix, 'cleanup refused: label mismatch');
    docker(['rm', '--force', '--volumes', container]);
    console.log('disposed of this run\'s labelled test container');
  }
  if (succeeded) {
    assert.equal(dirname(resolve(work)), resolve(tmpdir()));
    assert(basename(work).startsWith('infinicus-r4-'));
    rmSync(work, { recursive: true, force: true });
  } else console.log(`Retained failed-run test reports: ${work}`);
}
