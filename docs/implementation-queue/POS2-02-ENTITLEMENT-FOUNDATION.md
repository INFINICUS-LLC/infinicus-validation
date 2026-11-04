# POS2-02: POS Core entitlement foundation

Workstream: INFINICUS POS 2.0 program. Baseline: `main` at `59ae873` (POS2-01 merged). Status: DEVELOPMENT. Nothing here is deployed, priced, sold, activated or applied to any production database. Owner rulings R1 to R8 of the POS 2.0 owner rulings are the authority for this block.

## 1. What was built

A dedicated entitlement store, `billing.entitlements` (migration **0225**, the next free number after `0224` on `main` at `59ae873`; re-check before merge), and the resolution that sits between commercial state and the application capability checks:

```
Commercial state  ->  entitlement derivation (a later process)  ->  billing.entitlements  ->  capability checks (requireCapability)
```

Until a tenant has a row in the store, nothing changes for it: the application derives today's compatibility behaviour from the subscription state (the POS2-01 profile). Once a tenant has any row, the store alone decides.

## 2. Rulings applied

| Ruling | How it is met |
|---|---|
| R1 dedicated store, several simultaneous capabilities, not derived from the single subscription row, many future sources | Table keyed by tenant, capability, `source_type` (`compatibility`, `trial`, `subscription`, `add_on`, `enterprise_contract`, `operator_grant`) and `source_reference`; the same capability may come from several sources at once; `billing.subscriptions` is untouched and stays one row per tenant. |
| R2 no final tier contents | No seed rows, no bundle, no plan mapping anywhere. Tier contents are data to be written later. Tests use explicit fixtures only. |
| R3 POS Core not permanently free; do not change current behaviour | The compatibility profile is unchanged (a tenant with no rows behaves exactly as before); nothing grants or withholds `pos.core` from the free plan. Paid enforcement is not activated. |
| R4 history for offline replay | `effective_from`, `effective_until`, `status` and `revoked_at` are kept and never rewritten, so "was the tenant entitled at time T" is answerable (`EntitlementService.wasEntitledAt`). The offline replay rule itself is POS2-08. |
| R5 reads stay available | The capability gate was never applied to reads and still is not; a test shows a tenant without `pos.core` can still read its order list. |
| R6 `pos.core`, `pos.inventory`, `pos.offline` stay separate keys | They are separate vocabulary keys and separately grantable; no packaging decision is encoded. |
| R7 readiness is separate | Nothing about readiness is stored here. |
| R8 no production capability mutation | No seed, no backfill, no route that writes; the application role cannot write the table or execute the write functions (section 4). |
| Traceability | Every row carries `tenant_id`, `capability`, `source_type`, `source_reference`, `effective_from`, `effective_until`, `status`, `created_at` (plus `revoked_at`). No provider identifier is part of capability semantics. |
| Fail closed | See section 5. |

## 3. Storage

`billing.entitlements`: `id`, `tenant_id` (FK to tenants), `capability` (checked shape `family.name`, families `pos|intelligence|enterprise`), `source_type`, `source_reference` (opaque, 1 to 200 characters), `effective_from`, `effective_until` (must be later than the start when set), `status` (`active|revoked`), `revoked_at` (set exactly when revoked), `created_at`. Unique on `(tenant_id, capability, source_type, source_reference, effective_from)`, which is the idempotency identity: a renewal is a new row with a new start.

Row-level security is enabled and forced on `tenant_id` (billing is tenant-level, as in 0152). Rows are never deleted or truncated (the `billing.forbid_mutation` trigger, which tenant erasure recognises as retained history), and the only change ever allowed is the one-way revocation.

## 4. Write path and who may write

Rows are written only by two `SECURITY DEFINER` functions with a hardened `search_path` and no dynamic SQL: `billing.grant_entitlement(...)` (idempotent: an exact replay changes nothing, including of a revoked grant; the same identity with a different end is refused) and `billing.revoke_entitlement(...)` (one way; already revoked is a no-op). Both require the stated tenant to equal the transaction's authoritative `app.tenant_id`. A table trigger refuses any write that does not come from those functions run as their owner (marker plus owner check, the pattern used for the BO governed writes in 0196), so even a privileged session cannot insert, update or delete directly.

