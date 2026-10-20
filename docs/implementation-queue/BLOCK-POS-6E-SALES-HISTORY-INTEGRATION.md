# POS-6e — Sales history integration

Date: 2026-10-20. Owner authorization: next.

Restores POS-6b completed sales history from commit 8e6e5cd, previously merged into the foundation branch but absent from main. This branch is based on POS-6d PR #192 (itself based on main 29d237a). Review/merge #192 first, then retarget this PR to main. No automatic merge.

The counter links to completed sales, paginated by scoped UUID cursors with PostgreSQL timestamp precision and deterministic ID ordering. Full scoped order detail is fetched for reprinting; no new sale or payment is created. Superseded responses are ignored. Recorded quantities retain four decimal places.

Historical reprints now use POS-6d BusinessReceipt, matching the counter: exact canonical business lookup, scope-keyed read state, business identity validation, retry/close on failure and printing only after identity loads. The old POS-6b first-business-page header limitation is superseded. SalesHistoryView receives a receipt slot so the presentation layer cannot independently produce an unverified printable receipt.

BO/COMMERCE remains authoritative for orders, lines, currency, totals, payments and change. Business identity remains owned by the canonical BusinessRepository. Locked architecture, schemas of record, existing discount/tax/register authorization and checkout idempotency remain unchanged. No migrations, production/deployment changes, H-5A/recovery access, refunds, offline queue, new branch policy, exports or fiscal receipt format.

Validation covers the full web suite, scoped cursor integration, existing checkout/register/currency/API permission regressions, production build, typechecks and lint. New integrated reprint tests check identity waiting/error/success and recorded four-decimal quantities/payment references.

Limits: history is live rather than a frozen reporting snapshot; headers use the current canonical business name. Owner review and CI completion are required before release. Stop after this block.

History list/detail endpoints now use getForWorkspace so a read-only user in a sibling workspace cannot retrieve another workspace’s orders or receipts. Soft-deleted businesses are also refused. This applies the same canonical visibility rule as POS-6d without changing mutation routes.
