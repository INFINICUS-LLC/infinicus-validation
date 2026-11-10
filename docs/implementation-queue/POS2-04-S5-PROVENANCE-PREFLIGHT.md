# POS2-04-S5 — Catalogue provenance trust preflight (development only)

Status: **BLOCKED FOR ACTIVATION — trusted producer/writer authorization unresolved.**
Baseline: main `ace6a07ae1efda558483afd68cfcd81ca4615c79` (S4 / PR #438).
This sub-block characterizes the existing trust boundary; it is **not** the S5 durable pull processor, a release approval or a declaration of S5 completion.

## Established code facts

1. `OrderRepository.addLineItem` writes a business_operations.order_line_items row with the BO product ID absent from the canonical `product_id` FK, then writes an `order_events` note containing `kind=catalog_line_added`, `lineItemId` and `catalogProductId`.
2. `OfflineSaleRepository` also writes the note, including the honoured-price-drift variant after writing a custom-priced line.
3. Migration 0219 makes order_events append-only and scope-bound. Append-only protects against rewriting a note but **does not authenticate the INSERT writer**.
4. `grant-app-role.sh` grants INSERT on business_operations tables and specifically revokes UPDATE/DELETE/TRUNCATE (but **not INSERT**) on order_events. The ordinary application database role can therefore append a syntactically valid catalogue note under its own tenant/workspace scope.
5. Migration 0229 checks the note's content, time, business scope, uniqueness and mapping consistency, but does not prove that the note was emitted by the trusted POS line-authoring code. The S3 trigger is a **consistency** validator, not source authentication.
6. The S4 command `OperationalCommandExecutor.applyPosSaleEffectOn` is privileged and unwired. No route, pull worker or scheduler calls it; automatic stock deduction must remain disabled.

An application-role principal able to insert arbitrary order notes could manufacture a `catalog_line_added` payload. The legacy event schema also permits callers with column-level INSERT permission to provide `occurred_at`, so chronological checks against completion do not prove the event was originally emitted before the sale. A forged note may be caught when conflicting with an earlier note, but it cannot be assumed authentic when it is the only note. An append-only record alone is insufficient authority to move inventory.

## Proof and limits

The rollback-only disposable-PG16 characterization in
`infinicus-platform/packages/database/tests/pos-inventory-sale-effects.integration.test.ts`
checks that the ordinary app role can INSERT an arbitrary same-scope catalogue-line note with an artificially backdated `occurred_at`, cannot directly INSERT sale-effect evidence, and that the forged note is rolled back. This test **does not** establish that the current S3 producer can be exploited, nor does it authorize activation.

The test runs only when both `DATABASE_URL` and `ADMIN_DATABASE_URL` are set. A skipped or unexecuted integration test is UNKNOWN, not PASS. Run only on disposable PG16 with CI-equivalent app-role grants and RLS. A future fix that removes the described INSERT capability must replace this characterization with an enforceable rejection test.

## S5 activation decision gate

S5 cannot move forward to automatic stock effects until Core/POS and BO/security owners approve an enforceable trusted source of catalogue-product attribution. Required decision:

- **Option A (preferred for review):** Store authoritative, immutable, tenant-scoped catalogue association at line creation using a dedicated privileged write boundary separate from ordinary note INSERT, and require S3 evidence verification to use that association. Establish precisely which service/role may create it and how online and offline drift paths are authenticated.
- **Option B:** Keep note-based provenance only with independent, verifiable writer attestation and protected signing-key custody, including replay protection and key rotation. Signing by a principal with the same compromised privileges as the unrestricted note writer does not close the trust gap.
- **Reject:** Treating the existing `catalog_line_added` payload, a `created_by` claim, or mere append-only semantics as authenticated source evidence.

No selection is implemented in this preflight. Do not alter existing Core-owned contracts, existing migrations (0229/0230), tenant RLS, application permissions, sale-completion behavior, payments, refunds, or the canonical movement writer without a separately reviewed decision.

## Acceptance for the subsequent S5 implementation

The next authorized implementation must demonstrate: an authenticated same-transaction line association; no unauthorized write surface; tenant/business isolation; offline parity; existing-order migration/backfill policy; invalid/conflicting/replayed forged-note refusal; exact quantity and active mapping validation; only one effect per line; rollback atomicity; shortage exception semantics; and an independently governed, closed-by-default pull processor. Access, erasure, lifecycle and operational activation must receive separate security signoff.

**Go/no-go:** NO-GO for an S5 producer, consumer, live stock movement, deployment and merge authorization from this preflight. Owner architecture decision required.
