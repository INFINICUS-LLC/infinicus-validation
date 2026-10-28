# AUTH-LOCKOUT-1 — Corrected Release Build and Deployment Procedure (RC `bea03e66`)

Status: PROCEDURE DOCUMENTATION ONLY. Nothing in this file has been executed on production, and no step may be executed without the explicit
owner authorization of a release window (gates G-1 to G-12 in `RP-13_RELEASE_GATE_MATRIX.md`). Supersedes the build and execution parts of
`ISOLATED_SECURITY_RELEASE_DESIGN.md` §6D and `RP-11_RELEASE_READINESS_PACKAGE.md` §4 where they differ (see §1).
Labels: VR = VERIFIED — REPOSITORY, RH = VERIFIED — REHEARSAL (disposable local infrastructure), OO = OWNER-OBSERVED — PRODUCTION (operator output, not
independently verified), INF = INFERRED, UV = UNVERIFIED.

## 0. Artifact under release

| Item | Value |
|---|---|
| Release candidate | branch `claude/auth-lockout-1-isolated-rc`, commit `bea03e66f00889fdfa6fa5aa69e3feaa3ee7b4e5` (VR). Never merged to `main`. |
| Deployed base (OO) | `ccadbf51be90c35377e21b73ceda77a1d455a805`, image `sha256:e94114e2a96dc5a47126e953a0b953e0ceae76d8d350e2bde428cedc07f5ccf4`, container `oci-api-1` |
| Schema step | migration `0220_normalize_access_event_tenant_context.sql`, sha256 `78a17188e4f01e7dbe78fb422578864345607c9a4eefeb30ea7f9913d1222472` (VR) |
| Delta vs base | 14 files, +289/−84 (VR) |

## 1. What production evidence changed in this procedure (OO, RP-12A/RP-12B)

| Finding | Consequence for the procedure |
|---|---|
| The running image was **not** built from `/opt/infinicus/repo` (stale, HEAD `130bf5ac`, 2026-10-14). It was built from an exported tree `/home/deploy/w2clean/infinicus-release-ccadbf5` (no `.git`). | Build from a fresh, hash-recorded export of the RC commit; never from `/opt/infinicus/repo`. |
| Compose labels of the running stack: project `oci`; one config file `…/w2clean/infinicus-release-ccadbf5/infinicus-platform/infrastructure/deployment/oci/docker-compose.yml`; working dir the same folder; environment file `/opt/infinicus/repo/infinicus-platform/infrastructure/deployment/oci/.env`. | Use project name `oci`, the single compose file of the new export, and `--env-file` pointing at the existing external file. |
| `/opt/infinicus/repo/…/oci/` holds a real `.env` and `.env.backup-before-preview-cors`; a retained older image (`oci-api:rollback-20261014`) contains a real `.env`. The repo `.dockerignore` only excluded root-level env files. | The export must contain no env files; the finished image is scanned for them. The `.dockerignore` fix is SEC-DOCKER-1 (separate PR) and is **not** part of the RC. |
| The VM has 1 vCPU, 1.9 GB RAM, no swap (previous plan: about 600 MB headroom, "no builds or heavy work on it"). | The image is built **off the VM** and moved with `docker save` / `docker load`, as in the 2026-10-21 window (`PHASE_W2_WINDOW_PLAN_0202-0206.md` P5). |
| The running image exists only under the tags `oci-api:latest` and `oci-tools:latest`. | Tag it before the new image is loaded (§5), as the previous windows did (`infinicus-api:rollback-pre-0202`, `…-pre-0199`). |
| The backup unit's systemd drop-in runs the backup scripts from `/home/deploy/w2clean/infinicus-release-ccadbf5/` (W11 of the previous window). | That folder must stay untouched. It is also the compose file and scripts of the rollback path. |
| The first export copies of the previous window were rejected because of Windows line endings. | The export is checked for carriage returns (expected 0) as well as env files. |
| The VM discovery script is an older version; `sudo` needs a password. | Use the RC export's scripts; read-only checks that need `sudo` are marked as owner-only. |

## 2. Preconditions (all must be recorded as satisfied before the window)

