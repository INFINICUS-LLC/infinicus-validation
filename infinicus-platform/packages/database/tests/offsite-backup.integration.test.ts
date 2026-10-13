/**
 * Off-VM encrypted backup (infrastructure/backups): the real scripts, run against a dedicated scratch database on the live PostgreSQL test server.
 *   backup-offsite.sh   -> encrypted objects + manifest written through a file "sink" (stand-in for an S3-compatible client)
 *   restore-proof.sh    -> fetch, verify, decrypt (private key held in a SEPARATE gpg home), restore into a scratch database, compare ledger + schema fingerprint
 *   check-backup-freshness.sh
 * --check is exercised with stub version/aws commands (no network, no S3); restore expectations (row counts, outbox classification) use a profile for this synthetic database.
 * Requires ADMIN_DATABASE_URL (a role that can create databases and roles), gpg, pg_dump, pg_dumpall, pg_restore and psql on PATH.
 * Source data is a small synthetic database created by this test (isolated from every other test file).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
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
  let serverMajor: number;
  let binDir: string; // stub `aws` (records every call; never prints credentials)
  let awsLog: string;

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
      BACKUP_PG_DUMP_VERSION_CMD: 'pg_dump --version',
      BACKUP_PG_RESTORE_VERSION_CMD: 'pg_restore --version',
      BACKUP_EXPECT_PG_MAJOR: String(serverMajor),
      ...over,
    };
  }

  /** Expectations for the synthetic source database. `edit` rewrites lines to simulate a mismatch. */
  function writeProfile(edit: (lines: string[]) => string[] = (l) => l): string {
    const m = JSON.parse(readFileSync(join(sink, manifestKey()), 'utf8'));
    const lines = [
      '# synthetic profile for the test database', 'ledger_count=2', 'ledger_head=0170_add_approved_action_source_recommendation.sql', `schema_fingerprint=${m.schema_fingerprint}`,
      'count tenancy.customers=1', 'count events.outbox_events=5', 'outbox a.done=3', 'outbox b.changed=2',
      'count audit.audit_events=0', 'count business_operations.purchase_orders=0',
    ];
    const path = join(work, 'expectations.profile');
    writeFileSync(path, edit(lines).join('\n') + '\n');
    return path;
  }
  const stub = (name: string, body: string): string => { const f = join(binDir, name); writeFileSync(f, `#!/usr/bin/env bash\n${body}\n`); chmodSync(f, 0o755); return f; };
  /** PATH without any directory entry named `cmd` (dirs that contain it are replaced by symlink shadows of their other executables). */
  function pathWithout(cmd: string): string {
    const shadow = join(work, `path-without-${cmd}`); mkdirSync(shadow, { recursive: true });
    const keep: string[] = [];
    for (const dir of (process.env.PATH as string).split(delimiter)) {
      if (!existsSync(join(dir, cmd))) { keep.push(dir); continue; }
      for (const f of readdirSync(dir)) if (f !== cmd && !existsSync(join(shadow, f))) { try { symlinkSync(join(dir, f), join(shadow, f)); } catch { /* ignore */ } }
    }
    return [shadow, ...keep].join(delimiter);
  }
  const AWS_SINK = 'aws s3 cp - s3://infinicus-bk-test/%KEY% --profile infinicus-backup-writer --region eu-central-1 --only-show-errors';
  const awsEnv = (over: Record<string, string> = {}): Record<string, string> => backupEnv({
    PATH: `${binDir}${delimiter}${process.env.PATH}`, AWS_STUB_LOG: awsLog, AWS_ACCESS_KEY_ID: 'AKIAFAKEFAKEFAKE', AWS_SECRET_ACCESS_KEY: `SECRETMARKER${suffix}`,
    BACKUP_SINK_CMD: AWS_SINK, BACKUP_FETCH_CMD: 'aws s3 cp s3://infinicus-bk-test/%KEY% - --profile infinicus-backup-writer', ...over,
  });
  const objects = (): string[] => (existsSync(sink) ? (readdirSync(sink, { recursive: true }) as string[]).filter((f) => statSync(join(sink, f)).isFile()) : []);
  const manifestKey = (): string => objects().filter((f) => f.endsWith('manifest.json')).sort().pop() as string;
  function restoreEnv(over: Record<string, string> = {}): Record<string, string> {
    return { BACKUP_FETCH_CMD: `cat '${sink}/%KEY%'`, RESTORE_GNUPGHOME: restoreHome, RESTORE_ADMIN_URL: maintenance, RESTORE_DB_NAME: `bk_restore_${suffix}`, RESTORE_EXPECTATIONS: join(work, 'expectations.profile'), ...over };
  }

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'offsite-backup-'));
    sink = join(work, 'sink'); stateDir = join(work, 'state');
    mkdirSync(join(work, 'tmp'), { recursive: true });
    pool = new Pool({ connectionString: maintenance });
    serverMajor = Math.floor(Number((await pool.query('show server_version_num')).rows[0].server_version_num) / 10000);
    binDir = join(work, 'bin'); mkdirSync(binDir); awsLog = join(work, 'aws.log');
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
    await s.query(`CREATE SCHEMA events; CREATE TABLE events.outbox_events (id serial primary key, event_type text not null, status text not null default 'pending')`);
    await s.query(`INSERT INTO events.outbox_events (event_type) VALUES ('a.done'),('a.done'),('a.done'),('b.changed'),('b.changed')`);
    await s.query(`CREATE SCHEMA audit; CREATE TABLE audit.audit_events (id serial primary key)`);
    await s.query(`CREATE SCHEMA business_operations; CREATE TABLE business_operations.purchase_orders (id serial primary key)`);
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
    // stub aws client: records every call, prints no credential, behaviour switched by STUB_* variables; it refuses anything that is not a read-only identity/metadata call
    stub('aws', `echo "$*" >> "$AWS_STUB_LOG"
case "$1 $2" in
  "--version "*) echo aws-cli/2.15.0 ;;
  "configure list-profiles") echo default; [ "$STUB_PROFILE_MISSING" = 1 ] || echo infinicus-backup-writer ;;
  "configure get") echo eu-central-1 ;;
  "sts get-caller-identity")
    if [ "$STUB_STS" = fail ]; then echo "InvalidClientTokenId for $AWS_SECRET_ACCESS_KEY" >&2; exit 254; fi
    if [ "$STUB_STS" = root ]; then echo arn:aws:iam::123456789012:root; else echo arn:aws:iam::123456789012:user/infinicus-backup-writer; fi ;;
  "s3api head-bucket")
    case "$STUB_HEAD" in
      deny) echo "An error occurred (403) when calling the HeadBucket operation: Forbidden" >&2; exit 254 ;;
      missing) echo "An error occurred (404) when calling the HeadBucket operation: Not Found" >&2; exit 254 ;;
      down) echo "Could not connect to the endpoint URL" >&2; exit 255 ;;
    esac ;;
  *) echo "stub aws: unexpected call: $*" >&2; exit 99 ;;
esac`);
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

  describe('--check: version compatibility, public-key-only keyring, AWS sink (stub client; nothing is dumped, uploaded or written)', () => {
    const noWrites = (r: { stdout: string }) => {
      expect(objects()).toEqual([]);
      expect(existsSync(join(stateDir, 'last-success.json'))).toBe(false);
      expect(readdirSync(join(work, 'tmp'))).toEqual([]);
      expect(r.stdout).not.toContain('BACKUP COMPLETE');
    };
    const pgDumpStub = (ver: string) => stub('pg-dump-version', `echo "pg_dump (PostgreSQL) ${ver}"`);

    it('reports each tool and the server as compatible when pg_dump, pg_restore and the server share the expected major version', () => {
      const r = sh('bash', [BACKUP, '--check'], backupEnv());
      expect(r.status, r.stdout + r.stderr).toBe(0);
      for (const l of [`pg_dump major version ${serverMajor}`, `pg_restore major version ${serverMajor}`, `server major version ${serverMajor}`, 'database session is read-only', 'no secret key in this gpg keyring', 'custom sink command'])
        expect(r.stdout, l).toContain(l);
      noWrites(r);
    });

    it('a missing pg_dump fails --check; a missing pg_restore fails --check', () => {
      const a = sh('bash', [BACKUP, '--check'], backupEnv({ BACKUP_PG_DUMP_VERSION_CMD: 'no-such-pg-dump-xyz --version' }));
      expect(a.status).toBe(2);
      expect(a.stdout).toContain('check FAIL: pg_dump is missing');
      const b = sh('bash', [BACKUP, '--check'], backupEnv({ BACKUP_PG_RESTORE_VERSION_CMD: 'no-such-pg-restore-xyz --version' }));
      expect(b.status).toBe(2);
      expect(b.stdout).toContain('check FAIL: pg_restore is missing');
      noWrites(b);
    });

    it('a pg_dump or pg_restore of the wrong major version fails --check; so does a server of the wrong major version', () => {
      const wrong = serverMajor === 15 ? '14.9' : '15.4';
      const a = sh('bash', [BACKUP, '--check'], backupEnv({ BACKUP_PG_DUMP_VERSION_CMD: pgDumpStub(wrong) }));
      expect(a.status).toBe(2);
      expect(a.stdout).toContain(`check FAIL: pg_dump is major version ${wrong.split('.')[0]}, expected ${serverMajor}`);
      const b = sh('bash', [BACKUP, '--check'], backupEnv({ BACKUP_PG_RESTORE_VERSION_CMD: stub('pg-restore-version', `echo "pg_restore (PostgreSQL) ${wrong}"`) }));
      expect(b.status).toBe(2);
      expect(b.stdout).toContain('check FAIL: pg_restore is major version');
      const c = sh('bash', [BACKUP, '--check'], backupEnv({ BACKUP_EXPECT_PG_MAJOR: String(serverMajor + 1) }));
      expect(c.status).toBe(2);
      expect(c.stdout).toContain(`check FAIL: server is major version ${serverMajor}, expected ${serverMajor + 1}`);
      noWrites(c);
    });

    it('the PRIVATE key matching the recipient in the production keyring fails --check, and so does any other secret key', () => {
      const a = sh('bash', [BACKUP, '--check'], backupEnv({ BACKUP_GNUPGHOME: restoreHome }));
      expect(a.status).toBe(2);
      expect(a.stdout).toContain('the PRIVATE key matching the backup recipient is present');
      // a keyring that has the public key AND a different secret key
      const mixed = join(work, 'gpg-mixed'); mkdirSync(mixed, { mode: 0o700 });
      expect(sh('gpg', ['--batch', '--quiet', '--homedir', mixed, '--import', join(work, 'pub.gpg')]).status).toBe(0);
      writeFileSync(join(work, 'other.batch'), `%no-protection\nKey-Type: eddsa\nKey-Curve: ed25519\nName-Real: unrelated\nName-Email: other-${suffix}@example.test\nExpire-Date: 0\n%commit\n`);
      expect(sh('gpg', ['--batch', '--quiet', '--homedir', mixed, '--gen-key', join(work, 'other.batch')]).status).toBe(0);
      const b = sh('bash', [BACKUP, '--check'], backupEnv({ BACKUP_GNUPGHOME: mixed }));
      expect(b.status).toBe(2);
      expect(b.stdout).toMatch(/check FAIL: \d+ secret key record\(s\) present/);
      noWrites(b);
      // the real run is blocked as well (fail closed): nothing is dumped or uploaded
      const c = sh('bash', [BACKUP], backupEnv({ BACKUP_GNUPGHOME: restoreHome }));
      expect(c.status).toBe(2);
      noWrites(c);
    });

    it('an AWS sink passes with a valid profile and region, validates the identity without writing, and treats a denied bucket HEAD as EXPECTED for an upload-only policy', () => {
      writeFileSync(awsLog, '');
      const r = sh('bash', [BACKUP, '--check'], awsEnv({ STUB_HEAD: 'deny' }));
      expect(r.status, r.stdout + r.stderr).toBe(0);
      for (const l of ['aws sink is structurally valid', "aws profile 'infinicus-backup-writer' exists", 'aws region eu-central-1', 'principal infinicus-backup-writer', 'EXPECTED for an upload-only policy', 'fetch command targets the same bucket'])
        expect(r.stdout, l).toContain(l);
      const calls = readFileSync(awsLog, 'utf8');
      expect(calls).toMatch(/sts get-caller-identity/);
      expect(calls).toMatch(/s3api head-bucket/);
      expect(calls).not.toMatch(/s3 cp|s3 rm|s3 mv|s3 sync|put-object|delete|s3api put/);
      noWrites(r);
      const open = sh('bash', [BACKUP, '--check'], awsEnv({ STUB_HEAD: '' }));
      expect(open.status).toBe(0);
      expect(open.stdout).toContain('bucket infinicus-bk-test is reachable');
    });

    it('a missing AWS client, a missing profile, a failing identity call, the root user, a missing bucket and a malformed sink each fail --check', () => {
      const awsSinkEnv = awsEnv();
      const noAws = sh('bash', [BACKUP, '--check'], { ...awsSinkEnv, PATH: pathWithout('aws') });
      expect(noAws.status).toBe(2);
      expect(noAws.stdout).toContain('check FAIL: sink command present');
      const noProfile = sh('bash', [BACKUP, '--check'], awsEnv({ STUB_PROFILE_MISSING: '1' }));
      expect(noProfile.status).toBe(2);
      expect(noProfile.stdout).toContain("aws profile 'infinicus-backup-writer' does not exist");
      const sts = sh('bash', [BACKUP, '--check'], awsEnv({ STUB_STS: 'fail' }));
      expect(sts.status).toBe(2);
      expect(sts.stdout).toContain('aws sts get-caller-identity failed');
      const root = sh('bash', [BACKUP, '--check'], awsEnv({ STUB_STS: 'root' }));
      expect(root.status).toBe(2);
      expect(root.stdout).toContain('AWS ROOT user');
      const missing = sh('bash', [BACKUP, '--check'], awsEnv({ STUB_HEAD: 'missing' }));
      expect(missing.status).toBe(2);
      expect(missing.stdout).toContain('does not exist');
      const down = sh('bash', [BACKUP, '--check'], awsEnv({ STUB_HEAD: 'down' }));
      expect(down.status).toBe(2);
      expect(down.stdout).toContain('could not be checked');
      for (const bad of ['aws s3 cp - s3://Bad_Bucket/%KEY% --profile infinicus-backup-writer', 'aws s3 cp - s3://infinicus-bk-test/fixed-name --profile infinicus-backup-writer %KEY%', 'aws s3 sync . s3://infinicus-bk-test/%KEY% --profile infinicus-backup-writer']) {
        const m = sh('bash', [BACKUP, '--check'], awsEnv({ BACKUP_SINK_CMD: bad }));
        expect(m.status, bad).toBe(2);
        expect(m.stdout, bad).toContain('aws sink must have the form');
      }
      noWrites(missing);
    });

    it('--check never prints a credential, a database password or key material, even when every dependency fails', () => {
      const dbPassword = `DBPASSMARKER${suffix}`;
      const r = sh('bash', [BACKUP, '--check'], awsEnv({ STUB_STS: 'fail', STUB_HEAD: 'down', BACKUP_PSQL_CMD: `psql postgresql://someone:${dbPassword}@127.0.0.1:1/none -X -At`, BACKUP_GNUPGHOME: restoreHome }));
      expect(r.status).toBe(2);
      const out = r.stdout + r.stderr;
      for (const secret of [`SECRETMARKER${suffix}`, 'AKIAFAKEFAKEFAKE', dbPassword, 'BEGIN PGP PRIVATE KEY', SECRET_MARKER]) expect(out, secret).not.toContain(secret);
      expect(out).toContain('check FAIL: database not reachable');
    });
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
    writeProfile();
    const r = sh('bash', [RESTORE, manifestKey(), '--keep'], restoreEnv());
    expect(r.stdout + r.stderr).toContain('RESTORE_PROOF=PASS');
    expect(r.stdout).toMatch(/RESTORE_TIMINGS download=[\d.]+s decrypt=[\d.]+s restore=[\d.]+s verify=[\d.]+s total=[\d.]+s \(evidence only; not an RTO\)/);
    expect(r.stdout).toMatch(/verified {3}count tenancy\.customers = 1/);
    expect(r.stdout).toMatch(/verified {3}outbox a\.done = 3/);
    expect(r.stdout).toMatch(/profile expectations\.profile sha256:[0-9a-f]{16}/);
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

  it('restore proof reports non-secret phase timings as evidence, and the backup run records its own timings (dump+encrypt streamed, upload) without printing the sink command', () => {
    const r = sh('bash', [BACKUP], backupEnv({ BACKUP_LABEL: 'timing' }));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/TIMING dump_and_encrypt_database=[\d.]+s dump_and_encrypt_roles=[\d.]+s/);
    expect(r.stdout).toMatch(/TIMING upload db\.dump\.gpg=[\d.]+s/);
    expect(r.stdout + r.stderr).not.toContain(`'${sink}`); // the sink command (which may embed a bucket or remote) is never logged
    const m = JSON.parse(readFileSync(join(sink, manifestKey()), 'utf8'));
    expect(Object.keys(m.timings_seconds).sort()).toEqual(['dump_and_encrypt_database', 'dump_and_encrypt_roles', 'upload_objects']);
    for (const v of Object.values(m.timings_seconds)) expect(typeof v).toBe('number');
    writeProfile();
    const p = sh('bash', [RESTORE, manifestKey()], restoreEnv());
    expect(p.stdout).toContain('RESTORE_PROOF=PASS');
    const out = p.stdout + p.stderr;
    expect(out).toMatch(/RESTORE_TIMINGS download=/);
    expect(out).not.toContain(restoreHome); // no key-ring path, no key material
    expect(out).not.toContain('PRIVATE KEY');
    expect(out).not.toContain(SECRET_MARKER);
    // a FAILED proof still reports the phases it completed, and still ends with the FAIL line
    const f = sh('bash', [RESTORE, manifestKey()], restoreEnv({ RESTORE_EXPECTATIONS: writeProfile((l) => l.map((x) => x.replace('count tenancy.customers=1', 'count tenancy.customers=2'))) }));
    expect(f.stdout).toMatch(/RESTORE_TIMINGS download=[\d.]+s decrypt=[\d.]+s restore=[\d.]+s verify=[\d.]+s/);
    expect(f.stdout.trim().split('\n').pop()).toMatch(/^RESTORE_PROOF=FAIL/);
    writeProfile();
  });

  describe('restore proof FAILS on any difference from the expectations profile (row counts, outbox classification, zero-count tables, ledger, fingerprint)', () => {
    const proof = (edit: (lines: string[]) => string[]) => sh('bash', [RESTORE, manifestKey()], restoreEnv({ RESTORE_EXPECTATIONS: writeProfile(edit) }));
    const swap = (from: string, to: string) => (lines: string[]) => lines.map((l) => (l === from ? to : l));
    const expectFail = async (r: ReturnType<typeof proof>, reason: RegExp) => {
      expect(r.stdout).toMatch(reason);
      expect(r.stdout).toContain('RESTORE_PROOF=FAIL');
      expect(r.stdout).not.toContain('RESTORE_PROOF=PASS');
      expect(r.status).not.toBe(0);
      expect((await pool.query(`select 1 from pg_database where datname = 'bk_restore_${suffix}'`)).rowCount).toBe(0); // scratch dropped
    };

    it('a restored row count that differs fails (and PASSES again with the true value)', async () => {
      await expectFail(proof(swap('count tenancy.customers=1', 'count tenancy.customers=2')), /count tenancy\.customers restored 1, expected 2/);
      expect(proof((l) => l).stdout).toContain('RESTORE_PROOF=PASS');
    });
    it('an outbox total that differs fails', async () => {
      await expectFail(proof(swap('count events.outbox_events=5', 'count events.outbox_events=6')), /count events\.outbox_events restored 5, expected 6/);
    });
    it('a different split of the outbox event types fails, and so does an outbox row of a type the profile does not list', async () => {
      await expectFail(proof(swap('outbox a.done=3', 'outbox a.done=4')), /outbox a\.done restored 3, expected 4/);
      await expectFail(proof(swap('outbox b.changed=2', 'outbox b.changed=3')), /outbox b\.changed restored 2, expected 3/);
      await expectFail(proof((l) => l.filter((x) => x !== 'outbox b.changed=2')), /outbox rows of unlisted event types: 2, expected 0/);
    });
    it('a table that must be empty but holds rows fails', async () => {
      await expectFail(proof(swap('count audit.audit_events=0', 'count tenancy.customers=0')), /count tenancy\.customers restored 1, expected 0/);
    });
    it('a table that the profile names but the backup does not contain fails (it cannot be counted)', async () => {
      await expectFail(proof((l) => [...l, 'count business_operations.inventory_movements=0']), /cannot count business_operations\.inventory_movements/);
    });
    it('a ledger or schema fingerprint that differs from the profile (even though it equals the manifest) fails', async () => {
      await expectFail(proof(swap('ledger_count=2', 'ledger_count=170')), /ledger restored 2\/0170_add_approved_action_source_recommendation\.sql, expected 170\//);
      await expectFail(proof((l) => l.map((x) => (x.startsWith('schema_fingerprint=') ? 'schema_fingerprint=0000000000000000' : x))), /schema fingerprint restored [0-9a-f]{16}, expected 0000000000000000/);
    });
    it('the default PRODUCTION profile is enforced when none is supplied: the synthetic database cannot pass it', async () => {
      const r = sh('bash', [RESTORE, manifestKey()], restoreEnv({ RESTORE_EXPECTATIONS: '' }));
      await expectFail(r, /restored data differs from the expectations profile/);
    });
    it('a malformed or incomplete profile is a configuration error (exit 2), never a weaker proof; the restore never runs', async () => {
      const bad = join(work, 'bad.profile');
      writeFileSync(bad, 'ledger_count=2\nledger_head=x.sql\ncount tenancy.customers = one\n');
      const a = sh('bash', [RESTORE, manifestKey()], restoreEnv({ RESTORE_EXPECTATIONS: bad }));
      expect(a.stdout).toContain('invalid line in the expectations profile');
      expect(a.status).toBe(2);
      writeFileSync(bad, 'count tenancy.customers=1\n');
      const b = sh('bash', [RESTORE, manifestKey()], restoreEnv({ RESTORE_EXPECTATIONS: bad }));
      expect(b.stdout).toContain('must define ledger_count and ledger_head');
      expect(b.status).toBe(2);
      const c = sh('bash', [RESTORE, manifestKey()], restoreEnv({ RESTORE_EXPECTATIONS: join(work, 'absent.profile') }));
      expect(c.status).toBe(2);
      expect((await pool.query(`select 1 from pg_database where datname = 'bk_restore_${suffix}'`)).rowCount).toBe(0);
    });
    it('the outbox is only counted: the SOURCE database rows are untouched by the whole proof', async () => {
      const s2 = new Pool({ connectionString: srcUrl });
      const before = (await s2.query(`select status, count(*)::int n from events.outbox_events group by 1`)).rows;
      expect(proof((l) => l).stdout).toContain('RESTORE_PROOF=PASS');
      expect((await s2.query(`select status, count(*)::int n from events.outbox_events group by 1`)).rows).toEqual(before);
      await s2.end();
    });
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
