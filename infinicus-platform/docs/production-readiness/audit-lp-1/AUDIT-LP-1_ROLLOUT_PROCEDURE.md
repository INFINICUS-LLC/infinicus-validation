# AUDIT-LP-1 — Production Rollout Procedure (RP-18)

Status: **PROCEDURE ONLY — NOT EXECUTED, NOT AUTHORIZED FOR EXECUTION.** This document changes nothing in production. Every command below is run by the owner on `infinicus-prod-01`, in a window the owner schedules, after an explicit written go. The coding environment has no production access; production facts are OWNER-OBSERVED only.

Evidence labels: VERIFIED — REPOSITORY / CI, OWNER-OBSERVED — PRODUCTION, INFERRED, UNVERIFIED.

## 1. What is being rolled out

| Item | Value | Evidence |
|---|---|---|
| Change | The application role loses `UPDATE`, `DELETE`, `TRUNCATE` on `audit.access_events` (keeps `SELECT`, `INSERT`). | VERIFIED — REPOSITORY (PR #370, merged to main as `6c3f2bd6`) |
| Erasure change | `delete-tenant-data.mjs` erases that table over the admin connection with an explicit `tenant_id` predicate. | VERIFIED — REPOSITORY / CI |
| `delete-tenant-data.mjs` sha256 (main `6c3f2bd6`) | `1ed07032688f360451ab332d5fadebad8759b3349eb8af424d70d13fd50a862a` | VERIFIED — REPOSITORY |
| `grant-app-role.sh` sha256 (main `6c3f2bd6`) | `802fe92ddf5c86f2f0e068685abfd0aa8efad9201957b81dfd0a84aaa70a5154` | VERIFIED — REPOSITORY |
| Schema / migration | None. No migration, no ledger change, fingerprint `325158ea2a54cde9` unaffected. | VERIFIED — REPOSITORY |
| Production state today | App role still holds UPDATE/DELETE on the table (design §3). Re-confirm in Phase 0. | OWNER-OBSERVED (RP-12A) — re-check |

Not in scope: AUDIT-AO-1 (trigger-enforced append-only), `tenant_id IS NULL` retention (D2), erasure exit-code change (D3).

## 2. Hazards that drive the order of steps

1. **Wrong order breaks erasure.** If the revoke lands while the operators still use the old erasure script, access-event rows are never deleted and the old script reports partial but exits 0. Hence: script replacement first, revoke second.
2. **The revoke is undone by any old-script grant run.** The OCI runbook requires `grant-app-role.sh` after every migration run. The old script blanket-grants `SELECT, INSERT, UPDATE, DELETE` on every table in every schema, which re-grants UPDATE/DELETE on this table. The AUTH-LOCKOUT-1 release candidate image (`ccadbf51` + #348) contains the OLD script. So:
   - Do not run this rollout inside the AUTH-LOCKOUT-1 window (design §8.6).
   - After this rollout, every future grant run must use the NEW script (hash in §1). Otherwise the privilege silently returns.
3. **Do not re-run the whole new grant script as the rollout step.** It re-applies blanket grants and default privileges to every schema. The rollout step is one `REVOKE` statement.
4. **Do not touch** `/home/deploy/w2clean/infinicus-release-ccadbf5/` (the backup unit drop-in runs scripts from there).
5. **Erasure is irreversible.** Do not test erasure against a real tenant in production to "prove" the change. CI/rehearsal evidence (tenant rows erased, other-tenant and NULL-tenant rows preserved) is the proof.

## 3. Entry conditions (all must hold; otherwise do not start)

| # | Condition | How checked |
|---|---|---|
| E-1 | AUTH-LOCKOUT-1 release is not in progress; if it was released, it has been stable and the owner has accepted it. | Owner |
| E-2 | A backup newer than the owner's accepted maximum age exists and `check-backup-freshness.sh` passes. Restore proof (G-4) is **not** a precondition of this step, because the change touches no data or schema and rollback is a single GRANT; the owner must accept that in writing in §10. | Owner |
| E-3 | Phase 0 read-only preflight output reviewed with no unexplained result (§4). | Owner + reviewer |
| E-4 | No tenant erasure running or scheduled in the window. | Owner |
| E-5 | Decisions D1 (erase on tenant erasure = status quo) and D5 (nothing outside the repo deletes/updates the table as the app role) answered in §10. | Owner |
| E-6 | A named rollback owner is present for the whole window. | Owner |

## 4. Phase 0 — read-only preflight (no change)

Run on the VM as the deploy user. `COMPOSE` is the invocation already used for the oci project; set `APP_ROLE` to the real application role name first (RP-12A showed it; the default below is only a placeholder to confirm).

```bash
APP_ROLE=app_role   # CONFIRM against RP-12A output before use
COMPOSE="docker compose -p oci --env-file /opt/infinicus/repo/infinicus-platform/infrastructure/deployment/oci/.env -f <export>/infinicus-platform/infrastructure/deployment/oci/docker-compose.yml"
ro() { $COMPOSE exec -T -e PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=10s' postgres psql -X -q -U admin_role -d infinicus -P pager=off; }

# 0.1 current privileges, policy, triggers, rules (capture this output: it is the rollback baseline)
ro <<SQL
SELECT priv, has_table_privilege('$APP_ROLE','audit.access_events',priv) AS granted
FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) priv;
SELECT relacl::text AS acl FROM pg_class WHERE oid='audit.access_events'::regclass;
SELECT polname, pg_get_expr(polqual,polrelid) AS using_expr, pg_get_expr(polwithcheck,polrelid) AS check_expr FROM pg_policy WHERE polrelid='audit.access_events'::regclass;
SELECT tgname FROM pg_trigger WHERE tgrelid='audit.access_events'::regclass AND NOT tgisinternal;
SELECT count(*) AS rows, count(*) FILTER (WHERE tenant_id IS NULL) AS null_tenant_rows FROM audit.access_events;
SQL

# 0.2 D5: any scheduled job or operator tooling touching the table
sudo grep -rIl "access_events" /etc/cron* /var/spool/cron /etc/systemd/system /home/deploy 2>/dev/null | grep -v '\.git/' | head -50
crontab -l 2>/dev/null | grep -n -i "access_events\|delete-tenant\|psql" ; systemctl list-timers --all --no-pager | head -30

# 0.3 locate every copy of the erasure script and record its identity
sudo find / -name 'delete-tenant-data.mjs' -not -path '*/node_modules/*' -not -path '/proc/*' 2>/dev/null \
  -exec sh -c 'for f; do printf "%s  " "$f"; sha256sum "$f" | cut -c1-64; grep -c ADMIN_ERASED_TABLES "$f"; done' _ {} +
```

Interpretation:

| Result | Meaning / action |
|---|---|
| 0.1 shows UPDATE and DELETE granted, TRUNCATE not | Expected baseline. Record it verbatim. |
| 0.1 shows UPDATE/DELETE already NOT granted | Revoke already applied or never granted. Stop; report; do not proceed. |
| 0.1 shows a user trigger or rule on the table | Unexpected (UV). Stop and report. |
| 0.2 lists any job that deletes/updates the table | D5 = yes. Stop; that job must be redesigned first. |
| 0.3 copy prints hash `1ed07032…862a` and count ≥ 1 | Already the new script; Phase 1 reduces to verification. |
| 0.3 copy has count `0` | Old script. Replace in Phase 1. |
| 0.3 finds the only copy inside `/home/deploy/w2clean/infinicus-release-ccadbf5/` | Do not edit there. Stop and report; a separate operator copy location must be decided. |
| 0.3 finds no copy | Erasure is not currently runnable on the VM; place the new script in Phase 1 at the location the owner designates. |

## 5. Phase 1 — script replacement (before any privilege change)

Goal: every operator copy of `delete-tenant-data.mjs` is the reviewed version. No database change.

1. Obtain the file from a reviewed source: `git archive` of main at or after `6c3f2bd6`, or the release export, on a machine the owner trusts. Do not edit it by hand.
2. Verify the hash before copying:
   ```bash
   sha256sum infinicus-platform/infrastructure/database/scripts/delete-tenant-data.mjs
   # must print 1ed07032688f360451ab332d5fadebad8759b3349eb8af424d70d13fd50a862a
   ```
3. On the VM, for each operator copy found in 0.3 (not the backup drop-in directory):
   ```bash
   cp -p <path>/delete-tenant-data.mjs <path>/delete-tenant-data.mjs.pre-lp1   # rollback copy
   install -m 0644 /path/to/verified/delete-tenant-data.mjs <path>/delete-tenant-data.mjs
   sha256sum <path>/delete-tenant-data.mjs          # must match step 2
   node --check <path>/delete-tenant-data.mjs       # syntax only; does not connect or run
   grep -c ADMIN_ERASED_TABLES <path>/delete-tenant-data.mjs   # must be >= 1
   ```
4. Do not execute the script. Do not run it with a real `TENANT_ID`.
5. Gate to Phase 2: every copy prints the §1 hash. Replacement alone does not change database behavior and is reversible by restoring `.pre-lp1`.

Between Phase 1 and Phase 3 the new script runs against the still-permissive app role, which is the proven compatible state (the admin delete simply finds nothing left to delete after the app-role pass, or deletes the rows itself).

## 6. Phase 2 — pre-window checks

1. `check-backup-freshness.sh` passes (E-2); note the backup identifier and time.
2. Baseline health: `curl -sS https://api.infini-cus.com/v1/health` and `/v1/ready` healthy; note the running build SHA.
3. Note the current count of `audit.access_events` rows (0.1) and of recent `failed_auth` events, for post-change comparison.
4. Confirm no long-running or idle-in-transaction sessions on the table (the RP-12A G-6 queries).

## 7. Phase 3 — apply (single transaction, no application stop required)

Run once. The API is not stopped: the statement only changes privileges and the application never updates or deletes this table (design §2, VERIFIED — REPOSITORY).

```bash
$COMPOSE exec -T postgres psql -X -U admin_role -d infinicus -v ON_ERROR_STOP=1 -v role="$APP_ROLE" <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
REVOKE UPDATE, DELETE, TRUNCATE ON audit.access_events FROM :"role";
COMMIT;
SQL
```

`lock_timeout` makes the statement fail safe (no change) if it cannot get its lock quickly. If it fails, do nothing else; re-run once in a quieter moment, or stop and report.

## 8. Phase 4 — verification

Immediately after Phase 3:

```bash
ro <<SQL
SELECT priv, has_table_privilege('$APP_ROLE','audit.access_events',priv) AS granted
FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) priv;
SQL
```

Expected: `SELECT` t, `INSERT` t, `UPDATE` f, `DELETE` f, `TRUNCATE` f. Any other result: go to §9 rollback.

Application checks (within 10 minutes):

| Check | Expected |
|---|---|
| `/v1/health`, `/v1/ready` | healthy, same build SHA as Phase 2 |
| One login by the owner's own account | succeeds |
| One deliberately failed login for the owner's own account (wrong password, once) | normal 401 and no 5xx; lockout counter behavior unchanged |
| `docker compose logs --since 15m api` | no `permission denied for table access_events` |
| `docker compose logs --since 15m postgres` | no `permission denied for table access_events` |
| Row count of `audit.access_events` | not lower than Phase 2 (rows are still inserted) |

Pass criteria: all rows as expected. Record the output. Only then declare the step complete.

## 9. Rollback

Triggers: any Phase 4 check fails; 5xx or `permission denied ... access_events` appears; a job found later needs UPDATE/DELETE.

```bash
$COMPOSE exec -T postgres psql -X -U admin_role -d infinicus -v ON_ERROR_STOP=1 -v role="$APP_ROLE" <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5s';
GRANT UPDATE, DELETE ON audit.access_events TO :"role";
COMMIT;
SQL
```

Then re-run the Phase 4 privilege query and compare with the Phase 0.1 baseline (UPDATE t, DELETE t, TRUNCATE f). No data or schema was changed, so no restore is involved. The replaced erasure script stays (it works with either privilege state). If the script itself must be reverted, restore each `.pre-lp1` copy and re-check its hash against Phase 0.3.

After a rollback, a future run of the NEW `grant-app-role.sh` would re-apply the revoke; note this in the change record.

## 10. Failure modes

| Situation | Effect | Action |
|---|---|---|
| Revoke applied while an old erasure script is still in use | Access-event rows survive erasure; old script prints partial, exit 0 | Phase 1 gate prevents this; if it happens, roll back the revoke, fix the copy |
| Old `grant-app-role.sh` run later (any redeploy) | UPDATE/DELETE silently regranted | Use the new script; re-run Phase 4 query after every grant run |
| Erasure of a tenant after rollout prints `blockedTables` | Tenant erasure is partial though exit code is 0 (D3) | Operator must read the output, not the exit code; stop and escalate |
| `REVOKE` times out on lock | No change made | Retry once later or stop |
| Unknown job uses UPDATE/DELETE as app role | That job breaks | Phase 0.2 should find it; rollback per §9 |

## 11. Owner record (to be completed by the owner; nothing is assumed)

```
AUDIT-LP-1 ROLLOUT AUTHORIZATION
Date/time window (UTC):
Rollback owner present:
D1 (erase access events on tenant erasure; status quo): YES / NO
D5 (no job outside the repo updates/deletes the table as the app role): YES / NO / UNKNOWN
E-2 backup identifier and time:
Restore proof (G-4) not required for this step — risk accepted by:
Phase 0 output reviewed by:
Phase 1 hashes verified (list copies):
Phase 3 executed at / result:
Phase 4 results:
```

## 12. Evidence and gaps

- VERIFIED — REPOSITORY / CI: script behavior, tests (static, live privileges, erasure of tenant / other-tenant / NULL-tenant rows), main `6c3f2bd6`, hashes above.
- UNVERIFIED: production privileges today (re-check in 0.1), copies of the erasure script on the VM, any off-repo job touching the table, the real application role name (confirm in 0.1).
- Not done: no production command was run by the author of this document; no rehearsal against a production-state restore (needs G-4).
