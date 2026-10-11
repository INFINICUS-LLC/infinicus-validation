# inventory_movements — FORCE ROW LEVEL SECURITY (migration 0186)

Status: DRAFT PR. Defence-in-depth hardening only. Not applied to live Supabase (live 0169). No Block B/A/D/E, B2b/B2c/B2d, rule-set
activation, FX or P0-6.

## 1. Purpose

`business_operations.inventory_movements` had RLS ENABLED but not FORCED (0035). 0186 adds `FORCE ROW LEVEL SECURITY` so the **table owner**
can no longer bypass the tenant/workspace policy. It changes no predicate and no operational behaviour.

## 2. Survey (confirmed before coding)

| Item | Finding |
|---|---|
| Policy | `inventory_movements_isolation`, PERMISSIVE, FOR ALL, role `public`; USING `tenant_id = app.tenant_id AND workspace_id = app.workspace_id`; no separate WITH CHECK (USING covers inserts) |
| RLS before | enabled, not forced |
| Table owner | the migration/admin role (a superuser locally; Supabase `postgres` has BYPASSRLS) |
| Application role | non-owner, non-superuser, non-BYPASSRLS, so RLS already applied to it and its behaviour is unchanged |
| Production path | DAL → intake → mapper → command → `OperationalCommandExecutor` (the only writer) runs as the application role inside tenant transactions; it does not rely on owner bypass |
| Accepted pattern | 0180/0182 (BO) and 0176–0179 (ABA) use `ENABLE` + `FORCE` in the migration |
| Test cleanup | the 0184 test-only helper runs as a superuser (`session_replication_role = 'replica'`); superusers ignore FORCE, so it is unaffected |

## 3. Change

One statement: `ALTER TABLE business_operations.inventory_movements FORCE ROW LEVEL SECURITY;` (idempotent). Policy, 0184 triggers, 0183
constraints, columns, indexes, grants and writers are untouched; nothing is read, moved or backfilled.

## 4. Effect (what changes and what does not)

- Application role: **no change** (already subject to RLS).
- Non-superuser, non-BYPASSRLS owner: **now subject to the policy** (proved with a borrowed test owner role inside rolled-back transactions:
  without FORCE it sees every tenant's rows; with FORCE it sees none without a tenant context and only its own tenant with one).
- Superuser and BYPASSRLS roles (including the migration role and, on Supabase, `postgres`): **unchanged**; FORCE cannot bind them.
- No production bypass and no `SECURITY DEFINER` helper is added; architecture guards fail if any production code weakens RLS.

## 5. Allocation record (MIGRATION-ALLOCATION-POLICY)

| Item | Value |
|---|---|
| Predecessor | `0185_create_business_currency_declarations.sql` (main `0e89d5a`, CI run 38153615304 SUCCESS) |
| New range | `0186`; no open PR and no remote branch claimed it |
| SHA-256 frozen 0001-0185 | `1b1e2692c377260a76d07128b0aae5469ffb931e31b5216bfc3f44c07ad0d7f5` |
| SHA-256 frozen 0001-0184 (unchanged) | `68d466fa1877929c1f9e5e668cf48e919b956c1026ad2cfa03ff3f23b9228b41` |
| SHA-256 of `0186_force_rls_inventory_movements.sql` | `fd97c171aa96d576061e6ce84ef1ccedb461756d3ee74f525e8305fe22698c59` |
| Live Supabase | not applied |

## 6. Caveats

1. Because the migration role is a superuser/BYPASSRLS role, FORCE gives no extra protection against that role; it protects against a
   future non-superuser owner. It is defence in depth, not a behaviour change.
2. Two existing assertions that the table was "not forced" (Block C and 0184 tests) were updated to the new state.
3. The owner-bypass proof creates and drops a NOLOGIN test role (`force_rls_test_owner`), which needs a role-creating test connection
   (the CI admin role is one).
