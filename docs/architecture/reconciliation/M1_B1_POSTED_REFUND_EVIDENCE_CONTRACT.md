# M1-B1 — BO posted-refund evidence contract and compatibility preflight

**Status: DESIGN PROPOSAL ONLY; NO REFUND WRITER OR POSTING AUTHORITY.** Reviewed against `main` at `df69d284c554c0168890273479944dfd1598ba53` (migrations 0001–0218). This package does not ratify an operational refund policy, change frozen POS contracts, or authorize schema, API, production, OM-verdict or CL changes.

## Existing authority and gaps

| Source | What it proves | What it cannot prove |
| --- | --- | --- |
| `platform.orders`, `business_operations.order_events`, `business_operations.order_payments` | BO order status, a `completed` transition and cash/card/other tender applied at checkout; the payment consistency trigger protects the completed order total. | That a later refund occurred. `OrderRepository.void` accepts only `planned` orders; there is no completed-sale refund path. |
| `business_operations.credit_notes` | A financial document with `draft`, `issued`, `applied` or `cancelled` status, amount and optional invoice link. | Money returned, an immutable status history, a trusted posting timestamp or mandatory original-order linkage. `invoice_id` is nullable and its FK uses `ON DELETE SET NULL`. |
| `platform.invoices`, `platform.payments`, `business_operations.payment_allocations` | Invoice/payment document and allocation relationships. | A POS refund tied to an `order_payments` tender. Dates and status are mutable document fields, and the invoice's `order_id` is nullable. |
| `SaleEvidenceReviewRepository` | Read-only blocker findings for order, tender and linked credit notes; exact decimal-to-minor conversion. | Authoritative net-sales proof. It intentionally returns `authoritative: false` and reports mutable history, absent refund application time and potentially unlinked refunds. |
| `business_operations.business_events(sale)` | Operational projection written alongside BO order completion. | A second independently countable sale or a refund settlement. Governed revenue must not sum this projection with the original completed order. |

**Owner direction already recorded:** a credit note is not a posted refund; only BO-authorized immutable `REFUND_POSTED` evidence may reduce governed net sales. Offline refund processing remains disabled. BO owns a separate append-only refund/reversal relation; BI and OM are read-only consumers. Historical proof cannot be fabricated.

**Current dependency:** M1-A's immutable completed-sale snapshot and governed coverage watermark have not been implemented. Existing `order_events` provide a completion transition but do not supply that approved financial snapshot. A refund writer or OM revenue consumer must not treat the proposed snapshot reference as already available. POS v1 explicitly has no completed-sale refund action; adding one requires a formal POS-owned contract and security decision.

## Proposed BO event contract — requires separate owner approval

A future BO-owned `posted_refund_events` relation would be **the refund economic-evidence source**, separate from financial-document status. It would carry:

- Immutable `event_id`, scoped `(tenant_id, workspace_id, business_id)`, `refund_id` grouping identity and monotonically versioned correction/reversal sequence.
- Mandatory same-scope `original_order_id` and immutable completed-sale event/snapshot reference. A nullable credit-note or invoice reference is supplementary provenance, never the sole sale link.
- Optional same-scope original `order_payment_id` or allocation references when the approved refund method requires them; no raw card credentials or processor secrets.
- Event kind proposed as `REFUND_POSTED`, `REFUND_CORRECTED` or `REFUND_REVERSED`; the exact transition and economic meaning of a reversal **remain owner/payment decisions**. Until then, no kind is activated.
- Database-issued trusted `posted_at` for economic recognition and `recorded_at` for audit, plus external settlement time/reference as untrusted provenance where applicable. No device time determines governed revenue.
- Currency, exponent and exact signed integer minor-unit economic delta; separately identifiable refunded tax/discount components only under approved financial policy. Missing components remain unknown, never zero by default.
- BO authorization evidence, actor/service identity bound by a trusted writer, source system and source transaction/reference, idempotency key, canonical payload digest, prior-event digest, correction/reversal links and reason code.
- Scope-preserving composite FKs and forced RLS, append-only UPDATE/DELETE/TRUNCATE refusal, unique source/idempotency keys, and unique event version per refund chain.

**Metric eligibility:** A `REFUND_POSTED` record can be considered for `NET_SALES_REVENUE_V1` only if its sale linkage, business/currency, amount, settlement proof, coverage and correction lineage are complete under an approved definition. A credit-note `applied` status alone never qualifies. An unlinked or cross-currency refund remains outside governed revenue and yields an explicit incomplete-evidence finding, not an invented zero. BI may calculate from BO facts; OM consumes only approved governed evidence. Neither issues a refund.

