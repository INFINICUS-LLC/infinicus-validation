# Live environment discovery and production-readiness verification (READ-ONLY)

Date: 2026-10-12. Repo `main` at 842f2bb (migrations 0001-0198). Method: read-only catalog `SELECT`s and Supabase metadata calls against the live project, repository review, and a local PostgreSQL 17.6 rehearsal in a scratch directory. **No DDL, DML, grant, role, migration, branch, deployment, secret, Cloudflare or DNS change was made, and no write probe was attempted.** This document authorises nothing.

## 1. Verdict
**ACTIVATION BLOCKED. Live migration BLOCKED until four blockers are resolved (section 17).** The live schema is exactly the repository's 0001-0169 (zero drift) and every relevant business table is empty, so the 29 pending migrations (0170-0198) are technically low-risk and rehearsed green on PostgreSQL 17.6. The blockers are environmental: no least-privilege application role exists, the migration ledger is writable by anonymous API roles, backups/PITR are unverified, and it is not established that this Supabase project is the production target.

## 2. Live project (Step 1)
| Item | Value |
|---|---|
| Project / ref | `infinicus-development` / `cvlmjwauvzcappgvylbi` (the previously known candidate; confirmed by `get_project`) |
| Organization | `jvmhvxlhfoxwkrbyxfgt` (**not** the organization the connector lists, `axmrqteuwvpsamiifaoa`; `list_projects` returns `[]`, but `get_project` by ref works - the project is reachable only by ref) |
| Region / status | ap-south-1 / ACTIVE_HEALTHY, created 2026-07-30 |
| PostgreSQL | **17.6** (build 17.6.1.155) |
| Newer or replacement project | none visible (no other project in any visible organization); branches: none; edge functions: none |
| Is it "the" production environment? | **Not established.** The repository's own platform deployment topology (`infrastructure/deployment/hetzner`, `oci`) is a self-hosted PostgreSQL **16** container with an automatically created `app_role`; this Supabase project is named *development*, holds 106 tenants / 465 users and no business data. A second Supabase project (`dxheognltijswhtpnndk`) serves the legacy end-user site and is not the platform database. See section 17, decision D1. |

## 3. Live migration state (Step 2)
- Ledger: `public._migrations` (filenames only, no content hashes). 169 rows, 169 distinct, `0001_foundation.sql` ... `0169_add_manual_json_connector_type.sql`.
- Against repository 0001-0198: **APPLIED 169 (0001-0169, names identical, none missing, none unexpected, no duplicates); PENDING 29 (0170-0198); MISSING 0; UNEXPECTED 0.** DIVERGENT cannot be judged from the ledger (no hashes) - see schema drift below, which supersedes it.
- Ledger security: `public._migrations` has **RLS disabled** and `anon`, `authenticated` and `service_role` hold SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER. The Supabase security advisor reports `rls_disabled_in_public` (ERROR; that lint applies only to schemas exposed to PostgREST, so `public` is exposed). Anyone holding the project's anon key could therefore rewrite or truncate the ledger. **Blocker B2.** Not exploited or probed.

## 4. Schema drift (Step 3)
Method: a catalog fingerprint (columns with type / nullability / default / generation, constraints, indexes, triggers, functions with security-definer flag, source and config, RLS enabled / forced flags, policies) per schema, computed identically on live and on a freshly built repository baseline 0001-0169 on PostgreSQL 17.6. Whitespace-normalised function source was compared.

Result: **130 of 130 (schema, kind) groups are identical after normalising function whitespace; tables, columns, constraints, indexes, triggers, RLS flags and policies match exactly for all 20 application schemas, and all function signatures, bodies, security-definer flags and configs match.** The only raw difference was function source whitespace (and extension-owned functions in `public`, which belong to extensions, not to the platform). Classification: no PRE-EXISTING_DRIFT, no SECURITY_DRIFT, no FUNCTIONAL_DRIFT in the migrated objects.

