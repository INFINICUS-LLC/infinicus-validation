# BUILD-33 — Cross-Domain Business Event Architecture: completion report (DRAFT for owner review)

**Status of this document:** drafted by Claude Code at the owner's request so that PR #22's own merge condition can be evaluated. It records only what was run or read. **It does not declare BUILD-33 complete; the owner decides.** Specification: BUILD-33 v1.2 (v1.1 architecture amendment + v1.2 numbering correction). Governing architecture: Master Architecture Guardrail v1.0. Locked layer specifications are unchanged.

## 1. Scope completed
Canonical event contracts and an immutable Event Ledger foundation, plus hardening of the existing event-transport tables:
- `@infinicus/event-contracts`: `BusinessEventEnvelope`, validation, `BusinessEventContractRegistry`, five legacy event-type aliases.
- `@infinicus/database` eventing module: `EventLedgerRepository`, `CanonicalEventPublisher`, `LegacyOutboxCompatibilityRegistry`, `ReplayAuthorization`, `OutboxRepository`, `InboxRepository`, `DeadLetterRepository`, `EventSubscriptionRepository`, `EventDeliveryAttemptRepository`.
- Migrations `0172_create_business_event_ledger.sql` and `0173_harden_eventing_scope.sql`.
Not in scope (spec §24): BUILD-34, accounting ledger, brokers, event sourcing of every domain, UI, production deployment.

