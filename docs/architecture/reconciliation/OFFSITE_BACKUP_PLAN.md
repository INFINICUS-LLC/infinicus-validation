# Off-VM encrypted backup plan (production PostgreSQL, Hetzner VM infinicus-prod-01)

Status: **plan and tooling delivered; nothing installed, configured or run on any server, bucket or key.** Production writes remain unauthorised by this document. Everything below that writes to the VM, a bucket or a key is marked **[SETUP]** or **[RUN]** and needs the owner's explicit go-ahead.

## 1. Owner rulings applied
- Primary logical production backup **off the VM**, preferably **S3-compatible object storage**. A local-only dump is not sufficient production recovery.
- Hetzner server backups / snapshots are the **second, infrastructure-level layer** (provider-side; recorded, not replaced).
- Container-compatible PITR is **deferred** until real runtime and backup facts exist. This plan does not claim PITR: **recovery point = the last backup**, not an arbitrary moment.
- The running directory is `infinicus-platform/infrastructure/deployment/oci` (legacy name); the host is Hetzner. Nothing here renames it.

## 2. Design
```
Hetzner VM infinicus-prod-01
  docker compose exec postgres:  pg_dump -Fc (owners + privileges kept)   pg_dumpall --roles-only      <- read-only against the database
        |                                    |
        +---- gpg --encrypt --recipient <PUBLIC key> ----+      (the private key is never on the VM)
                         |  (encrypted temp files, 0700 dir, removed on exit)
                         v
        sink command (e.g. rclone rcat) ---> S3-compatible bucket:
              <prefix>/<UTC date>/<UTC stamp>-<label>/db.dump.gpg
              <prefix>/<UTC date>/<UTC stamp>-<label>/roles.sql.gpg
              <prefix>/<UTC date>/<UTC stamp>-<label>/manifest.json     <- written LAST: no manifest, no backup
Recovery / drill machine (private key, throwaway PostgreSQL 16): restore-proof.sh
        fetch -> SHA-256 vs manifest -> decrypt -> restore roles, then database -> compare ledger + schema fingerprint with the manifest -> PASS/FAIL
```
- **Why asymmetric gpg:** the VM can write backups but cannot read old ones; a compromised VM does not expose history. gpg is already on the VM (cloud-init installs it).
- **Why roles are backed up too:** a database dump does not contain cluster roles. Without `roles.sql`, owners and grants cannot be restored on a fresh server. The roles file contains password hashes - it is encrypted like the dump and the plain file never touches disk on the VM.
- **Why not the old `database/scripts/backup.sh`:** it uses `--no-owner --no-privileges` (a restore would lose the security model that migrations 0195/0196 depend on), writes plaintext locally, and has no off-host path. The old PITR scripts assume a Debian host cluster.
- **Manifest** (`manifest.json`, not encrypted, contains no secrets): format, UTC time, label, host, database, server version, migration-ledger count and head, **schema fingerprint** (the same algorithm as the production discovery script), recipient key fingerprint, and per object name / bytes / SHA-256. Anyone who can read the bucket can read the manifest (it reveals the database name and migration head, nothing else).
- **Consistency:** `pg_dump` takes one transactional snapshot, so the dump is internally consistent without stopping the application; for pre-migration backups the runbook additionally stops the API so the backup equals the migration baseline.
- **Disk:** only the encrypted dump touches the VM's disk (`/tmp` of the service, removed on exit). `--check` requires free space greater than twice the database size.
- **The script never deletes** (remote or local beyond its own temp dir) and never writes to the database; all SQL is `SELECT`/`SHOW` in a read-only session.