The objects of 0170-0198 are absent, as expected: `EXPECTED_BECAUSE_PENDING` for `execution_capability_activations`, `authorized_action_*`, `purchase_receipt_lines`, the OM verification table, the `events.business_event_ledger`, the 0173 scope columns and all 0170-0198 triggers and functions.

Not covered by the fingerprint: grants, ownership and ACLs (section 5), data, and anything outside the 20 schemas.

## 5. Role topology (Steps 4-5)
| Role | LOGIN | SUPERUSER | BYPASSRLS | CREATEDB / CREATEROLE | Notes |
|---|---|---|---|---|---|
| `postgres` | yes | no | **yes** | yes / yes | owner of every application schema, table and function; member of `anon`, `authenticated`, `service_role`, `authenticator` |
| `supabase_admin` | yes | yes | yes | yes / yes | platform |
| `service_role` | no | no | **yes** | no / no | Supabase |
| `anon`, `authenticated` | no | no | no | no / no | no USAGE on any application schema |
| `authenticator` | yes | no | no | no / no | PostgREST (session last seen 2026-10-07) |
| `supabase_etl_admin`, `supabase_read_only_user` | yes | no | **yes** | no / no | platform |
| `supabase_auth_admin`, `supabase_storage_admin`, `supabase_replication_admin`, `pgbouncer`, `dashboard_user`, `supabase_realtime_admin`, `supabase_privileged_role` | mixed | no (`dashboard_user`: createdb / createrole / replication) | no | - | platform |
| **INFINICUS application role / worker role / worker-discovery role** | **do not exist** | | | | no custom role of any kind |

- **Privileges:** no table-level grant exists on any application schema for any role other than the owner `postgres`. `anon`, `authenticated` and `service_role` have no schema USAGE on any application schema (only `public`, `graphql*`, `extensions`, `auth`, `storage`, `realtime`; `vault` for `service_role`).
- **Activity snapshot (`pg_stat_activity`):** only `postgres` (management API, pg_net worker), `supabase_admin`, `pgbouncer`, and `authenticator` (PostgREST). **No application API or worker session.**
- **P1 (application role != SECURITY DEFINER owner): FAIL, BLOCKER - DATABASE AUTHORITY HARDENING INEFFECTIVE.** All functions are owned by `postgres`, and `postgres` is the only role with any privilege on them. With no separate application role the API could only connect as `postgres` (or `service_role`), i.e. the function owner / a BYPASSRLS role, so the 0195-0196 least-privilege layer (`grant-app-role.sh` revocations) would have nothing to constrain, and FORCE RLS does not bind a BYPASSRLS role. (The table triggers and function checks from 0195/0196 still fire for every role, but they were designed as defence in depth beneath the role separation, not instead of it.) Remediation, not executed: create a dedicated `NOLOGIN`-free application login role (`NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`), run `grant-app-role.sh` for it after migrating, and point `DATABASE_URL` at it; keep `postgres` for the migration gate only. **Blocker B1.**
- **Worker discovery role:** the event-worker design needs a separate role created `BYPASSRLS` (`infrastructure/deployment/event-worker/README.md`). On Supabase the `postgres` role is not a superuser, and PostgreSQL requires superuser to create a `BYPASSRLS` role - I believe (about 70% sure, not tested) this cannot be done with the `postgres` login; confirm with Supabase before relying on that design here.

