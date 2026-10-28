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
| The VM has 1 vCPU, 1.9 GB RAM, no swap. | Check memory before building; an off-VM build is allowed (§4.2). |
| The running image exists only under the tags `oci-api:latest` and `oci-tools:latest`. | Tag it before anything is rebuilt (§5). |
| The VM discovery script is an older version; `sudo` needs a password. | Use the RC export's scripts; read-only checks that need `sudo` are marked as owner-only. |

## 2. Preconditions (all must be recorded as satisfied before the window)

1. Owner GO, window and named rollback owner (G-10, G-12). 2. Written owner confirmation of the dependency-scan exception (G-9, 3 advisories:
`zod` high, two `vite` dev-only). 3. Recovery readiness decided per `RECOVERY_READINESS_PLAN.md` (G-4). 4. The read-only gate checks G-1 to G-6 repeated
inside the window (G-6 especially: it is only a snapshot). 5. The plan for env-file hygiene reviewed (`PRODUCTION_HYGIENE_PLAN.md`).

## 3. Phase A — create and fingerprint the source export (off the VM, no production access)

On a trusted workstation or CI runner with a clone of the repository:

```bash
RC=bea03e66f00889fdfa6fa5aa69e3feaa3ee7b4e5
git fetch origin claude/auth-lockout-1-isolated-rc
test "$(git rev-parse origin/claude/auth-lockout-1-isolated-rc)" = "$RC" || { echo "RC head moved or mismatch"; exit 1; }
git diff --shortstat ccadbf51be90c35377e21b73ceda77a1d455a805 "$RC"          # expect: 14 files changed, 289 insertions(+), 84 deletions(-)
git archive --format=tar --prefix=infinicus-release-bea03e66/ "$RC" infinicus-platform | gzip -n -9 > infinicus-release-bea03e66.tar.gz
sha256sum infinicus-release-bea03e66.tar.gz | tee infinicus-release-bea03e66.tar.gz.sha256
tar -tzf infinicus-release-bea03e66.tar.gz | grep -E '(^|/)\.env($|\.)|env-backup|\.pem$|\.key$|discovery-.*\.txt$' | grep -v '\.env\.example$' || echo "no env-like files in the export"
```

`git archive` output depends only on the commit, and `gzip -n` omits the timestamp, so the checksum is reproducible by a second person. Record: commit, archive
checksum, who created it, when, and from which machine (provenance table in §9).

## 4. Phase B — transfer, verify, build (before the window; changes nothing that serves traffic)

### 4.1 Transfer and verification (state change on the VM: new directory only)

```bash
scp infinicus-release-bea03e66.tar.gz infinicus-release-bea03e66.tar.gz.sha256 deploy@<vm>:~/
# on the VM, as deploy:
cd ~ && sha256sum -c infinicus-release-bea03e66.tar.gz.sha256
mkdir -p /home/deploy/w2clean && tar -xzf infinicus-release-bea03e66.tar.gz -C /home/deploy/w2clean   # creates .../infinicus-release-bea03e66/
find /home/deploy/w2clean/infinicus-release-bea03e66 \( -name ".env" -o -name ".env.*" -o -name "*env-backup*" \) -not -name ".env.example" -not -path "*/node_modules/*"
#   expected: no output. Anything listed stops the procedure.
sha256sum /home/deploy/w2clean/infinicus-release-bea03e66/infinicus-platform/infrastructure/database/migrations/0220_normalize_access_event_tenant_context.sql
#   expected: 78a17188e4f01e7dbe78fb422578864345607c9a4eefeb30ea7f9913d1222472
```

Never reuse or overwrite `/home/deploy/w2clean/infinicus-release-ccadbf5`: it is the build source of the running image and the compose file of the rollback path.

### 4.2 Build

Preferred when memory allows (`free -m` shows ≥ 1.2 GB available and a `docker build` of the earlier release is known to have succeeded on this host):

