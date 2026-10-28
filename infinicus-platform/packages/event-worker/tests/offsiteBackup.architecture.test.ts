import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const DOCS = resolve(__dirname, '../../../../docs/architecture/reconciliation');

/**
 * Guard for the off-VM backup tooling (no database, no gpg). These scripts run on the production VM, so the properties that matter are structural:
 * encryption is mandatory and happens before anything leaves the machine, nothing is deleted, the database is only read, the restore proof can never
 * target production, and no secret or connection string can reach a log or a command line.
 */
const BACKUPS = resolve(__dirname, '../../../infrastructure/backups');
const read = (f: string): string => readFileSync(join(BACKUPS, f), 'utf8');
const codeOf = (f: string): string[] => read(f).split('\n').filter((l) => !/^\s*#/.test(l));
const backup = codeOf('backup-offsite.sh').join('\n');
const restore = codeOf('restore-proof.sh').join('\n');
const fresh = codeOf('check-backup-freshness.sh').join('\n');

describe('off-VM backup scripts: structure and safety', () => {
  it('all scripts fail fast, and the writers restrict file modes', () => {
    for (const f of ['backup-offsite.sh', 'restore-proof.sh', 'check-backup-freshness.sh']) expect(read(f), f).toMatch(/^set -euo pipefail$/m);
    expect(read('backup-offsite.sh')).toMatch(/^umask 077$/m);
    expect(read('restore-proof.sh')).toMatch(/^umask 077$/m);
    expect(backup).toMatch(/chmod 700 "\$WORK"/);
    expect(restore).toMatch(/chmod 700 "\$WORK"/);
  });

  it('encryption is mandatory and precedes storage: no unencrypted mode, dump and roles pass through gpg --encrypt --recipient to .gpg files, no plaintext file is written', () => {
    expect(backup).toMatch(/BACKUP_GPG_RECIPIENT is required \(encryption is mandatory/);
    expect(backup).toMatch(/gpg --batch --yes --quiet --trust-model always --compress-algo none --encrypt --recipient "\$BACKUP_GPG_RECIPIENT"/);
    expect(backup).toMatch(/run_pg_dump \| encrypt > "\$WORK\/db\.dump\.gpg"/);
    expect(backup).toMatch(/run_pg_roles \| encrypt > "\$WORK\/roles\.sql\.gpg"/);
    expect(backup).not.toMatch(/>\s*"\$WORK\/(db\.dump|roles\.sql)"/); // only the .gpg names are ever created
    expect(backup).not.toMatch(/--no-encrypt|--symmetric|-c\s+--cipher|NOENCRYPT|ENCRYPT=0/i);
    // upload and manifest only after both objects are encrypted; the manifest is the last upload
    expect(backup.indexOf('encrypt > "$WORK/roles.sql.gpg"')).toBeLessThan(backup.indexOf('sink "$key"'));
    expect(backup.lastIndexOf('sink "$BASE_KEY/manifest.json"')).toBeGreaterThan(backup.lastIndexOf('sink "$key"'));
  });

  it('the dump keeps owners and privileges (a restore keeps the security model) and the cluster roles are included', () => {
    expect(backup).toMatch(/pg_dump -U admin_role -d infinicus --format=custom/);
    expect(backup).not.toMatch(/--no-owner|--no-privileges|--no-acl/);
    expect(backup).toMatch(/pg_dumpall -U admin_role --roles-only/);
  });

  it('never deletes anything and never writes to the database: no remote delete/purge/sync, no DROP/DELETE/UPDATE/INSERT/TRUNCATE, read-only SQL session', () => {
    expect(backup).not.toMatch(/rclone\s+(delete|deletefile|purge|sync|move)|aws\s+s3\s+(rm|mv|sync)|\brm\s+-rf\s+(?!"\$WORK")/);
    expect(backup).toMatch(/default_transaction_read_only=on/);
    for (const m of backup.matchAll(/printf '([^'\n]*)\\n' \| run_psql/g)) expect(m[1], m[1]).toMatch(/^(select|show)\b/i);
    expect(backup).not.toMatch(/\b(insert\s+into|update\s+\w+\s+set|delete\s+from|truncate|drop\s+(table|database)|alter\s+table)\b/i);
  });

  it('no secret reaches a log or a command line: the sink/fetch commands are never printed, there is no tracing, and values in the manifest are validated', () => {
    for (const text of [backup, restore]) {
      expect(text).not.toMatch(/(echo|printf|log)\b[^\n]*(BACKUP_SINK_CMD|BACKUP_FETCH_CMD)/);
      expect(text).not.toMatch(/\bset\s+-x\b|\bxtrace\b|\bPS4=|\beval\b|\bprintenv\b|\benv\s*$/m);
      expect(text).not.toMatch(/SECRET_KEY|PASSWORD=|--password/);
      // AWS credentials are never read into a variable, logged or passed on a command line: the only mention is a presence test of the standard variables
      for (const l of text.split('\n').filter((x) => /AWS_(SECRET|ACCESS)/.test(x))) expect(l, l).toMatch(/\[\[ -n "\$\{AWS_ACCESS_KEY_ID:-\}" && -n "\$\{AWS_SECRET_ACCESS_KEY:-\}" \]\]/);
    }
    expect(backup).toMatch(/BACKUP_LABEL must match \[A-Za-z0-9\._-\]\{1,40\}/);
    expect(backup).toMatch(/a database-derived value is not manifest-safe/);
  });

  it('the restore proof can never target production: refuses the production database name, an existing scratch database, uses no production connection variable, and drops its scratch database', () => {
    expect(restore).toMatch(/"\$DB" != infinicus/);
    expect(restore).toMatch(/refusing to touch it/);
    expect(restore).not.toMatch(/\bDATABASE_URL\b|\bADMIN_DATABASE_URL\b|docker\s+compose/); // takes an explicit throwaway server URL only
    expect(restore).toMatch(/RESTORE_GNUPGHOME/);
    expect(restore).toMatch(/DROP DATABASE IF EXISTS/);
    expect(restore).toMatch(/SHA-256 mismatch/);
    expect(restore).toMatch(/schema fingerprint differs after restore/);
    expect(restore).toMatch(/ledger differs after restore/);
  });

  it('H-5: the restore target is validated fail-closed BEFORE anything is fetched, decrypted or written; roles.sql is allowlisted and stripped of password hashes', () => {
    // order in the script: target validation runs before the temporary directory, the manifest fetch and the decrypt
    const at = (re: RegExp): number => { const i = restore.search(re); expect(i, String(re)).toBeGreaterThan(-1); return i; };
    expect(at(/^validate_target$/m)).toBeLessThan(at(/WORK="\$\(mktemp/));
    expect(at(/^validate_target$/m)).toBeLessThan(at(/fetch "\$MANIFEST_KEY"/));
    for (const re of [/infinicus\.restore_target/, /must not contain a password/, /host must be loopback/, /PGHOSTADDR/, /is_superuser/, /pg_is_in_recovery/, /database named infinicus/,
      /--validate-target/, /RESTORE_TARGET=REFUSED/, /shell tracing is enabled/, /sanitize_roles/, /outside the allowlist/, /rolpassword is not null/]) expect(restore, String(re)).toMatch(re);
    // the connection check pins PGOPTIONS so the caller's environment cannot spoof the marker, and never prints the URL or a role line
    expect(restore).toMatch(/PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=15000' PGCONNECT_TIMEOUT=10 psql "\$url"/);
    expect(restore).not.toMatch(/^\s*(echo|printf|log)\b[^\n]*\$\{?(RESTORE_ADMIN_URL|url|SCRATCH_URL)\b/m);
    // roles.sql never reaches psql unfiltered: only the sanitized copy is applied, and the plaintext is removed right after
    expect(restore).toMatch(/psql [^\n]*-f "\$WORK\/roles\.guarded\.sql"/);
    expect(restore).not.toMatch(/psql [^\n]*-f "\$WORK\/roles\.sql"/);
    expect(restore).toMatch(/rm -f "\$WORK\/roles\.sql" "\$WORK\/roles\.safe\.sql" "\$WORK\/roles\.guarded\.sql"/);
    expect(restore).toMatch(/rm -f "\$WORK\/db\.dump"/);
    expect(restore).toMatch(/s\/ PASSWORD '\[\^'\]\*'\/\//);
    // cleanup also runs on INT, TERM and HUP
    expect(restore).toMatch(/trap 'exit 129' HUP/);
    expect(restore).toMatch(/trap 'exit 130' INT/);
    expect(restore).toMatch(/trap 'exit 143' TERM/);
  });

  it('the freshness check is read-only', () => {
    expect(fresh).not.toMatch(/>\s*[\w"$/.]|\brm\b|\btouch\b|\bmv\b|\bcp\b|\bcurl\b|\bdocker\b/);
  });

  it('systemd templates: oneshot as a non-root user, hardening, check before run, failure alert, daily persistent timer; nothing installs them', () => {
    const svc = read('systemd/infinicus-backup.service');
    expect(svc).toMatch(/^Type=oneshot$/m);
    expect(svc).toMatch(/^User=deploy$/m);
    expect(svc).toMatch(/^NoNewPrivileges=true$/m);
    expect(svc).toMatch(/^ProtectSystem=strict$/m);
    expect(svc).toMatch(/^ExecStartPre=.*backup-offsite\.sh --check$/m);
    expect(svc).toMatch(/^OnFailure=infinicus-backup-failed\.service$/m);
    expect(svc).not.toMatch(/PASSWORD|SECRET|KEY=/);
    const timer = read('systemd/infinicus-backup.timer');
    expect(timer).toMatch(/^OnCalendar=\*-\*-\* 02:30:00 UTC$/m);
    expect(timer).toMatch(/^Persistent=true$/m);
    const env = read('backup.env.example');
    expect(env).not.toMatch(/^[A-Z_]*(SECRET|PASSWORD|TOKEN|ACCESS_KEY)[A-Z_]*=\S/m);
    expect(read('backup.env.example')).toMatch(/NO secrets by design/);
  });

  it('--check validates tools, versions, the keyring and the sink, and stays write-free: pg_dump/pg_restore/server major version, read-only session, no secret key, aws/rclone structure', () => {
    for (const re of [
      /check_client_major "pg_dump" run_pg_dump_version/, /check_client_major "pg_restore" run_pg_restore_version/, /show server_version_num/, /show transaction_read_only/,
      /list-secret-keys/, /the PRIVATE key matching the backup recipient is present/, /the production host must hold the public key only/,
      /check_aws_sink/, /check_rclone_sink/, /aws configure list-profiles/, /aws sts get-caller-identity/, /aws s3api head-bucket/, /EXPECTED for an upload-only policy/, /AWS ROOT user/,
    ]) expect(backup, String(re)).toMatch(re);
    // every aws invocation is a read-only identity/configuration/metadata call: never s3 cp/rm/mv/sync, never an s3api put/delete
    const calls = [...backup.matchAll(/(?:\$\(|timeout 30 |\| *|if )aws +(\w+)(?: +([\w-]+))?/g)].map((m) => `${m[1]} ${m[2] ?? ''}`.trim());
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c, c).toMatch(/^(configure (list-profiles|get)|sts get-caller-identity|s3api head-bucket)$/);
    expect(backup).not.toMatch(/\baws\s+s3\s+(rm|mv|sync)|put-object|delete-object|rclone\s+(copy|sync|move|delete|purge)\b/);
    // the sink is only ever invoked by the real run (after --check exits), never by the check
    expect(backup.indexOf('sink "$key"')).toBeGreaterThan(backup.indexOf('CHECK PASSED'));
    expect(backup.indexOf('check_aws_sink')).toBeLessThan(backup.indexOf('CHECK PASSED'));
  });

  it('restore-proof: PASS requires the expectations profile; counts are SELECT-only in a read-only session; the outbox is never consumed, updated or replayed', () => {
    for (const re of [/restored data differs from the expectations profile/, /outbox rows of unlisted event types/, /invalid line in the expectations profile/, /must define ledger_count and ledger_head/,
      /RESTORE_TIMINGS/, /not an RTO/, /default_transaction_read_only=on/]) expect(restore, String(re)).toMatch(re);
    expect(restore.indexOf('RESTORE_PROOF=PASS')).toBeGreaterThan(restore.indexOf('restored data differs from the expectations profile'));
    expect(restore).not.toMatch(/\b(insert\s+into|update\s+\w+[\w.]*\s+set|delete\s+from|truncate|alter\s+table|nextval|pg_notify|outbox_events\s+set)\b/i);
    for (const m of restore.matchAll(/q "(select[^"]*)"/g)) expect(m[1], m[1]).toMatch(/^select count\(\*\) from [\w.$]+( where event_type (=|not in) [^"]*)?$/);
  });

  it('the production expectations profile holds exactly the owner-supplied facts', () => {
    const lines = read('expectations/production-pre-0171.profile').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    expect(lines).toEqual([
      'ledger_count=170', 'ledger_head=0170_add_approved_action_source_recommendation.sql', 'schema_fingerprint=38eabb12fde135b5',
      'count tenancy.tenants=15', 'count identity.users=6', 'count platform.businesses=15', 'count events.outbox_events=56',
      'outbox onboarding.step.completed=45', 'outbox billing.subscription.status_changed=11',
      'count audit.audit_events=0', 'count business_operations.inventory_movements=0', 'count business_operations.purchase_receipts=0',
      'count business_operations.inventory_balances=0', 'count business_operations.purchase_orders=0', 'count business_operations.purchase_order_line_items=0',
    ]);
  });

  it('restore-proof: a reviewed restored_fingerprint is the ONLY second form accepted, and only while the manifest fingerprint equals the profile schema_fingerprint', () => {
    expect(restore).toMatch(/\^restored_fingerprint=\(\[0-9a-f\]\{16\}\)\$/);
    // both ends pinned: restored == profile restored_fingerprint AND manifest == profile schema_fingerprint, both non-empty
    expect(restore).toMatch(/-n "\$E_RFP" && -n "\$E_FP" && "\$R_FP" == "\$E_RFP" && "\$M_FINGERPRINT" == "\$E_FP"/);
    // anything else still fails closed
    expect(restore).toMatch(/else\s+fail "schema fingerprint differs after restore \(restored \$R_FP, manifest \$M_FINGERPRINT\)"/);
    // the profile comparison accepts the restored form too, but never a wildcard
    expect(restore).toMatch(/-z "\$E_FP" \|\| "\$R_FP" == "\$E_FP" \|\| \( -n "\$E_RFP" && "\$R_FP" == "\$E_RFP" \)/);
  });

  it('every committed profile that carries a restored_fingerprint also carries a different schema_fingerprint; the 0209 profile pins both known values', () => {
    const dir = join(BACKUPS, 'expectations');
    let withRestored = 0;
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.profile'))) {
      const lines = readFileSync(join(dir, f), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
      const rfp = lines.filter((l) => l.startsWith('restored_fingerprint='));
      const sfp = lines.filter((l) => l.startsWith('schema_fingerprint='));
      expect(rfp.length, f).toBeLessThanOrEqual(1);
      if (rfp.length === 0) continue;
      withRestored += 1;
      expect(rfp[0], f).toMatch(/^restored_fingerprint=[0-9a-f]{16}$/);
      expect(sfp, f).toHaveLength(1);
      expect(rfp[0].split('=')[1], f).not.toBe(sfp[0].split('=')[1]);
    }
    expect(withRestored).toBeGreaterThanOrEqual(1);
    const p0210 = readFileSync(join(dir, 'production-pre-0210.profile'), 'utf8').split('\n').map((l) => l.trim());
    expect(p0210).toContain('ledger_head=0209_create_print_jobs.sql');
    expect(p0210).toContain('schema_fingerprint=325158ea2a54cde9');
    expect(p0210).toContain('restored_fingerprint=68407667a5618dc9');
  });

  it('the post-0220 profile pins the isolated-release state: ledger 210, head 0220, both fingerprints, the same stable row rules as the 0209 profile, and a hash-pinned 0220 migration', () => {
    const dir = join(BACKUPS, 'expectations');
    const lines = (n: string) => readFileSync(join(dir, n), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    const post = lines('production-post-0220.profile');
    expect(post).toContain('ledger_count=210');
    expect(post).toContain('ledger_head=0220_normalize_access_event_tenant_context.sql');
    expect(post).toContain('schema_fingerprint=c4d9f7f8aebfa5c8');
    expect(post).toContain('restored_fingerprint=fd30bc44bee4dca0');
    // data rules are carried unchanged from the 0209 profile: 0220 changes a policy, not data
    const rules = (l: string[]) => l.filter((x) => /^(count|outbox) /.test(x)).sort();
    expect(rules(post)).toEqual(rules(lines('production-pre-0210.profile')));
    // the profile's fingerprints describe THIS migration: a changed 0220 file must be re-reviewed together with the profile
    const mig = readFileSync(join(__dirname, '..', '..', '..', 'infrastructure', 'database', 'migrations', '0220_normalize_access_event_tenant_context.sql'));
    expect(createHash('sha256').update(mig).digest('hex')).toBe('78a17188e4f01e7dbe78fb422578864345607c9a4eefeb30ea7f9913d1222472');
  });

  it('the plan states the owner ruling: no lifecycle deletion until retention is approved; any expiry value is a proposal only; Object Lock default is owner-configurable', () => {
    const plan = readFileSync(join(DOCS, 'OFFSITE_BACKUP_PLAN.md'), 'utf8');
    expect(plan).toMatch(/NO lifecycle deletion or expiration rules/i);
    expect(plan).toMatch(/PROPOSAL ONLY — NOT AUTHORIZED/);
    expect(plan).toMatch(/GOVERNANCE/);
    expect(plan).toMatch(/90 days/);
    // every retention figure (35 days / 13 months / 12 months) sits in a block labelled as a proposal
    const section = plan.slice(plan.indexOf('## 6. Retention'), plan.indexOf('## 7.'));
    expect(section).toMatch(/PROPOSAL ONLY — NOT AUTHORIZED/);
    expect(section.indexOf('PROPOSAL ONLY — NOT AUTHORIZED')).toBeLessThan(section.search(/35 days|13 months|12 months/));
    expect(plan).not.toMatch(/lifecycle rules for retention \(section 6\)/);
  });
});

