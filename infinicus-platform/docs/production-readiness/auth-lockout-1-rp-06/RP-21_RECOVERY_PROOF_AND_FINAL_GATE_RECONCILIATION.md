# AUTH-LOCKOUT-1.RP-21 — Recovery Proof Status and Final Release-Gate Reconciliation

Status: EVIDENCE RECONCILIATION ONLY. **Production verdict: NO-GO / INSUFFICIENT EVIDENCE.** No production access, no restore of production data, no migration, no deployment and no merge occurred.
Date: 2026-10-28. Baseline: `main` at `9d5ad3c8` (RP-18 rollout procedure merged as #371; docs only). Release candidate: `claude/auth-lockout-1-isolated-rc` @ `bea03e66f00889fdfa6fa5aa69e3feaa3ee7b4e5` (re-checked on origin, unchanged).
Labels: VR = VERIFIED — REPOSITORY, VC = VERIFIED — CI, RH = VERIFIED — REHEARSAL (disposable local infrastructure, synthetic data; NOT an isolated restore of a production backup), OO = OWNER-OBSERVED — PRODUCTION, INF = INFERRED, UV = UNVERIFIED, BL = BLOCKED.

## A. Recovery proof report

| Item | Result |
|---|---|
| `RESTORE_PROOF` | **NOT_RUN** (BL) |
| Reason | Block C prerequisites are absent in this session: no explicit owner authorization naming a production backup; no approved restore host (the owner's connected-computer folder list is empty); no decryption-key custodian identified; no backup-store credential and no private key. No alternative access was sought. |
| Backup identity | none selected. Newest known: `infinicus-production/2026-10-28/20261028T023834Z-daily`, finished 02:38:37Z, `verified:true`, ledger 209 / `0209_create_print_jobs.sql` / fingerprint `325158ea2a54cde9` (OO, RP-12A). Not fetched here. |
| Profile for a pre-release backup | `production-pre-0210.profile` (ledger 209, head 0209, fingerprint `325158ea2a54cde9`, restored form `68407667a5618dc9`). The post-0220 profile is reserved for backups written after 0220 and is refused for a 0209 backup (RH). |
| Environment, authorization evidence, commands, exit code, ledger/fingerprint/row-count results from a real restore | none exist. |
| Recovery point (assessment) | last observed backup time 2026-10-28 02:38:37Z (11 h old at 13:46Z, OO). No PITR (`archive_mode=off`, OO): the recovery point is the backup time. |
| Restore duration | not measured on production data. 2026-10-21: about 31 s for the then-production dump (VR, W2 execution record). Synthetic rehearsals: 6–7 s (evidence only, not an RTO). |
| Last real restore evidence | 2026-10-21 (ledger 201 `RESTORE_PROOF=PASS`; ledger 209 backup restored by hand, 15/15 row rules; script FAIL was the known false negative fixed by the profile). Older than the current backup, so it is history, not fresh verification. |
| **G-4 result** | **BLOCKED.** It cannot pass on synthetic rehearsals. |

What does exist and is verified without production access:
- RH, combined tree (#373 + #372 merged locally on `9d5ad3c8`, no conflicts): the host pack picks `production-pre-0210.profile` for a 0209 backup and `production-post-0220.profile` for a 0220 backup, accepts the reviewed restored fingerprints (`68407667a5618dc9`, `fd30bc44bee4dca0`) and fails only on the six production row-count rules because the synthetic database is empty (`RP19_RESULT=NOT PASS`, the intended negative).
- VR/VC: `offsiteBackup.architecture.test.ts` 16/16 on the combined tree.

### Operator execution package (single list; owner-run)
1. Record in writing: the authorized backup prefix (a pre-release backup now; the window's on-demand backup later), the restore host, the key custodian, that restored data is production personal data and is disposed of.
2. Merge #373 then #372 (or clone the combined branches), clone main on the restore host.
3. VM: `bash rp19-fetch-on-vm.sh <prefix>` → `FETCH_OK`, both objects `MATCHES manifest`.
4. Restore host: `bash rp19-restore-proof-host.sh --repo … --objects … --prefix <prefix> --key-file …` (docker mode; passphrase typed at gpg's prompt).
5. Send the evidence file. G-4 is PASS only with `RP19_RESULT=PASS` for a named backup; any difference is reported, never absorbed by editing a profile.
6. Dispose of objects and temporary key copies; record times.

## B. PR integration review

| Item | #373 (RP-20) | #372 (RP-19) |
|---|---|---|
| Base / head | `6c3f2bd6` / `0896e76e` | `6c3f2bd6` / `67206ada` |
| State | open, draft, mergeable clean | open, **ready for review (draft cleared by the owner)**, mergeable clean |
| CI (validate, build-and-smoke-test-image, Cloudflare Pages) | all success (VC) | all success (VC) |
| Reviews | none | none |
| Changed files | profile, README row, guard test, RP-20 doc (4) | fetch script, host script, RP-19 doc (3) |
| Relation to `main` (`9d5ad3c8`) | one docs-only commit ahead of their base (#371); no file overlap | same |

Checks required by the task (VR, by reading the code and by the combined rehearsal):
1. The post-0220 profile is reachable by the host script: yes, after both are merged (the script resolves it from the clone).
2. Fails closed when the profile is absent: yes (`missing profile in this clone …`, exit 2, run against a tree without it).
3. No wildcard selection: yes, a `case` on the exact manifest `ledger_head`; every other head is refused (exit 3).
4. Fingerprints are not rewritten: `restore-proof.sh` is untouched; the profile pins both values and a test hash-pins the 0220 migration.
5. Pre-0210 behaviour unchanged: `production-pre-0210.profile` and `restore-proof.sh` are unchanged; combined rehearsal still maps and restores a 0209 backup with it.

Findings: the description of #372 still said "only 0209 has one" (stale, now corrected). Recommended order: merge #373 first, then #372 (either order fails closed, but this order never leaves the pack pointing at a missing file). Neither merge is performed here.

## C. Final release-gate matrix

| Gate | Expected | Actual observation | Evidence source / time | Verdict |
|---|---|---|---|---|
| G-1 API build / rollback | Running image is the known base `ccadbf51`; rollback image pinned | container `oci-api-1` healthy; image `sha256:e94114e2…ccf4`; embedded SHA `ccadbf51…`; running image holds only `.env.example`. Rollback tag `infinicus-api:rollback-pre-0220-ccadbf51` not yet created | OO, RP-12A/12B, 2026-10-28 13:46Z (history, not re-verified) | **PASS (identity); rollback pin PENDING** |
| G-2 Migration state | ledger 209, head 0209, fingerprint `325158ea2a54cde9`, no 0210–0220 | exactly that; 2026-10-28 02:38Z backup manifest agrees | OO 13:46Z | **PASS** (repeat in window) |
| G-3 Live audit RLS | policy without `NULLIF`; restricted app role | as expected: RLS on, FORCE off, app role not superuser/BYPASSRLS, no TRUNCATE, no triggers | OO 13:46Z | **PASS** (baseline confirmed) |
| G-4 Recovery proof | real restore of a named recent backup passes | no restore run (see A). Tooling verified in rehearsal only | RH (today), OO (backup freshness) | **BLOCKED** |
| G-5 Ledger permissions | app role has no access to `public._migrations` | no privilege; empty ACL | OO 13:46Z | **PASS** |
| G-6 Lock safety | no blocking transactions | clean snapshot: none | OO 13:46Z | **PASS at that snapshot; must repeat in window** |
| G-7 RC identity | RC = `bea03e66…` | branch tip unchanged on origin (re-verified today); 14 files vs `ccadbf51` | VR, 2026-10-28 | **VERIFIED** |
| G-8 Isolated migration procedure | 0220 applies alone, idempotent, rolls back | rehearsed with psql and the RC runner; procedure documented | RH (earlier blocks) | **VERIFIED IN REHEARSAL** |
| G-9 Dependency exception | written owner approval for the 3 advisories | CI fails only at the dependency scan on the RC (zod high; 2 vite dev-only); no written approval in the record | VC; none for approval | **PENDING** |
| G-10 Final authorization | owner decision | none | — | **PENDING** |
| G-11 Architecture isolation | no NEW-BDT-SIM-01, no 0210–0219, frozen contracts untouched | RC excludes them; today's PRs touch only docs, scripts, one profile and one test | VR | **VERIFIED** |
| G-12 Window and rollback owner | both named | none | — | **PENDING** |

No historical observation above was turned into fresh verification; G-1/2/3/5/6 are owner-observed at 13:46Z and must be repeated inside the window. G-4 PASS would still not authorize a release.

## D. Owner decision record

| # | Decision | Needed from | Status |
|---|---|---|---|
| 1 | Name the backup to prove, the restore host and the key custodian; run the pack; or sign a written G-4 risk acceptance | owner | open |
| 2 | Written dependency exception naming `zod` (high) and 2 `vite` advisories, commits `d41b08e4` (test) and `bea03e66` (dependency patch) | owner | open |
| 3 | Maintenance window (UTC) | owner | open |
| 4 | Rollback operator | owner | open |
| 5 | Release candidate identity: confirm `bea03e66f00889fdfa6fa5aa69e3feaa3ee7b4e5` | owner | open |
| 6 | Production migration 0220 authorization (window procedure `RELEASE_BUILD_AND_DEPLOY_PROCEDURE.md`) | owner | open |
| 7 | Deployment authorization | owner | open |
| 8 | Merge or close #372, #373 and this PR | owner | open |
| 9 | Separately scoped: AUDIT-LP-1 production rollout (`AUDIT-LP-1_ROLLOUT_PROCEDURE.md`; not in the AUTH-LOCKOUT-1 window); historical Docker credential exposure checks (rclone history lines, provider key revocation, `chmod 600` on two env backups) | owner | open |

## E. Verdict
**NO-GO / INSUFFICIENT EVIDENCE.** G-4 BLOCKED; G-9, G-10, G-12 pending; G-1 rollback pin pending. Nothing in RP-21 changes a production fact.