```bash
cd /home/deploy/w2clean/infinicus-release-bea03e66/infinicus-platform/infrastructure/deployment/oci
GIT_SHA=bea03e66f00889fdfa6fa5aa69e3feaa3ee7b4e5 \
  docker compose -p oci --env-file /opt/infinicus/repo/infinicus-platform/infrastructure/deployment/oci/.env build api tools
```

(`tools` builds the same Dockerfile, as in the W2 release where `oci-api` and `oci-tools` carried one image id.) The build context is the export, not
`/opt/infinicus/repo`, so the real env files are not in it. If the VM cannot build safely, build the same export on a clean machine with the same
`GIT_SHA` build argument and move the image with `docker save | gzip` / `docker load`; record both image ids. A rebuilt image will have a different id from any
other build of the same commit (timestamps); the commit is identified by `INFINICUS_BUILD_SHA`, not by the image id.

### 4.3 Verify the built image (names only; prints no secret)

```bash
IMG=$(docker image inspect oci-api:latest --format '{{.Id}}')
echo "image id: $IMG"
docker run --rm --network none --no-healthcheck --entrypoint sh oci-api:latest -c 'echo "build sha: $INFINICUS_BUILD_SHA"'
#   expected: bea03e66f00889fdfa6fa5aa69e3feaa3ee7b4e5
docker run --rm --network none --no-healthcheck --entrypoint sh oci-api:latest -c \
  'find /repo -maxdepth 6 \( -name ".env" -o -name ".env.*" -o -name "*env-backup*" \) -not -name ".env.example" -not -path "*/node_modules/*"; echo "(search done)"'
#   expected: only "(search done)". Any path listed: do not deploy, escalate.
```

If the machine already runs the unchanged earlier release container, building does not affect it: the running container keeps its image until recreated.

## 5. Phase C — window opening (state changes; only inside the authorized window)

1. Re-run the read-only gate checks (G-1 to G-6) and compare with the recorded values (ledger 209/0209; unsafe policy; no long transactions or locks).
2. Pin the rollback image: `docker tag e94114e2a96d infinicus-api:rollback-pre-0220-ccadbf51`; then record
   `docker image inspect infinicus-api:rollback-pre-0220-ccadbf51 --format '{{.Id}}'` (must equal `sha256:e94114e2…ccf4`). Without this tag, a rebuild of
   `oci-api:latest` leaves the running image untagged.
3. Take an on-demand backup with the same command the timer uses (`systemctl cat infinicus-backup.service` shows it; read-only) and wait for
   `BACKUP COMPLETE`; then `check-backup-freshness.sh` must exit 0. WAL archiving is off (OO), so this backup is the recovery point.

## 6. Phase D — schema step (Procedure P of the design, adapted to the OCI containers)

```bash
EXPORT=/home/deploy/w2clean/infinicus-release-bea03e66/infinicus-platform
# pre-check: still the baseline, and no old transaction on the table (read-only)
docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' oci-postgres-1 psql -X -U admin_role -d infinicus -At \
  -c "select count(*)||'|'||max(filename) from public._migrations" \
  -c "select bool_or(pg_get_expr(polqual,polrelid) ilike '%nullif%') from pg_policy where polrelid='audit.access_events'::regclass" \
  -c "select count(*) from pg_stat_activity where datname='infinicus' and xact_start < now()-interval '30 seconds'"
#   expected: 209|0209_create_print_jobs.sql   f   0
# apply the unmodified file with a lock timeout (up to 3 attempts, 30 s apart, on "lock timeout"); the file has its own BEGIN/COMMIT
docker exec -i -e PGOPTIONS='-c lock_timeout=3s' oci-postgres-1 psql -X -v ON_ERROR_STOP=1 -U admin_role -d infinicus \
  < "$EXPORT/infrastructure/database/migrations/0220_normalize_access_event_tenant_context.sql"
# post-check (read-only)
docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' oci-postgres-1 psql -X -U admin_role -d infinicus -At \
  -c "select count(*)||'|'||max(filename) from public._migrations" \
  -c "select pg_get_expr(polqual,polrelid) from pg_policy where polrelid='audit.access_events'::regclass" \
  -c "select relrowsecurity, relforcerowsecurity from pg_class where oid='audit.access_events'::regclass"
#   expected: 210|0220_normalize_access_event_tenant_context.sql ; policy text contains NULLIF ; t|f
```

