# Controlled live-migration review: 0170-0175 (READ-ONLY; nothing applied, nothing authorised)

Date: 2026-10-07. Target: Supabase project `infinicus-development` (ap-south-1, ACTIVE_HEALTHY, Postgres 17.6). Repo: `main` after #42 (migrations 0001-0175). Method: repository SQL read in full; live database inspected with SELECT/catalog queries only (no DDL, no DML, no migration tool used, no branch created). Row counts are reported, row contents were not read. **This review authorises no deployment.** Every finding below needs the owner's decision before any apply.

## 1. Verdict
**Not ready to apply as a blind run.** The six migrations are structurally compatible with the live data (every target object is absent, every added constraint is satisfied by existing rows, no existing row is rewritten except a 143-row generated-column add). But the review found items that must be resolved or consciously accepted first: (A) migration-ledger exposure, (B) no least-privilege application role on live so RLS is not exercised, (C) Postgres 17 vs the tested Postgres 16, (D) backup/PITR not verifiable from here, (E) required application deploy order, (F) behaviour change for pre-0174 recommendations.

## 2. Live state (read-only evidence)
| Check | Result |
|---|---|
| Applied ledger `public._migrations` | 169 rows, last `0169_add_manual_json_connector_type.sql` (0001-0169 contiguous by count). Supabase's own `list_migrations` is empty: INFINICUS uses its own ledger. |
| Ledger content hashes | **Not recorded**: only filenames. Live schema cannot be proven byte-identical to repo files 0001-0169 (see section 6). |
| Dev branches | none (no non-production rehearsal target exists) |
| Postgres | 17.6 live; CI and local validation ran 16 |
| WAL archiving | `archive_mode=on`, last archive 2026-10-07 20:16Z (11 files); `wal_level=logical` |

Target objects before apply (all absent as required): `approved_actions.source_recommendation_id` and its index (0170); `connectors.webhook_token_prefix/hash`, `connectors_webhook_token_pair_check`, `find_connector_for_webhook` (0171); `events.business_event_ledger` (0172; schema `events` exists); the four ADI columns (0174); the five ABA columns (0175).

Row counts: `approved_actions` 4, `connectors` 4, `events.outbox_events` 143 (all with tenant and workspace set), `inbox_events` / `dead_letter_events` / `event_subscriptions` / `event_delivery_attempts` 0, `decision_recommendation_versions` 22 (20 published), `action_review_package_versions` 11, review packages 15 (every one already has an approved decision), published or superseded Twin snapshots 31.

## 3. Per-migration review
| # | What it does | Locks / cost | Live compatibility | Reversible by |
|---|---|---|---|---|
| 0170 | adds nullable `approved_actions.source_recommendation_id` (FK to recommendations, ON DELETE SET NULL) and a partial index | brief; 4 rows | column absent; existing rows get NULL (honest, documented as unrecoverable) | drop index, drop column |
| 0171 | adds `connectors.webhook_token_prefix/hash`, a pair CHECK, a unique partial index, SECURITY DEFINER `find_connector_for_webhook` (pinned `search_path`, `REVOKE ALL FROM PUBLIC`) | brief; 4 rows | CHECK satisfied by NULLs; **plain `ADD CONSTRAINT` (not idempotent) is fine because the constraint is absent**; EXECUTE for the app role comes only from `grant-app-role.sh` | drop function, index, constraint, columns |
| 0172 | creates `events.business_event_ledger` (RLS enabled and forced, append-only trigger, idempotency unique index, FKs to tenancy and `platform.businesses`) | new table | additive; FKs target existing tables | drop table, function |
| 0173 | adds columns and generated `scope_type` to five `events.*` tables; adds CHECKs; makes `event_delivery_attempts` append-only; **enables and forces RLS on all five tables and replaces the two existing policies, adding three new** | `outbox_events` rewritten for the STORED generated column (143 rows, brief ACCESS EXCLUSIVE); policy swap | all five tables empty except outbox; the only existing CHECK it replaces (`event_subscriptions_status_check`) is dropped IF EXISTS and re-added; existing outbox rows have non-null workspace so all become `TENANT_WORKSPACE`; **but RLS posture changes materially (section 4B)** | forward-fix only (restore prior policies, see section 5) |
| 0174 | adds four nullable ADI columns, CHECKs, raise-only / published-immutable trigger on `decision_recommendation_versions` | brief; 22 rows | CHECKs satisfied by NULL; trigger fires on UPDATE only and ignores unchanged columns, so existing validate/publish updates are unaffected | drop trigger, function, constraints, columns |
| 0175 | adds five nullable ABA snapshot columns, risk CHECK, lineage FK (RESTRICT), partial index on the append-only `action_review_package_versions` | brief; 11 rows | adding columns does not touch the append-only trigger; existing rows keep NULLs | drop index, constraint, columns |
No migration contains a GRANT; `grant-app-role.sh` must be re-run after the migrations for the new table, columns and function.

## 4. Findings that need an owner decision
**A. The migration ledger is writable by public API roles (pre-existing, serious).** `public._migrations` has RLS disabled and `anon` and `authenticated` hold SELECT, INSERT, UPDATE, DELETE, TRUNCATE (Supabase advisor `rls_disabled_in_public`, level ERROR). The runner trusts this table to decide which files to skip. If the `public` schema is exposed through PostgREST (not verifiable from SQL: check Settings -> API -> Exposed schemas), anyone with the project's anon key could mark migrations applied or delete rows to force a re-run. Recommend: before any apply, verify exposure, then (as a separately authorised step) enable RLS and revoke those grants; never rely on the ledger as an integrity control. Also a SECURITY DEFINER emit function (`data_acquisition.emit_outbox_event`, owner `postgres`) is executable by `anon` and `authenticated`; 155 functions have mutable `search_path` (advisor WARN). Pre-existing; not changed by 0170-0175, but 0171 is the only one of these migrations that creates a SECURITY DEFINER function and it pins `search_path` correctly.

