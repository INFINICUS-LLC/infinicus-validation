# AUTH-LOCKOUT-1.RP-14A — Recovery Evidence Report (gate G-4)

Status: **G-4 REMAINS BLOCKED.** No production backup was fetched, no restore of production data was run, and no restore proof is claimed. What this report adds is
(1) a verified compatibility analysis between the production backup format and the current restore tooling, (2) a local rehearsal of the exact tooling pair on a
synthetic database at the production schema state, and (3) one consolidated procedure for the owner to produce the real restore proof.
Labels: VR = VERIFIED — REPOSITORY, RH = VERIFIED — REHEARSAL (disposable local PostgreSQL 16.15, synthetic data, throwaway keys, no network), VC = VERIFIED — CI,
OO = OWNER-OBSERVED — PRODUCTION (operator-run output, not independently verified here), UV = UNVERIFIED, BL = BLOCKED.

## 1. Authorization and environment (why no restore was run)

The task allowed restoration only on separately authorized disposable infrastructure using an explicitly authorized backup. Neither exists in this session: no backup
store credential, no private decryption key, no named backup, no approved restore host (the session's list of the owner's connected computer folders is empty), and no
production access. Per the task, the restoration workstream stops here and the consolidated owner procedure (§6) is issued.

## 2. Authoritative baseline

`main` at `01973fd3` (SEC-DOCKER-1 merged). PRs #362–#365 are merged (VR). Release candidate `claude/auth-lockout-1-isolated-rc` @ `bea03e66f00889fdfa6fa5aa69e3feaa3ee7b4e5` (VR).
Since the RP-13 baseline `c65f48d1`, the only commits on `main` are those four PRs; nothing else touches `infrastructure/backups`, `deployment` or the database scripts (VR).

## 3. Backup identity (what exists)

| Item | Value | Class |
|---|---|---|
| Newest daily at RP-12A | `infinicus-production/2026-10-28/20261028T023834Z-daily/manifest.json`, finished 2026-10-28T02:38:37Z, `verified:true`, ledger head `0209_create_print_jobs.sql`, fingerprint `325158ea2a54cde9`; both objects re-downloaded and checksum-verified by the upload job | OO |
| Method / location | `backup-offsite.sh` (production runs the copy in `/home/deploy/w2clean/infinicus-release-ccadbf5/…`), gpg-encrypted to the public key on the VM, S3-compatible offsite store | OO / VR |
| Last restore evidence on record | 2026-10-21: pre-window backup `…T141842Z-pre-0202-window` `RESTORE_PROOF=PASS` (ledger 201); evening: `…T172939Z-daily` (ledger 209) restored with the rotated key only, ledger `209/0209`, 15 of 15 row-count rules held by hand; the script's FAIL on that run was a known false negative (§4.2) | VR (W2 execution record) |
| Restore proof of any backup after 2026-10-21, or of the 02:38Z backup | none on record | OO / UV |
| Point-in-time recovery | none (`archive_mode=off`) | OO |

## 4. Compatibility between the production backup format and the restore tooling (VR + RH)

### 4.1 Source comparison (VR)
`git diff ccadbf51 origin/main -- infrastructure/backups` shows exactly three changed files: `README.md` (+1), the new `expectations/production-pre-0210.profile`, and
`restore-proof.sh` (+19/−5). `backup-offsite.sh` and `check-backup-freshness.sh` are **byte-identical** between the production base and `main`, so a backup written by the
installed script is read by `main`'s restore tooling with no format change.

### 4.2 Rehearsal on a synthetic production-shaped database (RH)
Source: a scratch database built from the committed migrations 0001–0209 of `ccadbf51` (ledger 209, head `0209_create_print_jobs.sql`, no data). Backup written by the
**production version** of `backup-offsite.sh` (`--verify`, file sink, throwaway gpg key; backup side holds the public key only). Restore on a **separate throwaway cluster**
(`initdb`, loopback, `infinicus.restore_target=disposable`), with the private key in a separate gpg home. Results:

