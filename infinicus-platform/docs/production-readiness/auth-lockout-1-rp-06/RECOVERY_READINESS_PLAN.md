# AUTH-LOCKOUT-1 — Recovery Readiness and Restore-Proof Plan (gate G-4)

Status: PLAN ONLY. No backup was created, no production data was downloaded and no restore was run in producing this document. Every step below needs the
explicit owner authorizations listed in §5.
Labels: VR = VERIFIED — REPOSITORY, OO = OWNER-OBSERVED — PRODUCTION (operator output, not independently verified), UV = UNVERIFIED, INF = INFERRED.

## 1. Current recovery posture

| Item | State | Class |
|---|---|---|
| Latest backup | daily, finished 2026-10-28T02:38:37Z, `verified:true`, ledger head `0209_create_print_jobs.sql`, schema fingerprint `325158ea2a54cde9`; manifest key `infinicus-production/2026-10-28/20261028T023834Z-daily/manifest.json` | OO |
| Method | `backup-offsite.sh` via `infinicus-backup.timer` (daily ≈ 02:34Z), encrypted with a public key held on the VM, uploaded to an S3-compatible offsite store; both artifacts re-downloaded and verified; the job's own log says a restore proof is still required to call the backup recoverable | OO / VR |
| Freshness | `check-backup-freshness.sh` OK, 11 h at observation (warning at 26 h, critical at 50 h) | OO |
| Point-in-time recovery | none: `archive_mode=off`, `wal_level=replica`, archiver counters 0 | OO |
| Restore proof history | VR (`docs/architecture/reconciliation/PHASE_W2_EXECUTION_RECORD_0202-0209.md`): 2026-10-21 ~15:08Z `RESTORE_PROOF=PASS` for the pre-window backup (ledger 201); in the evening a restore of `…T172939Z-daily` (ledger 209) with **only the rotated key** decrypted and restored, ledger `209 / 0209`, all 15 row-count rules held (checked by hand because the script then reported a false FAIL at the fingerprint step: restored copy `68407667a5618dc9` vs manifest `325158ea2a54cde9`; since addressed by the `restored_fingerprint` rule in `production-pre-0210.profile`). No proof of any later backup, and no proof run with the profile fix, is on record. |
| Backup key | VR (same record): rotated 2026-10-21 to key `F848EE01CFD25D1A88DB17DDD79DF16FA80298FE` (offline copies held by the owner); the old key still sits in the VM keyring and offline for older backups. Custody is an owner matter; this plan does not touch it. |
| Production host capacity | 1 vCPU, 1.9 GB RAM, no swap; an earlier restore-test container on this host was OOM-killed (`oom=true`, 2026-10-14) | OO |
| Hetzner server snapshots | not visible from the VM; unknown | UV |
| Production database size | about 58 MB (dump ≈ 4.7 MB encrypted at the last run) | OO |

## 2. What "recoverable" means here (no invented targets)

- **Recovery point (RPO):** the finish time of the newest verified backup. Without WAL archiving there is no point between backups. With the daily timer the exposure is up
  to about 24 h of writes; an on-demand backup immediately before the release window reduces it to the window length. No target value is set by this plan.
- **Recovery time (RTO):** unknown. `restore-proof.sh` prints `RESTORE_TIMINGS` as evidence only; it is not an RTO commitment.
- **Recoverable** requires all of: the object checksums match the manifest; the archive decrypts with a key that is **not** on the production VM; it restores into an
  empty scratch database; ledger count/head and schema fingerprint match both the manifest and a reviewed expectations profile; profile row counts match the restored
  data; and the application image can start against the restored database (§4).

## 3. Disposable infrastructure (separate from production)

Method used successfully before (VR, W2 record §5): the three encrypted objects were fetched on the VM with the installed backup settings, copied to the owner's PC, and
`restore-proof.sh` ran inside a throwaway `postgres:16-bookworm` container (loopback only, `infinicus.restore_target=disposable`, no production route), with the offline
key mounted read-only and the passphrase typed at the container prompt. Observed pitfall: Docker Desktop could not see a removable drive, so a single-file mount silently
became an empty directory. Leftovers noted in that record for the owner to remove: temporary copies of the encrypted objects on the VM and on the PC.

