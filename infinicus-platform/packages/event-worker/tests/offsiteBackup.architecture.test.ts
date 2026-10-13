import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
      expect(text).not.toMatch(/AWS_SECRET|SECRET_KEY|PASSWORD=|--password/);
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
});
