# AUTH-LOCKOUT-1 — Production Hygiene Remediation Plan (environment files, historical images, credentials)

Status: PLAN FOR THE OWNER. Nothing here was executed. No secret value was read or printed, no permission was changed, no image was removed or retagged and no credential
was rotated in producing this document. Every state-changing command below is for the owner to run, in an order the owner chooses, outside the release window unless stated.
Labels: VR = VERIFIED — REPOSITORY, RH = VERIFIED — REHEARSAL (disposable local infrastructure, dummy files), OO = OWNER-OBSERVED — PRODUCTION (operator output, not
independently verified), INF = INFERRED, UV = UNVERIFIED.
Related: `RELEASE_BUILD_AND_DEPLOY_PROCEDURE.md` (corrected release build), SEC-DOCKER-1 (`.dockerignore` fix and tests, separate PR), `RECOVERY_READINESS_PLAN.md`.

## 1. Findings

| ID | Finding | Class | Severity (provisional) |
|---|---|---|---|
| H1 | The retained image `oci-api:rollback-20261014` (id `ee6e44c5b7b2`, created 2026-10-04) contains a real `/repo/infrastructure/deployment/oci/.env`. The running image and the three other retained API images contain only `.env.example` files. | OO | MEDIUM if the image never left the host; HIGH–CRITICAL if it did (§3) |
| H2 | Root cause (reproduced): `.dockerignore` patterns were anchored at the build-context root, so `COPY . .` copied nested env files; builds from a tree that contained `infrastructure/deployment/oci/.env` baked it in. Reproduced with dummy files and a real image build: 3 dummy files leaked before the fix, 0 after (SEC-DOCKER-1). | RH | explains H1 |
| H3 | Two environment backup files are mode 664 (group/world readable): `/opt/infinicus/repo/infinicus-platform/infrastructure/deployment/oci/.env.backup-before-preview-cors` (2026-10-01) and `/home/deploy/infinicus-oci-env-backup-20261014T185738Z`. The live `.env` is mode 600. Contents were not read. | OO | LOW–MEDIUM (single operator account observed logged in) |
| H4 | The first file is also an untracked file inside the Git working tree and inside a Docker build context if anyone builds from `/opt/infinicus/repo`. | OO | MEDIUM (process risk) |
| H5 | `/home/deploy/.bash_history` is 135 KB (mode 600) and may contain pasted secrets; `/home/deploy/.git-credentials` (mode 600) holds a stored Git credential in plain text. | OO | LOW–MEDIUM, observation only |
| H6 | Leftovers recorded in the W2 execution record: temporary copies of encrypted backup objects (`~/proof-objects` on the VM, `~/w2src/proof` on the owner's PC); rejected CRLF folders (renamed `*-REJECTED-*`) and their archives; untagged image `9eec2a2e8c71`; exited test containers `infinicus-api-smoke-test` and `infinicus-restore-test-db` (the latter OOM-killed). Not re-verified in RP-12B (the listing was a partial top-level view). | VR / UV | LOW |

Credential names that were present in the production `.env` (names only, OO): `ANTHROPIC_API_KEY`, `POSTGRES_ADMIN_PASSWORD`, `POSTGRES_APP_PASSWORD`, `RESEND_API_KEY`, `SUPABASE_ANON_KEY`
(plus non-secret settings `SUPABASE_URL`, `CORS_ALLOWED_ORIGINS`, `EMAIL_FROM_ADDRESS`, `EMAIL_VERIFICATION_URL_BASE`, `LOG_LEVEL`). Which of them were present in the
2026-10-04 `.env` inside the image, and whether their values are still the current ones, is UV (§2.2).

## 2. Assessing the actual exposure (read-only; the owner runs these; they print names and yes/no only)

### 2.1 Did the image leave the host?

```bash
IMG=oci-api:rollback-20261014
docker image inspect "$IMG" --format 'id={{.Id}} created={{.Created}} tags={{json .RepoTags}} repoDigests={{json .RepoDigests}}'
#   repoDigests = [] suggests it was never pulled from or pushed to a registry; a non-empty entry names the registry it came from or went to
python3 -c 'import json,os;p=os.path.expanduser("~/.docker/config.json");d=json.load(open(p)) if os.path.exists(p) else {};print("registries with stored login:",sorted((d.get("auths") or {}).keys()))'
grep -c -E 'docker +(push|save|export|login)' ~/.bash_history        # a count only; do not print the lines
find /home/deploy /tmp /var/tmp -maxdepth 3 \( -name '*.tar' -o -name '*.tar.gz' -o -name '*.tgz' \) -size +50M -printf '%TY-%Tm-%Td %s %p\n' 2>/dev/null
docker ps -a --filter "ancestor=$IMG" --format '{{.Names}} {{.Status}}'
```

Interpretation: no registry digest, no stored registry login for a third party, no push/save/export in history, no archive that could hold the image, and no container using it
= **host-local** (tier T0). Anything else moves the finding up a tier (§4) and is flagged for immediate security review.

### 2.2 Which credentials were in that file, and are they still in use? (no values printed)

```bash
python3 - <<'PY'
import re, subprocess
def parse(t):
    d = {}
    for l in t.splitlines():
        m = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)=(.*)$', l)
        if m: d[m.group(1)] = m.group(2)
    return d
img = subprocess.run(['docker','run','--rm','--network','none','--no-healthcheck','--entrypoint','cat','oci-api:rollback-20261014',
                      '/repo/infrastructure/deployment/oci/.env'], capture_output=True, text=True).stdout
cur = parse(open('/opt/infinicus/repo/infinicus-platform/infrastructure/deployment/oci/.env').read())
old = parse(img)
for k in sorted(set(old) | set(cur)):
    state = 'only-in-image' if k not in cur else 'only-in-current' if k not in old else ('SAME' if old[k] == cur[k] else 'DIFFERENT')
    print(f'{k:36s} {state}')
PY
```

The script compares in memory and prints only variable names with `SAME` / `DIFFERENT` / `only-in-…`. Run the same comparison for each of the two backup files by replacing the
image read with `open('<file>').read()`. A credential that is `SAME` as today's value and was in a file that left the host is exposed; one that is `DIFFERENT` is historical (still
review whether the old value is still accepted by the provider).