1. Owner GO, window and named rollback owner (G-10, G-12). 2. Written owner confirmation of the dependency-scan exception (G-9, 3 advisories:
`zod` high, two `vite` dev-only). 3. Recovery readiness decided per `RECOVERY_READINESS_PLAN.md` (G-4). 4. The read-only gate checks G-1 to G-6 repeated
inside the window (G-6 especially: it is only a snapshot). 5. The plan for env-file hygiene reviewed (`PRODUCTION_HYGIENE_PLAN.md`).

## 3. Operating conventions (inherited from the proven 2026-10-21 window; `docs/architecture/reconciliation/PHASE_W2_WINDOW_PLAN_0202-0206.md`)

Every command block defines its own variables (SSH reconnects lose them):

```bash
OCI=/opt/infinicus/repo/infinicus-platform/infrastructure/deployment/oci          # external .env lives here
REL=/home/deploy/w2clean/infinicus-release-bea03e66/infinicus-platform               # the new, hashed export
C="docker compose -p oci --env-file $OCI/.env -f $REL/infrastructure/deployment/oci/docker-compose.yml"
SHA=bea03e66f00889fdfa6fa5aa69e3feaa3ee7b4e5
```

Never stop `postgres` or `caddy` by hand (`unless-stopped` containers stopped manually do not return after a reboot). Never pipe or truncate the output of the
migration gate. Read-only steps are marked `[READ]`; every other step changes the VM and needs the window authorization.

## 4. Before the window (no production traffic is touched)

### 4.1 Source export (off the VM, trusted workstation or CI runner)

```bash
RC=bea03e66f00889fdfa6fa5aa69e3feaa3ee7b4e5
git fetch origin claude/auth-lockout-1-isolated-rc
test "$(git rev-parse origin/claude/auth-lockout-1-isolated-rc)" = "$RC" || { echo "RC head moved or mismatch"; exit 1; }
git diff --shortstat ccadbf51be90c35377e21b73ceda77a1d455a805 "$RC"           # expect: 14 files changed, 289 insertions(+), 84 deletions(-)
git archive --format=tar --prefix=infinicus-release-bea03e66/ "$RC" infinicus-platform | gzip -n -9 > infinicus-release-bea03e66.tar.gz
sha256sum infinicus-release-bea03e66.tar.gz | tee infinicus-release-bea03e66.tar.gz.sha256
tar -tzf infinicus-release-bea03e66.tar.gz | grep -E '(^|/)\.env($|\.)|env-backup|\.pem$|\.key$|discovery-.*\.txt$' | grep -v '\.env\.example$' || echo "no env-like files in the export"
```

`git archive` depends only on the commit and `gzip -n` omits the timestamp, so a second person reproduces the checksum. Run the archive on a machine whose Git does not
rewrite line endings, then verify on the VM (§4.3) that no carriage returns arrived.

### 4.2 Image build (off the VM)

Build from the **extracted export** (not from a working tree with local files), so no env file can be in the build context:

```bash
tar -xzf infinicus-release-bea03e66.tar.gz && cd infinicus-release-bea03e66/infinicus-platform
docker build --build-arg GIT_SHA=bea03e66f00889fdfa6fa5aa69e3feaa3ee7b4e5 -f apps/api/Dockerfile -t oci-api:latest -t oci-tools:latest .
docker run --rm --network none --no-healthcheck --entrypoint sh oci-api:latest -c 'echo "build sha: $INFINICUS_BUILD_SHA"; find /repo -maxdepth 6 \( -name ".env" -o -name ".env.*" -o -name "*env-backup*" \) -not -name ".env.example" -not -path "*/node_modules/*"; echo "(search done)"'
#   expected: the full SHA above, then only "(search done)". Any path listed: do not ship the image, escalate.
docker save oci-api:latest oci-tools:latest | gzip -n > oci-image-bea03e66.tar.gz && sha256sum oci-image-bea03e66.tar.gz | tee oci-image-bea03e66.tar.gz.sha256
```

(`oci-api` and `oci-tools` are one image id with two tags, as in the previous release.) Record the image id. Another build of the same commit produces a different id; the
commit is identified by `INFINICUS_BUILD_SHA`, not by the image id. The retained `.dockerignore` of the RC is the old one; the export being env-free and the image scan
above are the controls (SEC-DOCKER-1 hardens the file on `main`, not on the RC).

