# OM-AUTH-M1A — read-only evidence review and owner decision

Base: `main` at `5a38c848702c9a836156eca043cb5a06d47139b6`. Status: **partial read-only inspection; no new authority**.

## Existing BO truth and transitions

- `platform.orders` is the canonical mutable order: `created_at`, `order_date`, `operational_status`, `total_amount`, `currency_code`, `version`. `OrderRepository.complete` locks a planned order, changes it to completed, appends `business_operations.order_payments`, `order_events(completed)`, and `business_events(sale)` in one transaction. A second completion is refused. `void` changes only a planned order to failed and appends an order event. Existing offline sale intake reuses this order path. The status vocabulary includes `reversed`, but no governed completed-sale reversal path was found.
- `order_payments` is an append-only tender ledger. Migration 0206 checks completed status, same currency/register and applied sum at commit. It is payment evidence, not a refund ledger.
- `order_events` has `occurred_at`, `created_at`, event ID and correlation ID. Completion currently relies on a default timestamp. The table is described as append-only, but no database UPDATE/DELETE/TRUNCATE prohibition or completion-event uniqueness was found; its timestamp can be caller-supplied. It cannot yet certify immutable completion time.
- `business_events(sale)` is a same-transaction business activity record with the order ID in `correlation_id`; it is not an independent payment/refund authority.
- `credit_notes` has `issue_date`, mutable `credit_note_status`, amount and currency. Its optional `invoice_id` can reach `platform.invoices.order_id`, but neither foreign key includes the business/currency tuple, and no applied-refund timestamp, refund tender, or compensating reversal record exists. An invoice/order link can be absent. `FinancialFactsRepository` deliberately does not net credits.
- `SalesFactsRepository` reads completed order totals and discounts by **order creation date**, not completion time. Its "net" is after discount, not after refunds. It cannot satisfy proposed `NET_SALES_REVENUE_V1`.

## Safe implementation in this branch

`SaleEvidenceReviewRepository` reads the existing BO order, lifecycle events, payments and invoice-linked credits under tenant/workspace RLS and an explicit business predicate. It reports a digest and exact minor-unit amounts using the existing currency exponent table, but always returns `authoritative: false`. It flags missing/duplicate completion, invalid timestamp ordering, payment/currency mismatch, cancelled credits, over-crediting and truncation. It always flags mutable history, absent refund application time and inability to detect unlinked refunds. No new ledger, write path, metric, migration, permission or OM verdict is added.

## Owner change proposal — STOP before implementation

1. **Completion authority:** approve BO database enforcement that exactly one completed transition is appended per order, its timestamp is issued by the database in the completion transaction, and lifecycle events cannot be updated, deleted or truncated. Decide how legacy completed orders without a trustworthy event are treated (recommended: inconclusive, no backfill fiction). Preserve the existing `OrderRepository.complete` as the only writer.
2. **Refund authority:** choose whether invoice-linked credit notes are financial adjustments or actual customer refunds. If refunds, approve a BO-owned append-only application and reversal record with unique external/source event key, original order and invoice reference, tenant/workspace/business/currency composite scope, exact minor-unit amount, database application time, actor and correction/supersession link. Linkage, partial/full amount bounds, and duplicate rejection must be enforced in the database. No separate sales ledger is proposed. Existing mutable credit-note status alone is insufficient.
3. **Authorization and history:** approve the exact BO role/permission for applying/reversing refunds and database RLS/immutability rules. POS owns payment and sale completion behavior; coordinate the shared order/payment contract with that workstream before any write change.
4. **Governed reader:** after the BO authority is approved and implemented, BI may derive net sales from BO facts. OM may consume only an approved scoped/digested evidence port. No automatic attribution PASS or positive verdict is part of M1A.

## Completion-matrix evidence delta

| Capability | Code/test state | Authority state |
| --- | --- | --- |
| Completed order and tender | Existing BO writer and append-only tender checks | Operational sale authority exists; immutable completion timestamp unproven |
| Linked applied refund and reversal | Optional invoice path and mutable credit-note status only | **Blocked by owner schema/semantic decision** |
| Exact minor-unit conversion and read-only review | Added in M1A with synthetic PostgreSQL proof | Inspection only, never a net-sales metric |
| OM governed net-sales observation | No M1 metric writer | **Closed** |
| VERIFIED/FAILED and CL learning | OM-MEASURE-7 preflight refuses | **Closed** |

This delta updates evidence for the M1 dependency. It does not revise the historical code-level completion percentages in `COMPLETION_GAP_ASSESSMENT.md` or claim deployed, migrated, activated or production-verified status.
