# AUTH-LOCKOUT-1.RP-15 — Reconciliation of the RP-14B Owner Pack Output and Release Decision

Status: EVIDENCE RECONCILIATION ONLY. Production verdict: **NO-GO.** Nothing was executed on production by the coding environment; no secret value was read or printed (the pack prints names and yes/no only).
Labels: OO = OWNER-OBSERVED — PRODUCTION (operator-run output, 2026-10-28T16:01:52Z–16:01:55Z, user `deploy`; not independently verified here), VR = VERIFIED — REPOSITORY,
INF = INFERRED, UV = UNVERIFIED, BL = BLOCKED.
Inputs: `rp14b-owner-pack.sh` (sha256 `e55ad2b0…bf8c`, verified by the operator before running) and `RP-14B_EXPOSURE_ASSESSMENT.md`. Baseline: `main` @ `a2654acf`; RC `bea03e66f00889fdfa6fa5aa69e3feaa3ee7b4e5`.

## 1. What the output shows (OO)

| Question | Observation | Reading |
|---|---|---|
| Image identity | `oci-api:rollback-20261014` = `sha256:ee6e44c5…fa56`, created 2026-10-04T03:09:56Z, tag applied 2026-10-14T19:31:57Z; no container uses it | matches the earlier inventory; the 14 Oct date is the tagging time |
| Pushed to a registry? | `repoDigests = ["oci-api@sha256:ee6e44c5…"]` — the repository part is the bare local name `oci-api`; no registry host appears. No stored registry login (`auths` empty, no credential store or helpers) | consistent with a local-only image (INF). A pulled or pushed image would carry a registry path in its digest reference |
| Env configuration baked into the image | names: `PATH`, `NODE_VERSION`, `YARN_VERSION`, `NODE_ENV` | no secret in the image configuration; the secrets are only in the copied file |
| Shell history of `deploy` (counts only) | `docker push` 0, `docker save` 0, `docker export` 0, `docker login` 0, `docker image save` 0, `scp … oci-image` 0, `rclone … (copy|sync)` **2** (the pack printed a stray `n/a` after each zero because of a cosmetic bug in the counting line, fixed in this PR; the zeros are real) | no export or push command in this account's history; the 2 `rclone` lines are not yet reviewed |
| Archives over 50 MB (home, `/tmp`, `/var/tmp`) | none | no image archive remains on disk (the earlier `oci-image-ccadbf5.tar.gz` is also absent) |
| Env-like files in images | affected image: `.env` + `.env.example`; running image and the other two: `.env.example` only | confirms the earlier finding; the running image is clean |
| Credential equality, image `.env` (2026-10-04) vs current `.env` | `POSTGRES_ADMIN_PASSWORD` **SAME**, `POSTGRES_APP_PASSWORD` **SAME**; `ANTHROPIC_API_KEY` **DIFFERENT**, `RESEND_API_KEY` **DIFFERENT**; `CORS_ALLOWED_ORIGINS` DIFFERENT (not secret); `EMAIL_FROM_ADDRESS`, `EMAIL_VERIFICATION_URL_BASE`, `LOG_LEVEL` SAME; `SUPABASE_URL`, `SUPABASE_ANON_KEY` only in the current file | the two database passwords in the artifact are today's live values; the provider keys in the artifact are old |
| Same comparison for the two env backups | identical outcome for the 2026-10-01 file; the home backup (mtime 2026-10-09) additionally has `CORS_ALLOWED_ORIGINS` SAME | the database passwords have not changed across at least 2026-10-01 → today |
| Permissions | current `.env` `-rw-------` deploy:deploy; both backups `-rw-rw-r--` deploy:deploy (1815 B, 1860 B) | confirms H3 |
| Local accounts | one interactive account: `deploy` (uid 1000), member of `sudo`, `users`, `docker` | the group `docker` is root-equivalent on the host; the world-readable bit adds little beyond service accounts |
| World-readable env-like files | only the two backups | — |
| Historical read evidence | `auditd` inactive; the SSH auth-log query returned nothing (log absent or not readable by `deploy`) | historical reads and logins are **not** establishable (UV) |

## 2. Classification after the output