### 4.3 Transfer and verification on the VM (adds new files only)

```bash
scp infinicus-release-bea03e66.tar.gz* oci-image-bea03e66.tar.gz* deploy@<vm>:~/
# on the VM, as deploy:
cd ~ && sha256sum -c infinicus-release-bea03e66.tar.gz.sha256 && sha256sum -c oci-image-bea03e66.tar.gz.sha256
mkdir -p /home/deploy/w2clean && tar -xzf infinicus-release-bea03e66.tar.gz -C /home/deploy/w2clean     # new folder; never touch ...-ccadbf5
REL=/home/deploy/w2clean/infinicus-release-bea03e66/infinicus-platform
find "$REL" \( -name ".env" -o -name ".env.*" -o -name "*env-backup*" \) -not -name ".env.example" -not -path "*/node_modules/*"      # expected: no output
grep -rIlP '\r$' "$REL" 2>/dev/null | wc -l                                                                                       # expected: 0
sha256sum "$REL/infrastructure/database/migrations/0220_normalize_access_event_tenant_context.sql"
#   expected: 78a17188e4f01e7dbe78fb422578864345607c9a4eefeb30ea7f9913d1222472
ls "$REL/infrastructure/database/migrations" | wc -l ; ls "$REL/infrastructure/database/migrations" | tail -2
#   expected: 210 files, ending ...0209_create_print_jobs.sql and 0220_normalize_access_event_tenant_context.sql  (ledger 209 => exactly one pending file)
```

Do **not** `docker load` yet: loading moves the `oci-api:latest` tag away from the running image. Pin the rollback image first (§5 step 2).

## 5. The window (all on the VM as `deploy`; owner authorization required)

| Step | Action | Pass condition / stop |
|---|---|---|
| W0 `[READ]` | Repeat gates G-1 to G-6: ledger/fingerprint through the **release** discovery script (`INFINICUS_DISCOVERY_ONLY=fingerprint`), policy text, privileges, long transactions/locks (forced read-only session: `PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=2000'`) | ledger 209, head 0209, fingerprint `325158ea2a54cde9`, policy without `NULLIF`, no long transactions; any other red: **STOP** |
| W1 `[READ]` | Record `docker inspect oci-api-1`, `$C images`, `/v1/health` | running image `sha256:e94114e2…ccf4`, version `ccadbf51…` |
| W2 | Pin the rollback image: `docker tag e94114e2a96d infinicus-api:rollback-pre-0220-ccadbf51`; then load the new image: `gunzip -c ~/oci-image-bea03e66.tar.gz \| docker load` | the tag resolves to `e94114e2…ccf4`; `oci-api:latest` is now the new image; the container keeps running its old image until recreated |
| W3 | Quiesce: `$C stop api` | `postgres` healthy, `api` stopped. With the API stopped the table has no application readers or writers, so the 0220 lock cannot wait behind live traffic. Downtime starts here (minutes; the previous window needed about 10) |
| W4 | Backup: `COMPOSE_DIR=$OCI BACKUP_LABEL=pre-0220-window BACKUP_ENV_FILE=/etc/infinicus/backup.env bash /home/deploy/w2clean/infinicus-release-ccadbf5/infinicus-platform/infrastructure/backups/backup-offsite.sh --check`, then `--verify` (the proven script version of the running release; read the manifest back) | `BACKUP COMPLETE`; manifest ledger 209, head 0209, fingerprint `325158ea2a54cde9`; both objects `verified`. Recovery point = this backup (no PITR) |
| W5 | Gate from the **release** image: `$C --profile tools run --rm --no-deps tools` | exactly one `apply` / `done` pair: `0220_normalize_access_event_tenant_context.sql`, then `Migration gate passed.` An `apply` without `done`, `FAILED`, or any other filename: **STOP**, read the PostgreSQL server log, no blind retry |
| W6 | Grants: not required (0220 creates no object and changes no privilege). Do not run `grant-app-role.sh` from any other checkout | — |
| W7 `[READ]` | Verify: ledger `210 / 0220_normalize_access_event_tenant_context.sql`; policy text contains `NULLIF`; `relrowsecurity` t, `relforcerowsecurity` f; `app_role` privileges unchanged; fingerprint recorded (rehearsal value on a local PostgreSQL 16 build: `c4d9f7f8aebfa5c8`; the discovery script has no reference for this state and will print `NO_REFERENCE_MATCH`: record the value and have the owner review it) | all as listed; otherwise the stop point below |
| Stop point | If W0–W7 passed the database is migrated; the old image (`ccadbf51`) works on it (rehearsed). If the new API is in doubt, start the pinned rollback image and stop | — |
| W8 | `$C up -d --no-deps api` (API only; `GIT_SHA` is not needed because no build happens) | `api` healthy; `/v1/ready` 200; `/v1/health` version = `bea03e66f00889fdfa6fa5aa69e3feaa3ee7b4e5`; external `/v1/ready` ok |
| W9 | `BASE_URL=https://api.infini-cus.com EXPECTED_BUILD_SHA=$SHA bash $REL/infrastructure/deployment/scripts/smoke-test.sh`; `docker logs oci-api-1 --since 10m` has no `LockoutStateUnavailable` and no unexpected 5xx. No login experiments with real credentials | exit 0 |
| W10 | Close: keep the output without values; recommended afterwards: a restore proof of the W4 backup (`RECOVERY_READINESS_PLAN.md`) | — |
| W11 | The backup unit keeps running from `…/infinicus-release-ccadbf5/` through its drop-in (still valid; backups record the new head). Repointing it is a separate, optional, owner-approved step | `check-backup-freshness.sh` OK at the next daily run |

