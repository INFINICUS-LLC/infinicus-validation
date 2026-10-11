# P0-5 Block B2b — BO-owned inventory policy evaluator

Status: DRAFT PR. No migration, no live change (live Supabase stays at 0169). B2c (verifier adapter / route / `modifiedAt` correction), B2d
(end-to-end modified approval authoring), the remaining data-capture blocks and P0-6 are NOT part of this block.

## 1. Purpose

Business Operations (BO) owns operational evaluation truth. `InventoryPolicyEvaluationService` evaluates one proposed
`inventory_reorder_policy_update@1` subject against the owner-approved rule set `inventory-reorder-policy/v1.0.0`
(`P0-5_B2_RULE_SET_inventory-reorder-policy_v1.0.0.md`, approved and effective 11 October 2026) and appends one authoritative, immutable
record per dimension through the B2a repository (`business_operations.inventory_policy_evaluations`, migration 0182).

It authorizes nothing, issues no package, executes nothing, mutates no inventory row, emits no event and produces no ExecutionEvidence.
ABA may later *verify* a stored record through an adapter (B2c); ABA is never the source of truth for it.

## 2. Architecture

```
caller (future B2c route / adapter)
  └─ InventoryPolicyEvaluationService.evaluate(ctx, request)          packages/business-operations-runtime/src/inventory-policy
       ├─ validate request (closed key set; supported action; approved rule-set version named explicitly)
       ├─ computeGovernanceSubjectDigest(subject)                       @infinicus/handoff-contracts (shared B2a helper)
       ├─ InventoryPolicyFactsRepository.loadSnapshot   (READ ONLY)     packages/database/src/repositories/bo — one statement, one MVCC snapshot, DB clock
       ├─ BusinessDeclaredCurrencyReader.getCurrent     (READ ONLY)     Business Administration read boundary (0185)
       ├─ evaluateInventoryReorderPolicy(...)           (PURE)          decimal.ts · ruleSet.ts · evaluate.ts
       └─ InventoryPolicyEvaluationRepository.recordAll (APPEND ONLY)   one transaction, four rows, evaluated_at stamped by the database
```

Dependencies: `@infinicus/database`, `@infinicus/handoff-contracts`, `node:crypto`. No ABA, workflow, onboarding, API or layer import
(guarded by `p0-5-b2b-evaluator.architecture.test.ts` and `boIsolation.architecture.test.ts`).

## 3. What a caller can and cannot do

| Can name | Cannot supply (refused with `CALLER_SUPPLIED_AUTHORITY`) |
|---|---|
| `businessId`, `actionType`, `target`, `finalParameters`, an approved `ruleSetVersion`, `correlationId` | result, dimension, thresholds, findings, inputs, subject digest, `evaluatedAt`, any other property |

There is no default rule set: an empty, unknown, DRAFT or future version is refused (`RULE_SET_NOT_APPROVED`). Only
`inventory_reorder_policy_update` schemaVersion `1` is evaluated (`UNSUPPORTED_ACTION_TYPE` / `UNSUPPORTED_SCHEMA_VERSION`). A target that is
not a lowercase UUID, not kind `inventory_item`, or not an item of the caller's tenant/workspace/business is refused before anything is
written (`TARGET_ID_NOT_UUID`, `TARGET_KIND_INVALID`, `TARGET_UNRESOLVED`) — the evaluation table references the item by foreign key, so an
unresolvable target has nothing to bind a record to and fails closed.

## 4. Dimensions and results

Exactly `CONSTRAINTS`, `RESOURCE_REQUIREMENTS`, `COST`, `EXPECTED_OUTCOME` (never REVERSIBILITY). Each yields `PASSED`, `FAILED` or
`INDETERMINATE`. Derivation (rule set §3): any `FAILED` finding ⇒ `FAILED`; else any `INDETERMINATE` ⇒ `INDETERMINATE`; else `PASSED`;
`INFORMATIONAL` findings never change a result. Only `PASSED` can later qualify as evidence; `FAILED` and `INDETERMINATE` fail closed.
An unset rule-set parameter is `INDETERMINATE` (`PARAMETER_UNSET`); nothing falls back to a default or invented threshold.

Finding shape: `{ rule, outcome, reasonCode, observed, limit }` (plus `basis`/`unitOfMeasure` on R1).