| Case | Restore script / profile | Result |
|---|---|---|
| Source | schema fingerprint via the discovery script | `325158ea2a54cde9` (equals the production value recorded in the manifest, OO) |
| Backup | `ccadbf51` `backup-offsite.sh --verify` | `BACKUP COMPLETE`, both objects verified, manifest ledger 209, head 0209, fingerprint `325158ea2a54cde9` |
| A | `main` `restore-proof.sh` + synthetic profile carrying the production `ledger_count`, `ledger_head`, `schema_fingerprint` and `restored_fingerprint` | **`RESTORE_PROOF=PASS`**; the restored fingerprint was `68407667a5618dc9`, independently reproducing the reviewed dump-and-restore form recorded in the profile; total 7.1 s (evidence only, not an RTO) |
| B | the **older** `ccadbf51` `restore-proof.sh` + the same profile | `RESTORE_PROOF=FAIL (invalid line in the expectations profile: restored_fingerprint=…)` — the older script cannot read the current profile |
| C | `main` script + the **real** `production-pre-0210.profile` on the synthetic data | `FAIL` with 6 row-count mismatches (first: `tenancy.tenants` restored 0, expected 16) — the production row-count rules are enforced and cannot be satisfied by an empty database |
| D | `main` script **without** `RESTORE_EXPECTATIONS` | `FAIL (schema fingerprint differs after restore: restored 68407667a5618dc9, manifest 325158ea2a54cde9)` — the script's default profile is `production-pre-0171.profile`; this is the false negative seen on 2026-10-21 |

Conclusions that bind the procedure: (a) restore with `main`'s `restore-proof.sh` (or newer), never the `ccadbf51` copy; (b) always pass
`RESTORE_EXPECTATIONS=…/expectations/production-pre-0210.profile` for a backup at ledger head 0209; (c) a backup taken **after** the 0220 step needs a new reviewed
profile (ledger count 210, head `0220…`, the fingerprint observed after the step); (d) a PASS on the synthetic data is not a recovery proof of production: it proves the tooling pair, the
profile logic and the fingerprint handling only.

### 4.3 CI coverage of the same tooling (VC)
`packages/database/tests/offsite-backup.integration.test.ts` runs the real backup and restore-proof scripts (real PostgreSQL 16, real gpg, throwaway restore cluster)
and is part of the database test suite that passed on `main`/the RP-13 PRs.

## 5. Recovery readiness verdict (G-4)

| Question | Answer |
|---|---|
| Is the newest production backup recoverable? | **Not proven.** It is fresh, encrypted, uploaded and checksum-verified (OO), and the tooling is compatible (§4), but it has not been restored. |
| Most recent verified recovery point | The `…T172939Z-daily` ledger-209 backup of 2026-10-21 (restored by hand, OO/VR record). Nothing later. |
| Restore duration | Not measured on production data. Rehearsal: 7.1 s total for an empty 0209 schema (RH, meaningless as an RTO). 2026-10-21: about 31 s for the then-production dump (VR). |
| Data-integrity verification on production data | None beyond the 2026-10-21 row-count rules. |
| Can G-4 be marked PASS? | **No.** It becomes PASS only with `RESTORE_PROOF=PASS` for a named recent backup on an isolated host under the criteria in `RECOVERY_READINESS_PLAN.md`, **or** an explicit written owner risk acceptance (that is an owner decision, not a PASS). |
| Limitations that remain even after a PASS | no point-in-time recovery (recovery point = backup time); 1.9 GB production host unsuited to restore tests; hardware snapshots not visible from the VM (UV). |

## 6. Consolidated owner-execution procedure (needs the authorizations of `RECOVERY_READINESS_PLAN.md` §5)

Before starting, the owner records in writing: which manifest key is authorized (default: the newest daily; if the release window is scheduled, the on-demand backup taken
in W4 of the release procedure is the better target), who holds the private key, which machine is the restore host, and that the restored data is handled as production personal data.

### Step 1 — fetch the encrypted objects on the VM (read-only against the backup store; uses the VM's installed settings)

```bash
KEY=infinicus-production/2026-10-28/20261028T023834Z-daily            # the authorized backup prefix; adjust to the authorized key
set -a; . /etc/infinicus/backup.env; set +a                             # same file the backup unit uses (do not print it)
OUT=$HOME/proof-objects; umask 077
for o in manifest.json db.dump.gpg roles.sql.gpg; do
  mkdir -p "$OUT/$KEY"
  bash -c "${BACKUP_FETCH_CMD//%KEY%/$KEY/$o}" > "$OUT/$KEY/$o" || { echo "fetch failed: $o"; break; }
done
ls -l "$OUT/$KEY"; sha256sum "$OUT/$KEY"/*.gpg                          # sizes and hashes only
```