## Proposed transaction and replay boundaries

1. An online BO/POS-authorized posting command would verify a completed original order, same scope and currency, available refundable balance, approved payment method, actual return-of-funds proof, canonical actor authority and any independent approval required by payment policy.
2. The BO transaction would serialize postings for one original sale/refund chain; bind the source settlement reference and request digest; append exactly one economic event and audit evidence. The existing order and `order_payments` remain unchanged.
3. Same key and same digest returns the first result. Same key with changed payload, or reused settlement reference for another sale, conflicts. Concurrent partial refunds cannot exceed the approved refundable amount. No `business_events(sale)` record is emitted for a refund.
4. A correction or reversal appends a linked event. It never deletes or edits a prior posting. Whether a reversal restores governed revenue requires approved evidence that the economic return itself was undone; a document cancellation alone cannot do so.
5. Payment processor failure, incomplete transfer, unsupported method, stale authority or missing sale linkage records no `REFUND_POSTED` event. The handling of pending/failed attempts must be designed separately and must not masquerade as posted evidence.

## Approval and conflict register

| ID | Exact decision needed | Owner/sign-off | Acceptance test before writer authorization |
| --- | --- | --- | --- |
| B1 posting proof | Define per-method evidence proving money actually returned, settlement finality and trusted BO acceptance time. | BO/POS, payment/accounting; processor/legal where applicable | Issued/applied credit note or pending processor response cannot post; confirmed return can post once. |
| B2 scope and linkage | Require original completed BO order and completion evidence, with invoice/credit note optional context. Decide treatment of refunds lacking a qualifying sale. | BO/POS, BI/OM source owners | Missing, ambiguous, foreign-business or foreign-currency sale link refuses governed eligibility. |
| B3 authorization | Map online posting, correction and reversal to existing canonical roles or approve a formal new mapping; decide separation of duties. No permission is inferred from `bo:write`, `bo:admin` or a credit-note status. | Owner, security, BO/POS | Revoked, foreign-scope, self-approving or insufficient actor is refused and audited. |
| B4 partial/refundable cap | Set whether tax, discount, fees, shipping and cash change enter the refundable base; require exact minor-unit conservation and concurrent cap enforcement. | BO/POS, payment/accounting, tax/legal | Multiple partial refunds never exceed the eligible basis; unknown component blocks instead of becoming zero. |
| B5 correction/reversal | Define event semantics and the exact proof for an economic reversal versus a document correction, including signed delta and period recognition. | BO, payment/accounting, BI/OM; legal where applicable | Duplicate, out-of-order and document-only reversal cannot change governed revenue. |
| B6 credit-note relationship | Decide when an invoice/credit note must be created or linked and how its status reconciles without becoming settlement proof. | BO finance/POS, accounting | Applied credit note without posting is not a refund; one posting is counted once despite multiple documents. |
| B7 coverage and history | Establish watermark only after writer and constraints are effective; historical mutable records remain nonauthoritative. | Owner, BO, BI/OM | Pre-watermark periods are inconclusive; no fabricated backfill. |

## Additive implementation dependencies and verification plan

Before any migration or writer: approve B1–B7, the exact event taxonomy and source payload, canonical role mapping, POS online refund contract, settlement evidence retention and rollback plan. Recheck the migration ledger then; **0219 is only a candidate at this baseline**. A separate review must prove the composite FKs, RLS/grants, immutable event history, unique source keys, posting transaction and correction chain against disposable PostgreSQL.

Required later tests: completion versus order creation; partial/full and excessive refund; duplicate source/key with conflicting payload; simultaneous partial refunds; reversal after posting; cross-tenant/workspace/business/currency; missing invoice or credit note with valid direct sale link; ambiguous/unlinked sale; invalid posting chronology; failed/pending settlement; revoked role; append-only refusal; rollback; BI/OM read-only and no double count with `business_events(sale)`. Existing POS offline behavior, completed-order totals and tender consistency must stay unchanged.

**Smallest next independently implementable package after approvals:** a disabled BO-owned refund-evidence schema and scoped read-only verifier, with no posting or reversal writer. Online posting follows only under a separate implementation authorization. M1-A operational R1–R6, authoritative OM VERIFIED/FAILED and CL learning remain closed.
