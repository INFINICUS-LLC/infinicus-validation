# infrastructure/backups - off-VM encrypted backups

Status: **tooling delivered, not installed or run anywhere.** Nothing in this directory touches production until the owner authorises an installation and a first run. Plan, threat model, retention, restore drills and the first-run procedure: `docs/architecture/reconciliation/OFFSITE_BACKUP_PLAN.md`.

| File | Purpose |
|---|---|
| `backup-offsite.sh` | `--check` (write-free) also verifies pg_dump/pg_restore/server major version, a read-only session, that the keyring holds the public key only, and the AWS/rclone sink (structure, profile, `sts get-caller-identity`, expected-denied bucket HEAD). Read-only dump of the database (with owners and privileges) and of the cluster roles; gpg-encrypts to a public key before anything leaves the VM; uploads through a configurable S3-compatible sink; writes `manifest.json` last; `--check` writes nothing; `--verify` re-fetches and re-checks SHA-256. Never deletes anything. |
| `restore-proof.sh` | Fetch, verify SHA-256, decrypt (private key on a separate machine), restore roles and database into a **scratch** database on a **throwaway** server, compare the ledger and the schema fingerprint with the manifest and with `expectations/production-pre-0171.profile` (critical row counts, outbox total and event-type split, tables that must be empty; read-only counts), and print non-secret phase timings. Prints `RESTORE_PROOF=PASS` or `FAIL`. |
| `check-backup-freshness.sh` | Exit 0/1/2 by the age of the last successful backup (for cron or an uptime monitor). |
| `expectations/production-pre-0171.profile` | Owner-supplied expected state of production at ledger head 0170 that a restore must reproduce for `RESTORE_PROOF=PASS`. |
| `systemd/` | Service, timer and failure-alert **templates**. |
| `backup.env.example` | Configuration template (no secrets). |

Tested (`packages/database/tests/offsite-backup.integration.test.ts`, real PostgreSQL 16, real gpg, a file sink standing in for the S3 client) including failure paths; architecture-guarded by `packages/event-worker/tests/offsiteBackup.architecture.test.ts`. **Not tested against a real S3-compatible service** (none is reachable from the build environment): the first real run uses `--check`, then a `--verify` backup, then a restore proof on a separate machine.

The older `database/scripts/backup.sh`/`restore.sh` (BUILD-22) remain for local use; they drop owners and privileges (`--no-owner --no-privileges`) and write plaintext to local disk, so they are not the production recovery path. The PITR scripts there assume a Debian host cluster and do not apply to the Docker PostgreSQL.
