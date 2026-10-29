# AUTH-LOCKOUT-1 — Owner Decision Record, 2026-10-29

Status: RECORD OF OWNER ANSWERS. Not a release authorization. **Production verdict: NO-GO / INSUFFICIENT EVIDENCE.**
Source: the owner's reply "1A 2A 3A 4A 5A 6A 7A 8C 9A 10A 11A" in the working session on 2026-10-29, answering the mobile decision sheet (option A = the recommended answer). Recorded verbatim in meaning, not extended. The owner may counter-sign or amend this file; anything not recorded here is NOT approved.
Baseline: `main` 35d37cd2; RC `claude/auth-lockout-1-isolated-rc` @ `bea03e66f00889fdfa6fa5aa69e3feaa3ee7b4e5`.

## 1. Decisions

| # | Decision | Answer | Recorded terms |
|---|---|---|---|
| 1 | D1 Backup | A, approved | Restore `infinicus-production/2026-10-28/20261028T023834Z-daily` for disaster-recovery validation only (expected: ledger 209, head `0209_create_print_jobs.sql`, fingerprint `325158ea2a54cde9`, profile `production-pre-0210.profile`). |
| 2 | D2 Restore host | A, approved **conditionally** | The owner's Windows PC (WSL2 Ubuntu-24.04 + Docker Desktop, data on `C:`), only after `manage-bde -status C:` shows **Fully Encrypted** and **Protection On**. Not met at the time of writing (`C:` reported Fully Decrypted, Protection Off, no key protectors). |
| 3 | D3 Key custodian | A, approved | The owner personally; key and passphrase never in chat, logs or evidence. |
| 4 | D4 Customer-data processing | A, approved | Read-only proof queries only; no export, copy, publication or connection to production. |
| 5 | D5 Retention and disposal | A, approved | Keep only the sanitized evidence file for 90 days; delete objects, decrypted dumps, restored database volume and key copies right after evidence capture; record the time. |
| 6 | G-4 | A | The real restore proof is required before any release. No waiver. |
| 7 | G-9 dependency exception | A, **approved** | Exactly 3 advisories: `zod` GHSA-mrhx-c7xc-m3w5 (high), `vite` GHSA-9jrq-w75r-8gcw (low), `vite` GHSA-rq7h-c2jc-7f22 (moderate). RC commits `d41b08e4` (test) and `bea03e66` (dependency patch). This release only; expires at the next release or 30 days, whichever is first. Replaces the earlier "14 advisories" wording of RP-08 (11 of 14 were fixed in `bea03e66`). |
| 8 | G-12 window | C | **Not chosen.** |
| 9 | G-12 rollback owner | A | A named person other than the executor, reachable for the whole window plus 2 h, with stop conditions agreed in advance. **No name given.** |
| 10 | Migration method | A | Stop the API for about 10 minutes, then apply 0220 through the gate (W3, W5). |
| 11 | Separate work | A | AUDIT-LP-1, NEW-BDT-SIM-01 and the Docker credential-exposure items (rclone history lines, old Anthropic/Resend key revocation, `chmod 600` on two env backups) stay outside this release; the hygiene items are still to be done. |

## 2. Gate effect

| Gate | Status after this record |
|---|---|
| G-1 | PASS (identity, owner-observed 2026-10-28 13:46Z); rollback pin PENDING (inside the window) |
| G-2, G-3, G-5 | PASS (owner-observed 2026-10-28 13:46Z; repeat inside the window) |
| G-4 | **BLOCKED**: real restore not run yet. Prerequisite from D2 (disk encryption) not met. Backup objects are on the owner's PC and match the manifest (owner-observed). |
| G-6 | PASS at that snapshot; repeat inside the window |
| G-7, G-11 | VERIFIED |
| G-8 | VERIFIED IN REHEARSAL |
| G-9 | **APPROVED by the owner** with the terms in row 7 |
| G-10 | PENDING (asked only after G-4, G-9, G-12) |
| G-12 | **PENDING**: window and rollback owner name missing |

## 3. What is still needed
1. Owner: enable BitLocker on `C:` and show `Fully Encrypted` / `Protection On` (recovery key saved outside `C:`).
2. Owner: run the restore proof (`rp19-restore-proof-host.sh`, main at or after 35d37cd2, script sha256 `68838c86d6bd4e2da4772f97bf12fedeef9050223f11f57266121f81324aba39`) and send the evidence file; G-4 passes only on `RP19_RESULT=PASS` and `RESTORE_PROOF=PASS`.
3. Owner: name the rollback owner and the window (UTC).
4. After 1–3: reconcile the gates, then the owner decides G-10. Migration 0220 and deployment each need their own authorization.

## 4. Not decided here
Production migration, deployment, G-10, any merge of unrelated work, AUDIT-LP-1 rollout timing.

## 5. Update 2026-10-29 (owner input form, same day)

Source: the owner's completed "OWNER INPUT FORM (G-4, G-12)". Recorded as answered; blanks are not decided. This section amends row 9 above and adds the form's answers. It is not a release authorization.