## 6. EXECUTE exposure (Step 6)
- All 130+ `SECURITY DEFINER` `emit_*` functions in the application schemas (owner `postgres`) are executable by `PUBLIC` (PostgreSQL default) and therefore show as executable by `anon`, `authenticated` and `service_role`; none has a pinned `search_path` (155 advisor warnings, pre-existing). `data_acquisition.emit_outbox_event` is one of them.
- **Correction to PR #106:** the earlier review said Supabase default privileges grant new functions to `anon`/`authenticated`. They do not for these schemas: `pg_default_acl` has no entry for the application schemas (only `public`, `storage`, `extensions`, `realtime`, `graphql*`, `auth`). The anon/authenticated EXECUTE comes **only through PUBLIC**, so `REVOKE ... FROM PUBLIC` in 0171 and 0196 is effective for the new functions, and no separate revoke from `anon` / `authenticated` is needed for them.
- Because `anon`, `authenticated` and `service_role` hold no USAGE on the application schemas, none of these functions is reachable through PostgREST even though PUBLIC can execute them. Classification: low residual risk.
- `record_execution_capability_activation` and `apply_inventory_reorder_policy` do not exist yet (0196 pending). After 0196: PUBLIC no; anon / authenticated no (they never receive a direct grant); service_role no unless explicitly granted; the application role yes, only through `grant-app-role.sh` (it grants EXECUTE on every function in each schema to the application role, which covers these two and all the `emit_*` trigger functions).
- Target state satisfied for the new governed functions by 0196 + `grant-app-role.sh`; the legacy `emit_*` functions keep PUBLIC EXECUTE (pre-existing; recommend revoking PUBLIC on them in a separate hardening step together with pinning `search_path`).

## 7. PostgREST exposure (Step 7)
The API settings page is not readable through the connector. Evidence: the advisor flags only `public` (exposed); `anon` / `authenticated` / `service_role` hold **no schema USAGE** on `business_operations`, `audit`, `events`, `approved_business_action`, `outcome_monitoring` or any other application schema, so even if one were listed under exposed schemas, requests would fail. Classification: not exposed in effect (inferred; confirm in Settings -> API -> Exposed schemas). `public` is exposed and holds the unprotected ledger (B2) and seven legacy RLS-enabled-no-policy tables.

## 8. Data profile (Step 8) - counts only
| Table | Rows |
|---|---|
| `audit.audit_events` | 0 |
| `business_operations.inventory_movements` (with cost: 0) | 0 |
| `business_operations.purchase_receipts` | 0 |
| `business_operations.inventory_balances` (non-zero reorder values: 0) | 0 |
| `business_operations.purchase_orders` / `purchase_order_line_items` | 0 / 0 |
| `events.outbox_events` | 143 (da.*, onboarding.*, billing.*; none `control_loop.*`) |
| `events.inbox_events`, `dead_letter_events`, `event_subscriptions` | 0 / 0 / 0 |
| `tenancy.tenants` (82 active, 24 trial) / workspaces / users / memberships / `platform.businesses` | 106 / 106 / 465 / 209 / 120 |
| `purchase_receipt_lines`, `execution_capability_activations`, `authorized_action_receipts`, `authorized_action_claims`, `authorized_action_executions` | tables do not exist yet (0176+, 0191, 0195, 0197 pending) |

**Activation rows: 0 by construction** (the activation table does not exist; no `event_subscriptions` row exists either, so even a running worker would deliver nothing). Production activation is OFF.
Note: although named *development*, the project holds 82 active tenants and 465 users; whether those are real customers is not determinable from here.

## 9. Append-only compatibility (Step 9)
Live: no trigger on `audit_events`, `inventory_movements` or `purchase_receipts`; no function body (outside Supabase schemas) references those tables or `purchase_orders`; `pg_cron`, `pg_net`, `http` and `dblink` are **not installed** (the `pg_cron scheduler` / `pg_net` processes are Supabase platform workers; there is no `cron` schema), no edge functions, no branches, six standard Supabase event triggers. Repository: no job, script or runbook updates or deletes the append-only tables except `delete-tenant-data.mjs` (convention-aware) and test helpers (replica role). **No incompatible dependency found.** Not visible to this review: any external client that connects directly as `postgres` and runs ad-hoc SQL.

## 10. Currency compatibility (Step 10)
`purchase_orders.currency_code` still has `DEFAULT 'USD'` live (0183 pending). `purchase_orders` is empty and no database function writes it. The runtime executor requires `currencyCode`. The deployed API version could not be inspected (section 15), so a deployed older build that omits currency is **UNVERIFIED**. Classification: SAFE_WITH_PRECHECK for 0183 (precheck: confirm the deployed API build, if any, is >= the build that sends `currencyCode`; with the table empty the migration itself cannot fail).

