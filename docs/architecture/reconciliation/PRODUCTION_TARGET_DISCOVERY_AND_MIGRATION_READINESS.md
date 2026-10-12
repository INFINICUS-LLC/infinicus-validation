# Production target discovery and migration readiness (READ-ONLY)

Date: 2026-10-12. Repo `main` at 57dd5f9 (migrations 0001-0198). Owner ruling applied: the Supabase project `infinicus-development` is development / staging; the authoritative production target is the Hetzner / OCI PostgreSQL deployment. **No write action of any kind was taken and none is authorised by this document.**

## 0. Honest scope statement
**Runtime discovery of the production environment was NOT possible from this session.** Every fact below is labelled:
- **REPO** - verified from the repository (config, scripts, compose files, code);
- **DESIGN** - what the deployment *should* look like if it was deployed exactly as the repository's runbook says (not evidence that it was);
- **UNVERIFIED** - needs runtime access that this session does not have.

Why runtime access is unavailable (checked, not assumed): no `hcloud` / `oci` CLI, no SSH client, key, token or credential for Hetzner, OCI or Cloudflare in the environment (the Hetzner runbook itself states the same: *"no Hetzner account or API token in this sandbox"*); the sandbox egress proxy returns 403 for `api.infini-cus.com` / `infini-cus.com`; the separate fetch tool cannot resolve those hosts (`ENOTFOUND`), including public DNS (`dns.google`); there is no CD workflow or GitHub deployment record (deployment is manual, section 3). I did not bypass any control. Stop condition met: credentials / access genuinely unavailable. What this document therefore delivers is (a) everything establishable from the repository, (b) exact read-only commands for the operator to run on the server to turn each UNVERIFIED item into a fact, with reference outputs to compare against, and (c) the migration, rollback, smoke and activation-gate runbooks adjusted to the verified design.

