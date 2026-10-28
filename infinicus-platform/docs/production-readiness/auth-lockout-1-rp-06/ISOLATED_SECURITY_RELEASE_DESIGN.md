# AUTH-LOCKOUT-1.RP-06 — Isolated Security Release Design

Status: DESIGN AND DOCUMENTATION ONLY. Nothing in this document has been executed against production.
Authorization scope: design, rehearsal on disposable local databases, documentation. No migration, deployment,
container restart, configuration change, backup operation or production login attempt was performed or is authorized by this file.

Related: `docs/production-readiness/ac3-r1-release-compatibility.md` (earlier release-compatibility precedent),
`infrastructure/deployment/hetzner/runbook.md` (normal release order), `infrastructure/backups/README.md`.

## 0. Evidence labels

| Label | Meaning |
|---|---|
| VERIFIED — REPOSITORY | read from Git objects in this repository |
| VERIFIED — REHEARSAL | executed by the author on a disposable local PostgreSQL 16 cluster and local checkouts; NOT production |
| VERIFIED — CI | observed in GitHub Actions |
| OWNER-OBSERVED — PRODUCTION | reported by the owner from the production host; not independently verified |
| INFERRED / UNVERIFIED | reasoning or unknown; must be closed by the checklist in section 6 |

Rehearsal results are evidence about the code and the SQL, not about production. Every production fact is OWNER-OBSERVED
or UNVERIFIED and is re-checked by gate G-1 to G-6 of the approval checklist.

## 1. Authentication-only release design

### 1.1 Problem