## 11. PostgreSQL version (Step 11)
Live 17.6 (the same exact minor as the rehearsal). CI and the local gate ran 16. Constructs worth a 17 rehearsal in 0170-0198: STORED generated column on `events.outbox_events` (0173), `pg_get_constraintdef ... LIKE` (0193), SECURITY DEFINER functions relying on `current_user` and `SET search_path` (0171, 0196), partial indexes / FORCE RLS / replica-role-sensitive triggers (0181-0198), `hashtextextended` advisory locks. **Rehearsed, see section 13: all pass on 17.6.** Tooling finding: `backup.sh`, `restore.sh` and `export-tenant.sh` (`pg_dump`) abort when the client major version is older than the server's; against Supabase 17.6 they need a PostgreSQL 17 client (4 database tests fail only for that reason on a 17 server with a 16 client).

## 12. Backup / PITR (Step 12)
Read-only evidence: `archive_mode=on`, `wal_level=logical`, archiver `wal-g` (managed), 44 segments archived, 0 failures, last archive 2026-10-12 17:42 UTC; database size 59 MB. Plan tier, PITR enablement, retention window and the latest recoverable point are **not visible** through the connector. Branches: none; branch pricing: not visible. **Classification: BLOCKER BEFORE LIVE MIGRATION (B3) until the owner confirms PITR / latest backup in the dashboard.** Because the database is only 59 MB, a pre-apply logical dump (with a PostgreSQL 17 `pg_dump`) is a cheap additional safety net - needs the owner's database credentials.

## 13. Rehearsal (Step 13) - done, Option C
Chosen: **Option C - an isolated production-like copy**, built in this session at no cost and with no production access beyond read-only catalog queries: PostgreSQL **17.6** (npm `@embedded-postgres/linux-x64@17.6.0-beta.15`, scratch directory outside the repository), 0001-0169 applied (reproducing the live ledger state and, by fingerprint, the live schema), then the real `migration-gate.sh` applied 0170-0198 in order, then `grant-app-role.sh`. Results on 17.6: gate passed; ledger 198 rows; database package 3469 passed / 26 skipped / 4 failed (the four `pg_dump` 16-vs-17 tooling failures above, not migration failures); business-operations runtime 554/554; event-worker 155/155; remaining CI-equivalent packages 35/35 turbo tasks; OM 33/33. Limits: no production data (but every relevant live table is empty), embedded build, no Supabase platform layer (roles, PostgREST, extensions-in-`extensions` schema). A Supabase branch would add the platform layer but is billable; **not created** - decision D3. Option A (branch) remains available if the owner wants platform-layer fidelity; estimated cost and duration are not visible to me.

## 14. Migration risk table (Step 14), against the actual live state
| Migration(s) | Class | Live-specific reasoning |
|---|---|---|
| 0170, 0171, 0172, 0174, 0175 | SAFE | additive; live tables tiny or empty (`approved_actions` 4, `connectors` 4, ADI 22, ABA 11 per the 2026-10-07 review - recount before apply) |
| 0173 | SAFE_WITH_PRECHECK | outbox rewrite for the stored generated column (143 rows, brief lock); changes RLS posture on five `events` tables (see D2); precheck: no running consumer |
| 0176-0180, 0182, 0185, 0191, 0194, 0195 | SAFE | new empty tables |
| 0181 audit append-only | SAFE_WITH_PRECHECK | `audit_events` has 0 rows; once applied no role can update / delete; precheck that no operator script does |
| 0183 currency | SAFE_WITH_PRECHECK | `NOT VALID` constraints on an empty table; drops the `USD` default (section 10) |
| 0184 / 0186 movements append-only + FORCE RLS | SAFE | 0 rows |
| 0187 positive cost | SAFE | `NOT VALID`, 0 rows |
| 0188 | SAFE | function replacement |
| 0189 / 0192 reorder state | SAFE | `inventory_balances` empty; defaults `UNSET` |
| 0190 | SAFE | nullable column + partial index on 143 outbox rows |
| 0193 | SAFE | `NOT VALID` on a table that is created by 0191 in the same run |
| **0195 / 0196** | **BLOCKED until B1** | schema changes are safe, but the privilege hardening they rely on is ineffective without a separate application role; apply them only together with role creation + `grant-app-role.sh` |
| 0197 receipts / receipt lines | SAFE | 0 rows; header becomes append-only |
| 0198 PO-item linkage | SAFE | 0 rows; nullable column, guards |
None of them needs a maintenance window on the data volumes observed; apply in a quiet period anyway.