### Target preconditions (every dimension)
T1 kind is `inventory_item` (else FAILED) · T2 id is a UUID (else FAILED) and resolves (else INDETERMINATE `TARGET_UNRESOLVED`) ·
T3 exactly one balance row: none ⇒ INDETERMINATE `NO_BALANCE`; several ⇒ INDETERMINATE `WAREHOUSE_AMBIGUOUS` (a warehouse is never guessed);
unreadable stored baseline ⇒ INDETERMINATE `BASELINE_UNREADABLE`. When T1–T3 do not hold, only the precondition findings are recorded.

### CONSTRAINTS
C1 item `status = active` · C2 `finalParameters` has exactly `reorderPoint` and `reorderQuantity`, finite numbers ≥ 0 (else FAILED with the
specific reason) · C3 `reorderPoint > 0 ⇒ reorderQuantity > 0` · C4 baseline non-zero unless `FIRST_CONFIGURATION_OPTION = YES`
(v1.0.0 = NO ⇒ a zero baseline is INDETERMINATE `BASELINE_UNSET_OR_ZERO`) · C5/C6 relative change ≤ 25 % of the non-zero baseline.
With FIRST_CONFIGURATION = YES and a zero baseline the relative bound is skipped *visibly* (INFORMATIONAL `FIRST_CONFIGURATION_BOUND_SKIPPED`).

### RESOURCE_REQUIREMENTS
R1 `reorderPoint + reorderQuantity ≤ MAX_IMPLIED_STOCK_UNITS (500)` in the item's own `unit_of_measure`. This is a **nominal policy cap**
(`basis: POLICY_CAP`), not physical capacity: `capacity_units` is never read and no unit conversion exists. A blank `unit_of_measure` ⇒
INDETERMINATE. (Caveat: the column defaults to `'unit'`, so "present" does not prove a person chose it; the policy cap is nominal either way.)

### COST
K1 latest `receipt` movement (by `occurred_at`, then `id`): absent ⇒ `NO_RECEIPT`; null cost ⇒ `UNIT_COST_MISSING`; zero, negative, NaN,
unparseable or below the smallest storable amount (0.0001) ⇒ `UNIT_COST_INVALID`. A historical invalid value is **never repaired, inferred,
rounded or replaced** — it makes COST INDETERMINATE. K2 governed `DECLARED_CURRENCY` (Business Administration, 0185): absent ⇒
`DECLARED_CURRENCY_MISSING`; cost currency absent ⇒ `COST_CURRENCY_MISSING`; differs ⇒ `COST_CURRENCY_MISMATCH`. K2b declared currency ≠
`ORDER_VALUE_CAP_CURRENCY` (USD) ⇒ `CAP_CURRENCY_MISMATCH`. **No FX conversion exists.** K3 `reorderQuantity × unit_cost ≤ 5000`.
K4 `max(0, final order value − baseline order value) ≤ 25 % × 5000 = 1250` (baseline quantity 0 ⇒ INDETERMINATE `BASELINE_QUANTITY_ZERO`).
K5 supplier cap: INFORMATIONAL `SUPPLIER_CAP_NOT_RESOLVABLE` (no item-to-supplier link exists; no cap is invented).

### EXPECTED_OUTCOME
Window: `(now − 90 days, now]` on the **database clock**, `now` read in the same statement as the other facts. Qualifying movements: type
`issue` only; demand is the sum of the magnitudes (`abs(quantity)`). E1 at least `MIN_DEMAND_OBSERVATIONS (10)` qualifying movements, else
INDETERMINATE `INSUFFICIENT_HISTORY` for E1–E3 (missing history is never PASSED and never zero demand). A sum of zero (or unreadable)
with enough observations ⇒ INDETERMINATE `NO_USABLE_DEMAND`. With `d = SUM / 90` and every inequality multiplied through by the window so the
arithmetic stays exact:

```
E2 stock-out guard : reorderPoint ≥ d × LEAD_TIME_DAYS × SAFETY_FACTOR   ⇔  reorderPoint × 90 ≥ SUM × 14 × 1.25
E3 overstock guard : reorderPoint + reorderQuantity ≤ d × MAX_COVER_DAYS ⇔  (reorderPoint + reorderQuantity) × 90 ≤ SUM × 90
```

No Simulation result is consulted or substituted (see §9).

## 5. Exact arithmetic
All comparisons use a BigInt-scaled `Decimal` (`decimal.ts`). Numbers enter through their shortest round-trip text, never a binary
expansion, so `0.1 + 0.2 = 0.3` and `250.1 + 249.9 = 500` hold exactly. `NaN`/`Infinity` never parse.

