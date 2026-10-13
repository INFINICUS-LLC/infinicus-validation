/**
 * Off-VM encrypted backup (infrastructure/backups): the real scripts, run against a dedicated scratch database on the live PostgreSQL test server.
 *   backup-offsite.sh   -> encrypted objects + manifest written through a file "sink" (stand-in for an S3-compatible client)
 *   restore-proof.sh    -> fetch, verify, decrypt (private key held in a SEPARATE gpg home), restore into a scratch database, compare ledger + schema fingerprint
 *   check-backup-freshness.sh
 * Requires ADMIN_DATABASE_URL (a role that can create databases and roles), gpg, pg_dump, pg_dumpall, pg_restore and psql on PATH.
 * Source data is a small synthetic database created by this test (isolated from every other test file).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';

// Each script run spawns pg_dump/gpg/psql (and the fingerprint query); allow for a loaded shared test server.
vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

const have = (cmd: string): boolean => spawnSync('bash', ['-c', `command -v ${cmd}`]).status === 0;
const run = Boolean(process.env.ADMIN_DATABASE_URL) && ['gpg', 'pg_dump', 'pg_dumpall', 'pg_restore', 'psql'].every(have);

const BACKUPS = resolve(__dirname, '../../../infrastructure/backups');
const BACKUP = join(BACKUPS, 'backup-offsite.sh');
const RESTORE = join(BACKUPS, 'restore-proof.sh');
const FRESH = join(BACKUPS, 'check-backup-freshness.sh');

function urlFor(base: string, db: string): string {
  const u = new URL(base);
  u.pathname = `/${db}`;
  return u.toString();
}

describe.runIf(run)('off-VM encrypted backup and restore proof (real scripts, real PostgreSQL)', () => {
  const suffix = randomBytes(4).toString('hex');
  const SRC = `bk_src_${suffix}`;
  const ROLE = `bk_owner_${suffix}`;
  const SECRET_MARKER = `TOP-SECRET-CUSTOMER-${suffix}`;
  const admin = new URL(process.env.ADMIN_DATABASE_URL as string);
  const maintenance = urlFor(admin.toString(), 'postgres');
  const srcUrl = urlFor(admin.toString(), SRC);
  let pool: Pool;
  let work: string;
  let sink: string;
  let stateDir: string;
  let backupHome: string; // public key only
  let restoreHome: string; // private key
  let recipient: string;

  // Lowest CPU priority: this test spawns many short-lived processes and must not starve the other test files sharing the machine and server.
  const sh = (cmd: string, args: string[], env: Record<string, string> = {}) =>
    spawnSync('nice', ['-n', '19', cmd, ...args], { encoding: 'utf8', timeout: 120000, env: { PATH: process.env.PATH, HOME: work, TMPDIR: work, ...env } });

  function backupEnv(over: Record<string, string> = {}): Record<string, string> {
    return {
      BACKUP_ENV_FILE: join(work, 'no-such.env'),
      BACKUP_GPG_RECIPIENT: recipient,
      BACKUP_GNUPGHOME: backupHome,
      BACKUP_SINK_CMD: `mkdir -p "$(dirname '${sink}/%KEY%')" && cat > '${sink}/%KEY%'`,
      BACKUP_FETCH_CMD: `cat '${sink}/%KEY%'`,
      BACKUP_PG_DUMP_CMD: `pg_dump -d ${srcUrl} --format=custom --compress=6`,
      BACKUP_PG_ROLES_CMD: `pg_dumpall -d ${srcUrl} --roles-only`,
      BACKUP_PSQL_CMD: `psql ${srcUrl} -X -At`,
      BACKUP_STATE_DIR: stateDir,
      BACKUP_TMP_DIR: join(work, 'tmp'),
      BACKUP_PREFIX: 'infinicus-test',
      ...over,
    };
  }
  const objects = (): string[] => (existsSync(sink) ? (readdirSync(sink, { recursive: true }) as string[]).filter((f) => statSync(join(sink, f)).isFile()) : []);
  const manifestKey = (): string => objects().filter((f) => f.endsWith('manifest.json')).sort().pop() as string;
  function restoreEnv(over: Record<string, string> = {}): Record<string, string> {
    return { BACKUP_FETCH_CMD: `cat '${sink}/%KEY%'`, RESTORE_GNUPGHOME: restoreHome, RESTORE_ADMIN_URL: maintenance, RESTORE_DB_NAME: `bk_restore_${suffix}`, ...over };
  }

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'offsite-backup-'));
    sink = join(work, 'sink'); stateDir = join(work, 'state');
    mkdirSync(join(work, 'tmp'), { recursive: true });
    pool = new Pool({ connectionString: maintenance });
    await pool.query(`CREATE ROLE ${ROLE} NOLOGIN`);
    await pool.query(`CREATE DATABASE ${SRC} OWNER ${ROLE}`);
    const s = new Pool({ connectionString: srcUrl });
    await s.query(`CREATE TABLE public._migrations (id serial primary key, filename text not null unique)`);
    await s.query(`INSERT INTO public._migrations (filename) VALUES ('0001_foundation.sql'), ('0170_add_approved_action_source_recommendation.sql')`);
    await s.query(`CREATE SCHEMA tenancy AUTHORIZATION ${ROLE}`);
    await s.query(`CREATE TABLE tenancy.customers (id serial primary key, name text not null)`);
    await s.query(`ALTER TABLE tenancy.customers OWNER TO ${ROLE}`);
    await s.query(`INSERT INTO tenancy.customers (name) VALUES ('${SECRET_MARKER}')`);
    await s.query(`CREATE FUNCTION tenancy.touch() RETURNS int LANGUAGE sql AS 'select 1'`);
    await s.end();

    // two gpg homes: the backup side holds the PUBLIC key only; the restore side holds the private key
    restoreHome = join(work, 'gpg-restore'); backupHome = join(work, 'gpg-backup');
    mkdirSync(restoreHome, { mode: 0o700 }); mkdirSync(backupHome, { mode: 0o700 });
    writeFileSync(join(work, 'key.batch'), `%no-protection\nKey-Type: eddsa\nKey-Curve: ed25519\nSubkey-Type: ecdh\nSubkey-Curve: cv25519\nSubkey-Usage: encrypt\nName-Real: infinicus-test-backup\nName-Email: backup-${suffix}@example.test\nExpire-Date: 0\n%commit\n`);
    expect(sh('gpg', ['--batch', '--quiet', '--homedir', restoreHome, '--gen-key', join(work, 'key.batch')]).status).toBe(0);
    recipient = `backup-${suffix}@example.test`;
    const pub = spawnSync('gpg', ['--batch', '--homedir', restoreHome, '--export', recipient]);
    expect(pub.status).toBe(0);
    writeFileSync(join(work, 'pub.gpg'), pub.stdout);
    expect(sh('gpg', ['--batch', '--quiet', '--homedir', backupHome, '--import', join(work, 'pub.gpg')]).status).toBe(0);
  });

  afterAll(async () => {
    await pool?.query(`DROP DATABASE IF EXISTS bk_restore_${suffix}`).catch(() => undefined);
    await pool?.query(`DROP DATABASE IF EXISTS ${SRC}`).catch(() => undefined);
    await pool?.query(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => undefined);
    await pool?.end();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('--check validates prerequisites and writes nothing (no dump, no upload, no state)', () => {
    const r = sh('bash', [BACKUP, '--check'], backupEnv());
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('CHECK PASSED');
    expect(objects()).toEqual([]);
    expect(existsSync(join(stateDir, 'last-success.json'))).toBe(false);
  });

  it('refuses to run without encryption, with an unsafe label, with a missing key, and without a sink', () => {
    expect(sh('bash', [BACKUP], backupEnv({ BACKUP_GPG_RECIPIENT: '' })).status).toBe(2);
    expect(sh('bash', [BACKUP], backupEnv({ BACKUP_LABEL: 'bad label; rm -rf /' })).status).toBe(2);
    expect(sh('bash', [BACKUP], backupEnv({ BACKUP_GPG_RECIPIENT: 'nobody-with-this-key@example.test' })).status).toBe(2);
    expect(sh('bash', [BACKUP], backupEnv({ BACKUP_SINK_CMD: '' })).status).toBe(2);
    expect(sh('bash', [BACKUP], backupEnv({ BACKUP_SINK_CMD: 'cat > /tmp/no-key-placeholder' })).status).toBe(2);
    expect(objects()).toEqual([]);
  });

  it('creates encrypted objects plus a manifest (written last), with correct SHA-256, ledger, fingerprint, and verified upload', () => {
    const r = sh('bash', [BACKUP, '--verify'], backupEnv({ BACKUP_LABEL: 'pre-migration-0171' }));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('BACKUP COMPLETE');
    const files = objects();
    expect(files.filter((f) => f.endsWith('.gpg')).length).toBe(2);
    expect(files.some((f) => f.endsWith('manifest.json'))).toBe(true);
    const m = JSON.parse(readFileSync(join(sink, manifestKey()), 'utf8'));
    expect(m).toMatchObject({ format: 1, label: 'pre-migration-0171', database: SRC, ledger_count: 2, ledger_head: '0170_add_approved_action_source_recommendation.sql', verified_after_upload: true });
    expect(m.schema_fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(m.gpg_recipient_fingerprint).toMatch(/^[0-9A-F]{16,64}$/);
    expect(m.objects.map((o: { name: string }) => o.name).sort()).toEqual(['db.dump.gpg', 'roles.sql.gpg']);
    for (const o of m.objects as { name: string; bytes: number; sha256: string }[]) {
      const body = readFileSync(join(sink, manifestKey().replace('manifest.json', o.name)));
      expect(createHash('sha256').update(body).digest('hex')).toBe(o.sha256);
      expect(body.length).toBe(o.bytes);
    }
    expect(JSON.parse(readFileSync(join(stateDir, 'last-success.json'), 'utf8')).key).toBe(manifestKey());
  });

  it('nothing in the stored objects is readable without the private key (no plaintext data, no dump header, no role names)', () => {
    for (const f of objects().filter((n) => n.endsWith('.gpg'))) {
      const body = readFileSync(join(sink, f));
      expect(body.includes(Buffer.from(SECRET_MARKER))).toBe(false);
      expect(body.subarray(0, 5).toString('latin1')).not.toBe('PGDMP');
      expect(body.includes(Buffer.from(ROLE))).toBe(false);
    }
    // and the backup-side keyring (public key only) cannot decrypt
    const body = readFileSync(join(sink, objects().find((n) => n.endsWith('db.dump.gpg')) as string));
    const dec = spawnSync('gpg', ['--batch', '--quiet', '--homedir', backupHome, '--decrypt'], { input: body });
    expect(dec.status).not.toBe(0);
  });

  it('restore proof PASSES: verify, decrypt, restore roles + database into a scratch database, ledger and schema fingerprint equal the manifest; owner and data preserved', async () => {
    const r = sh('bash', [RESTORE, manifestKey(), '--keep'], restoreEnv());
    expect(r.stdout + r.stderr).toContain('RESTORE_PROOF=PASS');
    expect(r.status).toBe(0);
    const t = new Pool({ connectionString: urlFor(admin.toString(), `bk_restore_${suffix}`) });
    const owner = await t.query(`select pg_get_userbyid(relowner) o from pg_class where oid = 'tenancy.customers'::regclass`);
    expect(owner.rows[0].o).toBe(ROLE);
    expect((await t.query(`select count(*)::int n from tenancy.customers where name = $1`, [SECRET_MARKER])).rows[0].n).toBe(1);
    await t.end();
    await pool.query(`DROP DATABASE bk_restore_${suffix}`);
  });

  it('restore proof FAILS on a tampered object (SHA-256 mismatch), on the wrong private key, on a missing manifest, and on an existing or production-named target', async () => {
    const key = manifestKey();
    const dbObject = join(sink, key.replace('manifest.json', 'db.dump.gpg'));
    const original = readFileSync(dbObject);
    const tampered = Buffer.from(original); tampered[Math.floor(tampered.length / 2)] ^= 0xff;
    writeFileSync(dbObject, tampered);
    const a = sh('bash', [RESTORE, key], restoreEnv());
    expect(a.stdout).toContain('RESTORE_PROOF=FAIL');
    expect(a.stdout).toContain('SHA-256 mismatch');
    expect(a.status).not.toBe(0);
    writeFileSync(dbObject, original);

    const emptyHome = join(work, 'gpg-empty'); mkdirSync(emptyHome, { mode: 0o700 });
    const b = sh('bash', [RESTORE, key], restoreEnv({ RESTORE_GNUPGHOME: emptyHome }));
    expect(b.stdout).toContain('RESTORE_PROOF=FAIL');
    expect(b.stdout).toContain('cannot decrypt');

    const c = sh('bash', [RESTORE, key.replace('manifest.json', 'missing/manifest.json')], restoreEnv());
    expect(c.stdout).toContain('RESTORE_PROOF=FAIL');

    const d = sh('bash', [RESTORE, key], restoreEnv({ RESTORE_DB_NAME: 'infinicus' }));
    expect(d.stdout).toContain('RESTORE_PROOF=FAIL');
    await pool.query(`CREATE DATABASE bk_restore_${suffix}`);
    const e = sh('bash', [RESTORE, key], restoreEnv());
    expect(e.stdout).toContain('already exists');
    await pool.query(`DROP DATABASE bk_restore_${suffix}`);
  });

  it('restore proof FAILS when the restored schema or ledger does not equal what the manifest recorded (fingerprint / ledger mismatch)', async () => {
    const key = manifestKey();
    const path = join(sink, key);
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, original.replace(/"schema_fingerprint":"[0-9a-f]{16}"/, '"schema_fingerprint":"0000000000000000"'));
    const a = sh('bash', [RESTORE, key], restoreEnv());
    expect(a.stdout).toContain('RESTORE_PROOF=FAIL');
    expect(a.stdout).toContain('schema fingerprint differs');
    writeFileSync(path, original.replace(/"ledger_count":\d+/, '"ledger_count":999'));
    const b = sh('bash', [RESTORE, key], restoreEnv());
    expect(b.stdout).toContain('ledger differs');
    writeFileSync(path, original);
    // the scratch database is dropped after a failed proof as well
    expect((await pool.query(`select 1 from pg_database where datname = 'bk_restore_${suffix}'`)).rowCount).toBe(0);
  });

  it('a failing sink makes the backup fail (exit 4), writes no manifest and records no success', () => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(sink, { recursive: true, force: true });
    const r = sh('bash', [BACKUP], backupEnv({ BACKUP_SINK_CMD: 'false %KEY%' }));
    expect(r.status).toBe(4);
    expect(objects()).toEqual([]);
    expect(existsSync(join(stateDir, 'last-success.json'))).toBe(false);
  });

  it('an object upload that fails while the manifest sink would succeed still fails the backup: no manifest is written, so no dangling backup exists', () => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(sink, { recursive: true, force: true });
    const partial = `case '%KEY%' in *.gpg) exit 1 ;; *) mkdir -p "$(dirname '${sink}/%KEY%')" && cat > '${sink}/%KEY%' ;; esac`;
    const r = sh('bash', [BACKUP], backupEnv({ BACKUP_SINK_CMD: partial }));
    expect(r.status).toBe(4);
    expect(objects().filter((f) => f.endsWith('manifest.json'))).toEqual([]);
    expect(existsSync(join(stateDir, 'last-success.json'))).toBe(false);
  });

  it('a failing dump makes the backup fail (exit 3) and uploads nothing', () => {
    const r = sh('bash', [BACKUP], backupEnv({ BACKUP_PG_DUMP_CMD: 'false' }));
    expect(r.status).toBe(3);
    expect(objects()).toEqual([]);
  });

  it('freshness check: critical when nothing has succeeded, ok right after a success, warning/critical when stale', () => {
    rmSync(stateDir, { recursive: true, force: true });
    expect(sh('bash', [FRESH], { BACKUP_STATE_DIR: stateDir }).status).toBe(2);
    expect(sh('bash', [BACKUP], backupEnv()).status).toBe(0);
    const ok = sh('bash', [FRESH], { BACKUP_STATE_DIR: stateDir });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('OK');
    const stale = (hours: number) => {
      const t = new Date(Date.now() - hours * 3600 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
      writeFileSync(join(stateDir, 'last-success.json'), `{"finished_utc":"${t}","key":"k"}\n`);
      return sh('bash', [FRESH], { BACKUP_STATE_DIR: stateDir }).status;
    };
    expect(stale(30)).toBe(1);
    expect(stale(60)).toBe(2);
  });
});