## 3. Owner decisions required (with recommendations)
| # | Decision | Recommendation |
|---|---|---|
| D1 | Which S3-compatible provider and account | A bucket in an account **separate from the Hetzner Cloud project** (ideally another provider): the VM, its Hetzner backups and a same-account bucket then do not share one account-level failure or compromise. Hetzner's own object storage is acceptable if you accept that correlation. Choose a region with an acceptable data-residency position (the database holds personal data; the legal page still lists Hetzner's region as unverified). I have not verified any provider's features or prices. |
| D2 | Bucket protections | Versioning **and** object lock (retention) enabled, so even a leaked credential cannot destroy history; lifecycle rules for retention (section 6). If the provider lacks object lock, treat the bucket as weaker and add a periodic copy to a second bucket. |
| D3 | Credentials | VM credential: **write-only** (no delete, no list/read) if the provider can express it. Verification and drills use a **separate read credential held off the VM**. Consequence: `--verify` on the VM needs read permission; if the VM credential is write-only, run verification (and the restore proof) from the drill machine right after the backup instead. |
| D4 | gpg key custody | Generate the key pair on an owner workstation, **not on the VM**; give the VM only the public key. Store the private key in two places (password manager + offline/hardware backup) with at least two people who can retrieve it. **Losing the private key makes every backup unrecoverable.** Rotate by adding a new recipient and keeping the old private key for the retention period. |
| D5 | Schedule | Daily at 02:30 UTC (template timer, randomised by 10 minutes) -> recovery point up to ~24 h; add a pre-migration backup before every migration window. More frequent backups are possible; true point-in-time needs the deferred PITR work. |
| D6 | Failure alert channel | The failed-unit hook is a stub (`logger`); the owner picks the real channel (email, chat webhook, uptime monitor). Required before activation (monitoring minimum). |
| D7 | Drill machine | A workstation or small throwaway VM with PostgreSQL 16, gpg and the S3 client, holding the private key only while drilling. Never the production VM. |