| Item | Owner's answer | Recorded as |
|---|---|---|
| Row 9 (rollback owner), changed | The owner is both executor and rollback owner, "under Claude's guidance" (no separate named person; no one on call, B3 = NO) | Option B. The independent second person recommended in the decision sheet is NOT provided. The owner states they will treat the stop conditions as binding (B4 YES) and keep the rollback commands open before starting (B5 YES). Claude gives guidance only and has no production access. |
| Window (A1-A5) | Not ready (A5). Date and time not chosen. Time zone: Kuwait / Asia (KWT, UTC+3). A4: the owner does NOT expect to be undisturbed for the whole window. | **No window chosen.** The text "start immediately / the start is yours" is an intention to begin once readiness is confirmed, not a date and time. It is not an authorization. |
| C1 BitLocker | NOT YET (encryption in progress: 11.7% at last check, TPM and recovery-password protectors present) | D2 condition still unmet |
| C2 recovery key saved outside C: | YES | recorded as stated by the owner (not verifiable by Claude) |
| C3 restore command run | NOT YET | G-4 stays BLOCKED |
| C4, C5 | left blank | not done (the restore has not run) |
| E1 rclone history lines | not yet | open |
| E2 old Anthropic and Resend keys revoked | not yet | open |
| E3 `chmod 600` on the two env backups | left blank | open |
| D1, D2 of the form | YES, YES | this update was prepared at the owner's request; the owner merges it |

Gate effect of the update: G-12 stays **PENDING** (no window; rollback owner is the executor, with the risk above). G-4 stays **BLOCKED**. G-10 is not asked and no migration or deployment is authorized. A4 (not undisturbed) is a risk to resolve before any window is set. Verdict: NO-GO / INSUFFICIENT EVIDENCE.

### 5.1 BitLocker acceptance (owner, 2026-10-29, after the form)

`manage-bde -status C:` as pasted by the owner: `Used Space Only Encrypted`, 100.0%, AES 128, `Protection On`, key protectors TPM and Numerical Password (owner-observed; Claude cannot verify). A free-space wipe (`manage-bde -w C:`) was started by the owner; the status did not show a change and Claude cannot confirm that it finished.

Owner decision, in their words: "I Accept Used Space Only Encrypted plus Protection On."

Recorded effect: the D2 condition is **accepted as met in that form** (not "Fully Encrypted"). The restored database is written after encryption and is therefore encrypted; unencrypted old deleted-file remnants in free space are the known residual risk and are accepted by the owner. This acceptance covers the restore proof only. G-4 stays BLOCKED until the evidence file shows `RP19_RESULT=PASS` and `RESTORE_PROOF=PASS`.

### 5.2 G-4 restore proof result (owner-run, 2026-10-29)

Source: the evidence file `rp19-restore-proof-20261029T154746Z.txt` produced by the owner on their Windows PC (WSL2 Ubuntu-24.04 + Docker Desktop, Docker `--network none`, BitLocker as accepted in 5.1). The owner pasted its result lines; Claude read them and did not run the restore. Sanitized summary, no secrets:

| Item | Value |
|---|---|
| Backup | `infinicus-production/2026-10-28/20261028T023834Z-daily` (created 2026-10-28 02:38:34Z) |
| Run | 2026-10-29 15:47:46Z to 15:49:54Z, mode docker, repo head `faea31ef` |
| Scripts and objects | `restore-proof.sh` sha256 `9439ccaf…`, profile `production-pre-0210.profile` sha256 `4d4d2a01…`, `db.dump.gpg` sha256 `64f78309…`, `roles.sql.gpg` sha256 `1bcba35d…`; object hashes equal the manifest |
| Ledger | 209 rows, head `0209_create_print_jobs.sql` |
| Fingerprints | manifest `325158ea2a54cde9`; restored `68407667a5618dc9` (the reviewed dump-and-restore form) |
| Row rules | all 15 verified: tenants 16, users 6, businesses 16, outbox events 59; audit_events, inventory_movements, purchase_receipts, inventory_balances, purchase_orders, purchase_order_line_items, orders, register_sessions, order_payments, printers and print_jobs all 0 |
| Outbox | 48 `onboarding.step.completed` + 11 `billing.subscription.status_changed`, no unlisted event type |
| Timings (evidence only, not an RTO) | download 0.1 s, decrypt 23.7 s, restore 37.8 s, verify 2.0 s, total 63.6 s |
| Result | `RESTORE_PROOF=PASS`, `RP19_RESULT=PASS` |
| An earlier attempt at 15:23:11Z | stopped before restoring (no key file); not part of this result |

Disposal reported by the owner (owner-observed): key copy shredded, objects deleted on the PC and the VM, stray evidence file removed, no restore container left, Docker volume count back to 15 (before the restore: 15). The evidence file is kept 90 days (until about 2027-01-27, D5).

**G-4: PASS** with these limits: the recovery point is the backup time (about 37 h before the restore; no point-in-time recovery, `archive_mode=off`); the restore proved a pre-release (head 0209) backup, not a post-0220 backup (profile `production-post-0220.profile` is untested on real data); the restore host's free-space wipe was not confirmed (5.1); shred on a virtual disk is not guaranteed, so BitLocker protection is what covers leftovers.

G-4 PASS does not authorize anything. G-10 and G-12 stay PENDING, the G-1 rollback pin and the in-window repeat checks are still to do, and the verdict stays **NO-GO / INSUFFICIENT EVIDENCE**.

