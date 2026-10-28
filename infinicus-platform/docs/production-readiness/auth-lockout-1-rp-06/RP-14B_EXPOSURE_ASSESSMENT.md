# AUTH-LOCKOUT-1.RP-14B — Historical Image and Credential Exposure Assessment

Status: **ASSESSMENT FROM AVAILABLE EVIDENCE; owner-run checks outstanding.** No secret value was read or printed, no production file or image was touched, no image was
exported for inspection, no credential was rotated. The conclusions below are bounded by evidence that is owner-observed, repository-derived, or inferred; the single
check that decides the exposure tier (whether the image ever left the host) has not been run.
Labels: VR = VERIFIED — REPOSITORY, RH = VERIFIED — REHEARSAL (disposable local Docker, dummy files), VC = VERIFIED — CI, OO = OWNER-OBSERVED — PRODUCTION (operator output,
not independently verified here), INF = INFERRED, UV = UNVERIFIED.
Baseline: `main` at `01973fd3`; release candidate `bea03e66f00889fdfa6fa5aa69e3feaa3ee7b4e5` (VR).

## 1. Historical image inventory (OO, RP-12A/RP-12B)

| Tag(s) | Image id | Created (UTC) | Real `.env` in image | Role |
|---|---|---|---|---|
| `oci-api:latest`, `oci-tools:latest` | `e94114e2a96d` | 2026-10-21 14:01:46 | **no** — only `.env.example` files | running API (`ccadbf51`); the real rollback target |
| `infinicus-api:rollback-pre-0202` | `f55bbfa6e73a` | 2026-10-18 19:13:28 | no | previous release |
| `infinicus-api:candidate-20261014` = `…:rollback-pre-0199` | `4fba8110ac9c` | 2026-10-14 21:01:25 | no | older release; two exited test containers use it |
| `oci-api:rollback-20261014` | `ee6e44c5b7b2` | 2026-10-04 03:09:56 | **yes** — `/repo/infrastructure/deployment/oci/.env` | historical; the tag date (14 Oct) does not match the creation date (4 Oct) and the 0199–0201 readiness report already judged it unreliable as a rollback image (G6) |
| untagged `9eec2a2e8c71` (built from a rejected CRLF export) | — | — | not assessed | listed in the W2 record for later pruning; not in the RP-12A image listing (UV whether it still exists) |

Only one image carries a real environment file. The affected file is a runtime configuration file for the compose stack, not application code.

## 2. Provenance and distribution of the affected image

| Question | Evidence | Answer |
|---|---|---|
| How did a real `.env` get into the image? | VR: the Dockerfile copies the whole workspace (`COPY . .`), and the pre-fix `.dockerignore` excluded env files only at the build-context root. RH: with the old file a build whose context contained `infrastructure/deployment/oci/.env` put that file in the image (3 of 3 dummy files leaked; 0 after SEC-DOCKER-1). | root cause **established** |
| Where was it built? | INF: created 2026-10-04 03:09:56Z, the date of the first VM setup artifacts (`turbo-full.log` 03:37, `.git-credentials` 03:25, both on the VM); the repo's later practice (from 2026-10-19) is to build release images on a laptop from a clean worktree because the VM is too small. | **most likely built on the VM** from `/opt/infinicus/repo`, where `oci/.env` lives |
| Is there a documented route that pushes images to a registry? | VR: no `docker push`, `docker login` or registry host appears in the repository's deployment documents or workflows; the CI image job states it builds and smoke-tests without publishing and that no registry is configured (BUILD-23 known limitations). | none documented |
| Is there a documented route that exports images? | VR: yes for **release** images — `docker save` on the laptop, `scp`, hash check, `docker load` on the VM (Phase W and W2 plans) — direction laptop → VM. These release images are the clean ones. | not applicable to the VM-built affected image on the documented path |
| Was this image pushed, exported, copied or shared? | UV. No registry digest, registry login, history or archive evidence has been collected; the check is in §6 (section A of the pack). | **unknown** |
| Is it needed for rollback? | VR/OO: no. The running image `e94114e2` is the rollback target (to be pinned); the three other API images are older releases. | not required |
| Are secrets present in layers? | OO: the `.env` file is present in the runtime image (it arrives through `COPY . .` in the build stage and `COPY --from=build /repo /repo` in the runtime stage); layer-by-layer content was not inspected and must not be exported. | yes for the file; layer detail UV |