OWNER-OBSERVED — PRODUCTION: the running API is build `ccadbf51be90c35377e21b73ceda77a1d455a805` (commit #209, 2026-10-21);
the migration ledger head is `0209_create_print_jobs.sql`; `audit.access_events` carries policy `access_events_isolation` with an unguarded
`current_setting('app.tenant_id', true)::uuid` cast.

VERIFIED — REPOSITORY:
- `ccadbf51` treats a failed lockout read as "not locked" (fail-open, `AuthenticationService.login`).
- PR #348 (`984afb14`) makes that read fail closed (HTTP 503, `LockoutStateUnavailableError`); it embeds PR #349 / migration 0220, which makes the
  policy tolerate an empty `app.tenant_id`.
- `main` (10634e36 when checked) is 135 commits ahead of `ccadbf51` and ships migrations 0210–0219 and the NEW-BDT-SIM-01 hand-off route
  (`apps/api/src/app.ts` registers it unconditionally). Releasing from `main` is therefore not an authentication-only release.

VERIFIED — REHEARSAL: the hazard is real and depends on pool history. On a database built from the 0209 migrations, the DB-02 integration test
(`packages/database/tests/auth-lockout-tenant-context.integration.test.ts`) fails 4 of 6 tests with `invalid input syntax for type uuid: ""`
(reused pooled connection after a transaction-local `set_config('app.tenant_id', …, true)`); after 0220 it passes 6 of 6.
Consequence: today the lockout is silently skipped on affected requests (fail-open); the new code without 0220 would answer HTTP 503 on those requests.
0220 is therefore a hard prerequisite of the new code, and is backward compatible with the old code (section 4, M-5).

### 1.2 Composition of the release candidate

`RC = ccadbf51` plus exactly the AUTH-LOCKOUT-1 change set from `984afb14`, with one file dropped.

| Included (9 files, +215 / −18) | Purpose |
|---|---|
| `packages/authentication/src/AuthenticationService.ts`, `errors.ts`, `index.ts` | fail-closed lockout read, `LockoutStateUnavailableError` |
| `apps/api/src/errors.ts`, `apps/api/src/routes/auth.ts` | HTTP 503 mapping |
| `infrastructure/database/migrations/0220_normalize_access_event_tenant_context.sql` | policy correction + ledger row |
| `apps/api/tests/lockoutUnavailable.test.ts`, `packages/authentication/tests/lockoutUnavailable.test.ts` | contract tests |
| `packages/database/tests/auth-lockout-tenant-context.integration.test.ts` | live RLS proof |

Dropped: `packages/outcome-monitoring-runtime/tests/om-obs-1.architecture.test.ts`. That file does not exist at `ccadbf51`; `984afb14` only
added the exact-name exemption for 0220 to a guard that arrived later. Cherry-picking `984afb14` onto `ccadbf51` therefore produces exactly one
conflict (modify/delete) and it is resolved by deleting the file. VERIFIED — REHEARSAL.

The change set is stored as `auth-lockout-1-isolated-release.patch` next to this file (`git diff --cached --binary` of the resolved cherry-pick,
326 lines, sha256 `c899bd167cd6dc227044dae8236f5d88433fb757a024ada4972611ad8333de00`). It applies to `ccadbf51` with `git apply --index`.
The commit that will carry it does not exist yet; it is created by a separate authorized block (section 1.5).

Excluded, by design: every other commit between `ccadbf51` and `main`, in particular NEW-BDT-SIM-01 (#350) and its hand-off route, migrations
0210–0219, the OM/BO/OFF-1 feature work, and the `grant-app-role.sh` / `delete-tenant-data.mjs` changes made after `ccadbf51`.
Nothing in the RC reaches the Digital Twin, Simulation, OM, BO or POS code paths beyond what `ccadbf51` already contains.

### 1.3 Why this base

| Option | Result |
|---|---|
| Build from `main` | ships NEW-BDT-SIM-01 route and code written for a schema at 0219; against a 0209 database those paths are unverified. Rejected. |
| Build from `main` with the hand-off route disabled | still 135 commits and 0210–0219 expectations; large unreviewed delta. Rejected for this release. |
| **RC = `ccadbf51` + #348 change set** | the deployed revision plus 215 reviewed lines; schema step is exactly one migration. **Selected.** |

### 1.4 Provenance and build

- Build with the existing mechanism: `GIT_SHA=$(git rev-parse HEAD) docker compose build` from a clean tree (`deploy.sh` refuses a dirty tree and a
  non-40-hex SHA). `GET /v1/health` reports the SHA; `smoke-test.sh` compares it (`EXPECTED_BUILD_SHA`).
- The RC commit SHA must differ from `ccadbf51` and the release record must state: base `ccadbf51`, patch sha256 above, resulting commit SHA,
  resulting image ID/digest.
- The RC branch must not be merged to `main` (main already contains #348). It is a release branch only; after release the `main` line is
  unchanged and still carries 0210–0220.

### 1.5 Build block (not authorized yet)

A later, separately authorized block creates the release branch from `ccadbf51`, applies the patch, runs the validation matrix of section 4 in CI or on a
disposable host, and produces the image. This document authorizes none of that.

### 1.6 Rehearsal evidence for the RC

VERIFIED — REHEARSAL (scratch checkout of `ccadbf51` + patch, local PostgreSQL 16, database at 0209 + 0220, application role with the
`grant-app-role.sh` grants):
- `turbo run build --filter=@infinicus/api...`: 16 of 16 tasks successful.
- `packages/authentication`: 60 passed, 1 skipped.
- `apps/api` tests that call `/auth/login` (30 files): 420 passed, 7 skipped, 0 failed.
- DB-02 RLS integration test: 6 of 6 after 0220 (4 of 6 failing before 0220).
- Not run: lint, full repository suite, container image build, static-export and security gates (they run in CI on a real RC branch).

## 2. Isolated 0220 migration procedure

### 2.1 What 0220 is

Source (VERIFIED — REPOSITORY, sha256 `78a17188e4f01e7dbe78fb422578864345607c9a4eefeb30ea7f9913d1222472`):

```sql
BEGIN;
ALTER POLICY access_events_isolation ON audit.access_events
  USING (tenant_id IS NULL OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
INSERT INTO _migrations (filename) VALUES ('0220_normalize_access_event_tenant_context.sql') ON CONFLICT (filename) DO NOTHING;
COMMIT;
```

One policy expression changes. No table, column, data, privilege, trigger or index changes. Tenant-scoped rows stay invisible when the setting is
empty; tenantless rows (`tenant_id IS NULL`) stay visible, as before. The file is idempotent: re-applying changes nothing (rehearsed: the ledger keeps
exactly one row).

### 2.2 Procedure P (primary): apply the unmodified repository file by `psql`

Run by the database owner with `admin_role`, from a host that has the RC tree, after gates G-1 to G-9 pass.

1. Verify the file hash: `sha256sum infrastructure/database/migrations/0220_normalize_access_event_tenant_context.sql` equals the value above.
2. Pre-check, read-only: ledger is exactly 209 rows with maximum `0209_create_print_jobs.sql`, and the live policy text still contains
   `current_setting('app.tenant_id'::text, true))::uuid` without `NULLIF`.
3. Pre-check, read-only: no transaction older than 30 seconds holds or waits for a lock on `audit.access_events`
   (`pg_locks` joined to `pg_stat_activity`). Reason: section 2.4.
4. Apply with a lock timeout and stop on error:
   `PGOPTIONS='-c lock_timeout=3s' psql -X -v ON_ERROR_STOP=1 -d infinicus -f 0220_normalize_access_event_tenant_context.sql`
   (via the compose database service as `admin_role`; no password on the command line). On `lock timeout` retry up to 3 times, 30 s apart; if it still
   fails, stop and report. The file's own `BEGIN/COMMIT` makes a failure leave no change (rehearsed: a lock timeout leaves the policy unchanged).
5. Post-check, read-only: policy text contains `NULLIF`; ledger has 210 rows, maximum filename `0220_normalize_access_event_tenant_context.sql`,
   exactly one 0220 row; `relrowsecurity = true`, `relforcerowsecurity = false` (unchanged).
6. Do not run `grant-app-role.sh`: 0220 creates no object and changes no privilege. Do not run the migration gate / `tools` container (see 2.3).

Procedure R (alternative): run the RC's own `migration-gate.sh`. Because the RC tree contains migrations 0001–0209 plus 0220 only, the runner would
apply exactly 0220 (VERIFIED — REHEARSAL: "apply 0220 … Migration gate passed", ledger 210, second run applies nothing). Procedure R is
acceptable only if gate G-8 (tree check) passes, because the same command run from a `main` checkout would apply 0210–0219. Its weakness is that the
runner cannot take a controlled `lock_timeout`: `createPool` sets `options: -c statement_timeout=…` explicitly and whether a connection-string
`options` survives that is UNVERIFIED. Procedure P is therefore primary.

### 2.3 Ledger consistency

Rehearsed on a database built from the repository migrations to 0209:

| State | `count(*)` | max filename | id of 0220 | Fingerprint (`production-readonly-discovery.sh`, section 6) |
|---|---|---|---|---|
| baseline 0209 | 209 | `0209_create_print_jobs.sql` | — | `325158ea2a54cde9` = `MATCHES_REPOSITORY_0209_PG16` (equals the recorded production reference) |
| after 0220 (P or R) | 210 | `0220_normalize_access_event_tenant_context.sql` | 210 | `c4d9f7f8aebfa5c8` (no repository reference exists; this is the rehearsal value, to be re-verified) |
| after rollback (2.6) | 209 | `0209_create_print_jobs.sql` | — | `325158ea2a54cde9` (restored exactly) |

Consequences, all deliberate and documented:
- The ledger is no longer a prefix of the migration directory (0220 present, 0210–0219 absent). The runner has no prefix assumption: it builds a set
  of applied filenames and processes files in sorted order (`packages/database/src/migrate.ts`).
- `ledger_head` as used by `production-readonly-discovery.sh`, `backup-offsite.sh` and `restore-proof.sh` is `max(filename)`, so it reads `0220_…`
  and `ledger_count` reads 210. The profile `infrastructure/backups/expectations/production-pre-0210.profile` (head 0209, count 209, fingerprint
  `325158ea2a54cde9`) will no longer match a backup taken after the change. A new expectations profile (head 0220, count 210, the fingerprint
  observed on production after the change) must be reviewed and added in the same release record; a restore proof of a pre-change backup keeps
  using the old profile. Never loosen a rule to make a run pass (repository rule in the profile header).
- `_migrations.id` is a serial: the ids of later migrations are not in filename order (0220 holds id 210; the next ten files receive larger ids). The
  runner reads `ORDER BY id` but only builds a set, so order is irrelevant. Ids may also skip values (a repeated idempotent insert consumes a
  sequence value). Nothing may rely on id contiguity or on id order meaning filename order.

### 2.4 Locking and availability

VERIFIED — REHEARSAL: `ALTER POLICY` on `audit.access_events` conflicts with an open transaction that has read the table: with one reader open,
the statement was cancelled by `lock_timeout` after 2 s. A waiting DDL statement queues behind the reader and then blocks later logins that touch
the table (login reads and writes it), so an unbounded wait is itself an outage. Hence the pre-check (2.2 step 3), the 3-second timeout with
bounded retries, and execution in a low-traffic window. The statement itself is a catalog-only change and completes in milliseconds once the lock is held.

### 2.5 Future migration-runner behavior

VERIFIED — REHEARSAL (database at 0209 + 0220, runner of `main`): the next ordinary release applies 0210, 0211, …, 0219 in filename order and
skips 0220; final ledger 220 rows, maximum filename 0220. 0220 is never re-applied; 0210–0219 do not read or alter `audit.access_events`
(VERIFIED — REPOSITORY, grep of the DDL), so there is no ordering invariant between them and 0220. That later release remains subject to its own preconditions
(RLS migrations 0211/0212, constraint migrations 0214/0215/0219) and is outside this design.

Guard against the accident "right migration command, wrong tree": before any `migration-gate.sh` / `docker compose run --rm tools`, compare
the set of `*.sql` files in the checkout with the ledger (read-only). For this release the pending set must be exactly `{0220}`. Any other pending
file means the wrong tree is in use: stop.

### 2.6 Compatibility with the currently deployed API

VERIFIED — REHEARSAL: the unmodified `ccadbf51` build, against a database at 0209 + 0220, passes 70 of 72 tests (2 skipped, 0 failed) in
`api`, `security`, `ac3-r1-managed-logout`, `ac3-j3-identity-exchange` and 58 of 59 in `packages/authentication`. So migration-first is safe: the
old image keeps working after 0220, and an image rollback needs no schema action.

Note on rehearsal hygiene: a first attempt failed 48 + 29 tests because the scratch database had not received the application-role grants; after
`grant-app-role.sh` the same suites passed. That was a rehearsal setup error, not a product defect, and is recorded for honesty.

## 3. Rollback and recovery

| Failure | Action | Evidence |
|---|---|---|
| Migration step fails (lock timeout, error) | Nothing changed (single transaction). Investigate, retry per 2.2. | rehearsed |
| New API misbehaves after deploy (503s, errors) | Re-promote image `ccadbf51` (kept in the host image list — verify, gate G-7). Schema stays at 0220. | old build passes on 0220 |
| Policy must be reverted (should not be needed) | Procedure B below, then deploy the old image only if the new image is also being removed | rehearsed |
| Data corruption / unknown state | Stop; restore from the verified backup (G-4) following `infrastructure/database/scripts/restore.sh`; owner decision | not rehearsed here |

Never roll back by deleting the 0220 ledger row alone, and never run the old policy with the new API (that recreates the 503 hazard).

Procedure B (exact reverse, `admin_role`, one transaction; VERIFIED — REHEARSAL: restores fingerprint `325158ea2a54cde9`, ledger 209):

```sql
BEGIN;
ALTER POLICY access_events_isolation ON audit.access_events
  USING (tenant_id IS NULL OR tenant_id = current_setting('app.tenant_id', true)::uuid);
DELETE FROM _migrations WHERE filename = '0220_normalize_access_event_tenant_context.sql';
COMMIT;
```

Use `PGOPTIONS='-c lock_timeout=3s'` as in 2.2. Because the new API requires the NULLIF policy, run Procedure B only after the new image has been
removed.

Recovery order for a failed release: (1) stop traffic to the new image or re-promote `ccadbf51`; (2) verify `/v1/health` build SHA and a read-only
smoke test; (3) decide on Procedure B; (4) only for data loss, restore from the backup recorded at G-4. `docs/production-readiness/rollback-procedure-build23.md`
covers image re-promotion generally; it does not cover 0210–0220 (not needed by this release).

## 4. Non-production validation matrix

Run on a disposable PostgreSQL 16 database built from the repository migrations to 0209 (and, for the full set, from a restored copy of the
newest production backup — that restore is the owner's separately authorized step). Roles: an admin role and the application role with
`grant-app-role.sh` applied. "Rehearsed" = already executed by the author on a scratch database.

| ID | Check | Pre-0220 expected | Post-0220 expected | Status |
|---|---|---|---|---|
| M-1 | Baseline fingerprint of the scratch DB | `325158ea2a54cde9` | — | rehearsed, matches |
| M-2 | DB-02 RLS integration test (6 tests) | 4 fail with `invalid input syntax for type uuid: ""` | 6 pass | rehearsed |
| M-3 | Lockout count with unset tenant, empty tenant, reused connection, 12 concurrent reads, 4 reset connections | error on reused/empty | count correct (1) | covered by M-2 |
| M-4 | Cross-tenant isolation: tenant A cannot read/write tenant B rows; empty context cannot write a tenant row (SQLSTATE 42501) | — | enforced | covered by M-2 |
| M-5 | Old build `ccadbf51` suites (api, security, managed logout/exchange, authentication) against the post-0220 DB | n/a | all pass | rehearsed |
| M-6 | RC build: `tsc` build, authentication unit tests, `/auth/login` API tests (30 files) | n/a | all pass | rehearsed |
| M-7 | RC fail-closed contract: lockout read failure → 503, generic body, no password verification, no session | — | pass | covered by the two `lockoutUnavailable` tests |
| M-8 | RC against a PRE-0220 DB (negative control for the deploy-order rule) | expect intermittent 503 on reused connections | n/a | NOT RUN — run it once to document the failure mode |
| M-9 | Healthy lockout behavior unchanged: threshold 5 failures / 15 min, locked on correct password, unknown email never locks | pass | pass | in the 30-file run; re-run on the real RC commit |
| M-10 | Procedure P and Procedure R both yield ledger 210 / head 0220; second run is a no-op | — | pass | rehearsed |
| M-11 | Procedure B restores fingerprint `325158ea2a54cde9` and ledger 209 | — | pass | rehearsed |
| M-12 | Runner from `main` after 0220: applies exactly 0210–0219, skips 0220 | — | pass | rehearsed |
| M-13 | Lock behavior: `ALTER POLICY` blocks behind an open reader; `lock_timeout` cancels it cleanly | — | pass | rehearsed |
| M-14 | Fingerprint after 0220 recorded as the expected production post-state | — | `c4d9f7f8aebfa5c8` (local PG 16 build) | rehearsed; must be re-observed on a restored production copy |
| M-15 | Full repository CI on the RC branch (lint, typecheck, build, static export, secret leak, dependency allowlist/scan, migration gate, grants, tests, security gates, image build) | — | green | NOT RUN (needs the RC branch) |
| M-16 | Procedure P dry run on a restored copy of the newest production backup, incl. fingerprint comparison with the expected pre-state | — | pass | NOT RUN (owner-authorized restore needed) |
| M-17 | Real container smoke test: image build with `GIT_SHA`, `/v1/health` SHA equality, login 401/200 with a synthetic account on the disposable stack | — | pass | NOT RUN |

Open limitation: the local scratch PostgreSQL is not the production minor version (16.15 is OWNER-OBSERVED), and production data volumes are not
replicated. M-14 and M-16 close that gap.

## 5. Residual risks (named, not hidden)

| Risk | Status |
|---|---|
| Production state differs from the owner-observed baseline | UNVERIFIED — gates G-1…G-6 |
| Lock wait during 0220 | mitigated by 2.2 step 3–4; low traffic window recommended |
| Ledger gap (0220 present, 0210–0219 absent) confuses later tooling/restore proofs | documented in 2.3; new expectations profile required |
| RC differs from reviewed `main` code | the delta is the #348 change set only; stored as a hashed patch |
| Audit-write failures remain best-effort | unchanged; separate review (code comment in `AuthenticationService.recordAuditEvent`) |
| `audit.access_events` remains mutable by the application role | out of scope; AUDIT-LP-1 / AUDIT-AO-1 need owner approval and a retention decision |
| Backup freshness / restore proof | UNVERIFIED — G-4 |

## 6. Final production approval checklist

All items must be "yes" and recorded (who, when, output reference) before the production steps. Items marked (O) are owner-run read-only checks.

**A. Preconditions (read-only, owner)**
- G-1 (O) Running container is the expected image: `/v1/health` reports `ccadbf51be90c35377e21b73ceda77a1d455a805`; image ID recorded; previous image retained for re-promotion.
- G-2 (O) Ledger: 209 rows, maximum `0209_create_print_jobs.sql`, no 0210–0220; discovery fingerprint `MATCHES_REPOSITORY_0209_PG16`.
- G-3 (O) Live policy text equals the 0011 original (no `NULLIF`), `relrowsecurity` true, `relforcerowsecurity` false; `app_role` not superuser/bypassrls.
- G-4 (O) A backup taken after the last production write window exists, is fresh per `check-backup-freshness.sh`, and a restore proof (`restore-proof.sh`) passed against it; WAL archiving state recorded.
- G-5 (O) Application role has no access to `_migrations`; admin role confirmed for the migration step.
- G-6 (O) No transaction older than 30 s touching `audit.access_events` (pre-check of 2.2 step 3); maintenance window agreed.

**B. Artifact**
- G-7 RC branch exists, built from `ccadbf51`, patch sha256 matches this document, tree differs from `ccadbf51` only by the 9 listed files.
- G-8 Pending-migration check on the RC checkout lists exactly `{0220}`; `0220` file sha256 equals `78a17188…2472`.
- G-9 CI fully green on the RC commit (matrix M-15); matrix M-8, M-9, M-16, M-17 results attached; image built with `GIT_SHA`, digest recorded.

**C. Approvals (owner)**
- G-10 Owner approves: base, patch hash, Procedure P, rollback Procedure B, window, and the new expectations profile.
- G-11 Owner confirms NEW-BDT-SIM-01 is absent from the RC (diff check) and that no frozen contract changed.
- G-12 Rollback owner and communication path named; stop conditions agreed (any 5xx spike on `/v1/auth/login`, any unexpected ledger row).

**D. Execution order (separate authorization required, not given here)**
1. Take/confirm backup (G-4). 2. Procedure P (schema first). 3. Post-checks of 2.2 step 5. 4. Build/pull RC image, `docker compose up -d` of the API only.
5. `smoke-test.sh` with `EXPECTED_BUILD_SHA`; read-only verification of `/v1/health`; watch logs for `LockoutStateUnavailableError` and 503 rate (no production
login experiments with real credentials). 6. Record the release: SHAs, hashes, fingerprints, timings. 7. Add the new expectations profile.

**E. Explicitly out of this release**
Migrations 0210–0219, NEW-BDT-SIM-01 / SEC-01 (#352), AUDIT-LP-1, AUDIT-AO-1, any change to `grant-app-role.sh`, any change to frozen contracts.

## 7. Owner decisions required

1. Approve the RC composition (section 1.2) and authorize the build block (1.5).
2. Approve Procedure P as primary (R as fallback) and the 3 s timeout / 3 retries policy.
3. Approve the ledger-gap consequence and the new expectations profile (head 0220, count 210).
4. Name the maintenance window and the rollback owner.
5. Decide whether AUDIT-LP-1 / AUDIT-AO-1 and the later 0210–0219 release are scheduled as independent blocks.
