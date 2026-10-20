# POS-6c — Split-tender and zero-total checkout

Date: 2026-10-20. Authorization: owner request, "next build", following POS-6b. This independent block starts from main `669e53d` (the owner merged PR #189); it does not depend on or merge PR #190.

Layer/domain: BO / COMMERCE. This block exposes the existing POS-5 tender contract through the counter. BO still validates and records payments, applied amounts, cash change, sale events and register reconciliation. There is no payment-policy or authority change.

## Implemented behavior

- Add/remove up to ten ordered payment rows, each with cash, card or other method, an amount, and an optional slip reference.
- Split payments require explicit amounts on every row. A single card/other payment retains the shortcut of a blank amount paying the server total. Cash received is always explicit.
- Advisory client validation uses integer currency minor units and rejects missing/invalid amounts, precision errors, unsafe integer amounts, underpayment, non-cash overpayment, extra payments after settlement, and card-number-like/overlong references. Change is labelled as a preview; the recorded amount remains the server's returned value.
- A nonempty zero-total order confirms with `payments: []`; an empty order remains invalid. No payment is taken or invented for a free order.
- Cart additions, quantity changes and line removal are disabled while a checkout confirmation is open. Tender inputs are locked while a request is in flight or its outcome is unresolved.
- The existing order session submits all entered payments in one completion request. It copies the tender payload before retaining the action, so a lost-answer retry reuses the same key and original body even if the caller later changes its draft.
- Existing server totals, multi-payment display, receipt payments, cash change and register reconciliation remain authoritative. No payment is recorded before successful full checkout; this is not a partial-credit or refund flow.

## Validation

Unit/controller tests cover KWD/USD/JPY precision, split method order, final cash change, payment-count/reference validation, zero-total and empty-order behavior, disabled controls, original-body retry and duplicate prevention. Live API regression coverage verifies three-tender KWD checkout, replay without duplicate records and cash-only register reconciliation using the existing backend contract.

## Boundaries

No migration, API or database implementation change, dependency addition, card processing, tax/discount/branch policy, refund, credit balance, offline queue, production deployment, H-5A/recovery action or locked-spec amendment. PR #190's history/reprints remain a separate review. Stop after this block and return the commit and PR for owner review; do not merge automatically.