**B. Live has no least-privilege application role, so RLS is not exercised.** The role list contains no INFINICUS app role; the table owner is `postgres`, which has BYPASSRLS. 0173 enables and FORCEs RLS on five event tables, but a connection as `postgres` or `service_role` ignores it. Today `events.dead_letter_events`, `event_subscriptions` and `event_delivery_attempts` have RLS off and `outbox_events`/`inbox_events` have it on but not forced. Question for the owner: which role does the deployed API use as `DATABASE_URL`? Post-migration RLS smoke tests are only meaningful as a non-BYPASSRLS role created by the provisioning step (`CREATE ROLE ...` then `grant-app-role.sh`, as CI does). Creating that role is outside these migrations and is not authorised here.

**C. Postgres 17.6 vs 16.** All validation (local and CI) ran Postgres 16. Nothing in the six files uses version-specific syntax, but they have never executed on 17. Recommend a rehearsal on a restored copy or a Supabase branch (none exists; creating one is a billable action needing your decision) before touching the live database.

**D. Backup / recovery cannot be verified from the database.** WAL archiving is on and recent, which is consistent with Supabase-managed backups but is not proof of PITR or of a restorable daily backup. Owner to confirm in the dashboard: plan tier, PITR enabled, latest backup time, and perform a restore test or at least record the restore point immediately before the apply.

**E. Application deploy order.** The new application code writes the new columns when it creates a review version and reads them at approval. **Migrate first, then deploy the new application.** Old application + new schema is safe (all new columns nullable); new application + old schema fails at review creation. The migration gate runs `runMigrations()` under an advisory lock, so concurrent deploys serialise.

**F. Behaviour change after apply.** The 20 published recommendation versions and 11 review versions on live have NULL facts. All 15 existing review packages already hold approved decisions, so nothing pending becomes unapprovable today; any future approval of an old recommendation is blocked until recalculated, and rejection still works. Nothing is back-filled.

## 5. Forward-only rollback strategy (no down migrations exist)
Preferred: restore to the recorded point (PITR/backup) if the apply fails or misbehaves before new writes. Forward fixes if a restore is not wanted:
- 0174/0175/0172/0171/0170: additive; a new migration drops the added objects (listed in section 3). Do not edit or delete the applied files.
- 0173: forward migration that drops the new policies, drops the three added CHECKs and the append-only trigger, optionally disables FORCE RLS, and **recreates the two original policies exactly as captured live before the apply**:
  - `inbox_events_isolation` ON `events.inbox_events` FOR ALL TO public USING `(tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)`
  - `outbox_events_isolation` ON `events.outbox_events` FOR ALL TO public USING `(tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)`
  (the five tables previously: `dead_letter_events`, `event_delivery_attempts`, `event_subscriptions` RLS off; `inbox_events`, `outbox_events` RLS on, not forced). Added columns can stay.
- Remove the matching rows from `public._migrations` only through the migration process, and only after the schema change is actually reverted.

## 6. Recommended order and per-step validation (for the owner to authorise; not executed)
0. Pre-flight: owner confirms D, decides A, B, C; record backup/restore point; re-run the read-only checks in section 2 immediately before the apply (state may drift); freeze other deployments.
1. Rehearse 0170-0175 on a restored copy or branch (Postgres 17.6) with `migration-gate.sh`, then `grant-app-role.sh`, then the post-migration checks below.
2. Apply on live with `migration-gate.sh` (admin `DATABASE_URL`); it applies in filename order, each file in its own transaction. Validate after each file (or at minimum after the run): ledger contains the file; 0170 column and index exist; 0171 columns, constraint, function exist and `has_function_privilege('anon', ..., 'EXECUTE')` is false; 0172 table exists with RLS enabled and forced; 0173 `scope_type` exists on five tables, five tables have RLS enabled and forced, `outbox_events` row count still 143; 0174 four columns, trigger present; 0175 five columns, FK and index present.
3. Run `grant-app-role.sh` for the application role (once it exists).
4. Deploy the new application.
5. Smoke and RLS checks (as a non-BYPASSRLS role): cross-tenant read denied on the ledger and outbox; tenant sees own `TENANT_WORKSPACE` rows; app role cannot UPDATE or DELETE the ledger; webhook lookup executable by the app role only; create a recommendation and review through the API and confirm the snapshot is copied; approve an old (NULL) recommendation and confirm the 409; reject works.
6. Re-run the Supabase security advisor and compare with the baseline in section 7.

## 7. Baseline advisor findings captured before any change (security)
`rls_disabled_in_public` ERROR: `public._migrations`; `rls_enabled_no_policy` INFO: seven legacy `public.*` tables (`audit_log`, `businesses`, `platform_events`, `tenants`, `users`, `workspace_members`, `workspaces`); `function_search_path_mutable` WARN: 155 functions; `extension_in_public` WARN: `pg_trgm`, `citext`. None are introduced or fixed by 0170-0175.

## 8. Limits of this review
Content of 0001-0169 on live was not compared to the repo (the ledger stores filenames only); row contents were not read; PostgREST exposure, dashboard backup settings and the application's runtime role were not visible; migrations were not executed on Postgres 17.
