# infrastructure/backups - off-VM encrypted backups

Status: **tooling delivered; installed on the production VM and run once (2026-10-13, first-proof backup, per the VM state file) — no fresh head-0198 backup and no restore proof of one exist yet.** Nothing in this directory touches production until the owner authorises a run. Plan, threat model, retention, restore drills and the first-run procedure: `docs/architecture/reconciliation/OFFSITE_BACKUP_PLAN.md`.

| File | Purpose |
|---|---|
| `backup-offsite.sh` | `--check` (write-free) also verifies pg_dump/pg_restore/server major version, a read-only session, that the keyring holds the public key only, and the AWS/rclone sink (structure, profile, `sts get-caller-identity`, expected-denied bucket HEAD). Read-only dump of the database (with owners and privileges) and of the cluster roles; gpg-encrypts to a public key before anything leaves the VM; uploads through a configurable S3-compatible sink; writes `manifest.json` last; `--check` writes nothing; `--verify` re-fetches and re-checks SHA-256. Never deletes anything. |
| `restore-proof.sh` | Fetch, verify SHA-256, decrypt (private key on a separate machine), restore roles and database into a **scratch** database on a **throwaway** server, compare the ledger and the schema fingerprint with the manifest and with `expectations/production-pre-0171.profile` (critical row counts, outbox total and event-type split, tables that must be empty; read-only counts), and print non-secret phase timings. Prints `RESTORE_PROOF=PASS` or `FAIL`. |
| `check-backup-freshness.sh` | Exit 0/1/2 by the age of the last successful backup (for cron or an uptime monitor). |
| `make-expectations-profile.sh` | Builds a restore-proof expectations profile from the owner's saved read-only evidence (`p3-owner-01-evidence.sql` output and the discovery script output). Reads files only; refuses unless the evidence is clean evidence of the expected database, read-only session, ledger head and fingerprint verdict; never overwrites; emits only lines the restore-proof grammar accepts. The result is a candidate for a reviewed commit, never typed or invented counts. |
| `expectations/production-pre-0171.profile` | Owner-supplied expected state of production at ledger head 0170 that a restore must reproduce for `RESTORE_PROOF=PASS`. |
| `systemd/` | Service, timer and failure-alert **templates**. |
| `backup.env.example` | Configuration template (no secrets). |

Tested (`packages/database/tests/offsite-backup.integration.test.ts`, real PostgreSQL 16, real gpg, a file sink standing in for the S3 client) including failure paths; architecture-guarded by `packages/event-worker/tests/offsiteBackup.architecture.test.ts`. **Not tested against a real S3-compatible service** (none is reachable from the build environment): the first real run uses `--check`, then a `--verify` backup, then a restore proof on a separate machine.

The older `database/scripts/backup.sh`/`restore.sh` (BUILD-22) remain for local use; they drop owners and privileges (`--no-owner --no-privileges`) and write plaintext to local disk, so they are not the production recovery path. The PITR scripts there assume a Debian host cluster and do not apply to the Docker PostgreSQL.

## Restore target rules (fail-closed; `restore-proof.sh`)

`restore-proof.sh` refuses, with exit 2 and before fetching or decrypting anything, any restore target that is not demonstrably disposable. Check a target without touching any backup: `RESTORE_ADMIN_URL=<url> restore-proof.sh --validate-target` prints `RESTORE_TARGET=OK` or `RESTORE_TARGET=REFUSED (<reason>)`.

- The URL has **no password** (use `PGPASSFILE` or local socket authentication), one host, and only the parameters `sslmode`, `connect_timeout`, `application_name`, `host`, `port`. The host is loopback (`localhost`, `127.x.x.x`, `::1`) or a local socket directory. `PGHOSTADDR`, `PGSERVICE` and `PGSERVICEFILE` must be unset.
- The server is **marked disposable by its builder**: started with `-c infinicus.restore_target=disposable`. It must be a superuser connection to a primary of the expected major version (`RESTORE_EXPECT_PG_MAJOR`, default 16) with no database named `infinicus`.
- `roles.sql` from the backup is validated line by line against the output `pg_dumpall --roles-only` produces and has its password hashes removed before it runs; any other statement (psql meta-commands, `COPY`, `ALTER SYSTEM`, `DO`, `CREATE EXTENSION`, ...) refuses the restore. No restored role may carry a password afterwards.
- Temporary files live in a private directory, are removed as soon as they are no longer needed and on exit, `INT`, `TERM` and `HUP`; shell tracing (`bash -x`) is refused.

Throwaway server (local Docker, loopback only):
`docker run --rm -d --name infinicus-restore-target -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=<random> postgres:16 -c infinicus.restore_target=disposable`
then keep the password in a `PGPASSFILE` (mode 600) and set `RESTORE_ADMIN_URL=postgresql://postgres@127.0.0.1:55432/postgres`. Remove the container (`docker rm -f -v`) when done. Limits: the archive itself runs as a superuser on that server, so the server must hold no secrets and have no route to production; the target must sit on an encrypted disk. Details: `docs/architecture/reconciliation/H5_RESTORE_TARGET_VALIDATION.md`.