## 1. Production topology (Step 1)
| Item | Finding | Basis |
|---|---|---|
| Provider | **Hetzner Cloud only** (case A). The `oci/` directory is a "legacy artifact of an earlier, abandoned OCI hosting plan" (`index.html` comment); `legal.html` lists Hetzner as "hosts the origin API server and database"; `SOURCE_OF_TRUTH_AUDIT.md` row P1: Stack B PostgreSQL = `api.infini-cus.com`, Hetzner, authoritative target | REPO (declared; no runtime proof) |
| Active/passive or split | none declared anywhere | REPO |
| Public API hostname | `api.infini-cus.com` (A record to the VM; Caddy terminates TLS with Let's Encrypt); frontend default `API_BASE_URL` points at it | REPO |
| Server | one Hetzner Cloud VM, Ubuntu 24.04, suggested CX22 (2 vCPU / 4 GB), no separate volume, deploy user `deploy`, project dir `/opt/infinicus/repo`, Hetzner Cloud Firewall (22/80/443) + `ufw` | DESIGN |
| Location / server id / IP / compose project name | **UNVERIFIED** | - |
| Containers (compose in `infrastructure/deployment/hetzner/`) | `postgres` (postgres:16-bookworm, not published), `api` (built from `apps/api/Dockerfile`, port 3000 expose-only), `caddy` (80/443), `tools` (one-off, profile `tools`, runs `migration-gate.sh` / `grant-app-role.sh`); the event worker is a separate compose file / profile (`event-worker/docker-compose.event-worker.yml`, profile `event-worker`) that must be merged onto the same network | REPO |
| Queues / event transport | none external: the outbox lives in PostgreSQL and the worker polls it; no queue, KV or R2 dependency for the platform API | REPO |
| Storage dependencies | local Docker volumes `postgres-data`, `caddy-data`, `caddy-config` | REPO |
| Health endpoints | `GET /v1/health` -> `{"status":"ok"}`; `GET /v1/ready` -> `{"status":"ready","pool":{...}}` (503 `not_ready` when the DB is unreachable). **Neither returns a version or git SHA** (section 4) | REPO |
| Cloudflare path | Cloudflare Pages serves the static site and Pages Functions (KV / D1 for the legacy site); the API is reached directly at `api.infini-cus.com` (whether that record is proxied / orange-cloud is UNVERIFIED) | REPO / UNVERIFIED |

## 2. Database actually serving production (Step 2)
- **DESIGN:** PostgreSQL **16** (image `postgres:16-bookworm`, minor floats with the image tag) in the `postgres` container, database `infinicus`, reachable only as `postgres:5432` on the compose network (never published), data on volume `postgres-data` on the VM's local disk. Connection from the API is plain (no SSL) because the host is the container name; `packages/database` enables SSL only when the URL host asks for it. No pooler (pg Pool inside the API, `DB_POOL_*`). No Hyperdrive in the platform path (section 20).
- **Roles by design (REPO):** `admin_role` = the image's `POSTGRES_USER`, i.e. the **superuser**, owner of every object and the migration / operator role (`tools` container); `app_role` = created by `postgres-init/01-create-app-role.sh` on first volume init, `LOGIN`, no other attributes; API `DATABASE_URL` and the worker `DATABASE_URL` both use `app_role`; the worker discovery connection is a separate role created by the operator (BYPASSRLS, read-only column grant; creatable here because `admin_role` is a superuser, unlike Supabase).
- **UNVERIFIED:** host / version of the running instance, persistent volume location, actual roles present, whether the instance was ever deployed per this runbook.
- Verified expectation for the earlier Supabase finding: the Supabase application-role blocker (B1) is **designed away** here (the owner and the application role are different roles by construction), but only if production really runs this compose.

## 3. Deployed application version (Step 3)
- **Deployment is manual** (runbook step 4-7: `git clone` / `git pull` on the VM, `docker compose build`, `run tools`, `up -d`). There is no CD workflow and no GitHub deployment metadata, and no registry image (CI builds and smoke-tests an image but does not publish it). The deployed version is therefore *whatever commit is checked out in `/opt/infinicus/repo` when `docker compose build` last ran*.
- The API exposes no version (`/v1/health`, `/v1/ready` carry none), so even with network access the build cannot be read from outside. Classification: **UNKNOWN**.
- Operator evidence to collect: `git -C /opt/infinicus/repo rev-parse HEAD`, `git status --porcelain`, `docker compose images`, `docker image inspect <api image> --format '{{.Id}} {{.Created}}'`, `docker compose ps --format json`.
- Compatibility risk with 0170-0198, by version of the running API: old API on migrated schema is safe (new columns nullable / defaulted; new tables unused; 0183 removes only the PO currency default which the executor already supplies); new API on an unmigrated schema fails at the first write that needs 0197/0198/0196. **Therefore migrate first, then deploy** (the runbook's redeploy order does this).
- **Runbook gap found (REPO):** "Redeploying a new version" is `git pull` -> `build` -> `run tools` -> `up -d`. It omits `grant-app-role.sh`. After 0196 that step is part of the security model (it revokes direct writes on the activation table and the protected reorder columns). Add it to the redeploy sequence (section 12).

## 4. Worker (Step 4)
Built, **not deployed by design** ("Status: built, not deployed, not enabled"; compose profile `event-worker`; empty `PRODUCTION_SUPPORTED_ACTION_TYPES` unless the build lists the action type, plus per-business activation, kill switch and `events.event_subscriptions` row). UNVERIFIED at runtime: whether a worker container exists. Expected safe state (execution not actively executing): follows from the four independent keys even if a worker did run - no activation table before 0195, no subscription rows, kill switch `INFINICUS_EXECUTION_KILL_SWITCH`. Operator check: `docker ps -a --filter name=event-worker`, `docker compose --profile event-worker ps`, and `select count(*) from events.event_subscriptions` (0 expected). **If a worker is running, stop reporting and escalate; do not stop or restart it as part of discovery.**

## 5-6. Migration ledger and schema drift (Steps 5-6)
UNVERIFIED (no database access). What is known:
- Ledger: `public._migrations`, written by the migration runner (advisory-locked); contents are filenames only.
- Production head is unknown: could be anywhere from 0001 to 0198; the Supabase development database sits at exactly 0169.
- Reference artifacts committed with this document (`production-discovery/`): the schema fingerprint SQL (columns, constraints, indexes, triggers, RLS flags, policies, function source / security-definer flags per schema) and reference outputs for the repository at **0169** and at **0198**, both built on PostgreSQL 16 (non-function groups are identical on 16 and 17.6; the live Supabase 0169 matched them exactly). The operator runs the same SQL against production and diffs against the reference file for the head it reports: any differing group is drift to classify as EXPECTED / EXPECTED_BECAUSE_PENDING / SECURITY_DRIFT / FUNCTIONAL_DRIFT / UNKNOWN. Do not repair drift.
- Production ledger states to report: APPLIED (names in the ledger that exist in the repo), PENDING (repo names not in the ledger), MISSING (a gap below the head), UNEXPECTED (ledger names not in the repo), DIVERGENT (fingerprint differs from the reference for the same head).

## 7-10. Roles, P1, application role, ledger security (Steps 7-10)
**By design (REPO):**
| Check | Expectation if deployed per the runbook |
|---|---|
| Application runtime role (API) | `app_role` (compose `DATABASE_URL`), not superuser / bypassrls / createrole / createdb (default `CREATE ROLE ... LOGIN PASSWORD`) |
| Worker runtime role | `app_role` (worker compose `DATABASE_URL`) plus a separate discovery role (BYPASSRLS, `GRANT SELECT (tenant_id, workspace_id, event_type, status, available_at, claimed_at) ON events.outbox_events`) |
| SECURITY DEFINER function owner | `admin_role` (the role that runs `migration-gate.sh`) |
| P1 (application / worker role != function owner) | **PASS by design**; UNVERIFIED at runtime. Fails if anyone points `DATABASE_URL` at `admin_role` (the superuser) or if migrations were run as `app_role` |
| Superuser / BYPASSRLS roles | `admin_role` (superuser), and the discovery role by design; nothing else expected |
| Ledger | owned by `admin_role`, in `public`; `grant-app-role.sh` deliberately excludes `public`, so `app_role` has no grant on `_migrations` (PG16 grants PUBLIC no table privileges): runtime roles cannot INSERT / UPDATE / DELETE / TRUNCATE history. UNVERIFIED at runtime |
| Application-role minimum grants | USAGE + SELECT / INSERT / UPDATE / DELETE on tables + EXECUTE on functions in every non-`public` schema (blanket grant), then (post-0196) no INSERT / UPDATE / DELETE / TRUNCATE on `execution_capability_activations` and column-limited UPDATE on `inventory_balances`. The blanket DML on append-only fact tables is refused by their triggers, not by privilege |
**Operator checks (read-only SQL, section 14):** `pg_roles` attributes and memberships, `\du`, per-schema `has_schema_privilege`, table grants to non-owner roles, `has_function_privilege` on the governed functions after migration, `select current_user` through the API's real connection, ledger ACL (`\dp public._migrations`). **Classification rules:** application or worker role equal to the function owner, superuser or BYPASSRLS -> BLOCKER - DATABASE AUTHORITY HARDENING INEFFECTIVE; any runtime-role write privilege on the ledger -> BLOCKER BEFORE PRODUCTION MIGRATION. Neither role may be created or altered in this block.

## 11. Backups / PITR (Step 11)
- **REPO:** the repository ships scripts (BUILD-22): `backup.sh` (`pg_dump -Fc`), `restore.sh`, `prune-backups.sh`, `enable-wal-archiving.sh`, `pitr-base-backup.sh`, `pitr-restore.sh`. There is **no scheduler**: the runbook says "Set up a cron job on the host ... if you want scheduled backups", with the destination (Hetzner Storage Box or S3) "not wired up here"; `infrastructure/backups/README.md` and `infrastructure/monitoring/README.md` are placeholders.
- **Mismatch:** the PITR scripts drive a Debian-style host cluster (`PGCLUSTER_VERSION` / `PGCLUSTER_NAME`, `/var/lib/postgresql/...`, `pg_ctlcluster`); production's database is a Docker container. PITR as written does **not** apply to the compose topology without adaptation, and the compose file sets no `archive_mode` / `archive_command`.
- **Therefore recoverability is not demonstrated by anything in the repository.** Classification: **BLOCKER BEFORE MIGRATION (B3)** until the operator shows (a) a recent successful logical backup that has been test-restored into a scratch database, and/or (b) Hetzner server snapshots / backups with a recorded time, and (c) offsite copy. Hetzner's own server backups / snapshots (provider-level, per-server option) are the likeliest existing mechanism and are UNVERIFIED. Do not enable or create anything in this block.
- Tooling: `pg_dump` on the host / tools image must be major 16 (matches the container).

## 12-17. Size, rows, append-only, currency, version, disk, health (Steps 12-17)
UNVERIFIED at runtime. Repository-derived expectations and the read-only operator checks are in section 14. Points that can be settled from the repository:
- **Append-only compatibility (REPO):** no cron, systemd timer, Docker job, maintenance script or runbook step in the repository updates or deletes `audit.audit_events`, `inventory_movements`, `purchase_receipts`, `purchase_receipt_lines` or execution / evidence fact tables. The only deleter is `delete-tenant-data.mjs` (it discovers append-only tables by the `forbid_mutation` convention). The host crontab and any ad-hoc operator SQL on the VM are not visible: operator check `crontab -l -u deploy`, `/etc/cron.*`, `systemctl list-timers`, shell history is out of scope - ask the operator to confirm no job touches these tables.
- **Currency (REPO):** the runtime executor requires `currencyCode` for `create_purchase_order` and no repository code path relies on the old default; the deployed build is UNKNOWN (section 3). 0183 is BLOCKED only if a deployed build older than the removal of the executor-side default is running or an external SQL writer inserts into `purchase_orders` without a currency; operator check: `select count(*) from business_operations.purchase_orders` (0183's constraints are `NOT VALID`, so existing rows are never rejected).
- **PostgreSQL version:** design = 16, which is the CI version, so the CI evidence (migration gate + suites green on 16 for every block) is the closer match; the PG17.6 rehearsal remains useful only if the instance turns out to be 17. If the image tag floated to another major, classify compatibility work.
- **Disk / headroom, CPU, memory, restarts, OOM, connections:** UNVERIFIED. CX22 has a 40 GB local disk by default (hardware assumption, not verified); the pending migrations add no large data. Rough headroom need: schema changes are metadata-only on the volumes seen in development (59 MB total); the only table rewrite is `events.outbox_events` for the stored generated column in 0173. Required free space before apply: at least the size of the largest affected table plus the logical backup.

## 18-20. Cloudflare, secrets, Hyperdrive (Steps 18-20)
- **Cloudflare (REPO):** `wrangler.toml` is for the legacy Pages site (KV `INFINICUS_USERS`, `INFINICUS_WAITLIST`, D1 `INFINICUS_DB`). The security-preview Pages project builds from branches (the "Cloudflare Pages" PR check). No Worker routes, Access policies or rate limits for the platform API are declared. DNS records, proxy status, TLS mode, origin restrictions: UNVERIFIED (need dashboard / API access).
- **Hyperdrive:** **not referenced anywhere in the repository** (`grep -ri hyperdrive` -> nothing outside docs of this review). The platform API connects directly to PostgreSQL by compose service name; Cloudflare plays no role in the DB path. Nothing obsolete to preserve.
- **Secrets / env by NAME (REPO requirements vs UNVERIFIED presence):** required: `POSTGRES_ADMIN_PASSWORD`, `POSTGRES_APP_PASSWORD` (compose; derive `DATABASE_URL` / `ADMIN_DATABASE_URL`); optional: `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS`, `EMAIL_VERIFICATION_URL_BASE`, `ANTHROPIC_API_KEY`, `CORS_ALLOWED_ORIGINS`, `LOG_LEVEL`, rate-limit and pool tuning. Worker (not yet deployed): `INFINICUS_EVENT_WORKER_DISCOVERY_DATABASE_URL`, `_ID`, `_ACTOR_USER_ID`, `_INTAKE_STATUS_MAX_AGE_MS`, `_EXECUTION_STATUS_MAX_AGE_MS`, `_CLAIM_TIMEOUT_MS`, `_BATCH_SIZE`, `_MAX_SCOPES_PER_CYCLE`, `_POLL_INTERVAL_MS`, optional `INFINICUS_EXECUTION_KILL_SWITCH`. Not in the repository's inventory: **Stripe** (the billing schema exists but no Stripe SDK or secret is read by the code), a separate auth / JWT secret, Cloudflare tokens for the platform (none needed by the platform), monitoring keys. `.env.example` lacks the worker variables (STALE/INCOMPLETE for the worker; update when the worker is deployed). Presence in production: UNVERIFIED; the operator can list names only with `grep -o '^[A-Z_]*=' .env | sort` (never print values).

## 21-22. Eventing and monitoring (Steps 21-22)
- **Eventing readiness (REPO):** outbox, inbox, dead letters, delivery attempts, subscriptions exist in schema `events` (production state UNVERIFIED). Before `ACTION_AUTHORIZED` can flow in production: migrations through 0198 applied; application role + grants in place; worker deployed with its own discovery role; a business-level governed activation (bo:admin) creating the subscription atomically; build lists the action type (`PRODUCTION_SUPPORTED_ACTION_TYPES`, one entry `inventory_reorder_policy_update@1`); global kill switch not engaged. None of this is authorised here.
- **Monitoring (REPO):** only the API's structured logs (Fastify/pino, Caddy JSON access log with webhook token redaction) and the Docker HEALTHCHECK; `infrastructure/monitoring` is a placeholder; no uptime monitor, alert rules (disk, connections, execution refusals, dead letters), log shipping or error reporting (no Sentry in the API) are defined in the repository. Missing monitoring is **a readiness gap, not a migration-safety blocker**, but it is an activation blocker.

## 23. Migration range against the expected production state
Classification assumes the design topology and an unknown head; recount rows on the operator side before apply. Because the development database showed empty business tables, the same is expected but unproven for production.
| Migration | Class |
|---|---|
| 0170, 0171, 0172, 0174, 0175, 0176-0180, 0182, 0185, 0188, 0190, 0191, 0193, 0194 | SAFE_WITH_PRECHECK (precheck = row counts and head) |
| 0173 (RLS posture on five `events` tables, outbox rewrite) | REQUIRES_BACKUP, REQUIRES_DEPLOYMENT_ORDER (API must connect as `app_role`; superuser connections bypass RLS) |
| 0181 (audit append-only), 0184 (movements append-only), 0186 (FORCE RLS), 0197 (receipts append-only) | REQUIRES_BACKUP (irreversible without restore) + SAFE_WITH_PRECHECK (operator confirms no job updates / deletes these tables) |
| 0183 (currency, drops PO default) | SAFE_WITH_PRECHECK; **BLOCKED** if a deployed publisher relies on the default |
| 0187 (positive cost), 0192 (non-negative reorder), 0189 (reorder state) | SAFE_WITH_PRECHECK (`NOT VALID` / defaulted; run `select count(*)` on `inventory_balances` and movements) |
| 0195, 0196 | REQUIRES_ROLE_CHANGE only if `app_role` is not distinct from the owner; otherwise REQUIRES_DEPLOYMENT_ORDER (grants immediately after) |
| 0198 | SAFE_WITH_PRECHECK |
Everything is `REQUIRES_BACKUP` in the sense that the append-only and RLS changes cannot be undone by a migration.

## 24. Controlled migration sequence (prepared, NOT executed)
1. Readiness confirmation: owner approval, quiet window, a second operator on call; confirm production head and drift using section 14 (read-only). Stop if drift, head anomalies, an unexpected worker, or non-zero activation rows (none can exist before 0195) appear.
2. Verified backup and restore point: `backup.sh` (PostgreSQL 16 `pg_dump`) to a directory off the VM, test-restore into a scratch database on the same host, record the Hetzner snapshot/backup time and the dump checksum.
3. Verify (do not create) the least-privilege role: `app_role` exists, `NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`, and `DATABASE_URL` of the running API uses it. If not: stop; role creation is a separate authorisation.
4. `docker compose build` at the tagged commit; `docker compose run --rm tools` (migration gate as `admin_role`); watch each `apply` / `done`.
5. `docker compose run --rm --entrypoint bash tools infrastructure/database/scripts/grant-app-role.sh` (must complete; prints the 0196 withholding line).
6. Verify grants / RLS / owners with section 14 post-checks (governed functions: owner `admin_role`, `app_role` has EXECUTE, PUBLIC has none; activation table: no DML for `app_role`; ledger unreachable by `app_role`; fingerprint equals `reference-0198.pg16`).
7. `docker compose up -d` (API rebuilt on the new schema); then `curl -s https://api.infini-cus.com/v1/ready`.
8. Worker: deployed only if wanted, with `--profile event-worker`, kill switch ENGAGED (`INFINICUS_EXECUTION_KILL_SWITCH` set), discovery role created by the operator; verify it idles. Otherwise leave absent.
9. Smoke / reconciliation (section 26) read-only; verify `execution_capability_activations` = 0 and `event_subscriptions` for `bo.authorized_action_intake` = 0.
10. Owner separately authorises activation (not part of this sequence).

## 25. Rollback / recovery
- **Stop conditions:** gate non-zero exit; any `apply` without `done`; fingerprint mismatch after migration; `/v1/ready` not ready; app role privileges wrong; unexpected worker activity.
- **Migration failure:** each file runs in its own transaction under an advisory lock, so a failed file leaves the schema at the previous file; do not edit applied files; fix forward with a new migration or restore.
- **Application rollback:** keep the previous image tag (`docker tag` before build) and the previous commit; `git checkout <previous>`; `docker compose up -d --build api`. Safe against the migrated schema until 0197/0198/0196 features are used.
- **Database restore:** `restore.sh` from the pre-migration dump into a fresh database, switch the API over by recreating the stack against it, or restore the Hetzner server snapshot. **0181, 0184, 0186, 0196, 0197 are irreversible by migration** (append-only triggers, FORCE RLS, governed-function hardening); the recovery path is restore-from-backup unless a forward fix is approved. PITR is not available as written (section 11).
- **Worker disable:** stop the `event-worker` container (never started by default); engage `INFINICUS_EXECUTION_KILL_SWITCH`; remove the business activation through the governed path. **Kill switch use** is the first response to unexpected execution.
- **DNS / origin rollback:** only relevant if a replacement server is introduced; revert the `api` A record TTL-aware to the previous IP; Caddy certificates are per-host.

## 26. Production smoke plan (post-migration, pre-activation; read-only)
API boot and `GET /v1/health` / `/v1/ready`; `select current_user` through the application pool is `app_role`; `_migrations` last row `0198...` and 198 rows; fingerprint equals reference; RLS enabled / forced as in the reference; tenant isolation: a second tenant token cannot read the first tenant's rows (existing `bizops` / `orders` read endpoints); registration / login / business admin (existing routes) work; inventory read (balances list) works; **purchase receipt path, PO-item linkage, ABA authoring and package issuance are exercised only in a scratch copy restored from the backup** (they write); outbox: no `control_loop.*` rows pending; worker absent or idle with kill switch engaged; `execution_capability_activations` = 0; `events.event_subscriptions` for `bo.authorized_action_intake` = 0; OM verification table present and empty; ledger privileges: `has_table_privilege('app_role','public._migrations','INSERT'|'UPDATE'|'DELETE'|'TRUNCATE')` all false; `has_function_privilege` on the two governed functions: PUBLIC false, `app_role` true. **No production mutation smoke without separate authorisation.**

## 27. Activation gate: **BLOCKED**
| Condition | State |
|---|---|
| Production target positively identified | AMBIGUOUS-BY-DESIGN: repository declares Hetzner single VM; runtime identity UNVERIFIED |
| Migration head 0198 | UNVERIFIED (unknown head) |
| No schema drift | UNVERIFIED |
| App role least privilege / worker role least privilege / function owner distinct | DESIGN-PASS, UNVERIFIED |
| Migration ledger protected | DESIGN-PASS, UNVERIFIED |
| PUBLIC / unauthorised EXECUTE removed | after 0196 (pending) |
| Backups / restores verified | RED (no schedule, PITR scripts do not fit the topology, nothing demonstrated) |
| Deployed app compatible | UNKNOWN (no version endpoint) |
| Worker deployed but execution OFF | UNVERIFIED (expected absent) |
| Monitoring ready | RED (placeholders only) |
| Smoke green | NOT RUN |
| Activation rows zero | GREEN by construction until 0195 |
| Kill switch verified | NOT RUN |
| Explicit owner approval | not given |

## 28. Blockers and owner decisions
**Blockers:** P-B1 production runtime unverified (need operator output of section 14 or read-only server access); P-B2 backup / restore not demonstrated and PITR scripts mismatch the containerised topology; P-B3 no monitoring or alerting; P-B4 runbook gap - redeploy omits `grant-app-role.sh`; P-B5 deployed version cannot be determined (no version endpoint, manual deployment, nothing published).
**Decisions:** (1) provide the operator's read-only output (section 14) or grant read-only SSH / provider access for a follow-up discovery; (2) confirm the production provider (Hetzner only) and retire `oci/` or mark it historical; (3) choose the backup mechanism (scheduled `pg_dump` to Storage Box / S3 + Hetzner server backups) and whether to adapt PITR for the container; (4) approve adding a version / commit SHA to `/v1/health` (read-only, additive) and the `grant-app-role.sh` step to the redeploy runbook as a small follow-up PR; (5) monitoring minimum (uptime + disk + connections + dead-letter count) before activation; (6) confirm that no host cron / ad-hoc SQL touches the append-only tables.

## 29. Operator read-only command pack (turns UNVERIFIED into facts)
Run on the Hetzner VM as `deploy`, from `infrastructure/deployment/hetzner/`; all commands are read-only; never paste passwords. Replace the psql prefix with `docker compose exec -T postgres psql -U admin_role -d infinicus -At` (`-F'|'` where noted).

**Server / topology:** `hostname; uname -a; uptime; nproc; free -m; df -h /; docker --version; docker compose ls; docker compose ps --format json; docker ps -a --format '{{.Names}} {{.Image}} {{.Status}}'; docker compose images; docker stats --no-stream; docker inspect -f '{{.Name}} restarts={{.RestartCount}} oom={{.State.OOMKilled}}' $(docker ps -aq); journalctl -k --since '30 days ago' | grep -i -E 'out of memory|oom' | tail`; `ufw status`; (Hetzner console: server id / location / IP / firewall / backups / snapshots - read-only view).
**Version:** `git -C /opt/infinicus/repo rev-parse HEAD; git -C /opt/infinicus/repo status --porcelain; curl -s localhost:3000/v1/ready` (from inside the compose network if the port is not published: `docker compose exec -T api wget -qO- localhost:3000/v1/ready`).
**Database / ledger / roles:** `select version(), current_user, inet_server_port(), pg_size_pretty(pg_database_size(current_database()))`; `show max_connections; select count(*) from pg_stat_activity`; `select count(*), max(filename) from public._migrations`; `select string_agg(filename, ',' order by filename) from public._migrations`; `select rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole from pg_roles where rolname !~ '^pg_'`; membership: `select r.rolname, m.rolname from pg_auth_members a join pg_roles r on r.oid=a.member join pg_roles m on m.oid=a.roleid`; ledger ACL: `select relname, relowner::regrole, relacl, relrowsecurity from pg_class where oid='public._migrations'::regclass`; app privileges: `select has_table_privilege('app_role','public._migrations','INSERT')` (and UPDATE / DELETE / TRUNCATE); table grants to non-owners in the application schemas; `select current_user` is checked through the API connection by the application's own startup logging, not by running SQL as `app_role`.
**Drift:** `psql -At -F'|' -f production-discovery/schema-fingerprint.sql > prod.fp; psql -At -F'|' -f production-discovery/function-fingerprint.sql > prod.fn; diff prod.fp production-discovery/reference-<head>.pg16.fingerprint.txt; diff prod.fn production-discovery/reference-<head>.pg16.functions.txt` (heads: `0169`, `0198`).
**Counts (read-only):** `select count(*) from audit.audit_events`; same for `business_operations.inventory_movements`, `purchase_receipts`, `inventory_balances`, `purchase_orders`, `purchase_order_line_items`, `events.outbox_events`, `events.inbox_events`, `events.dead_letter_events`, `events.event_subscriptions`; after 0176+: `purchase_receipt_lines`, `authorized_action_receipts`, `authorized_action_claims`, `authorized_action_executions`, `execution_capability_activations` (must be 0); the 15 largest tables: `select relname, pg_size_pretty(pg_total_relation_size(oid)) from pg_class where relkind='r' and relnamespace::regnamespace::text not in ('pg_catalog','information_schema') order by pg_total_relation_size(oid) desc limit 15`.
**Jobs:** `crontab -l -u deploy; ls /etc/cron.d /etc/cron.daily; systemctl list-timers --all`.
**Backups:** `ls -la` of the backup directory with times; Hetzner console backups / snapshots tab; the date of the last `restore.sh` rehearsal.
**Secrets by name:** `grep -o '^[A-Z_]*=' .env | sort` (never values).
**Cloudflare (dashboard read-only):** DNS record for `api` (target IP, proxied or DNS-only), SSL/TLS mode, Pages project -> repo relationship, Access applications, rate limits, Workers routes.

## 30. Not done
No SSH, no server, database, Docker, Cloudflare, DNS or provider access of any kind; no migration, role, grant, backup, restart, deployment, worker start, secret change or activation. The runtime facts above remain UNVERIFIED until the operator supplies section 29's output.
