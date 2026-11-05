# POS2-03: POS readiness gate foundation

Workstream: INFINICUS POS 2.0 (POS-only). Baseline: `main` at `1058681a`. Status: DEVELOPMENT, draft. Nothing here is deployed or production-activated, and nothing consults it yet.

## 1. Recovered checkpoint

POS2-01 (#425, #427), POS2-02 (#428) and the separate Stripe workstream (#429) are merged. Migrations on `main` end at `0226`. No branch or PR implemented or started POS2-03 (checked: no open PR, no branch claiming a later migration). The branch `ccr-9ed397ed-7fggdr-p3-readiness` is an unrelated October release-readiness report.

## 2. What readiness is, and is not

Entitlement answers "may this tenant use POS?". Readiness answers "is this business configured to sell safely?". They are independent: readiness reads no billing, entitlement or provider state (a guard test enforces it) and is not stored in `billing.entitlements`. Role and business policy remain a third question. A tenant can be entitled and not ready, or ready and not entitled.

## 3. Findings about existing POS readiness concepts (from code on `main`)

No readiness concept existed. What the approved POS contracts already enforce, at the moment an order is created (`OrderRepository.create`), is exactly two things: the business has a **declared currency** that the platform can state exactly (migration 0185, minor-unit table), and the business has an **open register session whose currency equals the declared one**. Everything else a POS 2.0 checklist might include is either not enforced, optional, or not modelled:

| Candidate | Finding | Treatment in v1 |
|---|---|---|
| Tenant/business association | Enforced by the business-in-workspace guard on every business route | The business read is the scope check: a business not visible to the caller is 404, not a readiness answer |
| Declared, supported currency | Enforced at order creation | REQUIRED |
| Open register in the declared currency | Enforced at order creation | REQUIRED (session scope) |
| Business status (`active`, `draft`, `suspended`...) | **Not enforced** for any POS write | ADVISORY only |
| Active catalogue product | Not required: orders accept free-text lines | ADVISORY only |
| Merchant tax configuration | Not modelled (disabled tax resolver, POS2-07) | NOT_APPLICABLE |
| Opening stock / inventory configuration | Sales do not touch inventory yet (POS2-04) | NOT_APPLICABLE |
| Store / branch | No such concept | NOT_APPLICABLE |
| Authorized operator | Per actor and per request (`bo:write`), not a property of the business | Not a readiness check; stays a role check |
| Payment methods | Fixed set (cash, card, other) | Not configurable, no check |
| Hardware | Browser printing fallback exists | Not required, no check |

## 4. Contract: `pos-readiness/1`

`GET /v1/businesses/:businessId/pos-readiness` (read-only; `bo:read`; business in the caller's tenant and workspace; **no entitlement, subscription or idempotency gate**: reads of the customer's own records stay available).

```
{ contract: 'pos-readiness/1', businessId,
  configuration: READY | NOT_READY | UNVERIFIED,   // can the business sell at all (REQUIRED configuration checks)
  session:       READY | NOT_READY | UNVERIFIED,   // can it take an order now (every REQUIRED check, configuration and session)
  checks: [{ id, scope: CONFIGURATION|SESSION, requirement: REQUIRED|ADVISORY, status: PASS|FAIL|UNVERIFIED|SKIPPED|NOT_APPLICABLE, reasonCode|null }],
  blockingReasons: [reason codes of REQUIRED checks that are not passing, in check order] }
```

Check order is fixed: `BUSINESS_ACTIVE`, `CURRENCY_DECLARED`, `CURRENCY_SUPPORTED`, `CATALOG_HAS_ACTIVE_PRODUCT`, `TAX_CONFIGURATION`, `INVENTORY_CONFIGURATION`, `BRANCH_CONFIGURATION`, `REGISTER_OPEN`, `REGISTER_CURRENCY_MATCHES`. Reason codes are a closed vocabulary (`BUSINESS_NOT_ACTIVE`, `CURRENCY_NOT_DECLARED`, `CURRENCY_NOT_SUPPORTED`, `NO_ACTIVE_PRODUCTS`, `TAX_NOT_MODELLED`, `INVENTORY_NOT_LINKED_TO_SALES`, `BRANCH_NOT_MODELLED`, `REGISTER_NOT_OPEN`, `REGISTER_CURRENCY_MISMATCH`, `DEPENDENCY_UNAVAILABLE`, `PREREQUISITE_NOT_MET`) enforced by the response schema, and changing one is a contract version change.

Rules: deterministic (the evaluation is a pure function of facts; no clock, no randomness); a FAIL or SKIPPED required check makes the verdict NOT_READY and outranks UNVERIFIED; a required dependency that cannot be read is UNVERIFIED, never a pass, and its cause is not exposed; advisory and not-applicable checks never block; a check that depends on a failed prerequisite is SKIPPED, not guessed.

## 5. Multi-store

The contract is keyed by business, so a later store or branch concept can add per-store checks without changing existing codes. There is no store concept today, so `BRANCH_CONFIGURATION` reports `NOT_APPLICABLE`.

## 6. Not implemented, by design (owner decisions)

- **Storage and activation state.** v1 derives readiness from current facts and stores nothing, so there is no table, migration, activation record or "first transaction" maturity event. Whether activation is an explicit recorded step, who may perform it, and where it is stored (the proposal says readiness must not live in the entitlement table) is undecided.
- **The mandatory checklist.** Only the two enforced prerequisites are REQUIRED. Promoting business status, a catalogue product, tax, opening stock, a cashier account or hardware to REQUIRED changes behaviour and needs a ruling, and some depend on industry profiles (POS2-09).
- **Wiring the gate.** No order, register or tender code consults readiness. Making order creation or register opening refuse on it, and the response when a READY business becomes NOT_READY, are activation decisions.
- No web surface, no events, no audit rows (the read writes nothing).

## 7. Evidence

- Unit (20): every verdict, fixed order and determinism, fail-safe (UNVERIFIED), advisory never blocks, the service passes only the caller's context and business id, not-found is not swallowed, dependency causes are not exposed, no billing or write reference.
- Live PostgreSQL + Fastify (9): the report agrees with what order creation actually does (refused when no register, refused on currency mismatch, accepted when ready); a draft business is advisory only and orders still work; deterministic and writes nothing (orders, registers, entitlements, events and subscriptions unchanged); identical report for a plain, a suspended and a Growth-only tenant; another tenant, another workspace, an unknown id, no token and no `bo:read` are 404, 404, 404, 401, 403; invalid id is 400.
- Source guard (7): one GET with the exact guard chain; no entitlement, subscription or idempotency gate, no SQL; no existing code consults it; order, register and tender code unchanged.
- Mutation proofs (each failed a test, then reverted): undeclared currency treated as a pass; register currency comparison removed; advisory made required; unreadable dependency counted as a pass; not-found swallowed; session ignoring configuration checks; scope guard removed; capability gate added to the read; permission removed.

## 8. Dependency register (kept separate, not implemented here)

F-HIST-1 entitlement backdating (before POS2-08); billing tests outside hosted CI; intermittent BO/BI integration test; local FORCE RLS test setup documentation; entitlement provisioning; POS commercial activation; migration-governance improvements.

## 9. State vocabulary

Implemented = code on this branch. Locally verified = the evidence above on a disposable PostgreSQL 16. Hosted-CI verified = exact-head GitHub checks (recorded on the PR). Merged = on `main` (not yet). Production-ready = not claimed and not possible from development.