## 2. Files
35 files changed against the original base (3 docs/state, 2 migrations, eventing module, event-contracts, 4 database test files, 1 event-contracts test, lockfile and package manifests). Since then: `main` merged in twice (post-#31, post-#35) and the two migrations renumbered 0171/0172 → 0172/0173 (content unchanged).

## 3. Migrations (baseline before / after, freeze status)
- Before: 0001–0171 on `main` (0171 = Data Acquisition webhook lookup, merged first). After this PR: 0001–0173. 0001–0171 untouched.
- **0172** creates `events.business_event_ledger`: mandatory `evidence_class` (ACTUAL, ASSUMPTION_BASED, BENCHMARK_BASED, ESTIMATED, FORECAST, SIMULATION) bound to `provenance`, ENABLE+FORCE RLS on tenant/workspace, row-level UPDATE/DELETE-rejecting trigger, idempotency unique index.
- **0173** adds scope classes TENANT_WORKSPACE / TENANT_GLOBAL / PLATFORM_GLOBAL to the five transport tables (derived, not writer-declared), replaces their RLS policies with fail-closed UUID parsing, keeps platform-global rows for privileged relay, makes `event_delivery_attempts` append-only. The earlier v1.1 "compatibility hold" applied to the first draft; the redesigned file passed the architecture gate (`BUILD-33-ARCHITECTURE-GATE-VALIDATION.md`, commit 2185a37).
- Freeze: migrations are immutable once merged. Numbers 0172/0173 are allocated to this PR (owner ruling, 2026-10-07). P0-3 will take 0174/0175 after this merges.

## 4. Commands executed and results
Local, PostgreSQL 16, at head `a0b9b4e` (before the final `main` merge), fresh database, CI recipe:
| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | OK, lockfile unchanged |
| `node scripts/validate-workspace.mjs` (`pnpm workspace:validate`) | 38 passed, 0 failed |
| `check-dependency-vulnerabilities.mjs` | passed, 6 allowlisted advisories |
| `turbo run lint typecheck build` | 69/69 tasks, 0 errors |
| `migration-gate.sh` (fresh DB) | applied through 0173; re-run skips all (idempotent) |
| `grant-app-role.sh` | OK |
| `turbo run test` (database, configuration, observability, BO runtime, authentication, authorization, onboarding, workflow, api, web, data-acquisition-runtime, event-contracts, CL layer) | 36/36 tasks: database 2961 passed / 26 skipped; api 106 / 12 skipped; workflow 31 / 1; authentication 54 / 1; authorization 25 / 1; onboarding 20 / 1; web 14; BO runtime 22; DA runtime 94 / 1; configuration 46; observability 18; event-contracts 15 |
| BUILD-33 files only (live DB) | `build33-eventing-rls` 14 live checks passed; `migration-build33` 12 static; `publication-replay` and `delivery-attempt` unit tests passed; 37 passed, 1 skipped |
| `node --test platform/tests/*.test.mjs`, `scripts/check-bundles.mjs` | 12 passed; bundles OK |
Skips: the single BUILD-33 skip is the deliberate "no database credentials" fallback case (it runs only without `DATABASE_URL`). The other database skips predate this PR (25 on `main`). **The live eventing/RLS tests did not skip.**

GitHub CI: see section 11 (state at the time of writing).

## 5. Architecture compliance (v1.1)
- DATA owns event infrastructure/history only; the ledger is evidence, not business truth; no domain/layer ownership moved; no locked spec weakened.
- Cold-Start provenance persisted without coercion (six classes round-trip; legacy adapter requires an explicit profile `evidenceClass`, no default to ACTUAL).
- Append-only: ledger UPDATE/DELETE and delivery-attempt UPDATE/DELETE rejected even for privileged connections (test 7 of the gate).
- Tenant/workspace isolation: cross-tenant and cross-workspace reads denied; missing/empty context fails closed without UUID-cast crashes.
- Idempotency: unique (tenant, workspace, source_domain, source_service, idempotency_key); repository returns the existing record only for an identical logical event, otherwise conflict.
- Replay/ABA safety: `assertReplayAuthorized` requires approver, reason, `DELIVERY_ONLY` mode, and an ABA approval-action reference for action-related event types.

## 6. Producer / consumer inventory (read from the repository)
- **No application code publishes to or consumes from the canonical ledger yet.** `CanonicalEventPublisher` and the repositories are referenced only by the database package exports and tests; no `apps/*` route or service calls them.
- The contract registry has no registered contracts by default; five legacy aliases are defined (`da.data.published`, `bo.inventory.movement_recorded`, `bo.purchase_order.approved`, `bo.order.completed`, `bo.invoice.issued`).
- Existing producers remain the per-layer SQL `emit_*` trigger functions writing `events.outbox_events` (unchanged). Cross-layer handoffs still do not travel on events (reconciliation finding E-04, open).
- The Manifest example events (`ACTION_AUTHORIZED`, `ACTION_EXECUTED`, `OUTCOME_VERIFIED`, `CALIBRATION_PROPOSED`, `MODEL_VERSION_ACTIVATED`) are not defined here (E-05, open; depends on C-02/C-03).

## 7. Source-of-truth review
No table owned by another layer is read or written by the new code. `events.*` remains infrastructure. `platform.*` tables are not touched. Consistent with SOT rulings of 2026-10-07.

## 8. Contract compatibility
Legacy outbox rows are preserved (no delete/rewrite of historical rows); legacy `started` delivery status vocabulary is tolerated but not written; PLATFORM_GLOBAL subscriptions stay visible to privileged relay and hidden from the normal application role.

## 9. Security review (reviewer: Claude Code; not an independent audit)
- RLS ENABLE+FORCE with USING and WITH CHECK on the new ledger; replaced policies on five tables fail closed.
- No secrets, tokens or credentials in the migrations, repositories or tests; sensitive-data classification field present on the envelope.
- Replay cannot bypass ABA for action-related events (see A-3 below).
- Browser-secret scan and dependency scan pass.

## 10. Rollback procedure
Migrations are additive and immutable; there are no down-migrations. Operational rollback is: stop writers (nothing in the applications writes the ledger today, so no application change is needed), then a forward migration (new number) that drops the `events.business_event_ledger` objects and, for 0173, recreates the prior policies and drops the added scope columns/trigger. The prior policy definitions are in the earlier `events` migrations. **This procedure has not been rehearsed**; point-in-time recovery (`pitr-restore.sh`) is the fallback.

## 11. Unresolved defects, limitations, and evidence gaps
- **CI on the PR head:** `validate` failed at head `a0b9b4e` with one failure, `owner-authority.integration.test.ts` "writes nothing" (`expected 401 to be 400`). Cause: a table-wide row count racing with parallel test files; unrelated to BUILD-33 and fixed on `main` by #35. `main` has been merged into this branch to carry the fix; **the CI result of that new head must be green and is to be recorded here before merge.**
- **No producers/consumers wired** (section 6): the architecture exists but moves no real events yet. This is consistent with the "foundation" phase in the PR description; it means BUILD-33's value is not exercised end to end.
- Advisory A-1: append-only trigger is row-level; `TRUNCATE` is not intercepted (application role has no TRUNCATE grant).
- Advisory A-2: `grant-app-role.sh` grants UPDATE/DELETE on all tables including the ledger; protection relies on the trigger alone.
- Advisory A-3: the replay action-event rule is a name-pattern match, not a registry flag.
- Spec §18 still contains the original "compatibility hold on 0172" paragraph for the first draft; v1.2 notes it is superseded by the gate validation.
- Container smoke/DAST: run by GitHub CI only; not run locally.
- Rollback not rehearsed; no independent security audit.

## 12. Next eligible build
BUILD-34 remains **not authorised** by this report. Eligibility is the owner's decision after review.
