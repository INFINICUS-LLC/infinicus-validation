# Parked: production backup setup, migration 0171–0198, deployment

Status: **PARKED by the owner** so that the architecture builds can continue first. Nothing here is cancelled. Nothing here is authorized to run.
Owner standing rules still apply: no production access or writes, no AWS/Cloudflare/DNS/secret changes, no migration, deployment, worker start or activation without explicit authorization; Claude never merges or approves.

## Where things stand (facts as of the park date, 2026-10-13)
- Production: Hetzner `infinicus-prod-01`, compose project `oci`, PostgreSQL 16.15, ledger head `0170_add_approved_action_source_recommendation.sql` (170 migrations), canonical schema fingerprint `38eabb12fde135b5`. Repository head is 0198; 0171–0198 are pending in production. Worker not deployed; activation OFF.
- Merged and tested tooling (no production run yet): `infrastructure/backups/` (`backup-offsite.sh` with the extended `--check`, `restore-proof.sh` with the expectations profile and timings, freshness check, systemd templates — timer NOT enabled), `infrastructure/deployment/scripts/production-readonly-discovery.sh`, the migration runbook `PRODUCTION_MIGRATION_RUNBOOK_0171-0198.md`, the plan `OFFSITE_BACKUP_PLAN.md`.
- No production backup has been taken. No AWS bucket, IAM user or GPG key has been reviewed by Claude (nothing was reported).

## Closed since the park date
The Hetzner VM / production-readiness **discovery** task (VM reachable, runtime healthy, server checkout synchronized, live PostgreSQL 16.15 at migration 0170 fingerprint-confirmed, worker absent, subscriptions zero) is RESOLVED: see `VM_DISCOVERY_TASK_CLOSURE_2026-10-13.md`. It was not a numbered item below; **every numbered item below remains parked and unchanged** (including 11, the migration, and 12, identifying the deployed application SHA).

## Parked items, in dependency order
| # | Item | Owner / actor | Blocked until |
|---|---|---|---|
| 1 | AWS: separate account, bucket (Block Public Access, ACLs disabled, Versioning, Object Lock at creation, SSE-S3, TLS-only policy, no lifecycle rules), writer and recovery IAM users | Owner | Owner resumes this track |
| 2 | GPG: generate the key off production, two protected recovery copies, revocation certificate, send the 40-hex fingerprint | Owner | 1 not required; independent |
| 3 | AWS + GPG evidence review (read-only commands in the review message) | Claude reviews pasted output | 1 and 2 |
| 4 | Hetzner Cloud Console evidence: Backups enabled YES/NO, latest backup time, snapshots and times | Owner | Independent |
| 5 | VM: install AWS CLI v2 and the **public** key only (dedicated `BACKUP_GNUPGHOME`), `/etc/infinicus/backup.env` | Authorized operator | 1–4 and explicit authorization |
| 6 | Supervised `backup-offsite.sh --check`, then the first backup (`BACKUP_LABEL=first-proof`) | Operator, supervised | 5 and explicit authorization |
| 7 | Independent verification (recovery credential, separate machine) and `restore-proof.sh` against a throwaway PostgreSQL 16 → `RESTORE_PROOF=PASS` | Owner/operator | 6 |
| 8 | External alerting channel (D6) | Owner | Before production activation |
| 9 | Enable the daily 02:30 UTC timer | Owner | 6 and 7 both succeeded (D5) |
| 10 | Retention policy approval (no lifecycle deletion until then) | Owner | Independent |
| 11 | Pre-migration backup + restore proof, then controlled migration 0171–0198, grants, deployment (worker not started), post-checks | Owner-authorized operator | 7, 9 and the runbook entry criteria E1–E14 |
| 12 | `oci` compose `GIT_SHA` build-arg parity and identifying the deployed application SHA | Claude (small PR) / operator | Owner decision |

## Rule for resuming
Do not start any item above because it appears in this file. Resume only on an explicit owner instruction naming the item. The architecture reconciliation blocks take precedence until the owner says otherwise.

## Reminder mechanism
This file is the pin. No timed reminder or scheduled routine has been created, because no date was given. If the owner wants one, name the date and Claude can add it.
