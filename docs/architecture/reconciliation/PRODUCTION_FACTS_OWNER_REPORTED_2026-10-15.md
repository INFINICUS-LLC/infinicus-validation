# Production facts — owner-reported, not verified by Claude (2026-10-15)

**Purpose.** Several repository documents describe the production state as it stood on 2026-10-13 (live database at migration `0170`, no backup, no worker, running application SHA unidentified). The owner has since reported more recent operational progress. This record preserves those reports **as reported**, marks what is evidence and what is not, and lists the conflicts. It is not proof of system acceptance and records no secret or configuration value.

**Evidence labels.** `OWNER-REPORTED` = stated by the owner in the session, no artefact in the repository. `REPO-DOC` = stated in an older repository document. `VERIFIED-IN-REPO` = confirmed by reading the repository on 2026-10-15. Claude had no access to the server, database, Cloudflare or Supabase.

| # | Fact | Label | Conflict / note |
|---|---|---|---|
| 1 | Hetzner server `infinicus-prod-01` is the production host | OWNER-REPORTED; REPO-DOC (`VM_DISCOVERY_TASK_CLOSURE_2026-10-13.md`) | Consistent. |
| 2 | Primary Git remote on the server changed to `INFINICUS-LLC/infinicus-validation` | OWNER-REPORTED | No repo evidence. |
| 3 | Server `main` synchronised to `130bf5a` at the last verified checkpoint | OWNER-REPORTED | `130bf5a` exists on `origin/main` (VERIFIED-IN-REPO). The 2026-10-13 document recorded the server checkout at `ba1979e` with containers not rebuilt. Newer than the repo doc. |
| 4 | PostgreSQL migrations through `0198` applied | OWNER-REPORTED | **Conflicts with** the 2026-10-13 REPO-DOCs (live head `0170`, 28 migrations behind). Repo head `0198` is VERIFIED-IN-REPO (contiguous). Which of `0171`–`0198` were applied, how, and the `grant-app-role.sh` step are not recorded. |
| 5 | Production database backup restored successfully in an isolated rehearsal | OWNER-REPORTED | **Conflicts with** `PARKED_PRODUCTION_BACKUP_AND_MIGRATION.md` (no production backup taken). The rehearsal date, backup method, target, row-count or hash comparison and tool output are not in the repository. Off-VM backup tooling is merged but documented as untested against real S3. |
| 6 | Updated API deployed and health-checked | OWNER-REPORTED | The running image / `GET /v1/health` version should be recorded (Gate C). |
| 7 | An invalid Supabase token is rejected with HTTP 401 | OWNER-REPORTED | Matches the designed behaviour of `POST /v1/auth/identity-exchange`. Fake-provider tests only in the repository. |
| 8 | Successful browser sign-in | OWNER-REPORTED | Implies `SUPABASE_URL` and `SUPABASE_ANON_KEY` are already available to the API. This overlaps owner Step 2; **open question**: were they already set? Which page version (legacy `index.html`) and hosting path served the page is unrecorded (Gate C). |

## What is still not established
- Gate A (project match of the Supabase configuration), Gate B (`LEGACY_AUTH_API`, `LEGACY_BUSINESS_API`, `EMAIL_MODE` in Cloudflare Production and Preview), Gate C (what serves `infini-cus.com`, auto-deploy behaviour, API version, `apps/web` hosting), Gate D (live test with an authorised test identity), Gate E (release procedure and rollback) of `AC-3_OPTION_B_OWNER_DECISION.md`.
- The event worker: not deployed according to REPO-DOC and the base compose files (no worker service, VERIFIED-IN-REPO); the owner has not reported otherwise. No execution activation is recorded.
- Backup freshness, offsite backup configuration and any restore-proof output.

## Rule
Until artefacts exist (command output, a dated note, an incident or deployment record), these facts stay OWNER-REPORTED. Repository documents that contradict them were **not** rewritten to match; this record is the reconciliation pointer. Live migration state must never be assumed from the repository head (Guardrail §XIX).
