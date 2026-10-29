# AUTH-LOCKOUT-1 — Owner Decision Record, 2026-10-29

Status: RECORD OF OWNER ANSWERS. Not a release authorization. **Production verdict: NO-GO / INSUFFICIENT EVIDENCE.**
Source: the owner's reply "1A 2A 3A 4A 5A 6A 7A 8C 9A 10A 11A" in the working session on 2026-10-29, answering the mobile decision sheet (option A = the recommended answer). Recorded verbatim in meaning, not extended. The owner may counter-sign or amend this file; anything not recorded here is NOT approved.
Baseline: `main` 35d37cd2; RC `claude/auth-lockout-1-isolated-rc` @ `bea03e66f00889fdfa6fa5aa69e3feaa3ee7b4e5`.

## 1. Decisions

| # | Decision | Answer | Recorded terms |
|---|---|---|---|
| 1 | D1 Backup | A, approved | Restore `infinicus-production/2026-10-28/20261028T023834Z-daily` for disaster-recovery validation only (expected: ledger 209, head `0209_create_print_jobs.sql`, fingerprint `325158ea2a54cde9`, profile `production-pre-0210.profile`). |
| 2 | D2 Restore host | A, approved **conditionally** | The owner's Windows PC (WSL2 Ubuntu-24.04 + Docker Desktop, data on `C:`), only after `manage-bde -status C:` shows `Fully Decrypted`→ **Fully Encrypted and Protection On**. Not met at the time of writing (C: reported Fully Decrypted, no key protectors). |
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
