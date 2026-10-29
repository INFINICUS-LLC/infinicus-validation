# AUTH-LOCKOUT-1.RP-23 — G-4 Restore Proof: Authorization Gate, Operator Package, Evidence Report

Result recorded by the coding session: **`RESTORE_PROOF=NOT_RUN`. G-4 remains BLOCKED. Production verdict: NO-GO / INSUFFICIENT EVIDENCE.** No production access, backup access, restore, migration, deployment or merge was performed by this block.
Date: 2026-10-28. Authoritative `main`: `df645073` (PRs #372, #373, #374 merged 18:45–18:46Z). RC unchanged: `bea03e66f00889fdfa6fa5aa69e3feaa3ee7b4e5`.
Labels: VR = VERIFIED — REPOSITORY, VC = VERIFIED — CI, RH = rehearsal on synthetic data (cannot close G-4), OO = OWNER-OBSERVED — PRODUCTION, UV = UNVERIFIED, BL = BLOCKED.

## 1. Baseline (VR)
| Item | Observation |
|---|---|
| RP-19 pack on main | `rp19-fetch-on-vm.sh` sha256 `e5884d0ab8310c8774ee62bf461912bb2db9f1c38809bebe6930aeb1ccd92551`; `rp19-restore-proof-host.sh` sha256 `ab8f8836d316b662ff78b9a4dbc4a1bac9626ba9f899ef055b95681d9bf1c18b` |
| Profiles on main | `production-pre-0210.profile` (sha256 prefix `4d4d2a01…`), `production-post-0220.profile` (prefix `44feb117…`) |
| Docs on main | RP-19, RP-20, RP-21 |
| CI on `main` | #372/#373/#374 head checks were green; the run on the merge commit `df645073` was still in progress when this was written (VC pending) |
| Concurrent changes to backup/recovery tooling | none since RP-20 other than these merges |

## 2. Authorization and access gate (§4 of the task)
| # | Prerequisite | Status |
|---|---|---|
| 1 | Explicit owner approval naming the production backup | **missing** (no backup named) |
| 2 | Approved isolated restore host | **missing** (owner computer-folder list empty; no host named) |
| 3 | Decryption-key custodian | **missing** |
| 4 | CPU/RAM/storage and PostgreSQL 16 compatibility | cannot be assessed without a host (the pack validates major version 16 at run time) |
| 5 | Isolation from production services | enforced by the pack (loopback only, `--network none` in docker mode, target marked disposable, refuses a server holding a database named `infinicus`) — applies once a host exists |
| 6 | Restricted access to restored customer data | owner decision, not recorded |
| 7 | Evidence-retention and disposal policy | owner decision, not recorded (pack prints a disposal checklist) |
| 8 | No path from restore to production | enforced by the pack's fail-closed target validation (VR) |
Gate not passed → restore not attempted; no alternate credentials sought.

## 3. Backup selection (recorded values; nothing substituted)
Candidate, **owner-observed, not fetched here**: `infinicus-production/2026-10-28/20261028T023834Z-daily`, finished 2026-10-28T02:38:37Z, `verified:true`, ledger head `0209_create_print_jobs.sql`, fingerprint `325158ea2a54cde9`, encrypted to the public key on the VM, offsite S3-compatible store (OO, RP-12A). Expected ledger count 209, profile `production-pre-0210.profile`.
Age at 18:50Z on 2026-10-28: about 16 h. Recovery point = backup time (no PITR, `archive_mode=off`, OO). A newer daily may exist by the time the owner runs this: the owner chooses the prefix. If the chosen manifest has any head other than 0209 the pack selects the reviewed profile for that head, or refuses.

## 4. Consolidated operator package (the only action list; owner-run)
Written record first (needs the owner): backup prefix, restore host, key custodian, retention/disposal rule, who may see restored data.
1. VM, deploy user: `bash rp19-fetch-on-vm.sh <prefix>` (copy of the script from main; check its sha256 against §1) → `FETCH_OK`, both objects `MATCHES manifest`. Read-only against the store; nothing decrypted on the VM.
2. `scp -r` the objects directory to the restore host; delete it from the VM.
3. Restore host (not the VM): `git clone https://github.com/INFINICUS-LLC/infinicus-validation.git repo && git -C repo checkout df645073` (or newer main).
4. `bash repo/infinicus-platform/docs/production-readiness/auth-lockout-1-rp-06/rp19/rp19-restore-proof-host.sh --repo ./repo --objects ./objects --prefix <prefix> --key-file <key on an internal drive>`; type the passphrase at gpg's prompt.
5. Send `rp19-restore-proof-<utc>.txt` (no secrets by design). Dispose per the recorded policy.
G-4 may be PASS only if the file shows `RP19_RESULT=PASS` and `RESTORE_PROOF=PASS` for the named backup, profile auto-selected, ledger 209 / 0209, fingerprint `325158ea2a54cde9` with restored form `68407667a5618dc9`, all 15 row rules, and no unlisted outbox type. On any difference: report it; do not edit a profile.

## A. Recovery evidence report (to be completed from the owner's file)
| Field | Value |
|---|---|
| Backup identity / timestamp | not selected (candidate in §3) |
| Authorization evidence | none |
| Restore host / isolation controls | none |
| RP-19 script version and checksum | on main, §1 |
| Execution timestamps / exit code | NOT_RUN |
| Ledger count / head | expected 209 / `0209_create_print_jobs.sql`; observed: none |
| Expected vs observed fingerprint | expected `325158ea2a54cde9` (restored form `68407667a5618dc9`); observed: none |
| Data-integrity results | none |
| Restore duration | not measured on current production data (2026-10-21: about 31 s, VR; synthetic: 6–7 s, not an RTO) |
| Verified recovery point | none verified; last real restore evidence is from 2026-10-21 |
| `RESTORE_PROOF` | **NOT_RUN** |
| G-4 verdict | **BLOCKED** |

## B. Recovery limitations
- No PITR: the recovery point is the backup time, so up to the full interval since the last daily is lost on a disaster.
- No real restore of any backup after 2026-10-21 is on record; the rehearsals prove tooling and profiles only.
- The production VM (1 vCPU, 1.9 GB, no swap) cannot host restore tests; a restore needs separate hardware.
- Recovery depends on: the offline private key and its passphrase (custodian), the offsite store, the restore host, and the profile matching the backup head. Losing the private key makes every backup unrecoverable.
- Hardware snapshots are not visible from the VM (UV).
- Missing evidence: everything in §A except the tooling.

## C. Release-gate matrix (unchanged from RP-21; no new evidence)
| Gate | Status | Evidence class |
|---|---|---|
| G-1 | PASS (identity); rollback pin PENDING | OO 2026-10-28 13:46Z |
| G-2 | PASS | OO 13:46Z |
| G-3 | PASS | OO 13:46Z |
| G-4 | **BLOCKED** | rehearsal only (RH) |
| G-5 | PASS | OO 13:46Z |
| G-6 | PASS at that snapshot | OO 13:46Z |
| G-7 | VERIFIED | VR (RC tip re-checked today) |
| G-8 | VERIFIED IN REHEARSAL | RH |
| G-9 | PENDING (written approval) | VC shows the 3 advisories |
| G-10 | PENDING | — |
| G-11 | VERIFIED | VR |
| G-12 | PENDING | — |
A successful G-4 would not authorize migration 0220 or deployment.

## D. Owner decision record
1. Name backup, restore host and key custodian, set retention/disposal and data-access rules; run the pack; or sign a written G-4 risk acceptance.
2. Written dependency exception (zod high; two vite dev-only; commits `d41b08e4`, `bea03e66`).
3. Maintenance window. 4. Rollback operator. 5. Confirm RC `bea03e66f00889fdfa6fa5aa69e3feaa3ee7b4e5`.
6. Authorize migration 0220. 7. Authorize deployment.
8. Separately scoped: AUDIT-LP-1 rollout (`AUDIT-LP-1_ROLLOUT_PROCEDURE.md`), historical credential exposure checks.