## 15. Worker, application, Cloudflare (Steps 17-19)
- **Worker:** built but not deployed by design (`event-worker/README.md`, compose profile `event-worker`). Live evidence is consistent with NOT ACTIVE: no application or worker DB session, no `event_subscriptions` rows, no activation table. Runtime identity, image build, restart model and health: not applicable / not visible. **Expected state confirmed (by absence of evidence of activity); not independently provable.**
- **Application deployment:** `api.infini-cus.com`, `infini-cus.com` and similar hosts are blocked by this session's network policy (HTTP 403 from the egress proxy), so the deployed build / SHA, `/v1/ready` and Cloudflare routes could not be read. **UNVERIFIED.** No bypass was attempted. The intended sequence is unchanged: migration -> grants -> application / worker deployment -> smoke / reconciliation -> activation. Compatibility: old application on the new schema is safe (new columns nullable / defaulted); new application on the old schema fails at the first receipt, activation or governed reorder write.
- **Cloudflare / DNS / secrets (repo only):** `wrangler.toml` documents KV and D1 bindings for the legacy Pages project (`INFINICUS_USERS`, `INFINICUS_WAITLIST`, `INFINICUS_DB`); required secrets by name only: `RESEND_API_KEY`, `NURTURE_BATCH_SECRET`, `SENTRY_DSN`. The platform API (Stack B) is not a Cloudflare workload in this repository; its deployment targets are the Hetzner / OCI compose stacks. Production domain status, routes, Access policies, Hyperdrive and the presence of secrets: **not readable here**.

## 16. Grant / role sequence and ledger hardening (Steps 15-16)
`grant-app-role.sh` review: it does not create the role; for each non-`public` schema it grants USAGE, SELECT / INSERT / UPDATE / DELETE on all tables, EXECUTE on all functions and sets default privileges; then revokes INSERT / UPDATE / DELETE / TRUNCATE on `execution_capability_activations` and column-limits UPDATE on `inventory_balances`. It deliberately excludes `public` (so it never touches the ledger) and does not revoke anything from `PUBLIC`, `anon`, `authenticated` or `service_role`. Required sequence (none executed):
1. (Owner, outside migrations) create the application login role: `NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`, password from the secret store; decide the worker-discovery role design (section 5).
2. Take a pre-apply backup / record the PITR point; run the read-only checks of this document again immediately before.
3. `migration-gate.sh` with the operator (`postgres`) URL.
4. `grant-app-role.sh` with `ADMIN_DATABASE_URL` = operator and `APP_ROLE` = the new role.
5. Verify: function owner (`postgres`) != application role; `has_function_privilege` false for PUBLIC / `anon` / `authenticated` on the two governed functions, true for the application role; the application role cannot INSERT into `execution_capability_activations` nor UPDATE `reorder_point` / `reorder_quantity`; RLS flags as expected; `\dp` shows no direct grants to `anon` / `authenticated`.
6. Deploy the application with `DATABASE_URL` = the application role (never `postgres`).
7. Smoke (section 18), then - only on explicit owner action - activation.
**Ledger hardening (B2), smallest step, not executed:** enable RLS on `public._migrations` and revoke all privileges on it from `anon`, `authenticated` and `service_role` (the migration runner connects as the table owner / `postgres`, which keeps working; with RLS enabled and no policy the API roles see nothing). Prefer doing this before any further migration, as an environment step, and also remove `public` from the exposed schemas if nothing uses it.

