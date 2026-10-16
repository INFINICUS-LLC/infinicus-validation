# F-NA05-3 — Outcome Monitoring database scope integrity (migration 0200)

Status: **DRAFT, not applied anywhere except disposable local databases.** Production and staging application are not authorised by this change.

## What it enforces
A row that names a monitored action must name one of its own tenant, workspace and business — enforced by PostgreSQL itself (foreign-key checks bypass RLS, which is why the old single-column foreign key allowed cross-scope references).

| Constraint | Table | Columns |
|---|---|---|
| `monitored_actions_scope_key` (UNIQUE) | `outcome_monitoring.monitored_actions` | `(id, tenant_id, workspace_id, business_id)` |
| `outcome_observations_monitored_action_scope_fkey` | `outcome_monitoring.outcome_observations` | `(monitored_action_id, tenant_id, workspace_id, business_id)` → the key above |
| `action_execution_verifications_monitored_action_scope_fkey` | `outcome_monitoring.action_execution_verifications` | same four columns |

Both foreign keys are `MATCH SIMPLE`, `ON DELETE RESTRICT`. `action_execution_verifications.monitored_action_id` is nullable by design: a NULL reference is not checked (tenant/workspace/business are NOT NULL, so NULL in that one column is the only way to skip). The existing single-column foreign keys are kept. `monitored_action_versions` and `monitored_action_status_history` carry the same single-column pattern and are **not** changed here (see report: candidate F-NA05-4).

## Operational procedure (owner-run; each step needs separate authorisation)
1. Run `docs/architecture/reconciliation/production-discovery/f-na05-2-om-integrity-audit.sql` (read-only). Every `C0x` must be 0. The 2026-10-16 production audit reported 0 on all (3 observations, 3 monitored actions, head 0198).
2. Backup and restore proof as for every production migration. Note production is at 0198: migrations 0199 and 0200 apply in order; `grant-app-role.sh` is re-run after 0199 (new function), not required for 0200.
3. Apply through the repository migration gate. 0200 pre-flights violating rows and **refuses with counts only** (nothing changes) if any exist.
4. Verify: the three constraints exist and `convalidated = true`; the audit script still reports 0; `_migrations` shows 0200.
5. Rollback (no data change): drop the two foreign keys, then the unique key (statements are in the migration header).

## Known limitation
`runMigrations()` (`packages/database/src/migrate.ts`) runs its `finally` unlock on a connection left in an aborted transaction when a migration fails after its own `BEGIN`, so the gate prints "current transaction is aborted" instead of the migration's message. Run the file with `psql -v ON_ERROR_STOP=1` to read the refusal text. Pre-existing; not changed here.
