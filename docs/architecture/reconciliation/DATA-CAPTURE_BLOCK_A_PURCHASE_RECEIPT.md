# Data-capture Block A - purchase receipt write path (migration 0197)

Status: DRAFT PR. Not applied to any live database (the live head is unverified). Blocks D, B2b+ changes, P0-6 and every reorder-policy behaviour are NOT
part of this block. Implements section 3.A of `DATA-CAPTURE_RECONCILIATION_inventory-cost-receipts.md` (the authoritative specification) using the owner
rulings recorded in Blocks B, C and E (Q-D1 cost optional but valid and currency-tagged; Q-D2 no silent currency default; Q-D5 order C -> B -> A -> D -> E).

## 1. Specification mapping

| Specification (reconciliation doc 3.A, plus rulings) | State before | Gap | Where implemented |
|---|---|---|---|
| New DAL record type `purchase_receipt` | none | record type, versioned mapper | `intake/defaultMappers.ts` `purchaseReceiptMapper` (record type `purchase_receipt`, v1); `types.ts` `OperationalRecordType` |
| BO command `record_purchase_receipt`, executed by the existing executor, idempotent by the intake idempotency key | no command | command + executor branch | `types.ts` `RecordPurchaseReceiptCommand`; `OperationalCommandExecutor.recordPurchaseReceipt` |
| A receipt names its purchase order, warehouse, receipt number (unique per business, existing constraint) and one or more lines | header table `purchase_receipts` (0026) with the unique `(business_id, receipt_number)` | line table | migration 0197 `purchase_receipt_lines` |
| Lines: receipt, purchase-order line, inventory item, quantity, unit cost, cost currency | none | new BO table | `purchase_receipt_lines` (+ the ledger movement each line created) |
| Executing a receipt also creates the `receipt` movement(s) in the same transaction with `reference_type = 'purchase_receipt'`, `reference_id = receipt id`; no duplicated balances | `purchase_receipt` reference type accepted, pointing at nothing | movement per line | executor calls the ONE movement writer (`applyInventoryMovement`, extracted from `recordInventoryMovement`) per line |
| Receipt movement with cost: `unit_cost > 0` (Block B); cost present <=> explicit currency (Block C); cost optional (Q-D1) | enforced for movements | same rule at the receipt boundary | one shared rule set `procurement/purchaseReceipt.ts` reusing `unitCostProblem` |
| RLS and append-only guards where the data is a fact | header unguarded although 0036 lists it as append-only | lines + header guards | 0197 (`forbid_mutation`, FORCE RLS) |
| No DAL write of BO tables | holds | keep | architecture guard |

## 2. Write path

`external record -> DAL publication (validated, provenance recorded) -> BusinessIntakeService -> purchase_receipt mapper -> record_purchase_receipt ->
OperationalCommandExecutor (the one BO writer, one tenant transaction) -> header + lines + one receipt movement per line`. The DAL writes no BO table
(guarded). There is no API route that writes a receipt; the only entry is the published-record intake.

## 3. Receipt semantics

- **Identity / idempotency.** The receipt number is the business identity (`UNIQUE (business_id, receipt_number)`, pre-existing). Concurrent writers are serialized by an advisory lock on `(business, receipt number)`; then: no receipt -> create; the SAME canonical content -> safe no-op (same id, no second header, line, movement or balance effect); DIFFERENT content under the same number -> refused (`already exists with different content`), nothing changed; a different number -> a different receipt (identical lines are not collapsed). Package-level replay is already a no-op in the intake (delivered packages are not re-executed). "Same content" is a fixed canonical form (exact decimal text, 1-based line numbers, UTC instant, key order irrelevant).
- **Quantity.** Strictly positive, finite, at most 4 decimals, below 10^14 (`numeric(18,4)`). Nothing is rounded: a value the column could not store exactly is refused. Returns / negative receipts are NOT modelled here (movement types `return`/`adjustment` stay separate).
- **Unit cost.** Optional. When present: finite, > 0, >= 0.0001 (the existing shared Block B rule, reused) and at most 4 decimals; explicit `^[A-Z]{3}$` currency required with it, nothing inferred, defaulted or converted (no FX). The database repeats cost > 0 / not NaN / pairing / currency format as constraints that are valid from the first row.
- **Currency.** The line's own explicit currency is stored with the cost. No match against the business's declared currency is demanded at write time: per the declared-currency ruling that comparison belongs to the B2 COST evaluation (a mismatching or undeclared currency yields CAP_CURRENCY_MISMATCH / DECLARED_CURRENCY_MISSING there). No purchase-order currency is read.
- **Received time.** `receivedAt` is RFC 3339 with an explicit offset (no assumed time zone); it must not be in the future relative to the database clock. It is stored on the header and is the `occurred_at` of each receipt movement (the business instant of the stock change).
- **Provenance.** `sourceReference`, `provenanceReference` and the intake `idempotencyKey` are all required (fail closed); with the actor and occurrence time they are stored in the header `payload.provenance` next to the canonical content. Nothing is fabricated.
- **Scope.** Tenant, workspace and business come only from the command context / transaction. The payload may not carry them (unknown fields are refused). The purchase order, warehouse, every item and every purchase-order line must be in that business (RLS enforces tenant + workspace independently); the purchase-order line, when given, must be a line of the receipt's purchase order.
- **Atomicity.** Header, lines, movements, balance effects and movement events commit together or not at all (a failing later line rolls back everything).