`EXECUTE` is revoked from `PUBLIC`, and `grant-app-role.sh` withholds INSERT/UPDATE/DELETE/TRUNCATE on the table and EXECUTE on both functions from the application role on every run, after the blanket grants. **Deployment note:** the script must be rerun after migration 0225 (as for every new function). The repository exposes the two writes as static helpers (`EntitlementRepository.grant / revoke`) for the future governed commercial process, not for request-serving code; a source guard fails if any request-serving code references them.

## 5. Resolution and fail-closed rules

`EntitlementService.resolveProfile(ctx)`: a tenant with no store rows gets the compatibility profile; a tenant with any row (even only expired or revoked ones) gets the store profile, with no fallback that could re-grant what the store withholds. `enforceCapability` still runs the subscription gate first, so a suspended or canceled tenant gets the same 402 as before, then asks the profile.

Denied: an unknown capability (not in the vocabulary, including a stored key the code does not know); an unknown or non-functional state; an expired or not-yet-started entitlement; a revoked entitlement. Nothing is inferred from a plan name, provider product name, email, UI state or client flag: the resolver does not read the plan at all (a guard test enforces this). "Effective at T" is one SQL expression shared by every read, evaluated at database time when no moment is given.

## 6. The four required shapes (tested)

| Tenant | Store rows | Holds | Refused |
|---|---|---|---|
| A | `pos.core` | `pos.core` | `pos.inventory`, `pos.offline`, every intelligence capability |
| B | `pos.core`, `intelligence.growth` | both | `intelligence.pro`, `pos.inventory` |
| C | `intelligence.growth` | `intelligence.growth` | `pos.core` (POS writes get 403) |
| D | `pos.core`, `intelligence.pro`, `pos.inventory` (add-on) | all three | `intelligence.growth`, `pos.offline` |

POS code asks only for `pos.core`; it contains no plan, provider or price reference.

## 7. Tests

- Database (live PostgreSQL 16, app role + admin): 16 tests. Shape and constraints; idempotent grant and conflicting replay; one-way revoke and no resurrection; direct INSERT/UPDATE/DELETE/TRUNCATE refused even on the admin connection; the application role holds no write privilege and no EXECUTE; cross-tenant isolation both ways and "no scope sees nothing"; history at four moments.
- Service (live): the four shapes; compatibility unchanged for a tenant with no rows; cross-tenant independence; expired, not-yet-started and revoked deny with no fallback; several sources; unknown capability denies; suspension still wins (402); `wasEntitledAt`.
- API (live): per POS write family, POS Core alone opens POS, Growth alone gets 403, expired gets 403; POS Core + Growth holds POS and a suspended subscription still gives 402; a Growth-only tenant can still read.
- Source guards: no provider, plan or price semantics in the store, the capability code or the resolver; forced RLS and no delete; the application role's privileges withheld; no request-serving code can grant or revoke; migration numbering gap-free and unique.
- Mutation proofs (each caused a failure, then was reverted): store profile falling back to compatibility; unknown keys accepted; `effective_until` ignored; revocation ignored; RLS policy opened; write guard trigger disabled; application role granted INSERT; EXECUTE granted.

## 8. Not done, by design

- No derivation process (nothing writes entitlement rows from subscriptions or contracts), no operator tool, no route, no UI. Rows exist only as test fixtures.
- Intelligence routes still use `requireActiveSubscription`; gating consumption of Growth/Pro by capability is a later block. Capability resolution already answers the question; the wiring is not changed here.
- No pricing, tier distribution, Stripe mapping or free-plan change. No production migration or data.
- Offline replay by entitlement history is POS2-08; `wasEntitledAt` is the prerequisite only. A tenant with no store rows has no history, so it answers no.
- Carried-over items remain outside this block: per-product kitchen routing, migration production window, offline caps, clock-skew policy, unsigned M1-A7 rulings, merchant tax, refunds, staff-name permission, final pricing, final provider mapping.

## 9. Known limitations and risks

- While a store-entitled tenant also has a subscription, billing suspension or cancellation still denies every capability (the subscription gate runs first). This preserves today's behaviour; the derivation process should later make the store the single authority.
- Tenant erasure retains these rows (the same rule as other append-only billing history). Whether entitlement history must be erased with a tenant is a retention decision for the owner.
- The `source_type` list and the capability families are database CHECKs; a new family or source type needs a migration. Individual capability keys within a family need none.
- Rollback: the migration only adds one table and two functions and no existing object is altered, so reverting the application leaves them unused; dropping them is a separate approved step.