Do **not** run `migration-gate.sh`, `docker compose run tools` or `grant-app-role.sh` in this release (0220 creates no object and changes no privilege; the tools
container would be the wrong-tree hazard analysed in the design). Record the schema fingerprint after the step; the rehearsal value on a local PostgreSQL 16 build
was `c4d9f7f8aebfa5c8` (RH, expected, to be confirmed on production, not a pass criterion until reviewed).

## 7. Phase E — switch the API only

```bash
cd /home/deploy/w2clean/infinicus-release-bea03e66/infinicus-platform/infrastructure/deployment/oci
GIT_SHA=bea03e66f00889fdfa6fa5aa69e3feaa3ee7b4e5 \
  docker compose -p oci --env-file /opt/infinicus/repo/infinicus-platform/infrastructure/deployment/oci/.env up -d --no-deps api
```

Verify within two minutes: `docker compose -p oci … ps` shows `api` healthy; `curl -s https://api.infini-cus.com/v1/health` returns version
`bea03e66f00889fdfa6fa5aa69e3feaa3ee7b4e5`; `BASE_URL=https://api.infini-cus.com EXPECTED_BUILD_SHA=bea03e66f00889fdfa6fa5aa69e3feaa3ee7b4e5
infrastructure/deployment/scripts/smoke-test.sh` (from the export) passes; `docker logs oci-api-1 --since 10m` has no `LockoutStateUnavailable` and no
unexpected 5xx. No login experiments with real credentials. Caddy and Postgres are not recreated (`--no-deps`).

## 8. Rollback (decision order)

| Situation | Action |
|---|---|
| Schema step failed or timed out | Nothing changed (single transaction). Retry per §6 or stop. |
| New API unhealthy or errors after Phase E | Re-promote the pinned image: `docker tag infinicus-api:rollback-pre-0220-ccadbf51 oci-api:latest`, then from the **old** tree `cd /home/deploy/w2clean/infinicus-release-ccadbf5/infinicus-platform/infrastructure/deployment/oci && docker compose -p oci --env-file /opt/infinicus/repo/…/oci/.env up -d --no-deps --force-recreate api` (no build). Verify `/v1/health` shows `ccadbf51…`. The 0220 policy is backward compatible (rehearsed), so the schema stays. |
| 0220 itself must be reverted (should not be needed) | Only after the new API is removed: Procedure B of the design (one transaction: restore the original policy expression, delete the `0220` ledger row), then verify fingerprint `325158ea2a54cde9` and ledger 209. |
| Data loss or unknown state | Stop; restore from the on-demand backup of §5 per `RECOVERY_READINESS_PLAN.md`; owner decision. |

Stop conditions agreed with the rollback owner in advance: any failed pre-check; any non-empty env scan; a lock timeout after three attempts; unhealthy API after two
minutes; any 5xx spike on `/v1/auth/login`.

## 9. Release record (fill in at the window; keep with the release evidence)

| Field | Value |
|---|---|
| RC commit / archive sha256 / created by / when | |
| Image id built (`oci-api:latest`, `oci-tools:latest`) / build host | |
| Rollback image id and tag (`infinicus-api:rollback-pre-0220-ccadbf51`) | |
| Pre/post ledger and policy observations; post-step fingerprint | |
| On-demand backup key and freshness result | |
| Health version after Phase E; smoke-test result | |
| Start/end times, executor, rollback owner | |

## 10. Not part of this procedure

NEW-BDT-SIM-01 and migrations 0210–0219; the audit least-privilege work (AUDIT-LP-1); credential rotation and image cleanup (see the hygiene plan); any change to
`grant-app-role.sh`; any change to frozen contracts.
