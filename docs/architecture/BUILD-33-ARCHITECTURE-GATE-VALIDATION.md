# BUILD-33 — Architecture Gate Validation Evidence

**Specification:** BUILD-33 v1.1  
**Guardrail:** INFINICUS Master Architecture Guardrail v1.0  
**Validated commit:** `2185a3739450f64591e6b299e335f57c22a283d1`  
**Validated:** 2026-10-05  
**Result:** PASS — ARCHITECTURE GATE MAY REOPEN

## CI evidence

- BUILD-32 Operations Runtime CI #76 — PASS.
- INFINICUS Platform CI #178 — PASS.
- Platform validate job — PASS.
- Container image build / readiness / smoke / DAST — PASS.
- Install, lint, typecheck, build, browser-secret scan, dependency scan,
  least-privilege role creation, migrations, grants and tests all passed.

## Live PostgreSQL / RLS evidence

The BUILD-33 live integration suite
`packages/database/tests/build33-eventing-rls.integration.test.ts`
ran with:

- `DATABASE_URL` = least-privilege application role;
- `ADMIN_DATABASE_URL` = privileged CI admin role.

Twelve live checks passed.

Verified:

1. ACTUAL provenance round-trips unchanged.
2. ASSUMPTION_BASED provenance round-trips unchanged.
3. BENCHMARK_BASED provenance round-trips unchanged.
4. ESTIMATED provenance round-trips unchanged.
5. FORECAST provenance round-trips unchanged.
6. SIMULATION provenance round-trips unchanged.
7. Canonical ledger UPDATE is blocked even for privileged DB access.
8. Cross-tenant and same-tenant/cross-workspace ledger reads are denied.
9. TENANT_WORKSPACE subscriptions require exact workspace match.
10. TENANT_GLOBAL subscriptions are visible across one tenant only.
11. Legacy PLATFORM_GLOBAL subscriptions remain visible to privileged
    relay/admin access and hidden from the normal application role.
12. Missing/empty tenant/workspace context fails closed without UUID-cast
    crashes.

The file reports 13 total cases because the no-database fallback case is
deliberately skipped when live database credentials are present; the 12 live
database/RLS checks executed and passed.

## Full database regression

`@infinicus/database`:

- 43 test files passed.
- 2923 tests passed.
- 26 tests skipped under their established environment/guard conditions.
- BUILD-33 static migration architecture tests passed.
- BUILD-33 live PostgreSQL/RLS architecture tests passed.

## Architecture conclusion

The v1.1 corrections now demonstrate:

- DATA remains owner of event infrastructure/history only.
- No business-state source of truth moved domains or layers.
- Cold-Start evidence classification is persisted without coercion.
- Event history remains append-only.
- TENANT_WORKSPACE / TENANT_GLOBAL / PLATFORM_GLOBAL semantics are preserved.
- Legacy platform-global subscription semantics are not silently destroyed.
- Tenant and workspace isolation remains fail-closed.
- No locked layer specification was weakened.

The BUILD-33 architecture gate is therefore cleared to resume implementation.

This evidence does **not** mark BUILD-33 complete and does **not** authorize
BUILD-34.