## 3. Sensitive file presence (paths only, no contents)

| Image | Env-like files found (OO) |
|---|---|
| `oci-api:latest` (running) | `/repo/.env.example`, `/repo/apps/web/.env.example`, `…/hetzner/.env.example`, `…/oci/.env.example` |
| `infinicus-api:rollback-pre-0202` | same four `.env.example` files |
| `infinicus-api:candidate-20261014` | three `.env.example` files |
| `oci-api:rollback-20261014` | three `.env.example` files **and** `/repo/infrastructure/deployment/oci/.env` |

The `.env.example` templates are tracked in the repository and contain placeholders (VR).

## 4. Credential risk classification (no values were read)

Names in the production compose `.env` (OO, RP-12A): `ANTHROPIC_API_KEY`, `POSTGRES_ADMIN_PASSWORD`, `POSTGRES_APP_PASSWORD`, `RESEND_API_KEY`, `SUPABASE_ANON_KEY`, plus non-secret settings
(`SUPABASE_URL`, `CORS_ALLOWED_ORIGINS`, `EMAIL_FROM_ADDRESS`, `EMAIL_VERIFICATION_URL_BASE`, `LOG_LEVEL`). Which of these were present in the 2026-10-04 file inside the image, and whether
their values equal today's, is UV (the comparison is section C of the pack). The live `.env` was rewritten on 2026-10-14 19:21; the env backup in the repository folder dates from
2026-10-01 and the one in the home directory has a modification time of 2026-10-09 (name stamped 2026-10-14), so up to three different generations of the file may exist.

| Credential category | Items (names) | Classification now | Basis | Rotation | Interruption if rotated |
|---|---|---|---|---|---|
| PostgreSQL credentials | `POSTGRES_APP_PASSWORD`, `POSTGRES_ADMIN_PASSWORD` | **Present in a locally retained artifact only** (INF); equality with current values **Unknown** | file in a VM-built image; no distribution evidence; database not published on the host (compose `expose` only, OO) | not required on current evidence; **required if** the pack shows exposure beyond the host and the values are `SAME` as today's | app role: brief API interruption (role password + `.env` + API restart); admin role: check dependents first (backup job, maintenance containers) — UV |
| Third-party API keys | `ANTHROPIC_API_KEY` | same: local artifact only (INF); equality Unknown | same | same trigger; revoke at the provider after replacing | API restart |
| Email service credentials | `RESEND_API_KEY` | same | same | same trigger | API restart |
| Authentication secrets | `SUPABASE_ANON_KEY` (public client key by design); no JWT secret or service-role key is among the names | **Not affected** in the sense of secrecy; rotation not warranted | name list (OO) | not recommended | would be disruptive for clients |
| Cloud infrastructure credentials | none in the compose `.env` names. The backup store credential lives in the backup tooling's own configuration (`/etc/infinicus/backup.env`, S3/rclone configuration), not in this file (INF) | **Not affected** by this artifact on name evidence | name list + backup tooling design (VR) | n/a | n/a |
| Other runtime configuration | CORS origins, sender address, verification URL base, log level, proxy trust | **Not secret** | — | n/a | n/a |

**Confirmed exposed beyond authorized storage: none established.** **Urgent finding: none** on current evidence. The classification changes automatically with the pack output:
registry digest or third-party registry login, a `docker push/save/export` count above zero followed by an archive found, or any third-party access evidence moves the affected categories
to **Potentially exposed** (tier T1) or **Confirmed exposed** (tier T2); T2 is flagged for immediate security review and rotation of everything in the file, as already stated in
`PRODUCTION_HYGIENE_PLAN.md` §3. Rotation is not performed by any RP-14 step.

## 5. Environment backup files with mode 664 (OO)

