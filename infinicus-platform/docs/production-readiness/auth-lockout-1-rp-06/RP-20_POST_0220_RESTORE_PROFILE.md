# AUTH-LOCKOUT-1.RP-20 — Post-0220 Restore Profile

Status: **profile added (repository only). Nothing was restored from production; G-4 is unchanged (still BLOCKED).** The profile lets `restore-proof.sh` judge a backup taken AFTER the isolated AUTH-LOCKOUT-1 release (ledger 209 + migration 0220 only).
Labels: VR = VERIFIED — REPOSITORY, RH = VERIFIED — REHEARSAL (disposable local PostgreSQL 16.15, synthetic data), OO = OWNER-OBSERVED, UV = UNVERIFIED.

## 1. File
`infrastructure/backups/expectations/production-post-0220.profile`

| Rule | Value | Basis |
|---|---|---|
| `ledger_count` | 210 | production ledger 209 (OO) + the ledger row that 0220 inserts itself (VR migration text; RH build gives 210) |
| `ledger_head` | `0220_normalize_access_event_tenant_context.sql` | the head is `max(filename)`; the 0210–0219 files are deliberately absent (RH build) |
| `schema_fingerprint` | `c4d9f7f8aebfa5c8` | clean build of migrations 0001–0209 + 0220 (0220 sha256 `78a17188…2472`), fingerprinted with `production-readonly-discovery.sh` (RH); the same method on 0001–0209 gives `325158ea2a54cde9`, which production matched (OO) |
| `restored_fingerprint` | `fd30bc44bee4dca0` | observed twice and equal: restore-proof.sh restoring a `backup-offsite.sh` backup of that build; and `pg_dump \| pg_restore` of the clean build fingerprinted directly (RH) |
| row-count and outbox rules | identical to `production-pre-0210.profile` | 0220 changes a policy, not data; those counts matched the owner's 2026-10-28 discovery output (OO). Traffic-dependent: not re-read after the release |

## 2. Rehearsal (RH, synthetic data, throwaway keys and cluster)

| Case | Outcome |
|---|---|
| A. schema-rules-only variant vs the 0220 backup | `RESTORE_PROOF=PASS` (ledger 210 / 0220, both fingerprints accepted) |
| B. the real profile vs the (empty) synthetic 0220 backup | schema rules accepted; FAIL only on the 6 production row-count rules, as intended |
| C. the real profile vs a 0209 backup | FAIL (fingerprint) |
| D. `production-pre-0210.profile` vs the 0220 backup | FAIL (fingerprint) |
| E. tampered `restored_fingerprint` | FAIL |

Repository guard: `offsiteBackup.architecture.test.ts` now pins the profile values, requires the row rules to equal the 0209 profile, and hash-pins the 0220 migration so that a changed 0220 file forces a re-review of the profile (16 tests pass).

## 3. Limits and owner actions
- **UV:** production's actual post-release fingerprint. Confirm it from the owner's post-release discovery output or the post-release backup manifest: it must read `c4d9f7f8aebfa5c8`. If it differs, this profile does not apply; do not edit it to fit.
- **UV:** row counts at the time of the post-release backup. If the real run fails on a count line, change that line only through a reviewed PR after reading the restored database; never loosen a rule.
- The profile applies only to ledger head 0220 with ledger count 210. Any further migration needs a new profile.
- Use: `RESTORE_EXPECTATIONS=…/expectations/production-post-0220.profile` (the RP-19 host pack selects it automatically once its mapping includes this head).