| Category | Credentials | Classification | Why | Rotation |
|---|---|---|---|---|
| PostgreSQL | admin and app passwords | **Present in locally retained artifacts only** (INF, host-local). The artifact values equal today's live values. | no push/save/export/login, local-only digest reference, no archive, no container, one interactive account. Severity if the files ever left the host is limited by the network layout: the database is not published on the host (compose `expose` only, OO), so a password alone gives no remote path. | **Not required on current evidence.** Becomes required if the 2 `rclone` lines or another check show the file left the host. Discretionary hygiene rotation is the owner's call (the same value has lived in three files since at least 2026-10-01). |
| API provider key | `ANTHROPIC_API_KEY` | artifact value is **historical** (current value differs) | DIFFERENT | **Verify at the provider that the old key is revoked** (UV); if revoked: not affected |
| Email service key | `RESEND_API_KEY` | artifact value is **historical** | DIFFERENT | same: verify old key revoked |
| Authentication | `SUPABASE_ANON_KEY` | not in the artifact | only in the current file; public client key by design | none |
| Cloud infrastructure | backup-store credentials | not affected by these artifacts (not in this file by name evidence) | — | none |

**Confirmed exposed beyond authorized storage: none. Urgent finding: none.** The tier is T0 (host-local) on current evidence, **INFERRED, not proven**. Residual gaps that keep it from being
"confirmed": (a) the 2 `rclone … (copy|sync)` history lines are unreviewed (a copy/sync to the backup store or elsewhere); (b) the history of other accounts (root) and `journald` are not visible to `deploy`; (c) shell
history can be incomplete or edited; (d) provider-side revocation of the old keys is unchecked; (e) no log of who logged in and when.

## 3. Release-gate reconciliation

| Gate | Result after RP-14/RP-15 evidence |
|---|---|
| G-1 | PASS (identity) — rollback tag pinned inside the window (procedure W2). Unchanged. |
| G-2, G-3, G-5, G-6 | unchanged (re-check inside the window) |
| G-4 | **BLOCKED** — no restore proof; unchanged by this output |
| G-7, G-8, G-11 | unchanged (verified) |
| G-9 | owner confirmation pending (3 advisories) |
| G-10 | pending |
| G-12 | pending |
| Hygiene H1 (historical image) | **assessed — T0 host-local, INFERRED**; the residual checks below close it. Not a release gate by itself; the release procedure builds from an env-free export and scans the image. |
| Hygiene H3 (mode 664 backups) | **confirmed**; `chmod 600` pending the owner |

**Decision: NO-GO.** The hygiene findings are contained (no evidence of exposure beyond the host) and do not block the AUTH-LOCKOUT-1 release on their own. The release remains blocked by G-4 (recovery),
G-9 (written dependency exception), G-10 (authorization) and G-12 (window and rollback owner). Nothing in RP-15 converts a pending gate to PASS.

## 4. Remaining owner checks (all small; none rotates or deletes anything)

1. **Review the 2 `rclone` history lines** (redacted print): `grep -n -E 'rclone .*(copy|sync)' ~/.bash_history | sed -E 's/(--[a-z-]*(key|secret|pass|token)[a-z-]*[ =])[^ ]+/\1<redacted>/I' | cut -c1-200` — confirm they were backup-store operations, not a copy of an image or env file.
2. **Login history** (counts per account, no addresses): `last -w -F | awk 'NF{print $1}' | sort | uniq -c`; and whether other administrators have ever had access to the host (Hetzner console / key list).
3. **Provider consoles:** confirm the previous Anthropic and Resend keys are revoked.
4. **`chmod 600`** on the two backup files (reversible): command in `PRODUCTION_HYGIENE_PLAN.md` §4.
5. **Decide** the database-password question: accept T0 in writing, or rotate as hygiene (separate authorized change; plan in the hygiene document §3).
6. Optional: re-run the pack after step 4 to record `-rw-------`; the corrected pack in this PR has a new hash recorded in the PR description.

## 5. What this does not change

No change to the RC, the release procedure, the gate definitions or the CI exception. The restore proof (G-4) is still the owner-authorized step described in `RP-14A_RECOVERY_EVIDENCE.md` §6.