## 3. Credential rotation guidance (decision matrix; nothing is rotated by this plan)

| Credential | Used by | Rotation mechanics (each a separate, owner-authorized production change) | Notes |
|---|---|---|---|
| `POSTGRES_APP_PASSWORD` | `app_role` connection string of the API | `ALTER ROLE app_role PASSWORD …` in the database **and** the `.env` value, then restart the API only; brief API interruption | The postgres image applies `POSTGRES_PASSWORD` only at first initialization (init script creates the role), so changing `.env` alone changes nothing in the database |
| `POSTGRES_ADMIN_PASSWORD` | `admin_role` (superuser) used by tools/maintenance; local socket authentication inside the container is trusted | `ALTER ROLE admin_role PASSWORD …` and the `.env` value; check first which jobs (backup job, tools container) authenticate with it (UV) | highest impact if exposed; verify network exposure: `postgres` is not published on the host (compose `expose` only, OO) |
| `ANTHROPIC_API_KEY` | API runtime | create a new key in the provider console, update `.env`, restart the API, revoke the old key, review provider usage for the exposure period | revocation is immediate on the provider side |
| `RESEND_API_KEY` | API email sending | same pattern at the provider; confirm sender domain unaffected | |
| `SUPABASE_ANON_KEY` | API config; this key is a public client key by design | rotation (JWT secret) is disruptive and rarely warranted; rotate only if a service-role or secret key was ever in a leaked file (not in the name list) | |

