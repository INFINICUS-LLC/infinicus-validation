/**
 * CI-STAB-06C: the read-only count batching of infrastructure/database/scripts/delete-tenant-data.mjs.
 *
 * The real script runs against a stubbed `psql` (only its destination is replaced, as in delete-tenant-data.command.test.ts), so no database is needed and
 * every outcome is deterministic. What is proved here, and what the live-database comparisons of the same change prove separately:
 *   - counts are matched back to the right table (and summed over workspaces) by index, in the original table order, and reach the audit payload unchanged;
 *   - the tenant-only counts never set app.workspace_id, every workspace-scoped count sets both variables itself, and every count is its own transaction;
 *   - a count that cannot be read is an error, never zero: malformed, missing, repeated or out-of-range results, and a failing psql, all end the run with
 *     exit 1 and the withheld-details message;
 *   - a failing PRE-delete count aborts before any DELETE; a failing RETAINED count aborts before the audit record is written;
 *   - the deletes themselves are untouched: still one transaction per table and workspace.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(__dirname, '../../../infrastructure/database/scripts/delete-tenant-data.mjs');
const work = mkdtempSync(join(tmpdir(), 'erasure-counts-'));
const preload = join(work, 'psql.cjs');
const appUrl = 'postgresql://app_test_user:app%2Fsecret@invalid.example/erasure_test';
const adminUrl = 'postgresql://test_admin:admin%2Fsecret@invalid.example/erasure_test';
const tenantId = '01234567-89ab-4cde-8fab-0123456789ab';
const WS1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const WS2 = 'aaaaaaaa-0000-4000-8000-000000000002';
let invocation = 0;

// Tenant-scoped tables, each with a DIFFERENT count so that any mix-up of results between tables, workspaces or positions changes a total:
// workspace-scoped public.t_ws (2 + 3 over two workspaces) and public.t_ws2 (10 + 20), tenant-only public.t_plain (4) and public.t_plain2 (6), and the
// append-only public.t_kept (7 retained) and public.t_kept2 (9 retained). The stub answers each discovery query and each count/delete script;
// COUNT_SCENARIO bends one answer.
writeFileSync(preload, `
const cp = require('node:child_process');
const fs = require('node:fs');
const S = process.env.COUNT_SCENARIO || 'happy';
const APP = process.env.DATABASE_URL;
const WS = ['${WS1}', '${WS2}'];
const PRE = { 'public.t_ws': { '${WS1}': 2, '${WS2}': 3 }, 'public.t_ws2': { '${WS1}': 10, '${WS2}': 20 }, 'public.t_plain': { '-': 4 }, 'public.t_plain2': { '-': 6 } };
const KEPT = { 'public.t_kept': 7, 'public.t_kept2': 9 };
cp.execFileSync = function (command, args, options) {
  if (command !== 'psql') throw new Error('Unexpected command');
  const url = args[0];
  const inline = args[1] === '-tAc' ? args[2] : null;
  const input = options && options.input ? String(options.input) : null;
  fs.appendFileSync(process.env.ERASURE_CALLS, JSON.stringify({ url, inline, input }) + '\\n');
  if (inline) {
    if (inline.includes('rolsuper')) return 'f\\n';
    if (inline.includes('ORDER BY 1')) return 'public.t_ws\\npublic.t_ws2\\npublic.t_plain\\npublic.t_plain2\\npublic.t_kept\\npublic.t_kept2\\n';
    if (inline.includes("column_name = 'tenant_id'")) return 'public.t_ws\\npublic.t_ws2\\npublic.t_plain\\npublic.t_plain2\\npublic.t_kept\\npublic.t_kept2\\n';
    if (inline.includes("column_name = 'workspace_id'")) return 'public.t_ws\\npublic.t_ws2\\n';
    if (inline.includes("qual LIKE '%app.workspace_id%'")) return 'public.t_ws\\npublic.t_ws2\\n';
    if (inline.includes('forbid_mutation')) return 'public.t_kept\\npublic.t_kept2\\n';
    if (inline.includes('pg_constraint')) return '';
    if (inline.includes('FROM tenancy.workspaces')) return S === 'noworkspace' ? '' : WS.join('\\n') + '\\n';
    if (inline.includes('AS table_name')) return 'public.t_ws|0\\npublic.t_ws2|0\\npublic.t_plain|0\\npublic.t_plain2|0\\npublic.t_kept|7\\npublic.t_kept2|9\\n';
    if (inline.includes('SELECT name FROM tenancy.tenants')) return 'Stub Tenant\\n';
    throw new Error('Unexpected inline query');
  }
  if (input && input.includes('CNT|')) {
    const fromApp = url === APP;
    if (S === 'psql-fails-precount' && fromApp) throw new Error('simulated psql failure ' + url);
    if (S === 'psql-fails-retained' && !fromApp) throw new Error('simulated psql failure ' + url);
    const out = [];
    let ws = '-';
    for (const line of input.split('\\n')) {
      if (line.startsWith('BEGIN')) ws = '-';
      const set = /set_config\\('app\\.workspace_id', '([^']+)'/.exec(line);
      if (set) ws = set[1];
      if (line.includes('set_config')) out.push('${tenantId}');
      for (const cnt of line.matchAll(/SELECT 'CNT\\|(\\d+)\\|' \\|\\| count\\(\\*\\) FROM ([a-z0-9_.]+)/g)) {
        const table = cnt[2];
        const n = fromApp ? ((PRE[table] || {})[ws]) : KEPT[table];
        if (n === undefined) throw new Error('stub has no count for ' + table + ' in ' + ws);
        out.push('CNT|' + cnt[1] + '|' + n);
      }
    }
    if (fromApp && S === 'missing-precount') out.pop();
    if (fromApp && S === 'duplicate-precount') out.push(out[out.length - 1]);
    if (fromApp && S === 'extra-precount') out.push('CNT|99|1');
    if (fromApp && S === 'negative-precount') out[out.length - 1] = 'CNT|' + out[out.length - 1].split('|')[1] + '|-1';
    if (fromApp && S === 'garbage-precount') out[out.length - 1] = 'CNT|' + out[out.length - 1].split('|')[1] + '|abc';
    if (!fromApp && S === 'missing-retained') out.pop();
    return out.join('\\n') + '\\n';
  }
  if (input && (input.includes('DELETE FROM') || input.includes('INSERT INTO platform.data_deletion_events'))) return '';
  throw new Error('Unexpected script');
};
require('node:module').syncBuiltinESMExports();
`);

afterAll(() => rmSync(work, { recursive: true, force: true }));

interface Call { url: string; inline: string | null; input: string | null }

function run(scenario = 'happy') {
  const callsFile = join(work, `calls-${invocation++}.jsonl`);
  writeFileSync(callsFile, '');
  const result = spawnSync(process.execPath, ['--require', preload, script], {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, NODE_OPTIONS: '', DATABASE_URL: appUrl, ADMIN_DATABASE_URL: adminUrl, TENANT_ID: tenantId, DELETED_BY: 'counts-test', ERASURE_CALLS: callsFile, COUNT_SCENARIO: scenario },
  });
  expect(result.error).toBeUndefined();
  const calls = readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Call);
  return { ...result, calls, output: `${result.stdout}${result.stderr}` };
}

const isCountScript = (c: Call) => Boolean(c.input?.includes('CNT|'));
const isDelete = (c: Call) => Boolean(c.input?.includes('DELETE FROM'));
const isAudit = (c: Call) => Boolean(c.input?.includes('INSERT INTO platform.data_deletion_events'));
const auditPayload = (calls: Call[]) => {
  const call = calls.find(isAudit);
  expect(call, 'the audit record must be written').toBeDefined();
  return JSON.parse(/'(\{.*\})'::jsonb/s.exec(call!.input!)![1]) as Record<string, unknown>;
};

describe('tenant erasure: batched read-only counts', () => {
  it('maps counts back to their tables (summed over workspaces) in the original order, and writes them to the audit payload unchanged', () => {
    const r = run();
    expect(r.status, r.output.slice(-400)).toBe(0);
    const payload = auditPayload(r.calls);
    expect(payload.rowCounts).toEqual({ 'public.t_ws': 5, 'public.t_ws2': 30, 'public.t_plain': 4, 'public.t_plain2': 6 });
    expect(Object.keys(payload.rowCounts as object)).toEqual(['public.t_ws', 'public.t_ws2', 'public.t_plain', 'public.t_plain2']);
    expect(payload.retainedRowCounts).toEqual({ 'public.t_kept': 7, 'public.t_kept2': 9 });
    expect(Object.keys(payload.retainedRowCounts as object)).toEqual(['public.t_kept', 'public.t_kept2']);
    expect(payload.remainingRows).toEqual({ 'public.t_kept': 7, 'public.t_kept2': 9 });
    expect(r.stdout).toContain(`Partially erased tenant ${tenantId}`);
  });

  it('uses three count sessions in total (tenant-only, workspace-scoped, admin retained) instead of one process per table and workspace', () => {
    const r = run();
    const counts = r.calls.filter(isCountScript);
    expect(counts).toHaveLength(3);
    expect(counts.map((c) => c.url)).toEqual([appUrl, appUrl, adminUrl]);
  });

  it('gives every count its own transaction, sets app.tenant_id in each, and never sets app.workspace_id in the tenant-only session', () => {
    const [tenantOnly, scoped] = run().calls.filter(isCountScript).slice(0, 2).map((c) => c.input!.split('\n'));
    for (const lines of [tenantOnly, scoped]) {
      const begins = lines.filter((l) => l === 'BEGIN;').length;
      expect(begins).toBe(lines.filter((l) => l.startsWith("SELECT 'CNT|")).length);
      expect(begins).toBe(lines.filter((l) => l === 'COMMIT;').length);
      expect(lines.filter((l) => l.includes("set_config('app.tenant_id'")).length).toBe(begins);
      expect(lines[0]).toBe('\\set ON_ERROR_STOP on');
    }
    expect(tenantOnly.join('\n')).not.toContain('app.workspace_id');
    expect(tenantOnly.filter((l) => l.startsWith("SELECT 'CNT|")).map((l) => /FROM (\S+)/.exec(l)![1])).toEqual(['public.t_plain', 'public.t_plain2']);
    // workspace-scoped: both variables are set INSIDE every transaction, for each workspace, before its count
    const blocks = scoped.join('\n').split('BEGIN;\n').slice(1);
    expect(blocks).toHaveLength(4);
    expect(blocks.map((b) => /set_config\('app\.workspace_id', '([^']+)'/.exec(b)![1])).toEqual([WS1, WS2, WS1, WS2]);
    expect(blocks.map((b) => /FROM (\S+)/.exec(b)![1])).toEqual(['public.t_ws', 'public.t_ws', 'public.t_ws2', 'public.t_ws2']);
    for (const block of blocks) expect(block.indexOf('app.tenant_id')).toBeLessThan(block.indexOf('app.workspace_id'));
  });

  it('keeps the deletes exactly as before: one transaction per table and workspace, after every pre-delete count, and the audit record last', () => {
    const calls = run().calls;
    const deletes = calls.filter(isDelete).filter((c) => !c.input!.includes('tenancy.'));
    expect(deletes).toHaveLength(6); // the workspace-scoped tables once per workspace, the tenant-only tables once
    for (const d of deletes) {
      expect(d.url).toBe(appUrl);
      expect(d.input!.split('\n').filter((l) => l === 'BEGIN;')).toHaveLength(1);
      expect(d.input!.split('\n').filter((l) => l.startsWith('DELETE FROM'))).toHaveLength(1);
    }
    const firstDelete = calls.findIndex(isDelete);
    const preDeleteCounts = calls.map((c, i) => (isCountScript(c) && c.url === appUrl ? i : -1)).filter((i) => i >= 0).slice(0, 2);
    expect(preDeleteCounts.every((i) => i < firstDelete)).toBe(true);
    expect(calls.findIndex(isAudit)).toBe(calls.length - 1);
  });

  it('counts a workspace-scoped table as zero WITHOUT querying it when the tenant has no workspace (as before), and sets no workspace variable at all', () => {
    const r = run('noworkspace');
    expect(r.status, r.output.slice(-400)).toBe(0);
    expect(auditPayload(r.calls).rowCounts).toMatchObject({ 'public.t_ws': 0, 'public.t_ws2': 0, 'public.t_plain': 4, 'public.t_plain2': 6 });
    expect(r.calls.filter(isCountScript).map((c) => c.input).join('\n')).not.toContain('app.workspace_id');
  });

  it.each(['missing-precount', 'duplicate-precount', 'extra-precount', 'negative-precount', 'garbage-precount'])(
    'a malformed pre-delete count result (%s) ends the run before ANY delete and is never read as zero',
    (scenario) => {
      const r = run(scenario);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('Tenant erasure failed (details withheld)');
      expect(r.calls.some(isDelete)).toBe(false);
      expect(r.calls.some(isAudit)).toBe(false);
      expect(r.output).not.toContain('Deleted tenant');
    }
  );

  it('a failing pre-delete count session ends the run before any delete, with the withheld-details message and no connection details', () => {
    const r = run('psql-fails-precount');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Database operation failed (details withheld)');
    expect(r.calls.some(isDelete)).toBe(false);
    for (const secret of [appUrl, adminUrl, 'app%2Fsecret', 'admin%2Fsecret', 'simulated psql failure']) expect(r.output).not.toContain(secret);
  });

  it.each(['missing-retained', 'psql-fails-retained'])(
    'a failing or malformed retained-row count (%s) ends the run before the audit record is written, and is never read as zero',
    (scenario) => {
      const r = run(scenario);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/Tenant erasure failed \(details withheld\)|Database operation failed \(details withheld\)/);
      expect(r.calls.some(isDelete)).toBe(true); // the retained counts are taken after the deleting pass, as before
      expect(r.calls.some(isAudit)).toBe(false);
      expect(r.output).not.toContain('Deleted tenant');
      expect(r.output).not.toContain('Partially erased');
    }
  );
});