## 4. One-time setup **[SETUP]** (after D1-D7)
1. On the owner workstation: `gpg --quick-generate-key "INFINICUS backup <backup@...>" rsa4096 encr 0`, export the public key (`gpg --export --armor`), store the private key per D4. Record the fingerprint.
2. Create the bucket with versioning, object lock and lifecycle rules; create the write-only credential (VM) and read credential (drill machine).
3. On the VM: install the S3 client (rclone is the assumed default; pin the version and verify its checksum from the vendor's release page - this is the only new software); configure a remote named `offsite` in the `deploy` user's own config (mode 0600); `gpg --import` the **public** key only; install `/etc/infinicus/backup.env` from `infrastructure/backups/backup.env.example` (root-owned, readable by `deploy`).
4. Install the three systemd templates from `infrastructure/backups/systemd/` but **do not enable the timer yet**; run `systemd-analyze verify` on the VM (these units could not be exercised in the build environment).

## 5. First run and proof **[RUN]** (before the timer is enabled and before any migration)
1. `backup-offsite.sh --check` on the VM -> `CHECK PASSED` (writes nothing).
2. `BACKUP_LABEL=first-proof backup-offsite.sh --verify` (from the running compose directory) -> `BACKUP COMPLETE`. If the VM credential cannot read, omit `--verify` here and verify on the drill machine.
3. On the drill machine: `restore-proof.sh <manifest-key>` against a throwaway PostgreSQL 16 -> `RESTORE_PROOF=PASS`. Keep the output as evidence. The first PASS also yields the real size and duration of backup and restore (unknown today).
4. Only then enable `infinicus-backup.timer`, and confirm the next day's run and `check-backup-freshness.sh` (exit 0) the following morning.

## 6. Retention (bucket lifecycle rules, not script deletes)
| Prefix | Content | Keep |
|---|---|---|
| `infinicus-prod/` | daily | 35 days |
| `infinicus-prod-monthly/` | first-of-month backup (second timer with `BACKUP_PREFIX=infinicus-prod-monthly`) | 13 months |
| `infinicus-prod-premigration/` | one per migration window (`BACKUP_LABEL=pre-migration-NNNN`) | 12 months, and never before the migration has been in production for 30 days |
Object lock retention must be at least as long as the shortest lifecycle expiry so a leaked credential cannot shorten it.

## 7. Restore drills and disaster recovery
- **Drill:** monthly, after every migration window, and after any change to the tooling, the key or the bucket: `restore-proof.sh` on the latest manifest; record date, key, PASS/FAIL, duration.
- **Disaster recovery outline (new server):** provision a VM per the Hetzner runbook; start only `postgres` from the compose project; on the recovery machine fetch and verify the objects, decrypt with the private key; `psql -f roles.sql` (errors for roles that already exist are expected); `createdb`; `pg_restore --exit-on-error` the dump (owners and privileges come with it); run `production-readonly-discovery.sh` and require `fingerprint-verdict` to match the manifest head; run `grant-app-role.sh` (idempotent) as a safety net; restore `.env` from the owner's secret store; start `api` and `caddy`; point the `api` A record if the IP changed. Recovery time is **unmeasured** until the first drill.
- **Not covered by this backup:** the `.env` / secrets (keep an encrypted escrow copy in the owner's secret manager), Caddy certificates (re-issued automatically), the repository (GitHub), and anything outside PostgreSQL (the platform keeps no application data on local files).

## 8. Threat model
| Threat | Mitigation | Residual |
|---|---|---|
| VM compromised | public key only on the VM; write-only credential; object lock/versioning keep history; temp files are encrypted | attacker can write junk or fill the bucket; can read the SQL sink config; alerts on freshness/size |
| Bucket credential leaked | write-only; lock prevents delete/overwrite of history | provider-dependent feature support (D2/D3) |
| Backup tampered or corrupted | SHA-256 per object in the manifest, checked by `--verify` and the restore proof; `pg_restore` validates the archive; fingerprint compare detects altered schema | the manifest itself is not signed: with write access to the bucket an attacker could replace a backup+manifest consistently (object lock/versioning is the control; a detached signature by a separate signing key is a possible later hardening) |
| Private key lost or exposed | two custodians; offline copy; rotation procedure | loss = no recovery; exposure = historic backups readable |
| Restore pointed at production | restore-proof takes only an explicit throwaway server URL, refuses the production database name and an existing scratch database | operator error with a production URL as the "throwaway" - drill machine is separate by procedure |
| Backup silently stops | `ExecStartPre --check`, `OnFailure` alert, `check-backup-freshness.sh` (warn 26 h, critical 50 h) | alert channel not chosen yet (D6) |
| Personal data in backups | encrypted at rest/in transit, restricted access, retention bounded | deletion requests: backups age out per section 6; document this in the privacy notice |

## 9. What was verified (and what was not)
- **Tested, real components** (`packages/database/tests/offsite-backup.integration.test.ts`, 11 tests, PostgreSQL 16.15, real gpg, a file sink standing in for the S3 client): `--check` writes nothing; refusal without encryption / bad label / missing key / missing sink; encrypted objects + manifest with correct SHA-256, ledger, fingerprint and verified upload; stored objects contain no plaintext data, no dump header and no role names, and the public-key-only keyring cannot decrypt them; the restore proof PASSES with owner and data preserved and drops its scratch database; it FAILS on a tampered object, the wrong private key, a missing manifest, a production-named or existing target, and a fingerprint or ledger mismatch; a failing sink or dump fails the backup without a manifest or success record; freshness thresholds.
- **Mutation-tested:** removing the SHA check, the fingerprint compare, the ledger compare, encryption of the dump or the roles, the sink-failure handling, and the production-name and existing-database guards each made a test fail (two further mutants - making the recipient optional - are equivalent, because a second guard catches them).
- **Architecture guard** (`packages/event-worker/tests/offsiteBackup.architecture.test.ts`, 8 tests): encryption mandatory and before upload, manifest uploaded last, owners/privileges kept, roles included, no delete/purge, read-only SQL, no secret printing or tracing, restore proof cannot use production variables, systemd hardening; 7 further unsafe edits (remote delete, `set -x`, printing the sink command, plaintext dump, `--no-owner`, production URL in the restore script, weakened systemd) were caught.
- **Not verified:** any real S3-compatible service or rclone (none reachable from the build environment; the sink is a documented command contract), the Docker `exec` default paths (no Docker daemon here; they mirror the already-tested discovery script), systemd execution on the VM (`systemd-analyze verify` shows only the expected missing-path message here), real backup size/duration, and a restore on a different machine. These are exactly what steps 4.4 and 5 prove on the real system.

## 10. Not done
No key generated, no bucket or credential created, nothing installed on the VM, no unit enabled, no backup taken, no production access of any kind; the production migration remains blocked until section 5 has passed.