## 4. Purchase-order relationship (what Block A does, what stays for Block D)

Block A: the receipt references an existing purchase order (the existing NOT NULL FK) and may reference purchase-order lines (nullable FK, validated against that order). It does NOT change the purchase order, its status (`partially_received` / `received`), its lines' `received_qty`, or any supplier/agreement data, and it does not require PO lines to exist (they have no write path yet).
Block D (not started): the `inventory_item_id` link on purchase-order lines, the unbroken chain PO -> line -> receipt line -> movement -> item, PO status transitions and received-quantity reconciliation. The line column `purchase_order_line_id` is the hook for it.

## 5. Append-only, RLS

`purchase_receipt_lines` and `purchase_receipts`: UPDATE, DELETE and TRUNCATE refused for every role (`business_operations.forbid_mutation`, the convention `delete-tenant-data.mjs` discovers, so tenant erasure retains them). FORCE RLS on tenant + workspace for the new table. Consequence: because the lines reference the movement ledger, a plain `TRUNCATE inventory_movements` is now also refused by PostgreSQL's own foreign-key rule (the CASCADE form still reaches the append-only trigger); the three older tests that pin the message were updated to accept either refusal.

## 6. Migration allocation record (MIGRATION-ALLOCATION-POLICY)

| Item | Value |
|---|---|
| Predecessor | `0196_harden_database_authority_activation_and_reorder.sql` (main `10c5f61`, CI run 346 SUCCESS) |
| New range | `0197` (single migration); no open PR and no remote branch carried a migration above 0196 |
| SHA-256 frozen 0001-0196 (concatenated in name order) | `3a429ca4ab7ba31a58cf53b1ef56f81d624dbcad460cb923749242ce584f16b7` |
| SHA-256 frozen 0001-0197 | `739e2245f3e85c97b35429b454938e5a8c207e3f4a14457d51730706755441c4` |
| SHA-256 of `0197_create_purchase_receipt_lines.sql` | `20f43249d0240a3a80f6e2061a0257a56bf8c3aaf564ed3ea6a1eb4174f1af92` (before any later review edit; see the PR for the final hash) |
| Why a migration is needed | the specification names a line table that does not exist; nothing else could hold per-line quantity, cost and the link to the ledger movement |
| Historical data | none read, moved, rewritten, repaired or backfilled; the migration contains no data statement besides its registration |
| Live Supabase | not applied (live head unverified) |

## 7. Caveats and owner-visible items

1. **Purchase-order status is not gated.** The specification is silent on whether a receipt against a `draft` or `cancelled` purchase order is allowed; none was invented. Recommendation: decide together with Block D (PO lifecycle).
2. **Over-precision gap in the existing movement path (not changed here).** The existing `inventory_movement` mapper accepts a cost like 1.00005 that PostgreSQL then rounds; receipts refuse it. Recommendation: a small follow-up to apply the same exact-scale rule to that mapper.
3. **Future-dated receipts are refused with no clock-skew tolerance.** A source clock slightly ahead of the database would be refused; a tolerance would be an invented number, so none was added.
4. **Line limit.** At most 500 lines per receipt (an operational bound, not a business rule).
5. **Receipt number is the identity.** A source that reuses a number for a different receipt is refused by design; it must send the corrected content under a new number (a correction is a new fact, never an edit).
6. **`received_by` (employee) is left NULL.** The specification does not name it.

## 8. Tests and proofs

- `PurchaseReceipt.integration.test.ts` (48, real PostgreSQL as the least-privilege role): happy path, DAL end to end, 31 validation cases, scope, RLS, idempotency (incl. concurrency), append-only, database guards, separation from PO / reorder / activation.
- `PurchaseReceiptMapper.test.ts` (7): mapper, shared rule set, exact-decimal canonical form.
- `dataCaptureBlockA.architecture.test.ts` (10): DAL never writes BO, one BO writer, command only in four files, shared rule set, provenance fail-closed, idempotency, no Block D / P0-6 coupling, migration shape.
- 29 semantic mutants killed (unit cost allows zero/negative, NaN accepted, rounding, currency pairing/format removed, tenant trusted, scope checks removed, provenance omitted, duplicate/conflicting replay, lock removed, time/future rules, executor validation removed, reorder mutation, second writer, DAL direct write, append-only guards, insert guard, CHECKs, RLS). Two initially-surviving mutants were equivalent or exposed a missing case; the missing test was added and both are now killed.
