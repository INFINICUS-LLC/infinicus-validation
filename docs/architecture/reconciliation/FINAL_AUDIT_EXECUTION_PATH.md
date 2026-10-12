# Final audit - authorized-action execution path (main `a84ac00`)

Scope: ADI -> ABA -> AuthorizedActionPackage -> BO intake -> BO claim -> fresh ABA authority verification -> BO execution -> ExecutionEvidence ->
`operations.action.executed@1` -> OM EXECUTION_VERIFIED -> CL, as reconciled in P0-6.0 through P0-6h. Read-only audit of main: no product code, migration,
live database or configuration was changed. Evidence below was executed (SQL probes on a fresh database migrated through 0195 with the app role, and
a scratch engine probe), not only read. **The live Supabase head is unverifiable (the connector lists no projects); nothing here speaks for the live database.**

## 1. Verdict

The execution path in code conforms to the locked architecture. **No finding blocks the merged state.** Three findings (F1-F3) are pre-production
hardening decisions for the owner; F4 is an operational prerequisite. Production activation remains OFF and nothing is activated, seeded or backfilled.

## 2. Verified conformant (with evidence)

| Invariant | Evidence |
|---|---|
| Main is green | Platform CI run 344 on `a84ac00` success (runs 340, 342 also) |
| BO is the only writer of reorder fields | grep: only `OperationalCommandExecutor` updates `reorder_*`; `InventoryBalanceRepository` does not; API has no route to `InventoryReorderPolicyService` |
| ADI / SIM never execute or touch BO | grep of `layers/ai-decision-intelligence`, `layers/simulation`, `simulation-engine`, `llm-client`: no BO table, executor, or engine reference |
| ABA authorizes/announces only; BO reads no ABA table | architecture guards (P0-6a/6b/6f) pass in CI; only API composition root and worker root join the ABA status provider |
| Direct reorder UPDATE outside the BO command is refused (accidental path) | probe: `reorder policy can only be configured by the configure_inventory_reorder_policy command` |
| Tenant isolation | probe: other-tenant scope sees 0 rows and updates 0; app role is not superuser, not BYPASSRLS |
| Fact tables are append-only, RLS **forced**, TRUNCATE-guarded | catalog probe over claims, receipts, attempts, executions, intake attempts, activations, OM verifications: RLS+FORCE on all, UPDATE/DELETE/TRUNCATE triggers on all |
| Single use / one outcome | unique indexes: claims `(package_id, package_version)`; executions one per claim and per package; receipts per package; OM one per execution |
| Default CLOSED | activation table has 0 rows after migration; migration 0195 contains no seed/backfill; gate = registry AND activation AND no kill switch AND 3 valid subscriptions |
| Recovery adds no authority | P0-6g/6h guards and tests (13 + 10 real-PostgreSQL): terminal never re-driven, final authority check mandatory, gate checked, no claim creation, no scanner, no migration |
| OM verifies only; CL learns nothing | guards pass: OM never writes BO, outcomes beyond PENDING/INCONCLUSIVE refused by the database, nothing calls the learning gate |
| No new privilege since 0195 | newest migration is `0195`; P0-6g/6h add no role, grant or policy |

## 3. Findings

**F1 - Activation record is protected by application convention, not by the database (Medium; decision).** `execution_capability_activations` is append-only and
version-chained with RLS, but nothing in the database requires `permission_code = 'bo:admin'`, that the actor holds it, or that an audit row exists. Any code
running as the application database role inside a tenant scope can insert an `ENABLED` row. The API (`bo:admin`) and `ExecutionActivationService` enforce it; no route
bypasses them. Recommendation: before any production activation, make insertion go through a SECURITY DEFINER function (or at minimum `CHECK (permission_code = 'bo:admin')`)
and revoke direct INSERT from the application role. Needs a migration - a separate, owner-authorized block.

**F2 - A closed gate at engine time spends the claim (Low-Medium; decision).** Probe: with a claim held and the gate closed, `executeClaim` writes a terminal
`REFUSED(CAPABILITY_DISABLED)`; a second call replays it. So a kill switch or DISABLE that lands between intake and execution, on the original delivery path, consumes the
authorization (fail-safe: nothing executes, a new authorization is needed). The P0-6g recovery consumer and P0-6h operator control check the gate first and never do this, so
paths are inconsistent. Recommendation: either accept (conservative, simplest) or make a closed gate a non-terminal "cannot decide yet" so the held claim survives for recovery.
Needs an owner ruling because it changes a ruled terminal semantic.

**F3 - The reorder-field guard is a session-variable convention (Medium; decision).** Migrations 0189/0192 refuse reorder writes unless `app.bo_reorder_policy_writer` is set,
but the application role can set that variable itself: probe - after `set_config('app.bo_reorder_policy_writer', 'configure_inventory_reorder_policy', true)` a direct
`UPDATE ... SET reorder_point = 999` succeeded (state stayed UNSET). It protects against accidental writes, not against code or SQL running as the application role. No
route reaches it today. Recommendation as F1: column-level privilege plus a definer function, in a separate authorized migration block. "BO is the only writer" therefore holds at
the application layer (guarded in CI) and is not enforced against the database role.

**F4 - Production worker prerequisites are documentation, not provisioned state (Operational, blocks any activation).** The event worker's cross-tenant discovery role
(`infinicus_worker_discovery`, BYPASSRLS, column-limited SELECT on `events.outbox_events`) exists only in `infrastructure/deployment/event-worker/README.md`; no migration creates it
(correct for a privileged role) and the worker has no deployment. P0-6g/6h widened nothing (scopes still come only from outbox rows). Before activation: provision the role, deploy
the worker, set the kill-switch and status-age configuration, and verify the live database is migrated through 0195 (unverified here).

**F5 - Unexplained one-off test failure (Info).** The PR #98 run failed once in `AuthorizedActionExecution` ("healthy attempt" RETRY); it never reproduced and has not recurred in
main runs 340, 342, 344. The test now prints the attempt detail if it does.

**F6 - CI diagnosability (Info).** Failing logs were hard to retrieve (no uploaded test reports or failure summary). The recommended small CI-hardening PR remains unbuilt.

**F7 - Cost note (Info).** P0-6g writes one extra outbox/ledger row per claim, delivered as a no-op when the claim already completed.

## 4. Not audited

The live database and any deployed environment; frontend/web apps; ADI/SIM/LLM internals beyond the execution boundary; data-capture (A and D), outcome effectiveness and Continuous
Learning, which are intentionally unbuilt; performance and load; third-party dependency risk beyond the CI advisory allowlist (6 allowlisted advisories).

## 5. Confidence

About 90% on the code-level conformance claims (each backed by an executed probe, a CI-run guard, or a grep over the whole tree). Lower (about 70%) on completeness: an audit of this size
can miss a path that no guard or probe names; the guards are the standing protection.