## 17. Blockers and owner decisions
**Blockers**
- **B1 - no application role (P1 FAIL).** Create the role before applying 0195/0196 (section 5, 16).
- **B2 - migration ledger writable by `anon` / `authenticated` / `service_role` and `public` exposed** (security; ERROR advisor).
- **B3 - backups / PITR unverified** (WAL archiving is healthy, but PITR / retention / latest point are not visible).
- **B4 - production target not established** (Supabase *development* project vs the Hetzner / OCI PostgreSQL 16 topology in the repository), and the deployed application / Cloudflare state is unverifiable from this session.

**Decisions**
| # | Question | Recommendation |
|---|---|---|
| D1 | Which database is production for the platform: this Supabase project, or the self-hosted Hetzner / OCI PostgreSQL? | State it explicitly. If Hetzner / OCI, this review's live findings do not apply to it and that VM needs its own read-only discovery (it creates `app_role` automatically, which removes B1 there). |
| D2 | Accept 0173's change of RLS posture on the five `events` tables, and run the API only as a non-BYPASSRLS role afterwards | Yes, together with B1 |
| D3 | Rehearse further on a Supabase branch (billable, cost not visible)? | Not required for the data (empty tables) - only if you want platform-layer fidelity (PostgREST, roles) |
| D4 | Authorise the ledger hardening and role creation as separate, scoped environment steps | Yes, before any apply |
| D5 | Confirm PITR / latest backup in the Supabase dashboard (plan, retention, latest recoverable time) | Required before apply |
| D6 | Restore connector visibility of the organization `jvmhvxlhfoxwkrbyxfgt` (project is reachable only by ref) and allow read-only access to the deployed API / Cloudflare | Needed for the remaining unverified items |

## 18. Production smoke plan (post-migration, pre-activation; read-only unless separately authorised)
App boots and `/v1/ready` is green; connection role is the application role (`select current_user`) and is not `postgres` / BYPASSRLS; ledger lists 0001-0198 and nothing else; RLS enabled / forced as in this document; login and a second tenant cannot read the first; counts of `execution_capability_activations` = 0, `events.event_subscriptions` for `bo.authorized_action_intake` = 0; governed-function privileges as in section 16 step 5; OM verification table present and empty; worker process absent or idle with the kill switch engaged; read-only probes of: receipt write path (dry-run in the rehearsal copy, not live), PO-item linkage (rehearsal copy), ABA authoring and package issuance (rehearsal copy). **No production mutation tests without separate authorisation.**

## 19. Activation readiness gate (Step 21): **BLOCKED**
| Condition | State |
|---|---|
| Live migration head current | RED (0169; 29 pending) |
| Application role least privilege | RED (does not exist) |
| Function owner distinct from application role | RED |
| Grants correct | RED (none) |
| PUBLIC EXECUTE removed on governed functions | PENDING (follows 0196) |
| Sensitive schemas not exposed | GREEN (no USAGE for API roles; confirm in dashboard) |
| Ledger not writable by API roles | RED |
| PITR / backups verified | RED (unverified) |
| PostgreSQL 17 rehearsal | GREEN (17.6, this document) |
| Deployed application compatible | UNVERIFIED |
| Worker deployed, execution OFF | UNVERIFIED (no evidence of activity) |
| Smoke passed | NOT RUN |
| Activation rows = 0 until owner action | GREEN (0 by construction) |
| Kill switch verified | NOT RUN |
| Monitoring / alerts ready | UNVERIFIED |

## 20. Not done
No SQL write, DDL, grant, role creation, migration, ledger change, branch, deployment, worker start, secret, Cloudflare or DNS change, and no activation. No write probe of the ledger. Network egress to the deployed application hosts was blocked by the session proxy and was not circumvented.
