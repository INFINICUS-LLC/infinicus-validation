import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * make-expectations-profile.sh builds a restore-proof expectations profile from owner-run read-only evidence. These tests use SYNTHETIC evidence text (no
 * database, no server): the properties that matter are that it refuses anything that is not clean evidence of the expected database/head/fingerprint,
 * never overwrites, never connects anywhere, and only emits lines the restore-proof grammar accepts.
 */
const SCRIPT = resolve(__dirname, '../../../infrastructure/backups/make-expectations-profile.sh');
const HEAD = '0198_link_purchase_order_lines_to_inventory_items.sql';
const dir = mkdtempSync(join(tmpdir(), 'infinicus-profile-'));
let n = 0;

const evidence = (over: { db?: string; ro?: string; head?: string; count?: string; extra?: string[]; outbox?: string[] } = {}): string => [
  ' E01 identity | ' + (over.db ?? 'infinicus') + ' | 16.15 (Ubuntu) | ' + (over.ro ?? 'on') + ' |          198 | ' + (over.head ?? HEAD),
  ' E06 profile candidate | ledger_count=' + (over.count ?? '198'),
  ' E06 profile candidate | ledger_head=' + (over.head ?? HEAD),
  ' E06 profile candidate | count audit.audit_events=0',
  ' E06 profile candidate | count identity.users=6',
  ' E06 profile candidate | count outcome_monitoring.monitored_actions=3',
  ' E06 profile candidate | count outcome_monitoring.outcome_observations=3',
  ...(over.extra ?? []),
  ...(over.outbox ?? []).map((l) => ' E07 outbox candidate | ' + l),
].join('\n') + '\n';
const discovery = (verdict = 'MATCHES_REPOSITORY_0198_PG16', hash = '7fd4c419d738de8a'): string =>
  `fingerprint-groups=133 function-groups=12 combined-sha256-16=${hash}\nfingerprint-verdict=${verdict}\n`;

function run(ev: string, di: string, extraArgs: string[] = [], preexisting?: string) {
  const id = ++n;
  const e = join(dir, `e${id}.txt`); const d = join(dir, `d${id}.txt`); const o = join(dir, `o${id}.profile`);
  writeFileSync(e, ev); writeFileSync(d, di);
  if (preexisting !== undefined) writeFileSync(o, preexisting);
  const r = spawnSync('bash', [SCRIPT, '--evidence', e, '--discovery', d, '--out', o, ...extraArgs], { encoding: 'utf8', timeout: 20000 });
  return { status: r.status, out: r.stdout + r.stderr, file: o, text: existsSync(o) ? readFileSync(o, 'utf8') : null };
}

describe('make-expectations-profile.sh', () => {
  it('builds a profile from clean evidence: ledger, fingerprint from the discovery output, every count rule, and only grammar-valid lines', () => {
    const r = run(evidence({ outbox: ['outbox onboarding.step.completed=45', 'outbox billing.subscription.status_changed=11'] }), discovery());
    expect(r.status, r.out).toBe(0);
    const lines = (r.text as string).split('\n').filter((l) => l && !l.startsWith('#'));
    expect(lines).toContain('ledger_count=198');
    expect(lines).toContain(`ledger_head=${HEAD}`);
    expect(lines).toContain('schema_fingerprint=7fd4c419d738de8a');
    expect(lines).toContain('count outcome_monitoring.outcome_observations=3');
    expect(lines).toContain('outbox billing.subscription.status_changed=11');
    for (const l of lines) {
      expect(/^(ledger_count=[0-9]+|ledger_head=[A-Za-z0-9._-]+|schema_fingerprint=[0-9a-f]{16}|count[ ]+[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*=[0-9]+|outbox[ ]+[a-z0-9_.]+=[0-9]+)$/.test(l), l).toBe(true);
    }
    expect((r.text as string)).toMatch(/^# generated: .* \| evidence sha256:[0-9a-f]{16} \| discovery sha256:[0-9a-f]{16} \|/m);
    expect(r.text).toContain('A CANDIDATE');
  });

  it('with no outbox rows in the evidence it writes no outbox rules (an empty outbox is a count rule, not an invented classification)', () => {
    const r = run(evidence(), discovery());
    expect(r.status, r.out).toBe(0);
    expect(r.text).not.toMatch(/^outbox /m);
  });

  it.each([
    ['another database', evidence({ db: 'infinicus_staging' }), discovery(), /evidence database is 'infinicus_staging', expected 'infinicus'/],
    ['a session that was not read-only', evidence({ ro: 'off' }), discovery(), /not read-only/],
    ['a different migration head', evidence({ head: '0170_add_approved_action_source_recommendation.sql' }), discovery(), /ledger head is '0170/],
    ['a ledger count that disagrees with the E06 rule', evidence({ count: '197' }), discovery(), /ledger_count does not equal/],
    ['a missing table', evidence({ extra: [' E06 profile candidate | count outcome_monitoring.monitored_actions=TABLE_MISSING'] }), discovery(), /TABLE_MISSING/],
    ['an ERROR line (a failed run is not evidence)', evidence({ extra: ['psql:x.sql:1: ERROR:  relation "x" does not exist'] }), discovery(), /ERROR/],
    ['a discovery verdict that is not the expected clean reference', evidence(), discovery('NO_REFERENCE_MATCH (send the full fingerprint below for a group-level diff)', 'f620b3eb7b70a95a'), /fingerprint-verdict=MATCHES_REPOSITORY_0198_PG16/],
    ['an evidence file with no identity row', 'no evidence here\n', discovery(), /no E01 identity row/],
    ['a candidate line that is outside the profile grammar', evidence({ extra: [' E06 profile candidate | count Bad-Name.table=3'] }), discovery(), /does not match the profile grammar/],
  ])('refuses %s and writes nothing', (_n, ev, di, msg) => {
    const r = run(ev, di);
    expect(r.status).toBe(2);
    expect(r.out).toMatch(msg);
    expect(r.text).toBeNull();
  });

  it('accepts --expect-db / --expect-head for a non-production rehearsal database but still enforces them', () => {
    expect(run(evidence({ db: 'infinicus_rehearsal' }), discovery(), ['--expect-db', 'infinicus_rehearsal']).status).toBe(0);
    expect(run(evidence({ db: 'infinicus_rehearsal' }), discovery(), ['--expect-db', 'infinicus']).status).toBe(2);
  });

  it('never overwrites an existing profile', () => {
    const r = run(evidence(), discovery(), [], '# existing\nledger_count=1\n');
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/already exists; refusing to overwrite/);
    expect(r.text).toBe('# existing\nledger_count=1\n');
  });

  it('is a file transformer only: no database client, container, network or remote-shell command appears in its code', () => {
    const code = readFileSync(SCRIPT, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(code).not.toMatch(/\b(psql|pg_dump|pg_restore|docker|curl|wget|ssh|scp|rclone|aws|sudo|rm -rf)\b/);
    expect(code).toMatch(/^set -euo pipefail$/m);
    expect(code).toMatch(/^umask 077$/m);
  });
});