Alternative if the owner will not accept API downtime: skip W3, and in W5 apply the unmodified file online with a lock timeout instead of the gate
(`docker exec -i -e PGOPTIONS='-c lock_timeout=3s' oci-postgres-1 psql -X -v ON_ERROR_STOP=1 -U admin_role -d infinicus < "$REL/infrastructure/database/migrations/0220_normalize_access_event_tenant_context.sql"`,
up to three attempts 30 s apart; the design document explains why an unbounded wait is itself an outage). The old API tolerates the new policy.

## 6. Rollback (decision order)

| Situation | Action |
|---|---|
| Gate refuses or the migration fails (W5) | API is stopped; the file is one transaction, so the database stands at 0209. Read the server log; the owner decides to retry or to restart the rollback image. |
| Verification fails (W7), API stopped | If the policy or ledger is wrong, Procedure B of the design (one transaction: original policy expression back, `0220` ledger row deleted; fingerprint must return to `325158ea2a54cde9`, ledger 209), then restart the rollback image. Full restore from the W4 backup only if the schema is in doubt, on a disposable machine first. |
| New API started, defect found (W8–W9) | `docker tag infinicus-api:rollback-pre-0220-ccadbf51 oci-api:latest`, then from the **old** tree `OCI=/opt/infinicus/repo/infinicus-platform/infrastructure/deployment/oci; C_OLD="docker compose -p oci --env-file $OCI/.env -f /home/deploy/w2clean/infinicus-release-ccadbf5/infinicus-platform/infrastructure/deployment/oci/docker-compose.yml"; $C_OLD up -d --no-deps --force-recreate api` (no build). Verify `/v1/health` shows `ccadbf51…`. The schema needs no change. |
| Data corruption suspected | Restore the W4 backup on a disposable machine first; never over production unverified. |

Stop conditions agreed with the rollback owner in advance: any failed pre-check; any non-empty env or carriage-return scan; a gate output other than the single 0220 pair;
an unhealthy API after two minutes; any 5xx spike on `/v1/auth/login`.

## 7. Release record (fill in at the window; keep with the evidence)

| Field | Value |
|---|---|
| RC commit / export sha256 / image archive sha256 / who / when / build machine | |
| Image id built; rollback tag and its id (`infinicus-api:rollback-pre-0220-ccadbf51`) | |
| Pre/post ledger, policy text, fingerprint; gate output (verbatim) | |
| W4 backup key and `--verify` result | |
| Health version after W8; smoke-test result; log scan result | |
| Start/end times, API downtime, executor, rollback owner | |

## 8. Not part of this procedure

NEW-BDT-SIM-01 and migrations 0210–0219; the audit least-privilege work (AUDIT-LP-1); credential rotation and image cleanup (see `PRODUCTION_HYGIENE_PLAN.md`); any change to
`grant-app-role.sh`; any change to frozen contracts.
