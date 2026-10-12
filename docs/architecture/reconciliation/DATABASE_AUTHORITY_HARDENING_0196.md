# Database authority hardening (migration 0196) - closes final-audit findings F1 and F3

Status: implemented on a draft PR. **Not applied to any live database; nothing activated; F2 unchanged.** Production activation remains OFF
(no activation row is created, seeded or backfilled by anything in this change).

## 1. Purpose

The final audit (`FINAL_AUDIT_EXECUTION_PATH.md`) found two places where the database did not enforce what the locked architecture reserves:

- **F1** - execution capability activation rows were protected only by application code (any code running as the application database role could `INSERT` an `ENABLED` row).
- **F3** - the reorder-field guard trusted a session variable that the application role could set itself, then `UPDATE` the reorder fields directly.

This block makes the **database the hard boundary** for both writes. It changes WHO can write at the database boundary, not WHAT the product means.

## 2. Architecture

| | Governed entry point | Called by | Direct write |
|---|---|---|---|
| F1 activation | `business_operations.record_execution_capability_activation(...)` | `ExecutionCapabilityActivationRepository.recordOnClient` (the existing activation service, unchanged API) | refused |
| F3 reorder | `business_operations.apply_inventory_reorder_policy(...)` | `OperationalCommandExecutor.configureInventoryReorderPolicy` (the one BO writer; the engine and adapter reach it only through the executor) | refused |

How the boundary is enforced (the repository provisions roles per environment and migrations contain no role or `GRANT` statements, so the boundary is built from what a migration may contain):

1. Each entry point is a `SECURITY DEFINER` function owned by the migration/operator role, with `search_path = pg_catalog, pg_temp`, every object schema-qualified and no dynamic SQL.
2. The table trigger refuses a write unless the function's transaction-local marker is set **and `current_user` is the owner of that function**. Inside a definer function `current_user` is the owner; in an application session it is the connected role. A session can set a variable but cannot become the owner, so neither the old variable nor the new marker is sufficient. Even the operator connection cannot write outside the function.
3. `grant-app-role.sh` additionally withholds the privileges from the application role (INSERT/UPDATE/DELETE/TRUNCATE on the activation table; UPDATE on the five protected reorder columns) - least privilege on top of the trigger. `EXECUTE` on the two functions is revoked from `PUBLIC` and reaches the application role through the same script.
4. RLS: the functions may run with a privileged owner that bypasses RLS, so each re-establishes tenant isolation itself: the stated tenant/workspace must equal the transaction's authoritative `app.tenant_id` / `app.workspace_id`, and the business (and balance) must belong to exactly that tenant/workspace/business. Caller-supplied ids cannot override the authoritative scope.

The functions are the **protected mutation boundary, not the authorization engine**:

- The BO engine still performs claim validation, the final ABA authority check, the capability gate, the window/expiry/preconditions and the baseline comparison before it calls the reorder function.
- The activation function additionally verifies, in the database, the same rule the API enforces: the actor has an **active membership** in the tenant/workspace with a role granting the **existing `bo:admin`** permission. It writes the audit row (same table, same action names and metadata as before) in the same transaction, so an activation cannot exist without its audit row. No permission was invented.

## 3. Semantics preserved (no product change)

Activation: no row = CLOSED; append-only version chain; repeating the current state is a no-op; DISABLED works; the registry and kill switch are unchanged and the gate still needs all three keys plus valid subscriptions.
Reorder: compare-and-set against the caller's baseline (mismatch writes nothing), no rounding (non-negative, at most 4 decimals, inside `numeric(18,4)`), version +1 only on a real mutation, an unchanged configured policy is no UPDATE and no version bump, other columns untouched. F2 is unchanged (a claim reaching execution with a closed gate may still end `REFUSED(CAPABILITY_DISABLED)`).

## 4. Configuration and deployment preconditions (owner-visible)

- **P1 - the application must connect as a role other than the function owner.** The protection is `current_user`-based; if production connects the application as the migration/owner role (for example a single `postgres` role), the trigger cannot tell them apart. Verify before any live migration: `SELECT current_user` on the application connection must differ from `SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE proname IN ('record_execution_capability_activation','apply_inventory_reorder_policy')`, and the application role must be neither superuser nor `BYPASSRLS`. The live database could not be inspected in this block.
- **P2 - run `grant-app-role.sh` (or `GRANT EXECUTE` on the two functions to the application role) after applying 0196**, because `EXECUTE` is no longer left with `PUBLIC`. Until then the application cannot call the functions.
- **P3 - a dedicated NOLOGIN owner is a recommended follow-up, not done here.** Creating a role is a deployment decision this repository leaves to the environment; today the owner is the migration role. Moving ownership later is `ALTER FUNCTION ... OWNER TO <role>` (the triggers follow the owner dynamically); that role must not be superuser/BYPASSRLS if RLS is to apply inside the functions (they re-check scope explicitly either way).
- Residual by design: the database cannot authenticate an end user. A caller holding the application role can still invoke the activation function naming a REAL `bo:admin` actor of the same tenant; what changed is that this now requires a genuine administrator identity, is always audited under that identity, and can no longer be done by a plain INSERT or an unaudited path.

## 5. Tests

- `packages/business-operations-runtime/tests/DatabaseAuthorityHardening.integration.test.ts` (18, real PostgreSQL as the least-privilege role): direct writes refused; privileged non-owner role refused with the marker set; governed success, audit, history, no-op, DISABLED; refusals for wrong permission, tenant, workspace, business, missing/non-admin/suspended/foreign actor, bad state/reason; old variable, `SET`, `SET LOCAL`, `set_config` and the new marker all insufficient; cross-tenant/business/balance refused; baseline, stale point/quantity, negative, >4 decimals, range, source; real mutation exactly once; NO_CHANGE; BO executor end to end; column/table privileges; definer hygiene (owner, search_path, no dynamic SQL, hostile `search_path`, hostile arguments, no unrelated columns, minimal EXECUTE).
- `packages/event-worker/tests/databaseAuthority.architecture.test.ts` (8): activation writes only through the function; reorder writes only through the executor's call; no route/ABA/worker/other-layer path; no second writer; migration shape (two definer functions, pinned search_path, no dynamic SQL, no table/role/grant/seed); provisioning script; exactly one migration after 0195; no default-enabled path.
- Mutation proofs (each caused at least one failing test): direct-write grants restored (activation and reorder), permission check, membership check, role requirement, active-status requirement, business scope (function and trigger), transaction-scope check (both functions), audit omitted, trigger guards removed, owner check removed (both triggers), old session variable accepted, baseline (whole, point only, quantity only), negative values, more than 4 decimals, version bump, NO_CHANGE updating, EXECUTE left with PUBLIC (both), `search_path` pin removed (both), activation rows mutable, default-ON activation, a second reorder writer.
- Existing suites were updated, not weakened: tests that simulated a prior committed change used the old session variable and now use an operator-only fixture; tests that enabled execution with a random user now seed a real `bo:admin` member (the database requires one); the audit-failure atomicity test injects the failure inside the database; guards that pinned "no migration after 0195" and "the marker lives in the executor" now pin the new, stricter facts. `delete-tenant-data.mjs` now treats the activation table as append-only (retained) because the application role can no longer delete from it.

## 6. Future extension

Dedicated NOLOGIN owner role (P3); the same governed-function pattern for the remaining BO-owned facts if the owner wants database-level proof for them; live-database review/migration planning as a separate owner gate.