Tiers and actions:
- **T0 host-local** (§2.1 clean): rotation is not required for confidentiality unless the host itself is believed compromised; do the hygiene steps (§5) and keep the evidence of the assessment.
- **T1 shared or pushed to a private registry or sent to a third party**: rotate every credential that §2.2 shows as `SAME`, in the order database passwords, provider keys; treat as a security incident review.
- **T2 public or unknown destination, or evidence of third-party access**: **flag for immediate security review**, rotate everything that was in the file at once regardless of `SAME`/`DIFFERENT`, review provider and database logs for misuse.
No tier is assigned in this document: the facts for §2.1 and §2.2 are not available (UV).

## 4. Permissions (owner action; reversible)

```bash
ls -l /opt/infinicus/repo/infinicus-platform/infrastructure/deployment/oci/.env.backup-before-preview-cors /home/deploy/infinicus-oci-env-backup-20261014T185738Z    # before
chmod 600 /opt/infinicus/repo/infinicus-platform/infrastructure/deployment/oci/.env.backup-before-preview-cors /home/deploy/infinicus-oci-env-backup-20261014T185738Z
ls -l /opt/infinicus/repo/infinicus-platform/infrastructure/deployment/oci/.env.backup-before-preview-cors /home/deploy/infinicus-oci-env-backup-20261014T185738Z    # after: -rw-------
```

Longer term: keep env backups outside any Git working tree or build context (for example a mode-700 directory under the deploy user's home), and delete them when the owner confirms they are
no longer needed. The `.git-credentials` token and the shell history are the owner's call (scope the token, use a credential helper, clear or review the history).

## 5. Historical images and what must be preserved

| Image (OO ids) | Role | Env files | Keep? |
|---|---|---|---|
| `oci-api:latest` / `oci-tools:latest` `e94114e2a96d` (running, `ccadbf51`) | the real rollback target for this release; **pin it with a new tag first** (`infinicus-api:rollback-pre-0220-ccadbf51`) | `.env.example` only | **Keep** |
| `infinicus-api:rollback-pre-0202` `f55bbfa6e73a` | the previous release | `.env.example` only | Keep until the release is complete and stable |
| `infinicus-api:candidate-20261014` = `…rollback-pre-0199` `4fba8110ac9c` | older release | `.env.example` only | Keep for now (owner decision later) |
| `oci-api:rollback-20261014` `ee6e44c5b7b2` | tagged as a rollback image, but created 2026-10-04 and judged unreliable as a rollback target by the 0199–0201 readiness report (G6, "tag says 20261014 but created 2026-10-04") | **real `.env`** | Not a dependable rollback; **candidate for removal** once the conditions below hold |
| untagged `9eec2a2e8c71` (built from the rejected CRLF export, W2 record) | none | not assessed | prune later |

Removal conditions for `oci-api:rollback-20261014` (all must hold): the release is complete and the new rollback image is pinned and verified; the rollback owner confirms no procedure
depends on it; §2.1 was answered and recorded; no container uses it. Then `docker rmi oci-api:rollback-20261014` (the layers holding the file are unique to that image and are freed).
Removal does not undo any exposure that already happened; it only ends the on-host residue.

## 6. Ordered plan for the owner

1. Run §2.1 and §2.2; record the answers (no values). If anything points beyond the host: stop here and escalate (T1/T2, §3).
2. `chmod 600` the two env backup files (§4) — safe at any time.
3. Complete the AUTH-LOCKOUT-1 release first, with the rollback image pinned; do not change images, credentials or `.env` during the release window.
4. After the release is stable: decide on removal of `oci-api:rollback-20261014`, the W2 leftovers (H6) and the exited test containers.
5. Rotate credentials according to the tier (§3), each as its own change with its own backup and verification, never in the same window as a release.
6. Adopt the SEC-DOCKER-1 `.dockerignore` on `main` so future builds from any tree cannot carry env files, and keep building from hashed, env-free exports.

## 7. Owner decisions

1. Run the §2 assessment and share the yes/no outcomes (never values).
2. Approve `chmod 600` on the two files (and whether the repo-tree backup should be moved or deleted).
3. Approve removal criteria for `oci-api:rollback-20261014` and the other leftovers.
4. Decide the rotation tier and sequencing after §2 (or accept the T0 conclusion in writing).
5. Decide what to do with `.git-credentials` and the shell history.