| File | Owner:group, mode | Size | Modified | Note |
|---|---|---|---|---|
| `/opt/infinicus/repo/infinicus-platform/infrastructure/deployment/oci/.env.backup-before-preview-cors` | `deploy:deploy`, `-rw-rw-r--` | 1815 B | 2026-10-01 03:21 | untracked file inside the Git working tree and inside any build context rooted there |
| `/home/deploy/infinicus-oci-env-backup-20261014T185738Z` | `deploy:deploy`, `-rw-rw-r--` | 1860 B | 2026-10-09 18:00 (name says 14 Oct) | a copy, apparently with the original timestamp preserved |
| live `…/oci/.env` (for comparison) | `deploy:deploy`, `-rw-------` | 2121 B | 2026-10-14 19:21 | correct |

Local exposure: the files are group-writable and **world-readable** to any local account; the host shows one interactive account in use (`Users logged in: 0` at login, `deploy` sessions in
the outputs). Whether other interactive accounts exist, who logged in, and whether files were read cannot be established from the evidence: file reads are not audited unless `auditd`
is active (UV) and the SSH auth log gives login counts only. Section D of the pack collects: file metadata, interactive accounts, accepted-login counts per user (no addresses), auditd state.

**Minimal remediation (owner executes, reversible, not executed here):**
`chmod 600 /opt/infinicus/repo/infinicus-platform/infrastructure/deployment/oci/.env.backup-before-preview-cors /home/deploy/infinicus-oci-env-backup-20261014T185738Z`, then `ls -l` on both
(expect `-rw-------`). Longer-term location and deletion decisions are in `PRODUCTION_HYGIENE_PLAN.md` §4–§5.

## 6. SEC-DOCKER-1 verification against the authoritative `.dockerignore` (VR / RH / VC)

- `main` @ `01973fd3`: the committed `.dockerignore` is byte-identical to the SEC-DOCKER-1 PR head (VR).
- `packages/event-worker/tests/dockerBuildContext.architecture.test.ts` on that `main`: **5 passed, 0 failed, 0 skipped** with a Docker daemon, including a real BuildKit build whose exported
  file set equals the matcher's prediction (RH).
- Reported mutant results from the PR (drop `**/.env.*`, drop the `.env.example` negation, drop the backup pattern, revert to the old patterns): all caught (RH, recorded in the PR).
- A real image build with a poisoned context (dummy `.env`, `.env.backup-before-preview-cors`, `*env-backup*`) contained all 3 files before the fix and none after (RH, recorded in the PR).
- CI on the PR, including the image build and smoke job, passed on its second attempt; the first attempt failed on an unrelated shared-database test race (VC).
- Scope limit: the **release candidate's own** `.dockerignore` is the old one. The RC image must be built from an env-free export and scanned (corrected release procedure §4); SEC-DOCKER-1 protects builds from `main`.

## 7. Recommended remediation (nothing performed)

1. Run the owner pack (below, section list A–D) and send the output: it decides the exposure tier.
2. `chmod 600` the two backup files (any time).
3. After the release is complete and the new rollback image is pinned: remove `oci-api:rollback-20261014` under the conditions in `PRODUCTION_HYGIENE_PLAN.md` §5.
4. Rotate according to the tier; each rotation is its own authorized change with its own backup and verification, never inside a release window.
5. Keep building from hashed, env-free exports and keep SEC-DOCKER-1 in place.

## 8. Owner pack and decisions

`rp14b-owner-pack.sh` (this folder; sha256 in the PR description) is read-only: it prints metadata, variable **names** with `SAME`/`DIFFERENT`/`only-in-…`, counts and yes/no — it
never prints a value (checked with sentinel dummy values: 0 occurrences in the output). Run as `deploy` on the VM: `bash rp14b-owner-pack.sh 2>&1 | tee "rp14b-$(date -u +%Y%m%dT%H%M%SZ).txt"`.

Decisions required: (1) run the pack and share the output; (2) approve `chmod 600`; (3) after the output, accept the T0 conclusion in writing or choose T1/T2 handling; (4) approve removal
criteria for the historical image; (5) decide on the shell history and the stored Git credential noted in `PRODUCTION_HYGIENE_PLAN.md`.
