# AUTH-LOCKOUT-1.RP-19 — G-4 Restore Proof (owner-execution pack)

Status: **G-4 REMAINS BLOCKED.** No restore of production data was run and no restore proof is claimed. This session has no backup-store credential, no private key, no named backup, no
approved restore host (owner computer-folder list is empty) and no production access. RP-19 delivers the executable owner pack and its rehearsal; the proof itself is owner-run.
Labels: VR = VERIFIED — REPOSITORY, RH = VERIFIED — REHEARSAL (disposable local PostgreSQL 16.15, synthetic data, throwaway keys), OO = OWNER-OBSERVED, UV = UNVERIFIED.

## 1. What the pack adds over RP-14A §6
RP-14A gave copy-paste steps. RP-19 turns them into two scripts that refuse unsafe input and leave an evidence file:

| Script | Runs on | Does | Safety properties |
|---|---|---|---|
| `rp19/rp19-fetch-on-vm.sh <backup-prefix> [dir]` | `infinicus-prod-01` | Fetches the three **encrypted** objects of ONE named backup with the settings the backup unit already uses; prints sizes, sha256 and a manifest summary; checks object hashes against the manifest | prefix is mandatory (no "newest" default); read-only against the store; no decryption (no private key on the VM); never prints `backup.env`; refuses shell tracing |
| `rp19/rp19-restore-proof-host.sh --repo --objects --prefix --key-file [--mode docker\|native]` | the restore host (never the VM) | Runs the repository's `restore-proof.sh` on a throwaway loopback server marked disposable (docker mode: `--network none`), writes `rp19-restore-proof-<utc>.txt` with script/profile/object hashes, repo head, and `RP19_RESULT=PASS/NOT PASS` | refuses an old `restore-proof.sh`; picks the profile from the manifest head and **refuses** any head without a reviewed profile (`0209_create_print_jobs.sql` → `production-pre-0210.profile`; `0220_normalize_access_event_tenant_context.sql` → `production-post-0220.profile`, added by RP-20); never edits a profile; passphrase only at gpg's own prompt |

## 2. Owner procedure
0. **Record in writing before starting** (nothing here assumes it): the authorized backup prefix; who holds the private key; the restore host; that restored data is production personal data and is disposed of after.
   Choose the backup deliberately: the newest daily is a valid target now; if the AUTH-LOCKOUT-1 window is scheduled, the on-demand backup of that window (W4) is the better target. A backup taken **after** migration 0220 has ledger head `0220…` and
   uses `production-post-0220.profile` (RP-20; the clone must contain it) and only if it was written by the isolated release (ledger 210, head 0220); any other head is REFUSED.
1. On the VM: `bash rp19-fetch-on-vm.sh <prefix>` → expect `FETCH_OK` and both objects `MATCHES manifest`.
2. Copy the objects directory to the restore host (`scp -r`). Clone this repository at main on the restore host.
3. On the restore host (Docker): `bash rp19-restore-proof-host.sh --repo ./repo --objects ./objects --prefix <prefix> --key-file <internal-drive path to key>`; type the passphrase when gpg asks. (Docker Desktop cannot mount a removable drive: copy the key to an internal drive and delete the copy afterwards.)
4. Result: `RP19_RESULT=PASS` plus the line `RESTORE_PROOF=PASS` inside the evidence file. Anything else is NOT PASS: send the file; do not edit the profile.
5. Dispose: delete the objects on both machines, the temporary key copy, and note times. Send `rp19-restore-proof-<utc>.txt` (contains no secrets by design).

G-4 can be assessed as PASS only from that file, or closed by an explicit written owner risk acceptance (an owner decision, not a PASS). Limits that remain after a PASS: no point-in-time recovery (recovery point = backup time); the 1.9 GB production host is unsuited to restore tests.

## 3. Rehearsal evidence (RH)
Driver: real `backup-offsite.sh` at `ccadbf51` (production version) on a synthetic database built from committed migrations 0001–0209 (ledger 209, fingerprint `325158ea2a54cde9`), file sink, throwaway gpg keys, throwaway loopback cluster marked disposable.

| Case | Result |
|---|---|
| fetch script, valid prefix | `FETCH_OK`; manifest summary printed; both object hashes `MATCHES manifest` |
| fetch script, no prefix | usage error, nothing fetched |
| host pack, native mode, real `production-pre-0210.profile` on the synthetic data | profile auto-selected from the manifest head; target validated; decrypt/restore ran (total 6.4 s, evidence only, not an RTO); fingerprint `68407667a5618dc9` accepted as the reviewed dump-and-restore form; 6 row-count mismatches because the synthetic data is empty → `RP19_RESULT=NOT PASS`, exit 1. This is the intended negative (production counts cannot be met by synthetic data). |
| positive PASS path | established by RP-14A case A (synthetic profile); deliberately not re-created here, because the pack has no way to substitute a profile |
| docker mode | `bash -n` only; **NOT RUN** (no Docker image pull / key in this session). The image's tools (`gpg`, `psql`, `pg_restore`, `python3`) are UV; the pack stops with a named missing tool instead of guessing |

Hashes (this commit): see `git hash-object` / `sha256sum` of the two scripts in the PR description.