## 6. Persistence
One row per dimension, all four in **one transaction** (all or none), through `InventoryPolicyEvaluationRepository.recordAll` (the only
writer; the B2a append-only trigger forbids UPDATE/DELETE/TRUNCATE for every role). Each row stores the exact `subject`
(`actionType`, `target`, `finalParameters`) and its `subjectDigest` (the shared `computeGovernanceSubjectDigest`, computed once from the
persisted subject), `ruleSetVersion`, `requested_by_user_id` (the authenticated actor), the caller's `correlationId`, the findings, and the
input snapshot. `evaluated_at` is database-owned and never written by application code. The warehouse is stored only when exactly one
balance exists; otherwise the evaluation is about the item (`warehouse_id` NULL).

### Input snapshot (`inputs`, schema `inventory-policy-evaluation-inputs/1`)
`ruleSet {id, version, parameters}` · `capturedAt` and `window {startsExclusive, endsInclusive, days}` (database time) · `facts`: `item`,
`balances`, `latestReceipt`, `demand {count, sumOfMagnitudes, movementTypes}`, `declaredCurrency {status, currency, version}` ·
`snapshotDigest = sha256(canonicalize({ruleSetVersion, facts}))` — capture times are deliberately excluded so an identical fact set has an
identical digest.

## 7. Idempotency model (documented decision)
The evaluation is a pure function of (subject, rule-set version, BO fact snapshot, declared currency). Every call **appends** four new
records with their own database time; nothing is merged, updated or overwritten. A later call after the facts changed naturally produces new
records with a different `snapshotDigest`; a replay of identical facts produces identical results and the identical `snapshotDigest`, so the
repeat is recognisable and provably equal. Request-level replay protection (`Idempotency-Key`) belongs to the HTTP route of B2c; the
repository deliberately has no hidden de-duplication (it would have to update or suppress rows). Consumers (B2c) must select by subject
digest + rule-set version + freshness (`EVIDENCE_MAX_AGE = 24 h`), not by "latest row".

## 8. Files
New: `packages/business-operations-runtime/src/inventory-policy/{decimal,ruleSet,evaluate,InventoryPolicyEvaluationService,index}.ts`;
`packages/database/src/repositories/bo/InventoryPolicyFactsRepository.ts`. Edited: `InventoryPolicyEvaluationRepository.ts` (`recordAll`),
`packages/database/src/index.ts`, `packages/business-operations-runtime/src/index.ts`, and four earlier architecture guards whose
allow-lists named "no evaluator yet" / "no cost reader yet" (they now allow exactly the B2b readers and the evaluator as the only caller of the
evaluation repository; every writer check is unchanged).

## 9. Specification ambiguities and gaps (reported, not silently resolved)
1. **Simulation `NOT_APPLICABLE` (`NO_APPLICABLE_SIMULATION_MODEL`) is a B2c/B2d contract change.** `SIMULATION_NOT_APPLICABLE_ALLOWED` in the
   locked contract is still empty; B2b neither edits it nor consumes Simulation. Until B2c/B2d changes it, a package for this action type cannot
   carry Simulation NOT_APPLICABLE end-to-end.
2. **Unresolvable/invalid target cannot be persisted** (foreign key to the item). It is a refusal, not an INDETERMINATE record. The rule set's
   T1/T2 findings still exist in the pure evaluator and are exercised by unit tests.
3. **`unit_of_measure` defaults to `'unit'`** in the schema, so a non-blank value is not proof of a deliberate choice.
4. **Declared currency is read in a separate statement** from the facts snapshot (it lives behind the Business Administration read boundary).
   Both values are recorded in `inputs`; they are not one MVCC snapshot.
5. **Historical invalid costs** (0187 is `NOT VALID`) are evaluated, never repaired.
6. ISO 4217 membership is not checked (format `^[A-Z]{3}$` only; ruling deferred).

## 10. Future extension notes
B2c: `GovernanceEvidenceVerifier` adapter (reads a stored record by reference, re-derives the subject digest, checks `ruleSetVersion`, result
`PASSED` and freshness), the HTTP route with `Idempotency-Key`, and the `modifiedAt` correction. B2d: end-to-end modified-approval authoring.
New action types need their own rule sets and their own evaluator; this one is deliberately not generic.

## 11. Tests
`inventoryPolicyEvaluator.test.ts` (pure rules, boundaries, every INDETERMINATE reason) · `inventoryPolicyDecimalAndRuleSet.test.ts`
(exact decimal, closed registry, drift against the §12 approval record) · `InventoryPolicyEvaluationService.integration.test.ts` (live
PostgreSQL: persistence, digest, snapshot, refusals, tenant and business isolation, no mutation, append-only, atomicity) ·
`p0-5-b2b-evaluator.architecture.test.ts` · updated guards. Mutation proofs are listed in the PR report.