Required properties of the restore host (all checked by `restore-proof.sh --validate-target` where the script can check them):
- not the production VM, and with no route, credentials or secrets for production (the owner's PC with Docker satisfied this in the previous proof);
- encrypted disk; PostgreSQL 16 started on loopback only with `-c infinicus.restore_target=disposable` (the script refuses any other target); a superuser connection through a
  `PGPASSFILE` (mode 600) or socket, no password in a URL; no database named `infinicus`;
- the **private** gpg key available only on this host (never on the production VM), and either a **read-only** credential for the backup store or the previous method of fetching the encrypted objects on the VM and copying them over (which keeps the store credential on the VM);
- enough memory for `pg_restore` of the dump plus the application test (the production VM's 1.9 GB was not enough for the earlier test container; size is an owner/infrastructure decision, not set here);
- the repository checkout at the commit under test, so that the script, expectations profile and discovery script are the reviewed versions.

## 4. Procedure (not executed)

1. **Validate the target only** (reads nothing from the backup store):
   `RESTORE_ADMIN_URL=postgresql://postgres@127.0.0.1:55432/postgres restore-proof.sh --validate-target` → must print the target-accepted line, otherwise stop.
2. **Choose the backup** with the owner: the on-demand backup taken in the release window (best), or the newest daily. Record the manifest key.
3. **Choose the expectations profile.** For a backup at ledger head 0209 use `production-pre-0210.profile` (ledger count 209, fingerprint `325158ea2a54cde9`,
   restored-copy fingerprint `68407667a5618dc9` accepted only while the manifest fingerprint equals `schema_fingerprint`; count rules such as tenants 16, users 6, businesses
   16, outbox 59 were equal to the 2026-10-28 production discovery output, OO). A backup taken **after** the 0220 step needs a new, reviewed profile (ledger count 210, head
   `0220…`, fingerprint observed on production after the step); never loosen a rule to make a run pass (rule stated in the profile header).
4. **Run the proof** on the restore host (outline; the exact environment variables are in the script header):
   `BACKUP_FETCH_CMD='rclone cat <remote>:<bucket>/%KEY%' RESTORE_GNUPGHOME=<private-key home> RESTORE_ADMIN_URL=… RESTORE_EXPECTATIONS=<profile> restore-proof.sh <manifest-key>`
   Do not use `--keep`. Expect the final line `RESTORE_PROOF=PASS`; any other result is FAIL.
5. **Application restoration check** (disposable host only, synthetic traffic only): start the API image under test (the RC image or the `ccadbf51` image) against the
   restored scratch database as a freshly created `app_role` with a locally generated password, `NODE_ENV=test`, dummy values for third-party settings, **no** mail or webhook
   credentials (outbound email must stay disabled; the API logs "would have sent" without a key). Confirm `/v1/ready` 200, `/v1/health` reports the expected build SHA,
   and `smoke-test.sh` passes. No customer account is used; no request is sent to a real third-party service.
6. **Record** the evidence in §6 and dispose of everything in §7.

## 5. Authorizations the owner must give explicitly (none exist yet)

| # | Authorization |
|---|---|
| 1 | Access to the backup store with a read-only credential, for a named person/machine and period |
| 2 | Custody and use of the private decryption key on the restore host |
| 3 | The restore host (who builds it, where, how it is isolated and later destroyed) |
| 4 | Which backup is restored (daily or on-demand) and the expectations profile |
| 5 | Handling of the restored data as production personal data (16 tenants, 6 users at last observation) |
| 6 | An on-demand production backup (a write to the backup store) inside the release window |

## 6. Success and failure criteria

PASS only if: `RESTORE_PROOF=PASS`; PostgreSQL major 16 on both sides; ledger count/head and fingerprint equal the manifest and the reviewed profile; the application checks
of step 5 pass; no secret, key or customer value appeared in any retained output. FAIL on any other result, on any doubt about target isolation, or if a step had to be skipped.
A FAIL keeps the release at NO-GO and opens an investigation of the backup pipeline; it is never overridden by editing the profile.

## 7. Evidence retention and disposal

Retain (non-secret): the script output with `RESTORE_TIMINGS` and the final line, manifest key, profile name and SHA-256, host build record, timestamps, who ran it.
Do not retain: decrypted dumps, `roles.sql`, scratch databases, fetch credentials, private-key copies. Disposal: remove the PostgreSQL container with its volume (`docker rm -f -v`),
confirm the script's private temporary directory is gone, delete any copy of the key and the store credential, and record the disposal time. The retention period for the
evidence is an owner decision (not set here).

## 8. If the owner decides not to run a fresh restore proof before the release

This is an explicit risk acceptance, to be recorded in writing, not a default. Facts to weigh (all stated in this repository's evidence): the change being released is one
policy statement and an API image swap, rehearsed for apply, idempotence and exact rollback on a disposable database; the previous application image is retained for
re-promotion (once pinned); a verified encrypted backup exists and an on-demand one can be taken before the window; the last restore proof (2026-10-21) was at the same
schema head with the same tooling. Not covered by those facts: any event unrelated to this release that needs a restore, and the lack of point-in-time recovery.

## 9. Open items

- Newest Hetzner snapshot date (console only).
- Whether WAL archiving/PITR should be enabled (a separate infrastructure decision; the repository has `enable-wal-archiving.sh` and `pitr-*` scripts, not evaluated here).
- Restore-host sizing and location.
- The retention period for restore evidence.
