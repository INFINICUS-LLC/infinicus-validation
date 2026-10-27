import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(__dirname, '../../../infrastructure/database/scripts/delete-tenant-data.mjs');
const work = mkdtempSync(join(tmpdir(), 'erasure-command-'));
const preload = join(work, 'psql.cjs');
const failure = join(work, 'failure.cjs');
const appUrl = 'postgresql://app_test_user:app%2Fsecret@invalid.example/erasure_test';
const adminUrl = 'postgresql://test_admin:admin%2Fsecret@invalid.example/erasure_test';
const tenantId = '01234567-89ab-4cde-8fab-0123456789ab';
let invocation = 0;

// Run the real CLI and real failing subprocesses, but replace only psql's
// destination. No database connection or installed psql is needed here.
writeFileSync(failure, `
process.stdout.write('child stdout ' + process.env.DATABASE_URL + '\\n');
process.stderr.write('ERROR: child stderr ' + process.env.ADMIN_DATABASE_URL + ' app/secret admin/secret\\n');
process.exit(2);
`);
writeFileSync(preload, `
const cp = require('node:child_process');
const fs = require('node:fs');
const original = cp.execFileSync;
let calls = 0;
cp.execFileSync = function(command, args, options) {
  if (command !== 'psql') throw new Error('Unexpected command');
  fs.appendFileSync(process.env.ERASURE_CALLS, JSON.stringify(args) + '\\n');
  calls++;
  if (process.env.ERASURE_SCENARIO === 'admin' && calls === 1) return 'f\\n';
  return original(process.execPath, [process.env.ERASURE_FAILURE], options);
};
require('node:module').syncBuiltinESMExports();
`);

afterAll(() => rmSync(work, { recursive: true, force: true }));

function run(id: string, scenario = 'application', overrides: Record<string, string> = {}) {
  const callsFile = join(work, `calls-${invocation++}.jsonl`);
  writeFileSync(callsFile, '');
  const result = spawnSync(process.execPath, ['--require', preload, script], {
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      DATABASE_URL: appUrl,
      ADMIN_DATABASE_URL: adminUrl,
      TENANT_ID: id,
      ERASURE_CALLS: callsFile,
      ERASURE_FAILURE: failure,
      ERASURE_SCENARIO: scenario,
      ...overrides,
    },
  });
  expect(result.error).toBeUndefined();
  const calls = readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
  return { ...result, calls, output: `${result.stdout}${result.stderr}` };
}

describe('tenant erasure command boundary', () => {
  it.each([
    '', ' ', 'not-a-uuid', tenantId.replaceAll('-', ''), `{${tenantId}}`,
    ` ${tenantId}`, `${tenantId} `, `${tenantId}\n`, `${tenantId}\r\n`,
    `${tenantId}\t`, `${tenantId}x`, tenantId.slice(0, -1),
    tenantId.replace('0123', 'g123'), `${tenantId}' OR '1'='1`,
    `${tenantId}'; SELECT 1; --`, `${tenantId}\\echo injected`,
  ])('refuses malformed tenant identifier %j before invoking psql', (id) => {
    const result = run(id);
    expect(result.status).toBe(1);
    expect(result.calls).toEqual([]);
    expect(result.stderr).toContain('TENANT_ID');
    expect(result.output).not.toContain('child stderr');
  });

  // Canonical 8-4-4-4-12 hexadecimal form, without narrowing PostgreSQL's
  // existing UUID values to a particular generator, version or letter case.
  it.each([
    tenantId, tenantId.toUpperCase(), '01234567-89ab-1cde-8fab-0123456789ab',
    '01234567-89ab-7cde-8fab-0123456789ab',
    '00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff',
  ])('accepts canonical UUID %s and reaches the database boundary', (id) => {
    const result = run(id);
    expect(result.calls).toHaveLength(1);
    expect(result.stderr).not.toContain('TENANT_ID');
    // The fixture deliberately fails the database call; this is not an
    // erasure-success test. Real success is verified against PostgreSQL.
    expect(result.status).toBe(1);
  });

  it.each(['application', 'admin'])('redacts %s subprocess errors and captured child output', (scenario) => {
    const result = run(tenantId, scenario);
    expect(result.status).toBe(1);
    expect(result.calls).toHaveLength(scenario === 'admin' ? 2 : 1);
    expect(result.calls.at(-1)?.[0]).toBe(scenario === 'admin' ? adminUrl : appUrl);
    expect(result.stderr).toContain('Database operation failed (details withheld)');
    for (const secret of [appUrl, adminUrl, 'app%2Fsecret', 'admin%2Fsecret', 'app/secret', 'admin/secret', 'child stdout', 'child stderr']) {
      expect(result.output).not.toContain(secret);
    }
    expect(result.output).not.toContain('Deleted tenant');
  });

  it.each(['DATABASE_URL', 'ADMIN_DATABASE_URL', 'TENANT_ID'])('refuses missing %s without invoking psql', (key) => {
    const result = run(tenantId, 'application', { [key]: '' });
    expect(result.status).toBe(1);
    expect(result.calls).toEqual([]);
    expect(result.stderr).toContain(`${key} is required`);
  });

  it('reports a missing psql executable without exposing connection arguments', () => {
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, NODE_OPTIONS: '', PATH: join(work, 'no-executables'), DATABASE_URL: appUrl, ADMIN_DATABASE_URL: adminUrl, TENANT_ID: tenantId },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Database operation failed (details withheld)');
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/secret|postgresql:\/\/|spawnSync|ENOENT/);
  });
});