(`BACKUP_FETCH_CMD` is defined in `backup.env` with a `%KEY%` placeholder; the loop substitutes it. The objects are encrypted; the VM holds no private key.)

### Step 2 — copy to the restore host and prepare it (the owner's PC with Docker, as on 2026-10-21)

```bash
# PC, empty working folder; copy $OUT from the VM (scp -r deploy@<vm>:proof-objects ./objects)
git clone https://github.com/INFINICUS-LLC/infinicus-validation.git repo          # main at or after 01973fd3
docker run -d --rm --name rp14-restore -v "$PWD/repo:/repo:ro" -v "$PWD/objects:/objects:ro" -v "<path-to-offline-key-file>:/key/offline.asc:ro" \
  -e POSTGRES_HOST_AUTH_METHOD=trust --network none postgres:16-bookworm -c infinicus.restore_target=disposable
```

`--network none` keeps the container off every network, which also satisfies "no route to production" (the container's own loopback is enough because the proof runs inside it).
Pitfall recorded on 2026-10-21: Docker Desktop cannot see a removable drive, so mount the key file from the internal drive and delete that copy afterwards.

### Step 3 — run the proof inside the container (passphrase typed at the prompt; it never leaves the container)

```bash
KEY=infinicus-production/2026-10-28/20261028T023834Z-daily            # on the PC: the same authorized prefix as in step 1
docker exec -it rp14-restore bash -lc '
  export RESTORE_GNUPGHOME=$(mktemp -d) && chmod 700 "$RESTORE_GNUPGHOME"
  gpg --homedir "$RESTORE_GNUPGHOME" --import /key/offline.asc                                  # prompts for the passphrase
  export RESTORE_ADMIN_URL=postgresql://postgres@127.0.0.1:5432/postgres
  export BACKUP_FETCH_CMD="cat /objects/%KEY%"
  P=/repo/infinicus-platform/infrastructure/backups
  bash $P/restore-proof.sh --validate-target                                                     # must print RESTORE_TARGET=OK
  RESTORE_EXPECTATIONS=$P/expectations/production-pre-0210.profile bash $P/restore-proof.sh '"$KEY"'/manifest.json
' 2>&1 | tee rp14a-restore-proof.txt
```

Expected for the 02:38Z backup (ledger 209): the final line `RESTORE_PROOF=PASS`, ledger `209 / 0209_create_print_jobs.sql`, fingerprint line stating the profile's reviewed dump-and-restore form, 15 row-count rules
satisfied (counts as in the profile: tenants 16, users 6, businesses 16, outbox 59 with 48 + 11; they matched the 2026-10-28 production discovery output). Any other result is **FAIL**; do not edit the profile to make it pass.
Container details (that the image provides `gpg`, `psql`, `pg_restore`) match the 2026-10-21 run but are UV for the current image: stop and report if a tool is missing.

### Step 4 — optional application restoration check (disposable only, synthetic traffic, no outbound mail; see the plan §4 step 5)

### Step 5 — evidence and disposal

Keep: `rp14a-restore-proof.txt` (contains no secrets by design), the manifest key, the profile name, timestamps, who ran it. Dispose: `docker rm -f rp14-restore` (the container is `--rm`), delete `objects/` on the PC and `~/proof-objects` on the VM, delete the temporary key copy, record the times. The evidence retention period is an owner decision.

### Step 6 — report back

Send `rp14a-restore-proof.txt`. G-4 can then be assessed; nothing else changes the verdict.

## 7. Evidence references
Repository: `infrastructure/backups/{backup-offsite.sh,restore-proof.sh,check-backup-freshness.sh,expectations/production-pre-0210.profile}`; `docs/architecture/reconciliation/PHASE_W2_EXECUTION_RECORD_0202-0209.md`
§5 and §8; `RECOVERY_READINESS_PLAN.md`; `packages/database/tests/offsite-backup.integration.test.ts`. Production: the RP-12A/RP-12B operator outputs (owner-observed).
